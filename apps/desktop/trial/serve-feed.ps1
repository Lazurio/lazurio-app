# Serves a folder as the update feed of a trial build of Lazurio App (docs/adr/0005, point 9) on
# the loopback only, at http://127.0.0.1:<Port>/, where a trial build looks for its updates. It
# answers GET and HEAD for the files directly in the folder and nothing else. A trial build has no
# blockmap (nsis.differentialPackage false), so no range request is needed.
#
#   pwsh -NoProfile -File serve-feed.ps1 -Root <folder with latest.yml and the installer>
param(
  [string]$Root = $PSScriptRoot,
  [int]$Port = 47123
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Serving $Root on http://127.0.0.1:$Port/"

function Send-Head([System.IO.Stream]$Stream, [string]$Status, [long]$Length) {
  $head = "HTTP/1.1 $Status`r`nContent-Length: $Length`r`nContent-Type: application/octet-stream`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($bytes, 0, $bytes.Length)
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = "$($reader.ReadLine())"
      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq '') { break }
      }
      $parts = $requestLine.Split(' ')
      $method = $parts[0]
      $target = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
      $name = [Uri]::UnescapeDataString($target.Split('?')[0].TrimStart('/'))
      $file = $null
      # Only a plain file name directly in the folder: no separators, no parent.
      if ($name -ne '' -and $name -notmatch '[\\/:]' -and $name -notmatch '\.\.') {
        $candidate = Join-Path $Root $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $file = Get-Item -LiteralPath $candidate }
      }
      if ($null -ne $file -and ($method -eq 'GET' -or $method -eq 'HEAD')) {
        Send-Head $stream '200 OK' $file.Length
        if ($method -eq 'GET') {
          $content = [System.IO.File]::OpenRead($file.FullName)
          try { $content.CopyTo($stream) } finally { $content.Dispose() }
        }
        Write-Host "$method /$name 200"
      } else {
        Send-Head $stream '404 Not Found' 0
        Write-Host "$method /$name 404"
      }
    } catch {
      Write-Host "A request failed: $_"
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
