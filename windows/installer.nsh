; AnxHost Control Center install engine (electron-builder's assisted NSIS
; installer), customised for Build 216.
;
; Users normally never see this installer's pages. AnxHost Setup (Rust,
; windows/setup, docs/anxhost/d-installer/CUSTOM_INSTALLER_PROPOSAL.md) embeds
; this signed installer and runs it silently (/S) with the user's choices and
; /ANXSTATUS=<file>, where this script reports its phases so Setup can show
; real progress. The pages below appear only when Setup cannot show its own
; window (Microsoft Edge WebView2 missing), after Setup has explained that.
;
; Same engine, signing and update handoff as before: every NSIS plugin used
; here (nsDialogs, nsExec, System) is part of the toolsets that
; scripts/sign-nsis-toolsets.js signs for release builds, so Smart App Control
; can load them.

!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; The build being installed, from the release version the packaging script
; passes to electron-builder (ANXOS_RELEASE_ARTIFACT_VERSION, "2.0-build216").
; Recorded so a later Setup can tell an update from a repair. Empty when the
; variable is not set (a manual makensis run).
!searchparse /noerrors "$%ANXOS_RELEASE_ARTIFACT_VERSION%" "-build" ANX_BUILD
!ifndef ANX_BUILD
  !define ANX_BUILD ""
!endif

; Dark charcoal header bar and Welcome/Finish pages (fallback wizard only).
!define MUI_BGCOLOR 181521
!define MUI_TEXTCOLOR FFFFFF

!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TITLE "AnxHost Control Center is ready"
  !define MUI_FINISHPAGE_TEXT "Setup has finished.$\r$\n$\r$\nOpen the app to create your first server or connect another computer. Everything is a click away; no command line needed."
  !define MUI_FINISHPAGE_RUN_TEXT "&Open AnxHost Control Center now"

  Var anxSetupHelper
  Var anxHelperWasInstalled
  Var anxHelperCheckbox
  Var anxIsUpgrade
  Var anxWelcomeText
  Var anxWelcomeTitle
  ; The status file AnxHost Setup reads (empty when run on its own).
  Var anxStatusFile
  Var anxStatusHandle
!endif

