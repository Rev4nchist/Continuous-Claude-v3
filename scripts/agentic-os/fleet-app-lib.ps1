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

# Windows reuses process ids. ParentProcessId can name a dead parent whose id a new, unrelated process now holds.
# A real parent started before its child. A candidate that started after the child is a reused id: reject it.
function Test-IsRealParent($Parent, $Child) {
  if (-not $Parent -or -not $Child) { return $false }
  return ([datetime]$Parent.CreationDate) -le ([datetime]$Child.CreationDate)
}

# The port owner plus its Fleet ancestors (stop at the first process that is not Fleet) plus all their real descendants.
function Get-FleetProcessSet([int]$OwnerPid, [string]$AppDir) {
  $set = New-Object System.Collections.Generic.List[int]
  $cur = Get-ProcInfo $OwnerPid
  if (-not (Test-IsFleetProcess $cur $AppDir)) { return @() }
  $root = $cur
  $seen = New-Object System.Collections.Generic.HashSet[int]
  [void]$seen.Add([int]$root.ProcessId)
  while ($true) {
    $parent = Get-ProcInfo ([int]$root.ParentProcessId)
    if ((Test-IsFleetProcess $parent $AppDir) -and (Test-IsRealParent $parent $root) -and $seen.Add([int]$parent.ProcessId)) { $root = $parent } else { break }
  }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    if ($set.Contains([int]$p.ProcessId)) { continue }
    $set.Add([int]$p.ProcessId)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$p.ProcessId)" -ErrorAction SilentlyContinue |
      Where-Object { Test-IsRealParent $p $_ } | ForEach-Object { $queue.Enqueue($_) }
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
