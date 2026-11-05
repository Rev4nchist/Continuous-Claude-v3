# Stop-ProcessTree.ps1 -- the one approved way to kill a process tree on Windows.
#
# Dot-source it:   . (Join-Path $PSScriptRoot '..\lib\Stop-ProcessTree.ps1')
# Then:            $null = Stop-ProcessTree -RootId $proc.Id
#
# WHY NOT THE OS TREE SWITCH. The kill tool's tree switch resolves the tree by parent id at kill time.
# Process ids are reused on this machine, so it can kill a live peer-session shell that only inherited
# a recycled parent id. See docs/windows/msys-fork-storm-investigation.md. The safe form, used here:
# take ONE snapshot of the process table, walk it, kill leaves first by explicit id, and re-read each
# id's CreationDate right before its kill.
#
# Rules:
#   1. Never kills this shell or any of its ancestors (the protected set). A protected root kills nothing.
#   2. A child counts only if it was born at or after its parent. An older "child" is a reused id: skipped,
#      and its subtree is not walked.
#   3. Leaves first, root last. Each kill is Stop-Process -Id <id> -Force on one id.
#   4. Before each kill the id is read again. Gone or a different CreationDate: no kill.
#   5. Never throws for a missing id. It returns one row per id it considered.
#
# Rows: ProcessId, ParentProcessId, Name, Status, Detail.
#   Status is Killed, Gone, SkippedProtected, SkippedReused, Failed, or WouldKill (see -WhatIf and -Snapshot).
#
# Parameters:
#   -RootId       the root of the tree.
#   -ExcludeRoot  kill the descendants only.
#   -WaitMs       after the kills, wait up to this long for the root to exit (0 = do not wait).
#   -Snapshot     TEST SEAM. Rows of ProcessId, ParentProcessId, CreationDate, Name that replace the process
#                 table. It never kills anything: every id that would die gets Status WouldKill.
#
# PowerShell 5.1 and 7 compatible. ASCII only (powershell.exe 5.1 reads a file with no BOM as CP1252).

function New-SptRow($Id, $ParentId, $Name, $Status, $Detail) {
  [pscustomobject]@{ ProcessId = [int]$Id; ParentProcessId = [int]$ParentId; Name = [string]$Name; Status = $Status; Detail = $Detail }
}

function Get-SptTable {
  @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationDate = $_.CreationDate; Name = [string]$_.Name }
    })
}

# $null when the child is a real child of the parent. Else the reason it is not.
function Get-SptReuseProblem($Child, $Parent) {
  if ($null -eq $Child.CreationDate -or $null -eq $Parent.CreationDate) { return 'creation date unreadable, so the parent link cannot be trusted' }
  if ([datetime]$Child.CreationDate -lt [datetime]$Parent.CreationDate) { return 'older than its parent: the parent id was reused' }
  return $null
}

function Stop-ProcessTree {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][int]$RootId,
    [switch]$ExcludeRoot,
    [int]$WaitMs = 15000,
    [object[]]$Snapshot
  )

  $simulate = $PSBoundParameters.ContainsKey('Snapshot')
  $table = if ($simulate) { @($Snapshot) } else { Get-SptTable }

  $byId = @{}
  $kids = @{}
  foreach ($r in $table) {
    $id = [int]$r.ProcessId
    $parentId = [int]$r.ParentProcessId
    $byId[$id] = $r
    if ($parentId -eq $id) { continue }
    if (-not $kids.ContainsKey($parentId)) { $kids[$parentId] = New-Object System.Collections.ArrayList }
    [void]$kids[$parentId].Add($r)
  }

  # Protected: ids 0 and 4, this shell, and every ancestor of this shell.
  $protected = @{ 0 = $true; 4 = $true }
  $cur = [int]$PID
  while ($cur -gt 0 -and -not $protected.ContainsKey($cur)) {
    $protected[$cur] = $true
    if (-not $byId.ContainsKey($cur)) { break }
    $cur = [int]$byId[$cur].ParentProcessId
  }

  if (-not $byId.ContainsKey($RootId)) {
    return @(New-SptRow $RootId 0 '' 'Gone' 'not in the process table')
  }
  $root = $byId[$RootId]
  if ($protected.ContainsKey($RootId) -and -not $ExcludeRoot) {
    return @(New-SptRow $RootId $root.ParentProcessId $root.Name 'SkippedProtected' 'the root is this shell or one of its ancestors')
  }

  $skipped = New-Object System.Collections.ArrayList
  $plan = New-Object System.Collections.ArrayList
  $seen = @{ $RootId = $true }

  function Add-SptDescendants([int]$ParentId) {
    if (-not $kids.ContainsKey($ParentId)) { return }
    foreach ($kid in $kids[$ParentId]) {
      $id = [int]$kid.ProcessId
      if ($seen.ContainsKey($id)) { continue }
      $seen[$id] = $true
      if ($protected.ContainsKey($id)) {
        [void]$skipped.Add((New-SptRow $id $ParentId $kid.Name 'SkippedProtected' 'this shell or one of its ancestors'))
        continue
      }
      $problem = Get-SptReuseProblem $kid $byId[$ParentId]
      if ($problem) {
        [void]$skipped.Add((New-SptRow $id $ParentId $kid.Name 'SkippedReused' $problem))
        continue
      }
      Add-SptDescendants $id
      [void]$plan.Add($kid)
    }
  }
  Add-SptDescendants $RootId
  if (-not $ExcludeRoot) { [void]$plan.Add($root) }

  $killed = New-Object System.Collections.ArrayList
  $rootKilled = $false
  foreach ($p in $plan) {
    $id = [int]$p.ProcessId
    $row = { param($status, $detail) New-SptRow $id $p.ParentProcessId $p.Name $status $detail }
    if ($simulate -or -not $PSCmdlet.ShouldProcess("$($p.Name) ($id)", 'Stop-Process')) {
      [void]$killed.Add((& $row 'WouldKill' 'planned, nothing was killed'))
      continue
    }
    $now = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (-not $now) { [void]$killed.Add((& $row 'Gone' 'already exited')); continue }
    if ($now.CreationDate -ne $p.CreationDate) { [void]$killed.Add((& $row 'SkippedReused' 'the id now belongs to a newer process')); continue }
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      [void]$killed.Add((& $row 'Killed' ''))
      if ($id -eq $RootId) { $rootKilled = $true }
    } catch {
      $stillThere = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($stillThere) { [void]$killed.Add((& $row 'Failed' "$($_.Exception.Message)")) } else { [void]$killed.Add((& $row 'Gone' 'exited during the kill')) }
    }
  }

  if ($rootKilled -and $WaitMs -gt 0) {
    try { Wait-Process -Id $RootId -Timeout ([math]::Max(1, [int][math]::Ceiling($WaitMs / 1000.0))) -ErrorAction Stop } catch { }
  }

  return @($skipped.ToArray()) + @($killed.ToArray())
}
