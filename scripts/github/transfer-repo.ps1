<#
.SYNOPSIS
  Transfer one repo from the personal namespace to the company org, with a
  pre-flight that refuses the transfers which would strand work.

.WHY
  A GitHub transfer is easy to fire and awkward to undo, and the failure modes
  are all SILENT rather than loud:

    - GitHub keeps redirects from old owner to new, so every hardcoded
      "Rev4nchist/<repo>" reference KEEPS WORKING after the move. Nothing errors.
      The debt only surfaces later, when a redirect lapses or someone recreates
      the old name. So the reference sweep has to be deliberate; it will never be
      forced on you by a broken build.

    - The instant the remote owner becomes the org, gh-for.ps1 correctly routes
      auth to gh-work -- and if there is no git credential for the work user, you
      now own a repo you cannot push to. Verified 2026-08-05: the work account
      had NO stored credential while the personal one did.

    - A branch with no upstream exists ONLY on this disk. Transfer it first and
      the push that would have saved it is the push that now fails. Three of the
      eight repos in the first batch were in exactly that state, one of them
      holding a QA fix authored the same day.

  So: pre-flight is the product here, and it BLOCKS. The transfer itself is three
  lines.

.SAFETY
  Pre-flight only by default. Nothing mutates without -Apply. Blocking findings
  refuse the transfer even with -Apply; -Force downgrades blocks to warnings and
  exists for the case where a human has looked at each one, not as a shortcut.

.EXAMPLE
  pwsh -File scripts/github/transfer-repo.ps1 -Repo gong-mcp
  pwsh -File scripts/github/transfer-repo.ps1 -Repo gong-mcp -Apply

.NOTES
  ASCII only. Scheduled PowerShell on this machine is 5.1, where a UTF-8 dash in
  a double-quoted string breaks the parse (see ps51-bomless-cp1252 findings).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$SourceOwner = 'Rev4nchist',
  [string]$TargetOrg   = 'fourth',
  [string]$Path,
  [string]$NewName,
  [switch]$Apply,
  [switch]$Force,
  [switch]$SkipVerifier
)

$ErrorActionPreference = 'Stop'
$RepoRoot     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$AccountsPath = Join-Path $PSScriptRoot 'accounts.json'
$RegistryPath = Join-Path $RepoRoot '.claude\project-registry.json'
$LogPath      = Join-Path $RepoRoot '.claude\logs\repo-transfers.jsonl'

$cfg         = Get-Content $AccountsPath -Raw | ConvertFrom-Json
$personalDir = $cfg.accounts.personal.ghConfigDir -replace '^~', $HOME
$workDir     = $cfg.accounts.work.ghConfigDir     -replace '^~', $HOME
$personalUser = $cfg.accounts.personal.user
$workUser     = $cfg.accounts.work.user
$targetName   = if ($NewName) { $NewName } else { $Repo }

$findings = @()
function Add-Block([string]$m) { $script:findings += [pscustomobject]@{ sev = 'BLOCK'; detail = $m } }
function Add-Warn ([string]$m) { $script:findings += [pscustomobject]@{ sev = 'WARN';  detail = $m } }

# gh, pinned to one account's config dir, with ambient tokens stripped so the
# config dir is the only thing deciding identity (same contract as gh-for.ps1).
function Invoke-Gh {
  param([string]$ConfigDir, [string[]]$GhArgs)
  $prevDir = $env:GH_CONFIG_DIR; $prevGh = $env:GH_TOKEN; $prevGit = $env:GITHUB_TOKEN
  $env:GH_CONFIG_DIR = $ConfigDir
  Remove-Item Env:GH_TOKEN     -ErrorAction SilentlyContinue
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  try   { $out = (& gh @GhArgs 2>&1) -join "`n"; return [pscustomobject]@{ ok = ($LASTEXITCODE -eq 0); out = $out } }
  finally {
    if ($null -ne $prevDir) { $env:GH_CONFIG_DIR = $prevDir } else { Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $prevGh)  { $env:GH_TOKEN     = $prevGh }
    if ($null -ne $prevGit) { $env:GITHUB_TOKEN = $prevGit }
  }
}

