# Starts the Fleet app (apps/agentic-os, next dev) hidden, waits until it answers, then opens an app-style window.
# Safe to run twice: a running Fleet app is reused. A port held by another program is never touched (exit 2).
# Exit: 0 ok, 2 port held by a non-Fleet program, 3 app folder not ready, 4 app did not answer in time.
param(
  [int]$Port = 3010,
  [string]$AppDir = '',
  [string]$StateDir = '',
  [int]$TimeoutSec = 120,
  [switch]$NoWindow
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fleet-app-lib.ps1')

$app = Get-FleetAppDir $AppDir
$state = Get-FleetStateDir $StateDir
$nextBin = Join-Path $app 'node_modules\next\dist\bin\next'
$url = "http://localhost:$Port"

foreach ($need in @($nextBin, (Join-Path $app 'package.json'), (Join-Path $app '.env.local'))) {
  if (-not (Test-Path -LiteralPath $need)) {
    Write-Host "NOT READY: missing $need"
    Write-Host "Fix: in $app run npm ci (needs .env.local with AGENTIC_OS_DATABASE_URL)."
    exit 3
  }
}

function Open-FleetWindow([string]$Url) {
  $edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  if ($edge) { Start-Process $edge -ArgumentList "--app=$Url"; return }
  if (Test-Path -LiteralPath $chrome) { Start-Process $chrome -ArgumentList "--app=$Url"; return }
  Start-Process $Url
}

$owner = Get-PortOwnerPid $Port
if ($owner -gt 0) {
  $proc = Get-ProcInfo $owner
  if (-not (Test-IsFleetProcess $proc $app)) {
    Write-Host "STOPPED: port $Port is held by $($proc.Name) (pid $owner), not by the Fleet app. Nothing was changed."
    exit 2
  }
  Write-Host "Fleet app already running on $url (pid $owner)."
  if (-not $NoWindow) { Open-FleetWindow $url }
  exit 0
}

$log = Join-Path $state 'fleet-app.log'
$err = Join-Path $state 'fleet-app.err.log'
$node = (Get-Command node.exe).Source
# Start-Process without -Redirect* uses ShellExecute, which passes no inherited handles to the app.
# With -Redirect*, the hidden app inherits the caller's output pipe, and a caller that pipes this script never sees it end.
# --hostname 127.0.0.1: the app answers on this machine only. The default host of next dev is every network interface.
$inner = "`"$node`" `"$nextBin`" dev --port $Port --hostname 127.0.0.1 > `"$log`" 2> `"$err`""
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', "`"$inner`"") `
  -WorkingDirectory $app -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $state "fleet-app-$Port.pid") -Value $p.Id

$until = (Get-Date).AddSeconds($TimeoutSec)
$ok = $false
while ((Get-Date) -lt $until) {
  if ($p.HasExited) { break }
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) {
  Write-Host "FAILED: the Fleet app did not answer on $url within $TimeoutSec s. Log: $err"
  if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -TotalCount 8 | ForEach-Object { Write-Host "  $_" } }
  exit 4
}
Write-Host "Fleet app is up on $url (pid $($p.Id)). Log: $log"
if (-not $NoWindow) { Open-FleetWindow $url }
exit 0
