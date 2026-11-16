; electron-builder's NSIS hook (nsis.include defaults to build/installer.nsh): a real uninstall
; also removes the updater's cache, a downloaded installer nobody needs once the app is gone
; (Lazurio/lazurio-app#23). An update runs the old version's uninstaller too, with the new
; installer in that cache, so the cache stays then. The data folder always stays (ADR 0005).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\lazurio-app-updater"
  ${endIf}
!macroend