# ---------------------------------------------------------------- resolve path
if (-not $Path) {
  $reg = Get-Content $RegistryPath -Raw | ConvertFrom-Json
  $hit = $reg.projects | Where-Object { $_.github -eq "$SourceOwner/$Repo" }
  if ($hit) { $Path = $hit.path }
}
if (-not $Path) { Add-Block "no local path given and none found in project-registry.json for '$SourceOwner/$Repo'. Pass -Path." }

Write-Host ""
Write-Host "transfer-repo  $SourceOwner/$Repo  ->  $TargetOrg/$targetName"
Write-Host ("mode: " + $(if ($Apply) { 'APPLY' } else { 'PRE-FLIGHT ONLY (no mutation)' }))
Write-Host ""

# ------------------------------------------------------------------ pre-flight
Write-Host "=== pre-flight ==="

# 1. both config dirs authenticate as who accounts.json says
foreach ($pair in @(@{ n = 'personal'; d = $personalDir; u = $personalUser },
                    @{ n = 'work';     d = $workDir;     u = $workUser })) {
  if (-not (Test-Path $pair.d)) {
    Add-Block "gh config dir '$($pair.d)' missing. Run: `$env:GH_CONFIG_DIR='$($pair.d)'; gh auth login --scopes 'repo,workflow,read:org'"
    continue
  }
  $who = Invoke-Gh -ConfigDir $pair.d -GhArgs @('api', 'user', '--jq', '.login')
  $login = $who.out.Trim()
  if (-not $who.ok -or $login -ne $pair.u) {
    Add-Block "gh config dir '$($pair.d)' authenticates as '$login', expected '$($pair.u)'. A --web login stores whichever account the BROWSER session held -- verify, do not trust the login message."
  } else {
    Write-Host "  [ok] $($pair.n) -> $login"
  }
}

# 2. admin on the source repo (transfer requires it, and it must be the personal
#    account: it owns the repo, the work account would 404)
$src = Invoke-Gh -ConfigDir $personalDir -GhArgs @('api', "repos/$SourceOwner/$Repo", '--jq', '.permissions.admin')
if (-not $src.ok) {
  Add-Block "cannot read repos/$SourceOwner/$Repo as $personalUser : $($src.out)"
} elseif ($src.out.Trim() -ne 'true') {
  Add-Block "$personalUser does not have admin on $SourceOwner/$Repo -- transfer requires admin on the SOURCE."
} else {
  Write-Host "  [ok] admin on source"
}

# 3. work account can actually receive it
$org = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "orgs/$TargetOrg", '--jq', '.login')
if (-not $org.ok) {
  Add-Block "$workUser cannot read org '$TargetOrg': $($org.out). If the org enforces SAML SSO the credential needs explicit authorization -- 'it authenticated fine' is the wrong conclusion to draw."
} else {
  Write-Host "  [ok] $workUser sees org $TargetOrg"
}

# 4. target name free (a collision turns a transfer into a confusing 422)
$clash = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "repos/$TargetOrg/$targetName", '--jq', '.full_name')
if ($clash.ok) { Add-Block "$TargetOrg/$targetName ALREADY EXISTS. Pass -NewName to rename on transfer." }
else           { Write-Host "  [ok] $TargetOrg/$targetName is free" }

