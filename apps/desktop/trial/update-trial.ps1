# The update test from build N to N+1 on Windows (docs/adr/0005, point 9). It installs N for the
# current user, leaves a marker in the app's data folder, starts N, waits until N has downloaded
# N+1 from the loopback feed, closes N's window the way a person does, and waits until N+1 is the
# installed app. The marker must survive. It stops only the processes it started, by their PIDs.
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
      if (Test-Path $log) { Get-Content $log | Write-Host }
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

  $app = Start-Process -FilePath $exe -PassThru
  Write-Host "Started N, PID $($app.Id)"

  # electron-updater writes update-info.json into its pending folder once the download passed its
  # SHA-512 check, just before it reports update-downloaded.
  $pending = { Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Directory -Filter '*-updater' -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'pending\update-info.json' } |
      Where-Object { Test-Path -LiteralPath $_ } }
  Wait-Until { $null -ne (& $pending) } 'N has downloaded N+1'
  Write-Host "N downloaded N+1: $(& $pending)"
  # The download's event reaches the updater's state right after the file is written.
  Start-Sleep -Seconds 5

  # Without /F, taskkill asks the window to close, as a person closing it does. The app then
  # installs the downloaded update and starts N+1.
  & taskkill.exe /PID $app.Id | Write-Host
  Wait-Until { $app.HasExited } 'N has exited'
  Wait-Until { ((Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion) -like "$ExpectedVersion*" } 'N+1 is installed'
  Write-Host "Installed N+1: $((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)"

  if (-not (Test-Path -LiteralPath $marker)) { throw 'The data folder lost its marker in the update.' }
  Write-Host 'The data folder kept its marker.'
  Get-Content $log | Write-Host
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
