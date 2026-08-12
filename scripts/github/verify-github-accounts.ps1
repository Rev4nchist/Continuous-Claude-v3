<#
.SYNOPSIS
  Verify all FOUR GitHub identity layers independently, per account.

.WHY THIS IS THE REAL DELIVERABLE
  A dual-account setup has four layers that are configured separately and fail
  separately, and three of the four fail SILENTLY -- with the wrong identity, not
  an error:

    1. gh CLI          wrong account opens the PR
    2. git credentials wrong account is authenticated for push
    3. commit identity wrong email is baked into the commit, permanently
    4. github MCP      wrong account for everything Claude Code does via MCP

  Every one of those produces a successful-looking operation attributed to the
  wrong person. You find out days later, in someone else's repo history.

  So this does not ask "did it error". It asks each layer, separately, WHO ARE
  YOU -- and compares the answer to what accounts.json says it should be.

.SAML SSO
  A corporate org that enforces SAML SSO will accept a PAT for `gh api user`
  (that is just your identity) and then 403 on anything touching the org until
  the token is explicitly SSO-authorized. So verifying the token works is NOT
  the same as verifying it works FOR THE ORG. When an ssoOrg is configured this
  probes the org directly and reports that distinct failure by name, because
  "it authenticated fine" is the exact wrong conclusion to draw.

.EXAMPLE
  pwsh -File scripts/github/verify-github-accounts.ps1
  pwsh -File scripts/github/verify-github-accounts.ps1 -Json