# 4b. WHO INITIATES. This is the one that cost two failed -Apply runs, and the
#     first diagnosis of it was WRONG, so the reasoning is recorded in full.
#
#     Attempt 1, initiated as the PERSONAL account (it owns the repo, so it was
#     the obvious choice):
#       422 "You don't have the permission to create public repositories on fourth"
#     That names visibility, so the apparent fix was to flip the repo private.
#     Flipping it changed the message and nothing else:
#       422 "You don't have the permission to create private repositories on fourth"
#
#     Visibility was never the issue. A transfer is a repo CREATION in the target
#     org, authorized against the INITIATING account -- and the personal account
#     is not a member of the org at all (GET /orgs/fourth/members/Rev4nchist ->
#     404). GitHub reported whichever visibility was asked for, which is what
#     made the first message so convincingly wrong.
#
#     So the initiator must hold BOTH: admin on the source repo, AND membership
#     of the target org. Neither account had both by default. The fix is to make
#     the WORK account an admin collaborator on the source (the personal account
#     can grant that), accept the invitation as the work account, and initiate
#     from there. Proven end to end 2026-08-05.
#
#     Also do NOT try to answer this from GET /orgs/<org>: it reported
#     members_can_create_repositories=true in the same session both 422s fired.
#     A plain member gets a partial view (default_repository_permission came back
#     null beside it), so those fields will cheerfully green-light the exact
#     transfer that fails.
$srcW = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "repos/$SourceOwner/$Repo", '--jq', '.permissions.admin')
$workHasAdmin = ($srcW.ok -and $srcW.out.Trim() -eq 'true')
$mem = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "orgs/$TargetOrg/memberships/$workUser", '--jq', '.state')
if (-not ($mem.ok -and $mem.out.Trim() -eq 'active')) {
  Add-Block "$workUser is not an active member of '$TargetOrg' -- it cannot receive a transfer. A transfer is a repo CREATION in the target org, authorized against the INITIATING account."
} else {
  Write-Host "  [ok] $workUser is an active member of $TargetOrg"
}
if ($workHasAdmin) {
  Write-Host "  [ok] $workUser has admin on source (can initiate)"
} elseif ($Apply) {
  Write-Host "  [..] $workUser lacks admin on source -- granting collaborator + accepting"
  $inv = Invoke-Gh -ConfigDir $personalDir -GhArgs @('api', "repos/$SourceOwner/$Repo/collaborators/$workUser", '-X', 'PUT', '-f', 'permission=admin')
  if (-not $inv.ok) { Add-Block "could not grant $workUser admin on $SourceOwner/$Repo : $($inv.out)" }
  else {
    $ids = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', 'user/repository_invitations', '--jq', ".[] | select(.repository.full_name==`"$SourceOwner/$Repo`") | .id")
    foreach ($id in ($ids.out -split "`n" | Where-Object { $_.Trim() })) {
      Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "user/repository_invitations/$($id.Trim())", '-X', 'PATCH', '--silent') | Out-Null
    }
    $re = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "repos/$SourceOwner/$Repo", '--jq', '.permissions.admin')
    if ($re.ok -and $re.out.Trim() -eq 'true') { Write-Host "  [ok] $workUser now has admin on source" }
    else { Add-Block "granted collaborator but $workUser still lacks admin on $SourceOwner/$Repo -- invitation may not have been accepted." }
  }
} else {
  Add-Warn "$workUser does not yet have admin on $SourceOwner/$Repo. -Apply will grant it as an admin collaborator and auto-accept the invitation, which is what makes the transfer authorizable."
}