; One line for AnxHost Setup: "start", "plugins <dir>", "extracted",
; "registered", "helper-begin", "helper <exit code>", "helper-skipped", "done".
!macro anxStatus TEXT
  ${If} $anxStatusFile != ""
    FileOpen $anxStatusHandle "$anxStatusFile" a
    ${IfNot} ${Errors}
      FileSeek $anxStatusHandle 0 END
      FileWrite $anxStatusHandle "${TEXT}$\r$\n"
      FileClose $anxStatusHandle
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ; Silent installs and updates set the Helper up as before; /NOHELPER
    ; skips it (the same choice as turning it off in Setup's options).
    StrCpy $anxSetupHelper 1
    StrCpy $anxIsUpgrade 0
    StrCpy $anxHelperWasInstalled 0
    StrCpy $anxStatusFile ""
    ; Build 211 and earlier uninstall the Helper's startup task when an update
    ; runs them, and that happens before customInstall. Ask now whether the
    ; task exists, so an update sets a Helper that was set up again.
    nsExec::ExecToStack 'schtasks.exe /Query /TN AnxOSAgent'
    Pop $R2
    Pop $R3
    ${If} $R2 == 0
      StrCpy $anxHelperWasInstalled 1
    ${EndIf}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/NOHELPER" $R1
    ${IfNot} ${Errors}
      StrCpy $anxSetupHelper 0
    ${EndIf}
    ClearErrors
    ${GetOptions} $R0 "/ANXSTATUS=" $R1
    ${IfNot} ${Errors}
      StrCpy $anxStatusFile $R1
    ${EndIf}
    ClearErrors
    ; An update never removes a Helper that was set up (uninstalling the app, or
    ; Agent Control, does that).
    ${If} $anxHelperWasInstalled == 1
      StrCpy $anxSetupHelper 1
    ${EndIf}
    ; $PLUGINSDIR exists once a plugin has run (nsExec above). The app is
    ; extracted into its 7z-out folder first, which Setup measures.
    !insertmacro anxStatus "start"
    !insertmacro anxStatus "plugins $PLUGINSDIR"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; Runs right after the app's files are extracted and copied into place.
  !macro customFiles_x64
    !insertmacro anxStatus "extracted"
  !macroend
!endif

!macro customWelcomePage
  ; The page functions live here, not at the top of this file, because this
  ; macro is inserted after electron-builder defines APP_EXECUTABLE_FILENAME.
  Function anxWelcomePre
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName
    ${If} $R0 == ""
      ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayName
    ${EndIf}
    StrCpy $R1 $R0 5
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $anxIsUpgrade 1
      ${If} $R1 == "AnxOS"
        StrCpy $anxWelcomeTitle "AnxOS Control Center is now AnxHost Control Center"
        StrCpy $anxWelcomeText "AnxHost Control Center is the new name and look of AnxOS Control Center. Setup upgrades the copy on this PC in place.$\r$\n$\r$\nKept: your servers and worlds, saved sign-ins, settings, backups, paired computers, Agent identities and AnxNet networks.$\r$\n$\r$\nClick Next to continue."
      ${Else}
        StrCpy $anxWelcomeTitle "Update AnxHost Control Center"
        StrCpy $anxWelcomeText "AnxHost Control Center is already installed on this PC. Setup updates or repairs it in place.$\r$\n$\r$\nKept: your servers and worlds, saved sign-ins, settings, backups, paired computers, Agent identities and AnxNet networks.$\r$\n$\r$\nClick Next to continue."
      ${EndIf}
    ${Else}
      StrCpy $anxIsUpgrade 0
      StrCpy $anxWelcomeTitle "Welcome to AnxHost Control Center"
      StrCpy $anxWelcomeText "This installs AnxHost Control Center on this PC.$\r$\n$\r$\nCreate game servers, manage the computers that run them and share them with friends, without the command line.$\r$\n$\r$\nSetup takes about a minute. Click Next to continue."
    ${EndIf}
  FunctionEnd

  ; "Set up AnxHost": the app is always installed; the Helper is recommended and
  ; its administrator prompt is explained before it can appear.
  Function anxSetupPage
    !insertmacro MUI_HEADER_TEXT "Set up AnxHost" "Choose what to set up on this PC."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    CreateFont $1 "Segoe UI" 9 700
    ${NSD_CreateLabel} 0 0 100% 11u "AnxHost Control Center"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $1 1
    ${NSD_CreateLabel} 0 12u 100% 10u "The app you use to create and manage servers. Always installed."
    Pop $0
    ${NSD_CreateCheckbox} 0 30u 100% 11u "AnxHost &Helper (recommended)"
    Pop $anxHelperCheckbox
    SendMessage $anxHelperCheckbox ${WM_SETFONT} $1 1
    ${If} $anxSetupHelper != "0"
      ${NSD_Check} $anxHelperCheckbox
    ${EndIf}
    ${If} $anxHelperWasInstalled == 1
      EnableWindow $anxHelperCheckbox 0
    ${EndIf}
    ${NSD_CreateLabel} 12u 43u -12u 28u "Runs in the background so the app can start, stop and watch servers on this PC, even after a restart. It includes AnxNet, the private network for playing with friends, which stays off until you join one."
    Pop $0
    ${NSD_CreateLabel} 12u 74u -12u 28u "Windows will ask for administrator approval so the Helper can start when you sign in. Setup does not change your security settings, firewall or other apps. You can also set the Helper up later in Agent Control."
    Pop $0
    ${If} $anxIsUpgrade == 1
      ${NSD_CreateLabel} 0 110u 100% 10u "Your servers, settings, backups and paired computers are kept."
      Pop $0
    ${EndIf}
    ${If} $anxHelperWasInstalled == 1
      ${NSD_CreateLabel} 0 122u 100% 10u "The AnxHost Helper is already set up on this PC and is kept."
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
    ; Already set up on this PC: kept (the box is shown ticked and disabled).
    ${If} $anxHelperWasInstalled == 1
      StrCpy $anxSetupHelper 1
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE anxWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "$anxWelcomeTitle"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
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
  BrandingText "AnxHost Control Center by AnxLabs"
!macroend

!macro customInstall
  !insertmacro anxStatus "registered"
  ; Recorded for the next Setup, which uses it to tell an update from a repair
  ; (electron-builder removes this key on uninstall).
  ${If} "${ANX_BUILD}" != ""
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" AnxHostBuild "${ANX_BUILD}"
  ${EndIf}
  ${If} $anxSetupHelper == "0"
    DetailPrint "AnxHost Helper not set up. You can set it up later in Agent Control."
    !insertmacro anxStatus "helper-skipped"
  ${Else}
    ReadEnvStr $1 "USERDOMAIN"
    ReadEnvStr $2 "USERNAME"
    DetailPrint "Setting up the AnxHost Helper. Windows may ask for administrator approval..."
    !insertmacro anxStatus "helper-begin"
    ; Until the Helper is registered, this file tells the app to offer
    ; "Restore AnxHost Helper" (for example after a declined prompt).
    FileOpen $6 "$INSTDIR\resources\helper-restore-needed.json" w
    FileWrite $6 '{"reason":"setup"}'
    FileClose $6
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Install -UserId "$1\$2"'
    Pop $0
    Pop $3
    !insertmacro anxStatus "helper $0"
    ${If} $0 == 0
      Delete "$INSTDIR\resources\helper-restore-needed.json"
    ${EndIf}
    ${If} $0 != 0
      ; nsExec leaves a number (the script's exit code), "error" or "timeout".
      ; If the plugin itself could not load (for example Windows Smart App
      ; Control refusing an unsigned plugin), the command line is still on
      ; the stack and lands in $0; never show that as an error code.
      StrLen $5 $0
      ${If} $0 == "1223"
        StrCpy $4 "Administrator approval was not given, so the AnxHost Helper was not set up."
      ${ElseIf} $5 > 12
        StrCpy $4 "The AnxHost Helper could not be set up because its setup step could not run (Windows security may have blocked it)."
      ${Else}
        StrCpy $4 "The AnxHost Helper could not be confirmed started (code $0)."
      ${EndIf}
      DetailPrint "$4"
      ; The app itself is installed and works; the Helper can be repaired
      ; from inside it. /SD IDOK: a silent install (AnxHost Setup) must not
      ; wait for a click; Setup shows its own message for exit code 3.
      MessageBox MB_ICONEXCLAMATION "AnxHost Control Center is installed. $4$\r$\n$\r$\nTo finish, open the app and select Restore AnxHost Helper in its notification, or run Setup again." /SD IDOK
      ; Automated installs still see that something needs attention.
      SetErrorLevel 3
    ${EndIf}
  ${EndIf}
  !insertmacro anxStatus "done"
!macroend

; An interactive uninstall (Settings > Apps) shows AnxHost Setup's uninstall
; window instead of these pages: the installed copy of Setup is started and
; this uninstaller ends. Setup then runs this uninstaller silently (/S), so the
; handoff never repeats. Silent uninstalls and the --updated uninstall an
; upgrade runs are never handed off, and /ANXNOHANDOFF (Setup's own fallback
; when WebView2 is missing) keeps these pages.
!macro customUnInit
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/ANXNOHANDOFF" $R1
    ${If} ${Errors}
    ${AndIf} ${FileExists} "$INSTDIR\resources\AnxHost Setup.exe"
      ClearErrors
      Exec '"$INSTDIR\resources\AnxHost Setup.exe" --uninstall'
      ${IfNot} ${Errors}
        Quit
      ${EndIf}
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall AnxHost Control Center"
  !define MUI_WELCOMEPAGE_TEXT "This removes the app and the AnxHost Helper from this PC.$\r$\n$\r$\nYour servers, worlds, backups, settings and paired computers are kept, so installing again picks up where you left off. Servers on other computers are not affected.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUnInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  ${if} ${isUpdated}
    ; An update runs this (the installed) uninstaller before copying the new
    ; files. The running Helper must stop so its files can be replaced, but
    ; its startup task is kept: the new install starts it again, and a
    ; declined prompt, an unticked Helper or /NOHELPER must not remove a
    ; Helper that worked before the update.
    DetailPrint "Stopping the AnxHost Helper for the update..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Stop -UserId "$1\$2"'
  ${else}
    DetailPrint "Removing the AnxHost Helper startup task..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Uninstall -UserId "$1\$2"'
  ${endif}
!macroend
