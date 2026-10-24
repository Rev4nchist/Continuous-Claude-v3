# Prune a stale ~/.claude install after a full sync.
# Run this on the machine that holds the install (rog-strix), after
# scripts/sync-to-active.sh with no --changed flag.
# --changed deletes removed agents, skills, scripts, docs, rules-ondemand,
# and hook files, but it does not delete old .claude/commands/* (that case
# was removed). A full sync copies the current tree; this script deletes
# paths the sync no longer owns.
#
# Idempotent: a missing path is skipped. A second run deletes nothing and
# still reports leftovers: 0.
# Deletes stay under $env:USERPROFILE\.claude.
# Backup name: $env:USERPROFILE\.claude.bak-prune-<yyyyMMdd-HHmmss>[-n]
# (a sibling of the install, never inside it). Backups are never auto-deleted.
# A backup is created only when at least one path will be removed and every
# settings shim pre-check passed. Otherwise the script prints
# `backup: none (<reason>)` and creates nothing.
# The script prints the count of existing .claude.bak-* siblings.
# skills\fourth-* is left in place (CCV3-4).
# skills\synced\<id>\ is the Claude app's skill sync, not the installer.
# A leftover-shaped file there is reported as managed-sync. It is not
# deleted and it does not fail the run.
# The leftover scan covers the install folders the sync owns. It does not
# walk projects\, plugins\, or file-history. It skips node_modules under every
# scan root (rog-strix: third-party package files were false positives) and
# prints `excluded: <n> paths (<dirs>)`. Other vendor directories are not
# skipped: this install had no evidence for them. Paths outside those trees
# still fail the run.
# Planned removals and the settings shim pre-check run before any backup.
# A shim name still present in settings.json or settings.local.json aborts
# the script with no backup.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/prune-managed-sync.ps1')
$C = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude'))
if (-not (Test-Path -LiteralPath $C)) { throw "No install at $C" }
$sep = [System.IO.Path]::DirectorySeparatorChar
$prefix = $C.TrimEnd('\', '/') + $sep

function Resolve-InstallPath([string]$Rel) {
  $p = $C
  foreach ($part in ($Rel -split '[\\/]')) {
    if ($part -eq '') { continue }
    $p = Join-Path $p $part
  }
  return $p
}

function Get-BackupSiblingCount {
  $parent = Split-Path -Parent $C
  return @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.claude.bak-*' }).Count
}

$shims = @(
  'arch-context-inject.sh',
  'compiler-in-the-loop-stop.sh',
  'compiler-in-the-loop.sh',
  'edit-context-inject.sh',
  'epistemic-reminder.sh',
  'explore-to-scout.sh',
  'file-claims.sh',
  'impact-refactor.sh',
  'import-error-detector.sh',
  'import-validator.sh',
  'memory-awareness.sh',
  'no-haiku-enforcer.sh',
  'path-rules.sh',
  'persist-project-dir.sh',
  'post-edit-diagnostics.sh',
  'post-edit-notify.sh',
  'pre-tool-use-broadcast.sh',
  'session-start-dead-code.sh',
  'session-start-tldr-cache.sh',
  'session-start-tree-daemon.sh',
  'signature-helper.sh',
  'smart-search-router.sh',
  'tldr-context-inject.sh'
)

$stale = @(
  'agents\codex-worker.md',
  'agents\codex-adversary.md',
  'scripts\codex',
  'rules-ondemand\codex-worker-safety.md',
  'rules-ondemand\codex-adversarial.md',
  'skills\codex',
  'skills\codex-adversary',
  'skills\impeccable\reference\codex.md',
  'skills\_eval',
  'skills\_eval-progress.json',
  'skills\_parse-validation.js',
  'skills\ebr-data-prep.skill',
  'skills\notion-bridge\notion-bridge',
  'skills\neonctl\neonctl',
  'skills\railway-cli\railway-cli',
  'skills\commit\SKILL.v6.md',
  'skills\create_handoff\SKILL.v6.md',
  'skills\plan-agent\SKILL.v6.md',
  'docs\_archived\2026-04-27-vintage-overviews',
  'hooks\dist\daemon-client.mjs',
  'hooks\dist\transcript-parser.mjs',
  'commands\chats.md',
  'commands\dangerous.md',
  'commands\git.md',
  'commands\shared',
  'commands\skip.md',
  'commands\spawn-dangerous.md',
  'commands\task.md'
) + @($shims | ForEach-Object { "hooks\$_" })

$toRemove = @()
foreach ($rel in $stale) {
  $p = Resolve-InstallPath $rel
  $fp = [System.IO.Path]::GetFullPath($p)
  if (-not $fp.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch $fp"
  }
  if (Test-Path -LiteralPath $p) { $toRemove += $rel }
}

$precheckFailed = $null
foreach ($settingsName in @('settings.json', 'settings.local.json')) {
  $settings = Join-Path $C $settingsName
  if (Test-Path -LiteralPath $settings) {
    foreach ($shim in $shims) {
      if (Select-String -LiteralPath $settings -Pattern $shim -SimpleMatch -Quiet) {
        $precheckFailed = "$settingsName still references $shim"
        break
      }
    }
  }
  if ($precheckFailed) { break }
}

if ($precheckFailed) {
  "existing .claude.bak-*: $(Get-BackupSiblingCount)"
  "backup: none ($precheckFailed)"
  throw $precheckFailed
}

if ($toRemove.Count -lt 1) {
  "existing .claude.bak-*: $(Get-BackupSiblingCount)"
  "backup: none (nothing to remove)"
} else {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = "$C.bak-prune-$stamp"
  $n = 1
  while (Test-Path -LiteralPath $bak) {
    $bak = "$C.bak-prune-$stamp-$n"
    $n++
  }
  if ($bak.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to place backup inside the install: $bak"
  }
  Copy-Item -LiteralPath $C -Destination $bak -Recurse
  "existing .claude.bak-*: $(Get-BackupSiblingCount)"
  "backup $bak"
}

foreach ($rel in $toRemove) {
  $p = Resolve-InstallPath $rel
  $fp = [System.IO.Path]::GetFullPath($p)
  if (-not $fp.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch $fp"
  }
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Recurse -Force
    "removed $rel"
  }
}

