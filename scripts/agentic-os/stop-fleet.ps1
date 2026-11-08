# Stops the Fleet app on a port. It stops only processes that run a file inside the Fleet app folder.
# A port held by another program is left alone (exit 2). Exit: 0 stopped or not running, 2 not a Fleet process, 5 port still busy.
param(
  [int]$Port = 3010,
  [string]$AppDir = '',
  [string]$StateDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fleet-app-lib.ps1')

$app = Get-FleetAppDir $AppDir
$state = Get-FleetStateDir $StateDir
$pidFile = Join-Path $state "fleet-app-$Port.pid"

$owner = Get-PortOwnerPid $Port
if ($owner -eq 0) {
  Write-Host "Fleet app is not running on port $Port."
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}
$set = @(Get-FleetProcessSet $owner $app)
if ($set.Count -eq 0) {
  $proc = Get-ProcInfo $owner
  Write-Host "STOPPED: port $Port is held by $($proc.Name) (pid $owner), not by the Fleet app. Nothing was stopped."
  exit 2
}
# Children first, so the parent cannot respawn a worker while we stop it.
[array]::Reverse($set)
foreach ($id in $set) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
if (-not (Wait-PortFree $Port 20)) {
  Write-Host "FAILED: port $Port is still busy after stopping pids $($set -join ', ')."
  exit 5
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Fleet app stopped (pids $($set -join ', ')). Port $Port is free."
exit 0
