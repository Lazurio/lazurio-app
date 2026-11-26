# Trial only (lazurio-app#97): runs the WebAuthn probe in stock Electron 44.10.1, the app's version,
# on this Windows computer, in the signed-in person's session (Windows Hello needs it). It downloads
# Electron's official release, checks its SHA-256 against the release's SHASUMS256.txt, and writes
# the results and two screenshots to %USERPROFILE%\lazurio-webauthn-probe\out. Nothing is installed.
# Usage: powershell -ExecutionPolicy Bypass -File run-windows.ps1 -Ref <commit>
param([Parameter(Mandatory = $true)][string]$Ref)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = Join-Path $env:USERPROFILE 'lazurio-webauthn-probe'
New-Item -ItemType Directory -Force -Path "$dir\app", "$dir\out" | Out-Null
$base = "https://raw.githubusercontent.com/Lazurio/lazurio-app/$Ref/tools/base-trial/webauthn-probe"
foreach ($file in 'main.js', 'package.json') {
  Invoke-WebRequest "$base/$file" -OutFile "$dir\app\$file"
}
$name = 'electron-v44.10.1-win32-x64.zip'
$zip = "$dir\$name"
$release = 'https://github.com/electron/electron/releases/download/v44.10.1'
if (-not (Test-Path $zip)) { Invoke-WebRequest "$release/$name" -OutFile $zip }
$sums = (Invoke-WebRequest "$release/SHASUMS256.txt").Content -split "`n"
$expected = ($sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($name))\s*$" }) -replace '\s.*$', ''
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "Electron's SHA-256 does not match: $actual, expected $expected" }
if (-not (Test-Path "$dir\electron\electron.exe")) { Expand-Archive -Force $zip "$dir\electron" }
Start-Process -Wait -FilePath "$dir\electron\electron.exe" -ArgumentList @(
  "`"$dir\app`"", "--out=`"$dir\out\win-stock.json`"", "--mode=stock", "--shots=`"$dir\out`""
)
Get-Content "$dir\out\win-stock.json"
Get-ChildItem "$dir\out" | Select-Object Name, Length
