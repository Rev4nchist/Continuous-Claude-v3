<#
.SYNOPSIS
  Contact every GitHub remote read-only and report which account answered.
  This is the gate for the credential-routing change.

.WHY
  "Use git normally for a session and see if the popup comes back" is not a gate
  -- it cannot fail in a bounded way. This can: every repo is probed with
  interactivity disabled, so a credential the helper cannot resolve FAILS
  instead of opening a GUI prompt that blocks forever.

  The hang guard is the same one verify-github-accounts.ps1 uses. Without it a
  Git Credential Manager miss opens a picker and the whole sweep waits on a
  human; that bug already cost one session.

  Read-only: ls-remote only. Never pushes. Note that a successful ls-remote on a
  PUBLIC repo proves nothing about credentials -- only private repos are
  evidence. PRIVATE is reported separately for that reason.
#>
[CmdletBinding()]
param(
  [string[]]$Roots = @(
    '$env:USERPROFILE/Projects',
    '$env:USERPROFILE',
    'C:/agent-arch'
  ),
  [int]$Depth = 3,
  [switch]$OnlyWork
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'accounts-lib.ps1')
$cfg = Get-AccountsConfig

# Set BEFORE the first probe, not after the last one. All three are needed:
# GIT_TERMINAL_PROMPT stops git's own console prompt, GCM_INTERACTIVE stops Git
# Credential Manager's GUI picker, and credential.interactive=false is passed
# per-invocation below. Miss any of them and one unresolvable credential parks
# the sweep on a dialog nobody is watching.
$savedTerminalPrompt = $env:GIT_TERMINAL_PROMPT
$savedGcmInteractive = $env:GCM_INTERACTIVE
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

$seen = [System.Collections.Generic.HashSet[string]]::new()
$results = @()

foreach ($root in $Roots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($g in (Get-ChildItem -Path $root -Filter '.git' -Directory -Force -Depth $Depth -ErrorAction SilentlyContinue)) {
    $repo = $g.Parent.FullName
    if (-not $seen.Add($repo.ToLowerInvariant())) { continue }
    $url = (& git -C $repo remote get-url origin 2>$null)
    $owner = Get-OwnerFromUrl $url
    if (-not $owner) { continue }
    $account = try { Get-AccountNameForOwner $cfg $owner } catch { 'ERROR' }
    if ($OnlyWork -and $account -ne 'work') { continue }

    $out = & git -c credential.interactive=false -C $repo ls-remote --heads origin 2>&1
    $ok = $LASTEXITCODE -eq 0
    $err = if ($ok) { '' } else { (($out | Out-String) -split "`n" | Where-Object { $_ -match 'fatal|error|remote:' } | Select-Object -First 1).Trim() }

    $results += [pscustomobject]@{
      Repo     = $repo -replace '^C:\\Users\\david\.hayes\\', '~\'
      Owner    = $owner
      Expected = $account
      Ok       = $ok
      Detail   = $err
    }
  }
}

$env:GIT_TERMINAL_PROMPT = $savedTerminalPrompt
$env:GCM_INTERACTIVE = $savedGcmInteractive

$results | Sort-Object Ok, Expected, Repo |
  Format-Table Expected, Ok, Owner, Repo, Detail -AutoSize | Out-String -Width 240

$failed = @($results | Where-Object { -not $_.Ok })
""
"remotes probed : $($results.Count)"
"succeeded      : $($results.Count - $failed.Count)"
"FAILED         : $($failed.Count)"
if ($failed.Count) {
  ""
  "A failure here is a credential that did not resolve. 'Repository not found'"
  "is a 404, which on a private repo means the WRONG account answered."
  $failed | Format-Table Expected, Owner, Repo, Detail -AutoSize | Out-String -Width 240
}
exit $failed.Count
