; NetGuard NSIS hooks (referenced by bundle.windows.nsis.installerHooks).
;
; Startup registration is a per-user value written by the app itself:
;   HKCU\Software\Microsoft\Windows\CurrentVersion\Run  ->  NetGuard
; It must be removed on a real uninstall, but NOT on an upgrade (the upgrade runs the old
; uninstaller silently; removing it there would silently turn the user's setting off).
; User settings/history live in %APPDATA%\com.netguard.downloadmanager and are never touched
; here; Tauri's uninstaller only deletes them if the user ticks "Delete the application data".

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NetGuard"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "NetGuard"
  ${EndIf}
!macroend