# 5. git credential for the WORK user must exist BEFORE the move, or the first
#    post-transfer push fails. Non-interactive: GCM's default on a miss is a GUI
#    prompt, which blocks forever in a tool shell (verifier layer 2, 2026-08-05).
$prevTp = $env:GIT_TERMINAL_PROMPT; $prevGi = $env:GCM_INTERACTIVE
$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
try {
  $probe  = "protocol=https`nhost=github.com`nusername=$workUser`n`n"
  $filled = ($probe | & git -c credential.interactive=false credential fill 2>&1) -join "`n"
} finally {
  if ($null -ne $prevTp) { $env:GIT_TERMINAL_PROMPT = $prevTp } else { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
  if ($null -ne $prevGi) { $env:GCM_INTERACTIVE      = $prevGi } else { Remove-Item Env:GCM_INTERACTIVE      -ErrorAction SilentlyContinue }
}
if ($filled -match 'password=') { Write-Host "  [ok] git credential resolvable for $workUser" }
else { Add-Block "no git credential for https://$workUser@github.com. After transfer, pushes route to the work account and would FAIL. Fix first: git credential-manager github login  (git SUBCOMMAND form -- the bare git-credential-manager executable is not on PATH here)" }

# 6. local clone sane, and NOTHING is only on this disk
if ($Path -and (Test-Path $Path)) {
  $isRepo = (& git -C $Path rev-parse --is-inside-work-tree 2>&1) -join ''
  if ($isRepo -ne 'true') {
    Add-Block "'$Path' is not a git repository. Nothing to transfer -- it needs 'git init' and a fresh push to $TargetOrg instead."
  } else {
    $origin = ((& git -C $Path remote get-url origin 2>&1) -join '').Trim()
    if ($origin -notmatch [regex]::Escape("$SourceOwner/$Repo")) {
      Add-Block "origin of '$Path' is '$origin', which does not match $SourceOwner/$Repo. Check you are pointing at the right working copy -- local directory names do NOT reliably match repo names here."
    } else { Write-Host "  [ok] origin matches" }

    # THE check this script exists for.
    & git -C $Path fetch --quiet 2>&1 | Out-Null
    $stranded = @()
    foreach ($b in (& git -C $Path for-each-ref --format='%(refname:short)' refs/heads 2>&1)) {
      $b = $b.Trim(); if (-not $b) { continue }
      $up = ((& git -C $Path rev-parse --abbrev-ref "$b@{u}" 2>&1) -join '').Trim()
      if ($LASTEXITCODE -ne 0 -or $up -match 'no upstream|unknown revision|fatal') {
        $stranded += "$b (NO UPSTREAM - every commit on it is local-only)"
      } else {
        $ahead = ((& git -C $Path rev-list --count "$up..$b" 2>&1) -join '').Trim()
        if ($ahead -match '^\d+$' -and [int]$ahead -gt 0) { $stranded += "$b ($ahead unpushed)" }
      }
    }
    if ($stranded.Count) {
      Add-Block ("work exists only on this disk and would be stranded -- push it BEFORE transferring, while personal auth still works:`n        " + ($stranded -join "`n        "))
    } else { Write-Host "  [ok] every branch is pushed" }

    $dirty = ((& git -C $Path status --porcelain 2>&1) -join "`n").Trim()
    if ($dirty) { Add-Warn "working tree has $(($dirty -split "`n").Count) uncommitted change(s). Transfer does not touch them, but they are invisible to anyone who re-clones from the org." }

    $email = ((& git -C $Path config user.email 2>&1) -join '').Trim()
    if ($email -ne $cfg.accounts.work.email) {
      Add-Warn "commits here are authored as '$email', not '$($cfg.accounts.work.email)'. Transfer does NOT rewrite history. Land the includeIf rules first so new commits are right, and consider adding '$email' as a verified secondary email on the $workUser account so existing history attributes correctly (no rewrite, no SHA churn)."
    }
  }
} elseif ($Path) { Add-Block "local path '$Path' does not exist." }

# ---------------------------------------------------------------------- report
$blocks = @($findings | Where-Object { $_.sev -eq 'BLOCK' })
$warns  = @($findings | Where-Object { $_.sev -eq 'WARN' })
Write-Host ""
foreach ($f in $findings) { Write-Host "  [$($f.sev)] $($f.detail)"; Write-Host "" }

if ($blocks.Count -and -not $Force) {
  Write-Host "REFUSED  $($blocks.Count) blocking finding(s), $($warns.Count) warning(s). Nothing was changed."
  Write-Host "Resolve them, or pass -Force if a human has read every one."
  exit 1
}
if ($blocks.Count -and $Force) { Write-Host "PROCEEDING WITH $($blocks.Count) BLOCK(S) DOWNGRADED BY -Force." }

if (-not $Apply) {
  Write-Host "PRE-FLIGHT PASS  $($warns.Count) warning(s). Re-run with -Apply to transfer."
  exit 0
}

# ---------------------------------------------------------------------- apply
Write-Host ""
Write-Host "=== transferring ==="
$xferArgs = @('api', "repos/$SourceOwner/$Repo/transfer", '-X', 'POST', '-f', "new_owner=$TargetOrg")
if ($NewName) { $xferArgs += @('-f', "new_name=$NewName") }
# Initiated as the WORK account, NOT the owner of the source. See 4b: the target
# org authorizes the creation against the initiator, and the personal account is
# not a member of the org. Initiating as personal 422s regardless of visibility.
$xfer = Invoke-Gh -ConfigDir $workDir -GhArgs $xferArgs
if (-not $xfer.ok) { Write-Host "TRANSFER FAILED: $($xfer.out)"; exit 1 }
Write-Host "  transfer accepted (202 is async -- polling for arrival)"

$arrived = $false
foreach ($i in 1..12) {
  Start-Sleep -Seconds 5
  $chk = Invoke-Gh -ConfigDir $workDir -GhArgs @('api', "repos/$TargetOrg/$targetName", '--jq', '.full_name')
  if ($chk.ok) { $arrived = $true; Write-Host "  arrived: $($chk.out.Trim())"; break }
}
if (-not $arrived) {
  Write-Host "WARN  $TargetOrg/$targetName not visible after 60s. Transfer may still be in flight -- VERIFY before re-running (a retry against an already-moved repo will 404 confusingly)."
}

Write-Host ""
Write-Host "=== repointing local + config ==="
& git -C $Path remote set-url origin "https://github.com/$TargetOrg/$targetName.git"
Write-Host "  origin -> $(((& git -C $Path remote get-url origin) -join '').Trim())"

# Registry + routes: single-process atomic read-modify-write, never Edit-in-place
# on a file another process may be writing.
$node = @"
const fs = require('fs');
const regP = process.argv[1], accP = process.argv[2];
const oldRef = process.argv[3], newRef = process.argv[4], localPath = process.argv[5], acct = process.argv[6];
const reg = JSON.parse(fs.readFileSync(regP, 'utf8'));
let n = 0;
for (const p of reg.projects) { if (p.github === oldRef) { p.github = newRef; n++; } }
fs.writeFileSync(regP, JSON.stringify(reg, null, 2) + '\n');
console.log('  registry: ' + n + ' entry(ies) updated to ' + newRef);
const acc = JSON.parse(fs.readFileSync(accP, 'utf8'));
const norm = s => s.replace(/\\\\/g, '/').replace(/\/+$/, '').toLowerCase();
const has = acc.routes.some(r => norm(r.prefix) === norm(localPath));
if (!has) {
  acc.routes.unshift({ prefix: localPath.replace(/\\\\/g, '/'), commitAccount: acct, note: 'transferred to company org' });
  fs.writeFileSync(accP, JSON.stringify(acc, null, 2) + '\n');
  console.log('  accounts.json: route added for ' + localPath);
} else { console.log('  accounts.json: route already present'); }
"@
& node -e $node $RegistryPath $AccountsPath "$SourceOwner/$Repo" "$TargetOrg/$targetName" $Path 'work'

# Auth should now flip to the work account on its own -- that is the whole point
# of routing by remote owner rather than by directory.
Write-Host ""
Write-Host "=== routing after transfer ==="
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'gh-for.ps1') -Path $Path -WhichAccount

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
$row = [pscustomobject]@{
  ts = (Get-Date).ToString('o'); from = "$SourceOwner/$Repo"; to = "$TargetOrg/$targetName"
  path = $Path; arrived = $arrived; warnings = $warns.Count; forced = [bool]$Force
} | ConvertTo-Json -Compress
Add-Content -Path $LogPath -Value $row

if (-not $SkipVerifier) {
  Write-Host ""
  Write-Host "=== four-layer verifier ==="
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-github-accounts.ps1')
}

Write-Host ""
Write-Host "DONE  $SourceOwner/$Repo -> $TargetOrg/$targetName"
Write-Host "Still yours to do: sweep hardcoded '$SourceOwner/$Repo' references (GitHub redirects hide these -- nothing will break to remind you), and reconnect any Vercel/Railway git integration."