#>
[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Continue'
$cfg = Get-Content (Join-Path $PSScriptRoot 'accounts.json') -Raw | ConvertFrom-Json
$findings = @()
$checks = 0
$results = @()

function Expand-HomePath([string]$p) {
  if ($p -like '~*') { return (Join-Path $HOME $p.Substring(1).TrimStart('/', '\')) }
  return $p
}
function Add-Finding($layer, $account, $detail) {
  $script:findings += [pscustomobject]@{ layer = $layer; account = $account; detail = $detail }
}

foreach ($prop in $cfg.accounts.PSObject.Properties) {
  $name = $prop.Name
  $a = $prop.Value
  if ($a.user -like 'TBD-*') {
    Add-Finding 'config' $name "account '$name' is still a placeholder (user = $($a.user)) -- nothing can be verified until accounts.json is filled in"
    continue
  }

  $ghDir = Expand-HomePath $a.ghConfigDir
  $row = [ordered]@{ account = $name; expectedUser = $a.user }

  # --- layer 1: gh CLI identity -----------------------------------------
  $checks++
  if (-not (Test-Path $ghDir)) {
    $row.ghLogin = 'NO CONFIG DIR'
    Add-Finding 'gh' $name "config dir '$ghDir' does not exist. Run: `$env:GH_CONFIG_DIR='$ghDir'; gh auth login"
  } else {
    $prevDir = $env:GH_CONFIG_DIR; $prevGh = $env:GH_TOKEN; $prevGit = $env:GITHUB_TOKEN
    $env:GH_CONFIG_DIR = $ghDir
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
    $login = (& gh api user --jq .login 2>&1) -join ''
    $row.ghLogin = $login
    if ($login -ne $a.user) {
      Add-Finding 'gh' $name "gh in '$ghDir' authenticates as '$login', expected '$($a.user)'"
    }

    # --- layer 1b: SSO authorization for the org ------------------------
    if ($a.ssoOrg -and $a.ssoOrg -notlike 'TBD-*') {
      $checks++
      $orgOut = (& gh api "orgs/$($a.ssoOrg)" --jq .login 2>&1) -join ''
      if ($orgOut -eq $a.ssoOrg) {
        $row.ssoOrg = 'OK'
      } elseif ($orgOut -match 'SAML|SSO|single sign') {
        $row.ssoOrg = 'NOT SSO-AUTHORIZED'
        Add-Finding 'gh-sso' $name "token authenticates as a user but is NOT SSO-authorized for org '$($a.ssoOrg)'. This is the failure that looks like success -- authorize the token in GitHub settings. Raw: $orgOut"
      } else {
        $row.ssoOrg = 'UNREACHABLE'
        Add-Finding 'gh-sso' $name "could not read org '$($a.ssoOrg)': $orgOut"
      }
    }

    if ($null -ne $prevDir) { $env:GH_CONFIG_DIR = $prevDir } else { Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $prevGh) { $env:GH_TOKEN = $prevGh }
    if ($null -ne $prevGit) { $env:GITHUB_TOKEN = $prevGit }
  }

  # --- layer 2: git push credential -------------------------------------
  # `git credential fill` asks the SAME helper git itself would ask, for the
  # SAME user-scoped key. Anything less (reading cmdkey, assuming wincred) tests
  # a different question than the one that matters at push time.
  #
  # MUST be non-interactive. Git Credential Manager's default behaviour on a MISS
  # is to raise a GUI prompt, and a GUI prompt in a scheduled/tool shell blocks
  # forever -- nobody is there to answer it. Observed 2026-08-05: this layer hung
  # the whole verifier with `git credential fill` -> `git credential-manager get`
  # parked at 0% CPU, and the run had to be killed, producing ZERO output. A
  # verifier that can hang is a verifier that never gets run, which is how all
  # four layers stayed unverified while the setup was silently misconfigured.
  #
  # Belt and braces, because these are read by different components:
  #   GIT_TERMINAL_PROMPT=0        -- git's own terminal prompt
  #   GCM_INTERACTIVE=never        -- GCM env knob
  #   -c credential.interactive=false -- GCM git-config knob
  # A miss must FAIL, not ask.
  $checks++
  $probe = "protocol=https`nhost=github.com`nusername=$($a.user)`n`n"
  $prevTp = $env:GIT_TERMINAL_PROMPT; $prevGcmI = $env:GCM_INTERACTIVE
  $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
  try {
    $filled = ($probe | & git -c credential.interactive=false credential fill 2>&1) -join "`n"
  } finally {
    if ($null -ne $prevTp) { $env:GIT_TERMINAL_PROMPT = $prevTp } else { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    if ($null -ne $prevGcmI) { $env:GCM_INTERACTIVE = $prevGcmI } else { Remove-Item Env:GCM_INTERACTIVE -ErrorAction SilentlyContinue }
  }
  if ($filled -match 'password=') {
    $gotUser = if ($filled -match 'username=(\S+)') { $Matches[1] } else { '(none)' }
    $row.gitCredential = $gotUser
    if ($gotUser -ne $a.user) {
      Add-Finding 'git-credential' $name "credential helper returned username '$gotUser' for a request scoped to '$($a.user)' -- the two accounts are colliding on the host-level entry"
    }
  } else {
    $row.gitCredential = 'NONE STORED'
    # `git credential-manager`, NOT `git-credential-manager`. The bare executable
    # is NOT on PATH on this machine (it lives in Git's libexec/git-core and
    # mingw64/bin); the git-subcommand form resolves it. Verified 2026-08-05 --
    # the old wording sent you to a command that errors with "not recognized".
    Add-Finding 'git-credential' $name "no retrievable credential for https://$($a.user)@github.com. Add the account with: git credential-manager github login  (browser OAuth -- this also satisfies SAML SSO, which a PAT would not without separate authorization). Then confirm with: git credential-manager github list"
  }

  $results += [pscustomobject]$row
}

# --- layer 3: commit identity per route ---------------------------------
$routeRows = @()
foreach ($r in $cfg.routes) {
  $checks++
  #
  # Routes carry the account under `commitAccount`. They used to carry it under
  # `account`, and this script kept reading the old name after accounts.json was
  # refactored -- so `$cfg.accounts.($null)` returned $null, `$expected` was
  # $null, and `$actual -ne $expected` was TRUE for every route on disk. That
  # does not fail loudly; it fires a spurious commit-identity finding for ALL 15
  # routes, which is worse than hanging, because it looks like 15 real problems.
  #
  # Accept either spelling, but REFUSE to proceed if neither is present rather
  # than silently treating an unreadable route as "no expectation".
  $routeAcct = if ($r.PSObject.Properties['commitAccount']) { $r.commitAccount } `
               elseif ($r.PSObject.Properties['account']) { $r.account } `
               else { $null }
  if (-not $routeAcct) {
    Add-Finding 'commit-identity' '(schema)' "route '$($r.prefix)' has neither 'commitAccount' nor 'account' -- accounts.json schema drifted away from this verifier. Not guessing."
    $routeRows += [pscustomobject]@{ route = $r.prefix; account = '(UNREADABLE)'; expectedEmail = '(unknown)'; actualEmail = '(skipped)' }
    continue
  }
  $acct = $cfg.accounts.$routeAcct
  if (-not $acct) {
    Add-Finding 'commit-identity' $routeAcct "route '$($r.prefix)' points at account '$routeAcct' which is not defined in accounts.json"
    $routeRows += [pscustomobject]@{ route = $r.prefix; account = $routeAcct; expectedEmail = '(undefined account)'; actualEmail = '(skipped)' }
    continue
  }
  $expected = $acct.email
  $dir = $r.prefix
  $row = [ordered]@{ route = $r.prefix; account = $routeAcct; expectedEmail = $expected }
  if ($expected -like 'TBD-*') { $row.actualEmail = '(account is a placeholder)'; $routeRows += [pscustomobject]$row; continue }
  if (-not (Test-Path $dir)) {
    # A route pointing at nothing is normally a real defect: it looks like coverage
    # and protects nothing. But a DELIBERATELY reserved prefix (a directory that
    # will exist once something is cloned into it) is not a defect, and reporting
    # it as one made this verifier permanently FAIL on 2 findings while every real
    # repo was correct. A gate that can never go green stops being read, which is
    # worse than the thing it was reporting.
    #
    # The distinction comes from the route's own `note`, i.e. from stated INTENT,
    # not from guessing. An unnoted missing prefix is still a finding -- that is
    # how the stale Projects/fourth-connect route was caught and removed.
    if ($r.note -match '(?i)reserved') {
      $row.actualEmail = '(reserved - not yet created)'
    } else {
      $row.actualEmail = 'PATH DOES NOT EXIST'
      Add-Finding 'commit-identity' $routeAcct "route prefix '$dir' does not exist and is not marked reserved -- a route that matches nothing silently never applies. Either create it, delete the route, or add a note saying it is reserved."
    }
  } else {
    # Ask git from INSIDE the directory: that is what resolves includeIf.
    $actual = (& git -C $dir config user.email 2>&1) -join ''
    $row.actualEmail = $actual
    # An alias is accepted, not ignored. GitHub's noreply form attributes commits
    # to the same account, so flagging it reported a defect where there was none
    # -- two permanent findings that made the whole verifier read as FAIL. What
    # still fails is an address belonging to neither identity, which is the case
    # that actually bakes the wrong PERSON into history.
    $accepted = @($expected) + @($acct.emailAliases | Where-Object { $_ })
    if ($accepted -notcontains $actual) {
      Add-Finding 'commit-identity' $routeAcct "commits made in '$dir' would be authored as '$actual', which is neither '$expected' nor any configured alias. Add an includeIf gitdir rule -- this one bakes the wrong identity into history permanently."
    } elseif ($actual -ne $expected) {
      $row.actualEmail = "$actual (alias)"
    }
  }
  $routeRows += [pscustomobject]$row
}

# --- layer 4: github MCP server -----------------------------------------
$checks++
$mcpPath = Join-Path $HOME '.mcp.json'
# ABSENT ON PURPOSE since 2026-08-05: the `github` MCP server pointed at
# @modelcontextprotocol/server-github, which upstream DEPRECATED and archived in
# favour of github/github-mcp-server. It could not connect, and nothing in this
# repo ever called an mcp__github__* tool -- the gh CLI is the GitHub path here
# (see .claude/rules/cli-integration-strategy.md: native CLI is tier 1). So
# "absent" is the PASS state for this layer, not a misconfiguration to repair.
# If a github MCP server is ever reinstated, it must be the github/ one, and its
# identity has to be verified here like any other layer.
$mcpNote = 'absent (deliberate -- gh CLI is the GitHub path; see comment above)'
if (Test-Path $mcpPath) {
  $mcp = Get-Content $mcpPath -Raw | ConvertFrom-Json
  $srv = $mcp.mcpServers.github
  if ($srv) {
    $tokenRef = $srv.env.GITHUB_PERSONAL_ACCESS_TOKEN
    $mcpNote = "token ref: $tokenRef"
    if ($tokenRef -match '^\$\{(\w+)\}$') {
      $varName = $Matches[1]
      $val = [Environment]::GetEnvironmentVariable($varName, 'User')
      if (-not $val) { $val = [Environment]::GetEnvironmentVariable($varName, 'Process') }
      if (-not $val) {
        Add-Finding 'mcp' '(github server)' "resolves to `${$varName}` which is not set -- the MCP github server has no usable token"
      } else {
        $who = (& gh api user --jq .login 2>&1) -join ''   # uses ambient token deliberately
        $mcpNote = "resolves via `${$varName}` -> authenticates as '$who'"
      }
    }
  }
}

# --- layer 5: plain-git routing -----------------------------------------
#
# Layers 1-4 all go through a wrapper or a config dir. This one asks what PLAIN
# `git` does -- no gh-for.ps1, no git-for.ps1 -- because that is what VS Code,
# Claude Code's own git calls, and muscle memory actually use.
#
# The defect this guards was live until 2026-08-11: git asked the helper chain
# for https://github.com with NO username, Git Credential Manager could not
# choose between two accounts and raised a picker, and when that was suppressed
# a second helper (wincred) answered from an ambiguous stored entry that mapped
# to the WORK account. Every personal repo therefore authenticated as
# david-hayes44 and 404'd -- 25 of 64 remotes were failing this way.
#
# NOTE ON CHECK 3, because the obvious form of it is wrong: the original plan
# asserted that a no-username probe must NOT return a credential at all. That is
# false once credential.<url>.username is configured -- a no-username probe then
# resolves to the DEFAULT account, deterministically, which is the fix working
# as designed. The invariant is not "nothing comes back", it is "the personal
# account comes back, never the work account". Asserting the plan's version
# would fail on a correctly configured machine.
$defaultUser = $cfg.accounts.($cfg.authByOwner._default).user
$prevTp = $env:GIT_TERMINAL_PROMPT; $prevGcmI = $env:GCM_INTERACTIVE
$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
try {
  # 5a -- no username supplied: must resolve silently, as the DEFAULT account.
  $checks++
  $bare = ("protocol=https`nhost=github.com`n`n" | & git -c credential.interactive=false credential fill 2>&1) -join "`n"
  $bareUser = if ($bare -match 'username=(\S+)') { $Matches[1] } else { '(none)' }
  if ($bare -match 'Cannot prompt') {
    Add-Finding 'plain-git' '(no username)' "the helper chain cannot answer a bare https://github.com request. Interactively this is the account picker. Fix: git config --global credential.https://github.com.username $defaultUser"
  } elseif ($bareUser -ne $defaultUser) {
    Add-Finding 'plain-git' '(no username)' "a bare request resolved to '$bareUser', not the default account '$defaultUser'. This is the silent-wrong-account bug: every personal repo would authenticate as the wrong user and 404. Check for a stale ambiguous credential (cmdkey /list | findstr `"target=git:`") and a second credential.helper."
  }

  # 5b -- exactly one credential helper. A second helper masks GCM's failure
  # instead of surfacing it, which is how the wrong account went unnoticed.
  $checks++
  $helpers = @(& git config --get-all credential.helper 2>$null) | Where-Object { $_ }
  if ($helpers.Count -ne 1) {
    Add-Finding 'plain-git' '(helper chain)' "expected exactly one credential helper, found $($helpers.Count): $($helpers -join ', '). A fallback helper answers when GCM fails, silently and often as the wrong account."
  }
} finally {
  if ($null -ne $prevTp) { $env:GIT_TERMINAL_PROMPT = $prevTp } else { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
  if ($null -ne $prevGcmI) { $env:GCM_INTERACTIVE = $prevGcmI } else { Remove-Item Env:GCM_INTERACTIVE -ErrorAction SilentlyContinue }
}

# 5c -- the transport rewrite that routes work repos. Checked against a real
# repo on disk rather than by re-reading the config we just wrote, so a rule
# that parses but does not FIRE is caught.
$workAcct = $cfg.accounts.($cfg.authByOwner.fourth)
if ($workAcct) {
  $probeRepo = @($cfg.routes | ForEach-Object { $_.prefix } | Where-Object { Test-Path $_ } |
    Where-Object { (& git -C $_ remote get-url origin 2>$null) -match 'github\.com[:/]fourth/' }) |
  Select-Object -First 1
  if ($probeRepo) {
    $checks++
    $effective = (& git -C $probeRepo ls-remote --get-url origin 2>$null)
    if ($effective -notmatch [regex]::Escape("$($workAcct.user)@github.com")) {
      Add-Finding 'plain-git' 'work' "in '$probeRepo' the effective remote URL is '$effective' -- it does not carry '$($workAcct.user)@', so plain git will authenticate there as the default account. Fix: git config --global url.`"https://$($workAcct.user)@github.com/fourth/`".insteadOf https://github.com/fourth/"
    }
  }
}

# --- report --------------------------------------------------------------
$ok = $findings.Count -eq 0 -and $checks -gt 0
if ($checks -eq 0) {
  $findings += [pscustomobject]@{ layer = 'meta'; account = '(all)'; detail = 'ZERO checks ran -- this script proved nothing. Do not read a clean run as a pass.' }
  $ok = $false
}

if ($Json) {
  [pscustomobject]@{ ok = $ok; checks = $checks; accounts = $results; routes = $routeRows; mcp = $mcpNote; findings = $findings } | ConvertTo-Json -Depth 6
} else {
  Write-Host "`n=== accounts ==="; $results | Format-Table -AutoSize
  Write-Host "=== commit identity by route ==="; $routeRows | Format-Table -AutoSize
  Write-Host "=== github MCP server ===`n  $mcpNote`n"
  if ($ok) {
    Write-Host "PASS  verify-github-accounts  $checks checks, all four layers agree with accounts.json"
  } else {
    Write-Host "FAIL  verify-github-accounts  $checks checks, $($findings.Count) finding(s)`n" -ForegroundColor Red
    foreach ($f in $findings) { Write-Host "  [$($f.layer)] $($f.account)"; Write-Host "      $($f.detail)`n" }
  }
}
exit $(if ($ok) { 0 } else { 1 })
