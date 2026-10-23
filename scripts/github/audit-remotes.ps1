<#
.SYNOPSIS
  Enumerate every local git repo, its GitHub remotes, and the account each one
  resolves to. Read-only.

.WHY
  The credential-routing fix rewrites work URLs with a literal prefix
  (url."https://david-hayes44@github.com/fourth/".insteadOf). A literal prefix
  silently misses ssh remotes, git@ forms and case variants -- and a miss is not
  visible until a push fails or, worse, succeeds as the wrong account. So
  enumerate first and prove coverage rather than assuming it.

  MATCHES tells you whether the insteadOf rule would fire. It is only meaningful
  for rows whose owner routes to the work account; a personal repo is covered by
  the default credential username instead.
#>
[CmdletBinding()]
param(
  [string[]]$Roots = @(
    '$env:USERPROFILE/Projects',
    '$env:USERPROFILE',
    'C:/agent-arch'
  ),
  [int]$Depth = 3,
  [string]$RewritePrefix = 'https://github.com/fourth/'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'accounts-lib.ps1')
$cfg = Get-AccountsConfig

$seen = [System.Collections.Generic.HashSet[string]]::new()
$rows = @()

foreach ($root in $Roots) {
  if (-not (Test-Path $root)) { continue }
  # -Depth bounds the walk: a full recursive crawl of the user profile is the
  # quadratic git-crawl pathology already documented on this machine.
  $gitDirs = Get-ChildItem -Path $root -Filter '.git' -Directory -Force -Depth $Depth -ErrorAction SilentlyContinue
  foreach ($g in $gitDirs) {
    $repo = $g.Parent.FullName
    if (-not $seen.Add($repo.ToLowerInvariant())) { continue }
    $names = @(& git -C $repo remote 2>$null)
    if (-not $names) {
      $rows += [pscustomobject]@{ Repo = $repo; Remote = '(none)'; Url = ''; Owner = ''; Account = ''; Matches = '' }
      continue
    }
    foreach ($n in $names) {
      $url = (& git -C $repo remote get-url $n 2>$null)
      $owner = Get-OwnerFromUrl $url
      $account = ''
      if ($owner) {
        try { $account = Get-AccountNameForOwner $cfg $owner } catch { $account = "ERROR: $_" }
      } else {
        $account = '(not github)'
      }
      $rows += [pscustomobject]@{
        Repo    = $repo
        Remote  = $n
        Url     = $url
        Owner   = $owner
        Account = $account
        Matches = if ($url -and $url.StartsWith($RewritePrefix)) { 'yes' } else { 'no' }
      }
    }
  }
}

# Out-String -Width, not Format-Table -Wrap: the console here is narrow enough
# that -Wrap renders a URL one character per line, which is unreadable and hid
# the result the first time this ran.
function Show-Rows($r) {
  $r | Select-Object @{n = 'Account'; e = { $_.Account } },
  @{n = 'Match'; e = { $_.Matches } },
  @{n = 'Remote'; e = { $_.Remote } },
  @{n = 'Url'; e = { $_.Url } },
  @{n = 'Repo'; e = { $_.Repo -replace '^C:\\Users\\david\.hayes\\', '~\' } } |
  Format-Table -AutoSize | Out-String -Width 240
}

Show-Rows ($rows | Where-Object { $_.Account -eq 'work' } | Sort-Object Repo)

$work = @($rows | Where-Object { $_.Account -eq 'work' })
$uncovered = @($work | Where-Object { $_.Matches -ne 'yes' })

"";
"repos scanned          : $($seen.Count)"
"github remotes         : $(@($rows | Where-Object Owner).Count)"
"work-account remotes   : $($work.Count)"
"NOT matched by rewrite : $($uncovered.Count)"
if ($uncovered.Count) {
  ""
  "These work remotes would NOT be rewritten, so they fall back to the default"
  "credential username (personal) once the ambiguous wincred entry is deleted:"
  Show-Rows $uncovered
}
exit 0
