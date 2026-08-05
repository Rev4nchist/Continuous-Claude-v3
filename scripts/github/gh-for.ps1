<#
.SYNOPSIS
  Run `gh` as whichever GitHub account owns the directory you are standing in.

.WHY
  gh supports multiple accounts, but only through `gh auth switch`, which flips a
  GLOBAL active account. That fails silently: you open a PR on the company repo
  as your personal account and nothing errors.

  GH_CONFIG_DIR points gh at an entirely separate config directory -- its own
  hosts.yml, its own stored token. Setting it per invocation means the account is
  chosen by WHERE YOU ARE, not by what mode you left the CLI in. There is no
  global state to get wrong.

  gh manages both tokens in its own storage. This script never sees, stores, or
  handles a raw token.

.EXAMPLE
  pwsh -File scripts/github/gh-for.ps1 pr list
  pwsh -File scripts/github/gh-for.ps1 -Path C:\work\repo -- issue list
  pwsh -File scripts/github/gh-for.ps1 -WhichAccount        # just tell me who I'd be

.NOTES
  GH_TOKEN beats GITHUB_TOKEN beats stored credentials. A GITHUB_TOKEN sitting in
  the User environment therefore overrides gh's stored accounts entirely -- which
  is the state this machine was in, and why `gh auth switch` could not work. This
  script clears BOTH for its child process so the config dir is authoritative.
#>
[CmdletBinding()]
param(
  [string]$Path = (Get-Location).Path,
  [switch]$WhichAccount,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GhArgs
)

$ErrorActionPreference = 'Stop'

function Resolve-AccountConfig {
  $cfgPath = Join-Path $PSScriptRoot 'accounts.json'
  if (-not (Test-Path $cfgPath)) { throw "missing $cfgPath" }
  Get-Content $cfgPath -Raw | ConvertFrom-Json
}

function Expand-HomePath([string]$p) {
  if ($p -like '~*') { return (Join-Path $HOME $p.Substring(1).TrimStart('/', '\')) }
  return $p
}

<#
  AUTH is decided by the repo's REMOTE OWNER, not by the route.

  There is no choice here: a repo whose remote is Rev4nchist/foo can only be
  operated on by Rev4nchist. Authenticating as the company account would 404,
  and a lot of Fourth work currently lives in the personal namespace -- so a
  topic-based rule would break exactly the repos it was meant to help.

  Routes decide COMMIT IDENTITY (see apply-commit-identity.ps1). They are used
  here only as the fallback for a directory with no remote yet, e.g. the
  reserved Projects/fourth/ root, where the owner cannot be read.
#>
function Resolve-Account($cfg, [string]$forPath) {
  $owner = $null
  $url = (& git -C $forPath remote get-url origin 2>$null)
  if (-not $url) { $url = (& git -C $forPath remote get-url --all 2>$null | Select-Object -First 1) }
  if ($url -and $url -match 'github\.com[:/]([^/]+)/') { $owner = $Matches[1] }

  $name = $null
  $why = $null
  if ($owner) {
    $mapped = $cfg.authByOwner.$owner
    if (-not $mapped) { $mapped = $cfg.authByOwner._default }
    $name = $mapped
    $why = "remote owner '$owner'"
  } else {
    # No remote -- fall back to the longest matching route prefix.
    $norm = ($forPath -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
    $bestLen = -1
    foreach ($r in $cfg.routes) {
      $p = ($r.prefix -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
      if ($norm -eq $p -or $norm.StartsWith($p + '/')) {
        if ($p.Length -gt $bestLen) { $bestLen = $p.Length; $name = $r.commitAccount }
      }
    }
    $why = "no remote; longest matching route prefix"
  }

  if (-not $name) { throw "cannot determine an account for '$forPath' (no remote, no matching route). Add a route to accounts.json -- guessing is exactly the silent failure this design exists to prevent." }
  $acct = $cfg.accounts.$name
  if (-not $acct) { throw "resolved account '$name' is not defined in accounts.json" }
  if ($acct.user -like 'TBD-*') { throw "account '$name' is still a placeholder (user = $($acct.user)). Fill in accounts.json first." }
  return [pscustomobject]@{ Name = $name; Config = $acct; Why = $why }
}

$cfg = Resolve-AccountConfig
$resolved = Resolve-Account $cfg $Path
$ghDir = Expand-HomePath $resolved.Config.ghConfigDir

if ($WhichAccount) {
  [pscustomobject]@{
    path         = $Path
    authAccount  = $resolved.Name
    authUser     = $resolved.Config.user
    decidedBy    = $resolved.Why
    ghConfigDir  = $ghDir
    configExists = (Test-Path $ghDir)
  } | Format-List
  exit 0
}

if (-not (Test-Path $ghDir)) {
  Write-Error "gh config dir '$ghDir' does not exist. Run: `$env:GH_CONFIG_DIR='$ghDir'; gh auth login"
  exit 1
}

if (-not $GhArgs -or $GhArgs.Count -eq 0) {
  Write-Error "no gh arguments given. Example: gh-for.ps1 pr list"
  exit 2
}

# The child inherits everything EXCEPT the ambient tokens, so the config dir is
# the only thing deciding identity.
$env:GH_CONFIG_DIR = $ghDir
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue

& gh @GhArgs
exit $LASTEXITCODE
