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
# Deletes stay under $env:USERPROFILE\.claude. The backup is a sibling copy
# ($env:USERPROFILE\.claude.bak-ccv3-2-<yyyyMMdd-HHmmss>, plus -1, -2, ... if
# that name already exists). A rerun never copies into the previous backup.
# skills\fourth-* is left in place (CCV3-4).
# The leftover scan covers the install folders the sync owns. It does not
# walk projects\, plugins\, or file-history.

$ErrorActionPreference = 'Stop'
$C = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude'))
if (-not (Test-Path -LiteralPath $C)) { throw "No install at $C" }
$prefix = $C.TrimEnd('\') + '\'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$C.bak-ccv3-2-$stamp"
$n = 1
while (Test-Path -LiteralPath $bak) {
  $bak = "$C.bak-ccv3-2-$stamp-$n"
  $n++
}
if ($bak.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to place backup inside the install: $bak"
}
Copy-Item -LiteralPath $C -Destination $bak -Recurse
"backup $bak"

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

$settings = Join-Path $C 'settings.json'
if (Test-Path -LiteralPath $settings) {
  foreach ($shim in $shims) {
    if (Select-String -LiteralPath $settings -Pattern $shim -SimpleMatch -Quiet) {
      throw "settings.json still references $shim"
    }
  }
}

foreach ($rel in $stale) {
  $p = Join-Path $C $rel
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
$left = @()
foreach ($dir in $scanRoots) {
  $root = Join-Path $C $dir
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $left += @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    $full = $_.FullName
    if ($full.Length -lt $prefix.Length) { return $false }
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $tail = $full.Substring($C.Length)
    if ($tail -match '\\skills\\fourth-') { return $false }
    $_.Name -match 'codex' -or $full -match '\\_snapshots\\|\\_archive\\' -or $_.Name -match '\.pptx$|\.potx$'
  })
}
"leftovers: $($left.Count)"
if ($left.Count -ne 0) {
  $left | ForEach-Object { $_.FullName }
  throw "leftovers $($left.Count)"
}
"commands: $((Get-ChildItem -LiteralPath (Join-Path $C 'commands') -File -ErrorAction SilentlyContinue).Count)"
