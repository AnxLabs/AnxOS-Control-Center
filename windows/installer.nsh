; AnxOS Control Center installer customisation (Phase 9).
;
; Built on electron-builder's assisted NSIS installer: the same engine, signing
; and update handoff as before. This file only adds branding, beginner-friendly
; pages and the AnxOS Helper choice. Every NSIS plugin it uses (nsDialogs,
; nsExec, System) is part of the toolsets that scripts/sign-nsis-toolsets.js
; signs for release builds, so Smart App Control can load them.
;
; Page flow: Welcome (new install or upgrade/repair) -> install mode ->
; folder -> "Set up AnxOS" (Helper choice, permissions explained) ->
; progress -> Finish (open the app). Uninstall: Welcome (what is kept) ->
; progress -> Finish.

!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; Dark charcoal header bar and Welcome/Finish pages (artwork in
; windows/installer-art, wired up in package.json build.nsis).
!define MUI_BGCOLOR 181521
!define MUI_TEXTCOLOR FFFFFF

!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TITLE "AnxOS Control Center is ready"
  !define MUI_FINISHPAGE_TEXT "Setup has finished.$\r$\n$\r$\nOpen AnxOS Control Center to create your first server or connect another computer. Everything is a click away; no command line needed."
  !define MUI_FINISHPAGE_RUN_TEXT "Open AnxOS Control Center now"

  Var anxSetupHelper
  Var anxHelperCheckbox
  Var anxIsUpgrade
  Var anxWelcomeText

!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ; Silent installs and updates set the Helper up as before; /NOHELPER
    ; skips it (the same choice as unticking it on the Set up page).
    StrCpy $anxSetupHelper 1
    StrCpy $anxIsUpgrade 0
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/NOHELPER" $R1
    ${IfNot} ${Errors}
      StrCpy $anxSetupHelper 0
    ${EndIf}
  !endif
!macroend

!macro customWelcomePage
  ; The page functions live here, not at the top of this file, because this
  ; macro is inserted after electron-builder defines APP_EXECUTABLE_FILENAME.
  Function anxWelcomePre
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $anxIsUpgrade 1
      StrCpy $anxWelcomeText "AnxOS Control Center is already installed on this PC. Setup will update or repair it in place.$\r$\n$\r$\nYour servers, worlds, settings, backups and paired computers are kept.$\r$\n$\r$\nClick Next to continue."
    ${Else}
      StrCpy $anxIsUpgrade 0
      StrCpy $anxWelcomeText "This will install AnxOS Control Center on this PC.$\r$\n$\r$\nCreate game servers, manage the computers that run them and share them with friends, all without the command line.$\r$\n$\r$\nSetup takes about a minute. Click Next to continue."
    ${EndIf}
  FunctionEnd

  ; "Set up AnxOS": the app is always installed; the Helper is recommended and
  ; its one administrator prompt is explained before it can appear.
  Function anxSetupPage
    !insertmacro MUI_HEADER_TEXT "Set up AnxOS" "Choose what to set up on this PC."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    CreateFont $1 "Segoe UI" 9 700
    ${NSD_CreateLabel} 0 0 100% 11u "AnxOS Control Center"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $1 1
    ${NSD_CreateLabel} 0 12u 100% 10u "The app you use to create and manage servers. Always installed."
    Pop $0
    ${NSD_CreateCheckbox} 0 30u 100% 11u "AnxOS Helper (recommended)"
    Pop $anxHelperCheckbox
    SendMessage $anxHelperCheckbox ${WM_SETFONT} $1 1
    ${If} $anxSetupHelper != "0"
      ${NSD_Check} $anxHelperCheckbox
    ${EndIf}
    ${NSD_CreateLabel} 12u 43u -12u 28u "Runs in the background so Control Center can start, stop and watch servers on this PC, even after a restart. It includes AnxNet, the private network for playing with friends, which stays off until you join a network."
    Pop $0
    ${NSD_CreateLabel} 12u 74u -12u 28u "Windows will ask once for administrator approval so the Helper can start when you sign in. Setup does not change your security settings, firewall or other apps. You can also set the Helper up later in Agent Control."
    Pop $0
    ${If} $anxIsUpgrade == 1
      ${NSD_CreateLabel} 0 110u 100% 10u "Your servers, settings, backups and paired computers are kept."
      Pop $0
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function anxSetupPageLeave
    ${NSD_GetState} $anxHelperCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $anxSetupHelper 1
    ${Else}
      StrCpy $anxSetupHelper 0
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE anxWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "Welcome to AnxOS Control Center"
  !define MUI_WELCOMEPAGE_TEXT "$anxWelcomeText"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom anxSetupPage anxSetupPageLeave
!macroend

; The Finish page, as electron-builder builds it (same launch function, which
; opens the app as the signed-in user and passes --updated after an update),
; plus one fix: Windows draws a themed checkbox's text in the theme colour,
; which is unreadable on the dark page, so that one checkbox is drawn
; unthemed in white.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW anxFinishShow
  !insertmacro MUI_PAGE_FINISH

  ; Defined after MUI_PAGE_FINISH, which declares $mui.FinishPage.Run.
  Function anxFinishShow
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
    SetCtlColors $mui.FinishPage.Run FFFFFF 181521
  FunctionEnd
!macroend

!macro customHeader
  BrandingText "AnxOS Control Center by AnxLabs"
!macroend

!macro customInstall
  ${If} $anxSetupHelper == "0"
    DetailPrint "AnxOS Helper not set up. You can set it up later in Agent Control."
  ${Else}
    ReadEnvStr $1 "USERDOMAIN"
    ReadEnvStr $2 "USERNAME"
    DetailPrint "Setting up the AnxOS Helper. Windows may ask for administrator approval..."
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Install -UserId "$1\$2"'
    Pop $0
    Pop $3
    ${If} $0 != 0
      ; nsExec leaves a number (the script's exit code), "error" or "timeout".
      ; If the plugin itself could not load (for example Windows Smart App
      ; Control refusing an unsigned plugin), the command line is still on
      ; the stack and lands in $0; never show that as an error code.
      StrLen $5 $0
      ${If} $0 == "1223"
        StrCpy $4 "Administrator approval was not given, so the AnxOS Helper was not set up."
      ${ElseIf} $5 > 12
        StrCpy $4 "The AnxOS Helper could not be set up because its setup step could not run (Windows security may have blocked it)."
      ${Else}
        StrCpy $4 "The AnxOS Helper could not be confirmed started (code $0)."
      ${EndIf}
      DetailPrint "$4"
      ; The app itself is installed and works; the Helper can be repaired
      ; from inside it. /SD IDOK: a silent install must not wait for a click.
      MessageBox MB_ICONEXCLAMATION "AnxOS Control Center is installed. $4$\r$\n$\r$\nTo finish, open AnxOS Control Center, go to Agent Control and select Stop Old Local Agent and Repair in the Lifecycle section, or run this installer again." /SD IDOK
      ; Automated installs still see that something needs attention.
      SetErrorLevel 3
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall AnxOS Control Center"
  !define MUI_WELCOMEPAGE_TEXT "This removes the AnxOS Control Center app and the AnxOS Helper from this PC.$\r$\n$\r$\nYour servers, worlds, backups, settings and paired computers are kept, so installing again picks up where you left off. Servers on other computers are not affected.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUnInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  DetailPrint "Removing the AnxOS Helper startup task..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Uninstall -UserId "$1\$2"'
!macroend
