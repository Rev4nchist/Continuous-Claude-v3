# Creates two shortcuts: "Fleet" (starts the app and opens its window) and "Fleet - stop".
# Default folder is the Desktop. Run again to refresh them. -Remove deletes both.
param(
  [string]$Dir = '',
  [int]$Port = 3010,
  [string]$AppDir = '',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fleet-app-lib.ps1')

if (-not $Dir) { $Dir = [Environment]::GetFolderPath('Desktop') }
New-Item -ItemType Directory -Force $Dir | Out-Null
$start = Join-Path $PSScriptRoot 'start-fleet.ps1'
$stop = Join-Path $PSScriptRoot 'stop-fleet.ps1'
$pwsh = (Get-Command pwsh.exe).Source
$links = @(
  @{ Name = 'Fleet'; Script = $start },
  @{ Name = 'Fleet - stop'; Script = $stop }
)

$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
  $path = Join-Path $Dir "$($l.Name).lnk"
  if ($Remove) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $path"
    continue
  }
  $extra = ''
  if ($Port -ne 3010) { $extra += " -Port $Port" }
  if ($AppDir) { $extra += " -AppDir `"$((Resolve-Path -LiteralPath $AppDir).Path)`"" }
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $pwsh
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($l.Script)`"$extra"
  $lnk.WorkingDirectory = Split-Path -Parent $l.Script
  $lnk.WindowStyle = 7
  $lnk.Description = "Agentic OS Fleet app: $($l.Name)"
  $lnk.Save()
  Write-Host "Wrote $path"
}
