<#
.SYNOPSIS
  Shared account-resolution logic for the GitHub dual-account tooling.

.WHY
  gh-for.ps1 and git-for.ps1 each carried their own copy of Resolve-AccountConfig,
  Expand-HomePath and the owner -> account mapping. The copies were already
  diverging: gh-for's threw a different message for an unmapped owner, and only
  git-for's rejected a non-github remote. A third consumer (the gh shim) would
  have made it three copies of a mapping whose whole point is to be the single
  source of truth alongside accounts.json.

  What is NOT shared, deliberately: WHICH remote to read. gh operates on "the
  repo", so gh-for resolves from origin and falls back to a route prefix when
  there is no remote at all. git contacts a SPECIFIC remote, so git-for resolves
  from that remote and refuses to guess. That difference is the design (see the
  DESIGN NOTE in git-for.ps1), not duplication -- so each caller still decides
  the URL and hands it here.

  Dot-source it:  . (Join-Path $PSScriptRoot 'accounts-lib.ps1')
#>

function Get-AccountsConfig {
  $cfgPath = Join-Path $PSScriptRoot 'accounts.json'
  if (-not (Test-Path $cfgPath)) { throw "missing $cfgPath" }
  Get-Content $cfgPath -Raw | ConvertFrom-Json
}

function Expand-HomePath([string]$p) {
  if ($p -like '~*') { return (Join-Path $HOME $p.Substring(1).TrimStart('/', '\')) }
  return $p
}

<# Pull the owner out of any github.com remote URL, https or ssh. Returns $null
   for a non-github remote so the caller can decide whether that is fatal. #>
function Get-OwnerFromUrl([string]$url) {
  if ($url -and $url -match 'github\.com[:/]([^/]+)/') { return $Matches[1] }
  return $null
}

<# Validate a resolved account name against accounts.json. Both failure modes
   here are configuration errors that must stop the run rather than fall back to
   a guess -- guessing an identity is the silent failure this design exists to
   prevent. #>
function Get-AccountByName($cfg, [string]$name) {
  $acct = $cfg.accounts.$name
  if (-not $acct) { throw "resolved account '$name' is not defined in accounts.json" }
  if ($acct.user -like 'TBD-*') { throw "account '$name' is still a placeholder (user = $($acct.user)). Fill in accounts.json first." }
  return $acct
}

<# authByOwner, with the _default catch-all. #>
function Get-AccountNameForOwner($cfg, [string]$owner) {
  $name = $cfg.authByOwner.$owner
  if (-not $name) { $name = $cfg.authByOwner._default }
  if (-not $name) { throw "no account maps to owner '$owner' and no _default is set in accounts.json" }
  return $name
}

<# Longest-matching route prefix. Routes decide COMMIT IDENTITY; they are used
   for AUTH only as the fallback for a directory with no remote yet, e.g. the
   reserved Projects/fourth/ root. Compared case-insensitively with forward
   slashes, because Windows hands you both spellings. #>
function Get-AccountNameForPath($cfg, [string]$forPath) {
  $norm = ($forPath -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
  $name = $null
  $bestLen = -1
  foreach ($r in $cfg.routes) {
    $p = ($r.prefix -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
    if ($norm -eq $p -or $norm.StartsWith($p + '/')) {
      if ($p.Length -gt $bestLen) { $bestLen = $p.Length; $name = $r.commitAccount }
    }
  }
  return $name
}

<# gh-for's resolution: the repo's own remote, else a route prefix. #>
function Resolve-AccountByPath($cfg, [string]$forPath) {
  $url = (& git -C $forPath remote get-url origin 2>$null)
  if (-not $url) { $url = (& git -C $forPath remote get-url --all 2>$null | Select-Object -First 1) }
  $owner = Get-OwnerFromUrl $url

  $name = $null
  $why = $null
  if ($owner) {
    $name = Get-AccountNameForOwner $cfg $owner
    $why = "remote owner '$owner'"
  } else {
    $name = Get-AccountNameForPath $cfg $forPath
    $why = "no remote; longest matching route prefix"
  }

  if (-not $name) { throw "cannot determine an account for '$forPath' (no remote, no matching route). Add a route to accounts.json -- guessing is exactly the silent failure this design exists to prevent." }
  return [pscustomobject]@{ Name = $name; Config = (Get-AccountByName $cfg $name); Why = $why }
}

<# git-for's resolution: a SPECIFIC named remote, no route fallback. #>
function Resolve-AccountByRemote($cfg, [string]$forPath, [string]$remoteName) {
  $url = (& git -C $forPath remote get-url $remoteName 2>$null)
  if (-not $url) { throw "remote '$remoteName' has no URL in '$forPath'" }

  $owner = Get-OwnerFromUrl $url
  if (-not $owner) { throw "remote '$remoteName' ($url) is not a github.com remote -- this wrapper only routes GitHub credentials." }

  $name = Get-AccountNameForOwner $cfg $owner
  return [pscustomobject]@{ Name = $name; Config = (Get-AccountByName $cfg $name); Owner = $owner; Url = $url }
}
