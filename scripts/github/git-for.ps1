<#
  git-for.ps1 -- run git with the credential for the account that owns the
  REMOTE being contacted. Sibling of gh-for.ps1, which does the same for `gh`.

  WHY THIS EXISTS
  ---------------
  Git Credential Manager stores ONE credential per host. Its github.com entry is
  host-level and ignores the path, so a personal-namespace repo gets offered the
  company credential and the push fails:

      remote: Permission to Rev4nchist/Continuous-Claude-v3.git denied to david-hayes44.
      fatal: ... The requested URL returned error: 403

  Both accounts being present in GCM makes this worse, not better -- there is no
  tiebreak to appeal to. `credential.useHttpPath` is NOT relied on here: the
  system gitconfig proves it works for dev.azure.com, but that may be a GCM
  Azure-specific special case, and an unverified mechanism is not a fix.

  THE TWO TRAPS, both hit for real on 2026-08-05
  ----------------------------------------------
  1. `-c credential.helper='!f() {...}'` ALONE DOES NOT WORK. Git treats
     credential.helper as a LIST and appends to it, so the globally configured
     `wincred` still runs first and still wins. An empty `-c credential.helper=`
     must come FIRST to clear the list. The failing and passing commands differ
     by exactly that one token, and the failure looks identical to having no
     override at all.
  2. `git push --dry-run` against an up-to-date branch returns exit 0
     "Everything up-to-date" WITHOUT ever exercising write authorization. It
     reads all-clear while credentials are still wrong. Never validate this
     script that way -- push real content.

  DESIGN NOTE -- why the remote matters, and why this differs from gh-for.ps1
  --------------------------------------------------------------------------
  gh-for.ps1 resolves from `origin` because gh operates on "the repo". git push
  operates on a SPECIFIC remote, and in this repo they disagree: origin is the
  parcadei upstream (never pushed to) while fork is Rev4nchist. Resolving from
  origin would pick the wrong credential for `git push fork`. So the remote is
  read from the git arguments, falling back to the branch upstream, then origin.

  The token is passed through an ENVIRONMENT VARIABLE, never through argv, so it
  does not appear in the process list. It is cleared in a finally block.

  USAGE
    pwsh -File scripts/github/git-for.ps1 push fork agentic-os
    pwsh -File scripts/github/git-for.ps1 -WhichAccount push fork agentic-os
    pwsh -File scripts/github/git-for.ps1 -Remote fork push fork HEAD:agentic-os

  Composition: this is the OUTER wrapper. scripts/git-safe.ps1 (MSYS crash
  retry) stays innermost and is used via -UseGitSafe.
#>
# PositionalBinding=$false is LOAD-BEARING. Without it $Path is position 0, so
# `git-for.ps1 push fork agentic-os` binds Path='push' and Remote='fork', and
# the script fails with the baffling "remote 'fork' has no URL in 'push'".
# Same PowerShell binder hazard that made git-safe.ps1 refuse a param() block
# outright; here the named switches are worth keeping, so bind them explicitly
# and let ValueFromRemainingArguments collect every positional.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Path = (Get-Location).Path,
  [string]$Remote,
  [switch]$WhichAccount,
  [switch]$UseGitSafe,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GitArgs
)

$ErrorActionPreference = 'Stop'

if (-not $GitArgs -or $GitArgs.Count -eq 0) {
  Write-Error 'no git arguments given. Example: git-for.ps1 push fork agentic-os'
  exit 2
}

function Resolve-AccountConfig {
  $cfgPath = Join-Path $PSScriptRoot 'accounts.json'
  if (-not (Test-Path $cfgPath)) { throw "missing $cfgPath" }
  Get-Content $cfgPath -Raw | ConvertFrom-Json
}

