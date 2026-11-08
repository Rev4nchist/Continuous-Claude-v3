# Shared helpers for start-fleet.ps1, stop-fleet.ps1 and install-fleet-shortcut.ps1.
# The Fleet app is apps/agentic-os (Next.js). A Fleet process is a node.exe whose command line holds the app folder.

function Get-FleetAppDir([string]$AppDir) {
  if ($AppDir) { return (Resolve-Path -LiteralPath $AppDir).Path }
  $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  return (Join-Path $root 'apps\agentic-os')
}

function Get-FleetStateDir([string]$StateDir) {
  if ($StateDir) { $d = $StateDir } else { $d = Join-Path $env:USERPROFILE '.claude\state\fleet-app' }
  New-Item -ItemType Directory -Force $d | Out-Null
  return $d
}

function Get-PortOwnerPid([int]$Port) {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

function Get-ProcInfo([int]$ProcId) {
  if ($ProcId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
}

# True when the process is a node.exe that runs a file inside the Fleet app folder.
function Test-IsFleetProcess($Proc, [string]$AppDir) {
  if (-not $Proc) { return $false }
  if ($Proc.Name -ne 'node.exe') { return $false }
  $cmd = [string]$Proc.CommandLine
  return $cmd.IndexOf($AppDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

# The port owner plus its Fleet ancestors (stop at the first process that is not Fleet) plus all their descendants.
function Get-FleetProcessSet([int]$OwnerPid, [string]$AppDir) {
  $set = New-Object System.Collections.Generic.List[int]
  $cur = Get-ProcInfo $OwnerPid
  if (-not (Test-IsFleetProcess $cur $AppDir)) { return @() }
  $root = $cur
  while ($true) {
    $parent = Get-ProcInfo ([int]$root.ParentProcessId)
    if (Test-IsFleetProcess $parent $AppDir) { $root = $parent } else { break }
  }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue([int]$root.ProcessId)
  while ($queue.Count -gt 0) {
    $id = [int]$queue.Dequeue()
    if ($set.Contains($id)) { continue }
    $set.Add($id)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue |
      ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }
  }
  return $set.ToArray()
}

function Wait-PortFree([int]$Port, [int]$Seconds) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    if ((Get-PortOwnerPid $Port) -eq 0) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return ((Get-PortOwnerPid $Port) -eq 0)
}