$scanRoots = @(
  'agents',
  'commands',
  'docs',
  'hooks',
  'rules',
  'rules-ondemand',
  'scripts',
  'skills'
)
# node_modules only. .venv stays in the scan until a run shows it causes false positives.
$vendorNames = @('node_modules')
$left = @()
$vendorTotal = 0
$excludedMatches = @()
$managedSync = @()
$excludedDirs = [System.Collections.Generic.List[string]]::new()
foreach ($dir in $scanRoots) {
  $root = Join-Path $C $dir
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue)) {
    $full = $item.FullName
    if ($full.Length -lt $prefix.Length) { continue }
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $tail = $full.Substring($C.Length) -replace '\\', '/'
    $vendorHit = $false
    foreach ($vendor in $vendorNames) {
      $vendorPattern = '/' + [regex]::Escape($vendor) + '(/|$)'
      if ($tail -match $vendorPattern) {
        $vendorHit = $true
        if (-not $excludedDirs.Contains($vendor)) { $excludedDirs.Add($vendor) }
        break
      }
    }
    $matchesLeft = ($item.Name -match 'codex' -or $tail -match '/_snapshots/|/_archive/' -or $item.Name -match '\.pptx$|\.potx$')
    if ($vendorHit) {
      $vendorTotal++
      if ($matchesLeft) { $excludedMatches += $tail.TrimStart('/') }
      continue
    }
    if (Test-PruneManagedSyncPath $tail) {
      if ($matchesLeft) { $managedSync += $tail.TrimStart('/') }
      continue
    }
    if ($tail -match '/skills/fourth-') { continue }
    if ($matchesLeft) {
      $left += $item
    }
  }
}
$dirList = if ($excludedDirs.Count -gt 0) { $excludedDirs -join ', ' } else { '' }
$pathList = if ($excludedMatches.Count -gt 0) { $excludedMatches -join ', ' } else { '' }
$managedList = if ($managedSync.Count -gt 0) { $managedSync -join ', ' } else { '' }
"excluded: $($excludedMatches.Count) paths ($dirList): $pathList; vendor entries: $vendorTotal"
"managed-sync: $($managedSync.Count) paths (skills/synced; managed by sync, not ours): $managedList"
"leftovers: $($left.Count)"
if ($left.Count -ne 0) {
  $left | ForEach-Object { $_.FullName }
  throw "leftovers $($left.Count)"
}
"commands: $((Get-ChildItem -LiteralPath (Join-Path $C 'commands') -File -ErrorAction SilentlyContinue).Count)"