function Expand-HomePath([string]$p) {
  if ($p -like '~*') { return (Join-Path $HOME $p.Substring(1).TrimStart('/', '\')) }
  return $p
}

# Which remote will git actually contact? Explicit -Remote wins. Otherwise take
# the first argument that names a configured remote (covers `push fork branch`,
# `fetch fork`, `pull fork main`). Then the current branch's upstream. Then
# origin. Guessing is avoided: if none of these resolve, we say so and stop.
function Resolve-Remote([string]$forPath, [string[]]$gitArgs, [string]$explicit) {
  if ($explicit) { return $explicit }

  $configured = @(& git -C $forPath remote 2>$null)
  foreach ($a in $gitArgs) {
    if ($a.StartsWith('-')) { continue }
    if ($configured -contains $a) { return $a }
  }

  $upstream = (& git -C $forPath rev-parse --abbrev-ref '@{upstream}' 2>$null)
  if ($upstream -and $upstream -match '^([^/]+)/') { return $Matches[1] }

  if ($configured -contains 'origin') { return 'origin' }
  throw "cannot determine which remote this command contacts. Pass -Remote explicitly."
}

function Resolve-Account($cfg, [string]$forPath, [string]$remoteName) {
  $url = (& git -C $forPath remote get-url $remoteName 2>$null)
  if (-not $url) { throw "remote '$remoteName' has no URL in '$forPath'" }

  $owner = $null
  if ($url -match 'github\.com[:/]([^/]+)/') { $owner = $Matches[1] }
  if (-not $owner) { throw "remote '$remoteName' ($url) is not a github.com remote -- this wrapper only routes GitHub credentials." }

  $name = $cfg.authByOwner.$owner
  if (-not $name) { $name = $cfg.authByOwner._default }
  if (-not $name) { throw "no account maps to owner '$owner' and no _default is set in accounts.json" }

  $acct = $cfg.accounts.$name
  if (-not $acct) { throw "resolved account '$name' is not defined in accounts.json" }
  if ($acct.user -like 'TBD-*') { throw "account '$name' is still a placeholder (user = $($acct.user)). Fill in accounts.json first." }

  return [pscustomobject]@{ Name = $name; Config = $acct; Owner = $owner; Url = $url }
}

$cfg = Resolve-AccountConfig
$remoteName = Resolve-Remote $Path $GitArgs $Remote
$resolved = Resolve-Account $cfg $Path $remoteName
$ghDir = Expand-HomePath $resolved.Config.ghConfigDir

if ($WhichAccount) {
  [pscustomobject]@{
    path        = $Path
    remote      = $remoteName
    remoteUrl   = $resolved.Url
    owner       = $resolved.Owner
    authAccount = $resolved.Name
    authUser    = $resolved.Config.user
    ghConfigDir = $ghDir
    configExists = (Test-Path $ghDir)
  } | Format-List
  exit 0
}

if (-not (Test-Path $ghDir)) {
  Write-Error "gh config dir '$ghDir' does not exist -- run: GH_CONFIG_DIR=$ghDir gh auth login"
  exit 1
}

# Read the token from THAT account's gh config. Ambient tokens are cleared first
# because GH_TOKEN > GITHUB_TOKEN > stored credentials, so a stray env var would
# silently override the account selection -- the same precedence trap gh-for.ps1
# guards against.
$savedGhConfigDir = $env:GH_CONFIG_DIR
$savedGhToken     = $env:GH_TOKEN
$savedGithubToken = $env:GITHUB_TOKEN
$token = $null
try {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  $env:GH_CONFIG_DIR = $ghDir
  $token = (& gh auth token 2>$null)
  if ($token) { $token = $token.Trim() }
} finally {
  $env:GH_CONFIG_DIR = $savedGhConfigDir
  if ($savedGhToken)     { $env:GH_TOKEN = $savedGhToken }
  if ($savedGithubToken) { $env:GITHUB_TOKEN = $savedGithubToken }
}

if (-not $token) {
  Write-Error "no token in '$ghDir' for account '$($resolved.Name)' -- run: GH_CONFIG_DIR=$ghDir gh auth login"
  exit 1
}

# Token travels in the environment, never in argv. The helper is a literal
# single-quoted string so PowerShell does not interpolate it; sh expands
# $GIT_FOR_TOKEN at credential time inside git's own helper invocation.
$helper = '!f() { echo username=' + $resolved.Config.user + '; echo "password=$GIT_FOR_TOKEN"; }; f'

# `-c credential.helper=` FIRST clears the inherited list. See trap 1 above.
# Without it the configured wincred helper answers first and this whole wrapper
# is a no-op that fails exactly like doing nothing.
$prefix = @('-c', 'credential.helper=', '-c', "credential.helper=$helper")

try {
  $env:GIT_FOR_TOKEN = $token
  if ($UseGitSafe) {
    $safe = Join-Path (Split-Path $PSScriptRoot -Parent) 'git-safe.ps1'
    & pwsh -File $safe @prefix @GitArgs
  } else {
    & git @prefix @GitArgs
  }
  $code = $LASTEXITCODE
} finally {
  $token = $null
  Remove-Item Env:GIT_FOR_TOKEN -ErrorAction SilentlyContinue
}

exit $code
