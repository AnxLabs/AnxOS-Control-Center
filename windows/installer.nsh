!macro customInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  DetailPrint "Configuring elevated AnxOS Agent startup..."
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Install -UserId "$1\$2"'
  Pop $0
  Pop $3
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "AnxOS Control Center was installed, but the Local Agent could not be confirmed started (code $0).$\r$\n$\r$\nLaunch AnxOS Control Center from the Start menu, open Agent Connection, and select Repair Local Agent. You can also re-run this installer."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  DetailPrint "Removing AnxOS Agent startup..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Uninstall -UserId "$1\$2"'
!macroend
