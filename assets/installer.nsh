; Folio adds $INSTDIR\resources\bin to the user's PATH on first launch so that `folio` works in new terminals.
; On a real uninstall (not an auto-update) remove that entry again. Files are still present at this point.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\bin\remove-path.ps1" "$INSTDIR\resources\bin"'
    Pop $0
  ${endIf}
!macroend
