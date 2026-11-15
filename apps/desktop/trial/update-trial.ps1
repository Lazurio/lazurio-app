# The update test from build N to N+1 on Windows (docs/adr/0005, point 9). It installs N for the
# current user, leaves a marker in the app's data folder, starts N, waits for N's log line that the
# update is ready, closes N's window the way a person does, and waits until N+1 is the installed
# app and has opened the key N sealed with DPAPI (KeystoreCheck.ts). The marker must survive. It
# stops only the processes it started, by their PIDs.
param(
  [Parameter(Mandatory)] [string]$InstallerN,
  [Parameter(Mandatory)] [string]$Feed,
  [Parameter(Mandatory)] [string]$ExpectedVersion,
  [int]$Port = 47123,
  [int]$TimeoutMinutes = 6
)
$ErrorActionPreference = 'Stop'
$log = Join-Path ([System.IO.Path]::GetTempPath()) 'lazurio-app-feed.log'
$server = Start-Process -FilePath (Get-Process -Id $PID).Path -PassThru -NoNewWindow `
  -RedirectStandardOutput $log `
  -ArgumentList @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'serve-feed.ps1'), '-Root', $Feed, '-Port', $Port)

function Wait-Until([scriptblock]$Condition, [string]$What) {
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while (-not (& $Condition)) {
    if ((Get-Date) -gt $deadline) {
      foreach ($file in @($log, (Join-Path ([System.IO.Path]::GetTempPath()) 'lazurio-app-n.log'), (Join-Path ([System.IO.Path]::GetTempPath()) 'lazurio-app-n.err'))) {
        if (Test-Path $file) { Get-Content $file | Write-Host }
      }
      throw "Timed out waiting until $What."
    }
    Start-Sleep -Seconds 2
  }
}

try {
  $install = Start-Process -FilePath $InstallerN -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "The installer of N exited with $($install.ExitCode)." }
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\Lazurio App\Lazurio App.exe'
  $before = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Write-Host "Installed N: $before"
  if ($before -like "$ExpectedVersion*") { throw "N already has the version of N+1." }

  # The data folder is fixed in code (main.ts, DATA_FOLDER).
  $data = Join-Path $env:APPDATA 'Lazurio App'
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  $marker = Join-Path $data 'update-trial-marker.txt'
  Set-Content -LiteralPath $marker -Value 'kept'

  $appLog = Join-Path ([System.IO.Path]::GetTempPath()) 'lazurio-app-n.log'
  $app = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $appLog `
    -RedirectStandardError (Join-Path ([System.IO.Path]::GetTempPath()) 'lazurio-app-n.err')
  Write-Host "Started N, PID $($app.Id)"

  $check = Join-Path $data 'keystore-check.json'
  $checkIs = { param($Version, $Result)
    (Test-Path -LiteralPath $check) -and
      ((Get-Content -LiteralPath $check -Raw) -match ('"version":"' + [regex]::Escape($Version) + '","result":"' + $Result + '"')) }
  Wait-Until { & $checkIs '0.0.1' 'created' } 'N has sealed its check key'
  Write-Host 'N sealed its check key.'

  # Updates.ts logs this line once the update is downloaded, verified and ready to install.
  Wait-Until { (Test-Path -LiteralPath $appLog) -and (Select-String -LiteralPath $appLog -Pattern 'update ready' -Quiet) } 'N has the update ready'
  Write-Host 'N has N+1 ready.'

  # Without /F, taskkill asks the window to close, as a person closing it does. The app then
  # installs the downloaded update and starts N+1.
  & taskkill.exe /PID $app.Id | Write-Host
  Wait-Until { $app.HasExited } 'N has exited'
  Wait-Until { ((Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion) -like "$ExpectedVersion*" } 'N+1 is installed'
  Write-Host "Installed N+1: $((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)"

  Wait-Until { & $checkIs $ExpectedVersion 'opened' } 'N+1 has opened the key N sealed'
  Write-Host 'N+1 opened the key N sealed.'

  if (-not (Test-Path -LiteralPath $marker)) { throw 'The data folder lost its marker in the update.' }
  Write-Host 'The data folder kept its marker.'
  Get-Content $log | Write-Host
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
