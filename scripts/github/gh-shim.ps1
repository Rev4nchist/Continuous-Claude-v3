<#
.SYNOPSIS
  Make bare `gh` pick its account from the directory you are standing in.

.WHY
  GH_CONFIG_DIR is pinned to gh-personal at User scope, because without a
  default gh has no credential at all. The cost is that a bare `gh` inside a
  fourth/* repo authenticates as personal and 404s on private repos --
  gh-for.ps1 fixes that, but only when you remember to type it.

  This shim removes the remembering. It shadows `gh` with a function that
  resolves the account the same way gh-for.ps1 does, sets GH_CONFIG_DIR for that
  one invocation, and restores the environment afterwards.

.DESIGN
  IN-PROCESS, deliberately. Shelling out to `pwsh -File gh-for.ps1` per call
  would add a process spawn to every gh invocation, and spawn latency on this
  machine is degraded (p50 814-2167ms against a 30-80ms reference). So this
  dot-sources accounts-lib.ps1 -- the SAME resolution code gh-for.ps1 and
  git-for.ps1 use -- rather than reimplementing the owner mapping. A second copy
  of that mapping is exactly the drift this library exists to prevent.

  NEVER THROWS. A shell profile that can throw is a shell that will not start.
  Any resolution failure falls back to the default account and runs gh anyway.

.SCOPE
  A function only affects shells that load a profile. Scripts that invoke `gh`
  directly keep today's behaviour, so this cannot regress an existing pipeline.
  Those should keep using gh-for.ps1 explicitly.

.USAGE
  Dot-source from your profile:
    . "$HOME\continuous-claude\scripts\github\gh-shim.ps1"

  Then:  cd <any repo> ; gh api user --jq .login
  Bypass: `gh.exe ...`  or  Get-Command gh -CommandType Application
#>

# Resolve once at load, not per call. PS 5.1-safe: no ternary, no null-coalescing.
$script:GhShimLib = Join-Path $PSScriptRoot 'accounts-lib.ps1'
if (Test-Path $script:GhShimLib) { . $script:GhShimLib }

$script:GhShimCfg = $null
$script:GhShimCache = @{}
$script:GhShimExe = $null

# The User-scope default, captured once. Anything DIFFERENT in the process
# environment was set deliberately by a caller, and must win over this shim.
#
# This is not hypothetical tidiness -- the first version of this file omitted it
# and immediately broke verify-github-accounts.ps1, which sets GH_CONFIG_DIR
# per account and then calls `gh`. Loaded via the profile, this function
# shadowed gh.exe and re-pointed it at whatever the CURRENT DIRECTORY resolved
# to, so the verifier asked "who is gh-work?" and was answered "Rev4nchist".
# A shim that silently overrides an explicit request is the same wrong-account
# failure the whole dual-account design exists to prevent -- caught only because
# the verifier itself flagged it.
$script:GhShimAmbient = [Environment]::GetEnvironmentVariable('GH_CONFIG_DIR', 'User')

function Get-GhShimExe {
  if ($script:GhShimExe) { return $script:GhShimExe }
  $cmd = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $script:GhShimExe = $cmd.Source }
  return $script:GhShimExe
}

function Resolve-GhShimConfigDir([string]$cwd) {
  # Cache by directory: the same repo resolves to the same account all session,
  # and this runs on every gh call.
  if ($script:GhShimCache.ContainsKey($cwd)) { return $script:GhShimCache[$cwd] }
  $dir = $null
  try {
    if (-not $script:GhShimCfg) { $script:GhShimCfg = Get-AccountsConfig }
    $resolved = Resolve-AccountByPath $script:GhShimCfg $cwd
    $dir = Expand-HomePath $resolved.Config.ghConfigDir
    if (-not (Test-Path $dir)) { $dir = $null }
  } catch {
    $dir = $null   # fall through to the ambient default; never throw
  }
  $script:GhShimCache[$cwd] = $dir
  return $dir
}

function gh {
  $exe = Get-GhShimExe
  if (-not $exe) { Write-Error 'gh is not installed or not on PATH'; return }

  # EXPLICIT BEATS DIRECTORY. A caller that set GH_CONFIG_DIR itself -- gh-for.ps1,
  # verify-github-accounts.ps1, any script pinning an account -- has already
  # answered this question, and answering it again from the cwd would silently
  # contradict them.
  if ($env:GH_CONFIG_DIR -and $env:GH_CONFIG_DIR -ne $script:GhShimAmbient) {
    & $exe @args
    return
  }

  $dir = Resolve-GhShimConfigDir (Get-Location).Path
  if (-not $dir) { & $exe @args; return }

  $savedDir = $env:GH_CONFIG_DIR
  $savedGh = $env:GH_TOKEN
  $savedGithub = $env:GITHUB_TOKEN
  try {
    # GH_TOKEN beats GITHUB_TOKEN beats stored credentials, so an ambient token
    # would silently override the account this just chose. Same precedence trap
    # gh-for.ps1 clears.
    $env:GH_CONFIG_DIR = $dir
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
    & $exe @args
  } finally {
    if ($null -ne $savedDir) { $env:GH_CONFIG_DIR = $savedDir } else { Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $savedGh) { $env:GH_TOKEN = $savedGh }
    if ($null -ne $savedGithub) { $env:GITHUB_TOKEN = $savedGithub }
  }
}

function Get-GhAccount {
  <# Diagnostic: who would `gh` be right here? #>
  $cwd = (Get-Location).Path
  $dir = Resolve-GhShimConfigDir $cwd
  [pscustomobject]@{
    path        = $cwd
    ghConfigDir = if ($dir) { $dir } else { "(default: $env:GH_CONFIG_DIR)" }
    routedBy    = if ($dir) { 'gh-shim' } else { 'ambient GH_CONFIG_DIR' }
  }
}
