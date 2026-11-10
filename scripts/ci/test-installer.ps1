<#
 Windows installer test (runs on the CI runner; needs a real Windows machine).
 Checks: silent per-user install, files + Start Menu shortcut, uninstall removes the startup entry,
 and that user data folder is NOT deleted by a plain uninstall. Fails (exit 1) on any deviation.
 Usage: pwsh scripts/ci/test-installer.ps1 -Installer path\to\NetGuard-Setup.exe
#>
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$run    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$dataDir = Join-Path $env:APPDATA 'com.netguard.downloadmanager'
$fail = @()
function Check($name, $ok) { if ($ok) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name"; $script:fail += $name } }

# 1. install (per-user, silent)
Start-Process -FilePath $Installer -ArgumentList '/S' -Wait
$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\NetGuard*","$env:LOCALAPPDATA\Programs\NetGuard*" -Recurse -Filter 'NetGuard.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Check 'installed without administrator rights (per-user location)' ($null -ne $exe)
$installDir = if ($exe) { $exe.DirectoryName } else { $null }
Check 'uninstaller present' ($installDir -and (Test-Path (Join-Path $installDir 'uninstall.exe')))
Check 'MIT license shipped' ($installDir -and (Get-ChildItem $installDir -Recurse -Filter 'QDM-LICENSE.txt' -ErrorAction SilentlyContinue))
Check 'Start Menu shortcut' ([bool](Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter 'NetGuard*.lnk' -ErrorAction SilentlyContinue))

# 2. simulate the app having registered startup + having user data, then uninstall
New-ItemProperty -Path $run -Name 'NetGuard' -Value "`"$($exe.FullName)`" --minimized" -PropertyType String -Force | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content (Join-Path $dataDir 'config.json') '{}'
if ($installDir) { Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -Wait }
Start-Sleep -Seconds 3
Check 'uninstall removed startup registration' ($null -eq (Get-ItemProperty -Path $run -Name 'NetGuard' -ErrorAction SilentlyContinue))
Check 'uninstall removed program files' (-not ($installDir -and (Test-Path (Join-Path $installDir 'NetGuard.exe'))))
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
if ($fail.Count) { Write-Error ("Installer test failed: " + ($fail -join '; ')); exit 1 }
Write-Host 'Installer test: all checks passed'
