# The person's own tailnet setting under a standard Windows account (docs/it/tailnet-policy.md,
# "Without an administrator"; ADR 0008, point 6). On a Windows runner, whose own account is an
# administrator, it creates a local account outside Administrators, runs the documented file
# docs/it/lazurio-app-tailnets.cmd as that account, the way a double-click runs it, and reads the
# value back with the app's tailnet helper as that account (read-user-setting, as the packaged app
# does at its start). It then removes the account and its profile. No step asks for elevation.
#
#   standard-account-setting.ps1 <lazurio-tailnet.exe> <lazurio-app-tailnets.cmd>
param(
  [Parameter(Mandatory = $true)][string]$Helper,
  [Parameter(Mandatory = $true)][string]$Template
)
$ErrorActionPreference = 'Stop'
$Helper = (Resolve-Path $Helper).Path
$Template = (Resolve-Path $Template).Path

$expected = '[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]'
$name = 'lazurio-std-' + (Get-Random -Maximum 99999)
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = 'Aa1!' + [Convert]::ToBase64String($bytes)
$password = ConvertTo-SecureString $plain -AsPlainText -Force
$work = Join-Path $env:PUBLIC "lazurio-standard-trial-$name"

function Run-As([string]$File, [string[]]$Arguments, [string]$Output) {
  $credential = New-Object System.Management.Automation.PSCredential(".\$name", $password)
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -Credential $credential `
    -LoadUserProfile -WorkingDirectory $work -RedirectStandardOutput $Output `
    -RedirectStandardInput (Join-Path $work 'empty.txt') -WindowStyle Hidden -Wait -PassThru
  return $process.ExitCode
}

New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
try {
  Add-LocalGroupMember -Group 'Users' -Member $name -ErrorAction SilentlyContinue
  $administrators = Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.Name }
  if ($administrators -match "\\$name$") { throw "$name is an administrator" }
  Write-Host "Standard account $name, not in Administrators."

  # The account reads its files from a folder it may read, outside the runner's workspace.
  New-Item -ItemType Directory -Path $work | Out-Null
  Set-Content -Path (Join-Path $work 'empty.txt') -Value '' -NoNewline
  Copy-Item $Helper (Join-Path $work 'lazurio-tailnet.exe')
  $file = Join-Path $work 'lazurio-app-tailnets.cmd'
  $text = (Get-Content -Raw $Template).Replace('<tailnet>', 'org').Replace('<control-server>', 'headscale.org.lazurio.io').Replace('<domain>', 'org.lazurio.io')
  Set-Content -Path $file -Value $text -NoNewline -Encoding ascii
  icacls $work /grant "${name}:(OI)(CI)RX" | Out-Null

  # The documented file, as the standard account: reg add on its own HKCU, unelevated.
  $written = Run-As "$env:SystemRoot\System32\cmd.exe" @('/d', '/c', "`"$file`"") (Join-Path $work 'cmd.txt')
  Write-Host (Get-Content -Raw (Join-Path $work 'cmd.txt'))
  if ($written -ne 0) { throw "the documented file ended with $written" }

  # The app's helper, as the same account, reads exactly that value.
  $read = Run-As (Join-Path $work 'lazurio-tailnet.exe') @('read-user-setting') (Join-Path $work 'read.txt')
  $value = Get-Content -Raw (Join-Path $work 'read.txt')
  if ($read -ne 0) { throw "read-user-setting ended with $read" }
  if ($value -ne $expected) { throw "read-user-setting gave '$value', want '$expected'" }
  Write-Host "The standard account's own HKCU holds the setting, and the helper reads it."

  # The runner's own account, an administrator, got nothing: the value is the standard account's.
  & "$env:SystemRoot\System32\reg.exe" query 'HKCU\Software\Lazurio' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "the runner's own HKCU has a Lazurio key" }
  Write-Host 'The runner account has no such value.'
}
finally {
  $sid = (Get-LocalUser -Name $name).SID.Value
  Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Remove-CimInstance -ErrorAction SilentlyContinue
  Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
