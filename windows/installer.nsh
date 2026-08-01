!macro customInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  DetailPrint "Configuring elevated AnxOS Agent startup..."
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Install -UserId "$1\$2"'
  Pop $0
  Pop $3
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "AnxOS Agent startup configuration failed (code $0). Installation cannot continue."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  DetailPrint "Removing AnxOS Agent startup..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-agent-task.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Mode Uninstall -UserId "$1\$2"'
!macroend
