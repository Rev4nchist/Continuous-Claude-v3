#requires -Version 7.0
<#
.SYNOPSIS
  CCv3 PR1 deferred Windows / installed-harness gates (rog-strix). Spec: WINDOWS-GATES.md.
.DESCRIPTION
  Runs W0-W9 and saves each output to <RepoPath>\.claude\cache\e2e\<date>-pr1-win-<name>.txt,
  plus a summary (<date>-pr1-win-summary.md / .json).
  Safety:
  - Read-only toward ~/.claude. Every sync goes to a temp HOME. The install is NOT run here.
    `claude` and the hooks write their own runtime files (sessions, debug logs, hook state).
  - Uses only C:\Program Files\Git\bin\bash.exe (never WSL bash).
  - No secrets. No git push / fetch / commit. No scheduled-task registration.
.PARAMETER Phase
  pre  = W0 W1 W2 W9 (PR1 branch checked out, before merge/install)
  post = W3-W8 (after install)
  all  = both
.PARAMETER SkipClaude
  Skip W6/W8 (no signed-in claude).
.EXAMPLE
  pwsh -File run-windows-gates.ps1 -Phase pre
#>
[CmdletBinding()]
param(
  [ValidateSet('pre','post','all')][string]$Phase = 'pre',
  [string]$RepoPath = (Join-Path $env:USERPROFILE 'continuous-claude'),
  [string]$GitBash  = 'C:\Program Files\Git\bin\bash.exe',
  [switch]$SkipClaude
)
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
$D = Get-Date -Format 'yyyy-MM-dd'
if (-not (Test-Path $GitBash)) { throw "Git Bash not found at $GitBash" }
if (-not (Test-Path (Join-Path $RepoPath 'scripts\sync-to-active.sh'))) { throw "Not a CCv3 repo: $RepoPath" }
Set-Location $RepoPath
$E = Join-Path $RepoPath '.claude\cache\e2e'
New-Item -ItemType Directory -Force $E | Out-Null
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$Results = [System.Collections.Generic.List[object]]::new()

. (Join-Path $PSScriptRoot 'lib/windows-gate-verdicts.ps1')

function Save-Gate([string]$Id, [string]$Name, [string[]]$Lines, [bool]$Pass, [string]$Summary) {
  $file = Join-Path $E "$D-pr1-win-$Name.txt"
  $Lines | Set-Content -Path $file -Encoding utf8
  $Results.Add([pscustomobject]@{ gate=$Id; file=(Split-Path $file -Leaf); result=$Summary; pass=$Pass })
  $tag = if ($Pass) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0} {1,-4} {2}  ({3})" -f $Id, $tag, $Summary, (Split-Path $file -Leaf))
}
function Invoke-GB([string]$Cmd) { $o = & $GitBash -c $Cmd 2>&1 | ForEach-Object { "$_" }; ,@($o + "exit=$LASTEXITCODE") }

$runPre  = $Phase -in 'pre','all'
$runPost = $Phase -in 'post','all'

# ---------- W0 preflight ----------
$porcelain = @(git status --porcelain)
$o = Invoke-GB 'uname -s; command -v node; command -v sha256sum'
$o += "HEAD=$(git rev-parse HEAD)"; $o += "porcelain:"; $o += $porcelain; $o += @(git remote -v)
$uname = ($o | Select-Object -First 1)
$tree = Get-W0TreeVerdict -Porcelain $porcelain
if ($tree.Summary) { $o += $tree.Summary }
$ok = ($uname -match '^(MINGW|MSYS)') -and ($o -match 'node') -and ($o -match 'sha256sum') -and $tree.Pass
$w0Summary = "uname=$uname"
if (-not $tree.Pass) { $w0Summary += " FAIL tracked=$($tree.Tracked.Count)" }
elseif ($tree.Warn) { $w0Summary += " WARN untracked=$($tree.Untracked.Count)" }
Save-Gate 'W0' 'preflight' $o $ok $w0Summary
if ($uname -match 'Linux') { throw 'Git Bash resolved to a Linux/WSL shell; aborting.' }

if ($runPre) {
  # ---------- W1 sync cursor test (temp home inside the test) ----------
  $o = & $GitBash scripts/sync-to-active-cursor.test.sh 2>&1 | ForEach-Object { "$_" }; $rc = $LASTEXITCODE
  $p = @($o | Select-String -Pattern '\bPASS\b').Count; $f = @($o | Select-String -Pattern '\bFAIL\b').Count
  Save-Gate 'W1' 'sync-cursor-test' (@($o) + "exit=$rc") (($rc -eq 0) -and $p -gt 0 -and $f -eq 0) "PASS=$p FAIL=$f exit=$rc"

  # ---------- W2 temp-HOME sync, personal profile ----------
  $T = Join-Path $env:TEMP "ccv3-pr1-home-$D-$PID"; New-Item -ItemType Directory -Force $T | Out-Null
  $env:CCV3_GATE_HOME = $T
  $cmd = @'
H="$(cygpath -u "$CCV3_GATE_HOME")"
HOME="$H" CCV3_MACHINE_PROFILE=personal SYNC_ALLOW_BRANCH=1 "$BASH" scripts/sync-to-active.sh --skip-build; echo "sync_exit=$?"
echo "files=$(find "$H/.claude" -type f 2>/dev/null | wc -l)"
echo "archive_dirs=$(find "$H/.claude" -type d \( -name _snapshots -o -name _archive -o -name .archive -o -name archive -o -name _eval -o -name _sandbox \) 2>/dev/null | wc -l)"
for s in fourth-brand-guidelines fourth-presentation-suite fourthos-weekly weekly-report fabric kusto-cli; do test -e "$H/.claude/skills/$s" && echo "SKIPSKILL_PRESENT $s"; done
echo "work_paths=$(grep -rIl 'david[.-]hayes' "$H/.claude" 2>/dev/null | wc -l)"
'@
  $o = Invoke-GB $cmd
  $se = Get-GateCount -Lines $o -Key 'sync_exit'
  $fc = Get-GateCount -Lines $o -Key 'files'
  $ad = Get-GateCount -Lines $o -Key 'archive_dirs'
  $wp = Get-GateCount -Lines $o -Key 'work_paths'
  $sk = @($o | Select-String 'SKIPSKILL_PRESENT').Count
  $verdict = Get-W2SyncVerdict -SyncExit $se -Files $fc -ArchiveDirs $ad -SkipSkills $sk -WorkPaths $wp
  if ($verdict.Summary) { $o += $verdict.Summary }
  Save-Gate 'W2' 'temp-sync' $o $verdict.Pass "sync_exit=$se files=$fc archive_dirs=$ad skipskills_present=$sk work_paths=$wp"
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  Remove-Item Env:\CCV3_GATE_HOME -ErrorAction SilentlyContinue

  # ---------- W9 scheduled-task scripts ----------
  $o = @(); $errs = 0; $n = 0
  Get-ChildItem .claude\scripts -Recurse -Filter *.ps1 | ForEach-Object {
    $pe = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$pe)
    $n++; $errs += $pe.Count; $o += "$($pe.Count) errors  $($_.FullName)"
  }
  $hits = @(Select-String -Path .claude\scripts\*.ps1, .claude\scripts\scheduled\*.ps1, scripts\scheduled-health-check.bat -Pattern 'david[.-]hayes')
  $o += "work_path_hits=$($hits.Count)"; $o += @($hits | ForEach-Object { "$_" })
  $tasks = $null; try { $tasks = Get-Content scripts\scheduled\tasks.json -Raw | ConvertFrom-Json } catch { $o += "tasks.json parse error: $_" }
  $tl = @($tasks.tasks ?? $tasks); $personal = @($tl | Where-Object { "$($_.profile)" -match 'personal' }).Count
  $other = @($tl | Where-Object { "$($_.profile)" -and "$($_.profile)" -notmatch 'personal' }).Count
  $rr = @(Select-String -Path scripts\scheduled-health-check.bat -Pattern 'report-registry').Count
  $o += "tasks=$($tl.Count) personal=$personal other_profiles=$other report_registry_refs=$rr"
  Save-Gate 'W9' 'ps1-parse' $o ($n -gt 0 -and $errs -eq 0 -and $hits.Count -eq 0 -and $personal -gt 0 -and $other -eq 0 -and $rr -eq 0) "ps1=$n parse_errors=$errs work_paths=$($hits.Count) personal_tasks=$personal other_profiles=$other report_registry_refs=$rr"
}

if ($runPost) {
  $live = Join-Path $ClaudeHome 'settings.json'
  if (-not (Test-Path $live)) { throw "No $live - run the install (runbook 3.4+) before -Phase post." }

  # ---------- W3 render --check ----------
  $o = & node scripts/settings/render-settings.mjs --check 2>&1 | ForEach-Object { "$_" }; $rc = $LASTEXITCODE
  Save-Gate 'W3' 'render-check' (@($o) + "exit=$rc") ($rc -eq 0) "exit=$rc (read the compared-count line)"

  # ---------- W4 active manifest + timeouts ----------
  $o = & node scripts/hook-manifest-check.mjs 2>&1 | ForEach-Object { "$_" }; $rc = $LASTEXITCODE
  $s = Get-Content $live -Raw | ConvertFrom-Json -AsHashtable
  $n = 0; $over = 0
  foreach ($ev in $s.hooks.Keys) { foreach ($m in $s.hooks[$ev]) { foreach ($h in $m.hooks) { $n++; if ($h.timeout -gt 120) { $over++ } } } }
  $hasMcp = $s.ContainsKey('mcpServers')
  $o += "manifest_exit=$rc timeouts=$n over120=$over mcpServers_in_settings=$hasMcp"
  Save-Gate 'W4' 'manifest' $o (($rc -eq 0) -and $n -gt 0 -and $over -eq 0 -and -not $hasMcp) "manifest_exit=$rc timeouts=$n over120=$over mcpServers=$hasMcp"

  # ---------- W5 payloads into changed hooks ----------
  $o = @(); $bad = 0; $ran = 0
  $tmpCwd = Join-Path $env:TEMP "ccv3-pr1-hookcwd-$PID"; New-Item -ItemType Directory -Force $tmpCwd | Out-Null
  foreach ($hk in 'commit-preflight','test-run-tracker','pr-opened-review-loop','periodic-extract') {
    foreach ($ev in $s.hooks.Keys) { foreach ($m in $s.hooks[$ev]) { foreach ($h in $m.hooks) {
      $cmdline = "$($h.command) $(@($h.args) -join ' ')"
      if ($cmdline -notmatch [regex]::Escape("$hk.mjs")) { continue }
      $tools = "$($m.matcher)" -split '\|'
      $tool = if ($tools -contains 'PowerShell') { 'PowerShell' } elseif ($tools[0]) { $tools[0] } else { 'Bash' }
      $payload = @{ hook_event_name=$ev; tool_name=$tool; tool_input=@{ command='git status' }; cwd=$tmpCwd.Replace('\','/'); session_id="pr1-gate-$PID" }
      if ($ev -like 'Post*') { $payload.tool_response = @{ stdout=''; stderr=''; exit_code=0 } }
      $json = $payload | ConvertTo-Json -Compress -Depth 5
      $dist = Join-Path $ClaudeHome "hooks\dist\$hk.mjs"
      Push-Location $tmpCwd
      $out = $json | & node $dist 2>&1 | ForEach-Object { "$_" }; $rc = $LASTEXITCODE
      Pop-Location
      $ran++
      $stack = @($out | Select-String -Pattern '^\s+at |Error:').Count
      if ($rc -notin 0,2 -or $stack -gt 0) { $bad++ }
      $o += "== $hk [$ev / $tool] exit=$rc stack_lines=$stack"; $o += $out
    } } }
  }
  Remove-Item -Recurse -Force $tmpCwd -ErrorAction SilentlyContinue
  Save-Gate 'W5' 'hook-payloads' $o ($ran -ge 4 -and $bad -eq 0) "registrations_run=$ran bad=$bad"

  if (-not $SkipClaude -and (Get-Command claude -ErrorAction SilentlyContinue)) {
    # ---------- W6 headless behaviour checks (plan mode, temp cwd) ----------
    $prompts = @(
      @{ n=1; p='Using the hook-scaffold skill: what timeout value goes in settings.json for a simple regex-check hook? Number and unit only.'; ok={ param($t) $t -match '\b3\b' -and $t -match 'sec' -and $t -notmatch '3000' } },
      @{ n=2; p='Which bash executable must run scripts/sync-to-active.sh on this machine? Path only.'; ok={ param($t) $t -match 'Program Files\\+Git\\+bin\\+bash\.exe|Program Files/Git/bin/bash\.exe' } },
      @{ n=3; p='What is the path of my user-scope Claude settings.json? Path only.'; ok={ param($t) $t -match 'dkhay[\\/]+\.claude[\\/]+settings\.json' } }
    )
    Push-Location $env:TEMP
    foreach ($q in $prompts) {
      $raw = & claude -p $q.p --output-format json --permission-mode plan 2>&1 | Out-String
      $text = try { ($raw | ConvertFrom-Json).result } catch { $raw }
      $pass = (& $q.ok "$text") -and ("$text" -notmatch 'david[.-]hayes')
      $f = Join-Path $E "$D-pr1-win-claude-p-$($q.n).json"; $raw | Set-Content $f -Encoding utf8
      $Results.Add([pscustomobject]@{ gate="W6.$($q.n)"; file=(Split-Path $f -Leaf); result=$(($one = ("$text".Trim() -replace '\s+',' ')).Substring(0,[Math]::Min(120,$one.Length))); pass=$pass })
      Write-Host ("W6.{0} {1} {2}" -f $q.n, $(if ($pass) {'PASS'} else {'FAIL'}), "$text".Trim())
    }
    Pop-Location
  } else { Write-Host 'W6 SKIPPED (no claude or -SkipClaude)'; $Results.Add([pscustomobject]@{ gate='W6'; file=''; result='SKIPPED'; pass=$false }) }

  # ---------- W7 verify-setup ----------
  $o = & $GitBash scripts/verify-setup.sh 2>&1 | ForEach-Object { "$_" }
  $fm = $o | Select-String -Pattern 'Failed:\s*(\d+)' | Select-Object -Last 1
  $failed = if ($fm) { [int]$fm.Matches[0].Groups[1].Value } else { -1 }
  $passed = ($o | Select-String -Pattern 'Passed:\s*(\d+)' | Select-Object -Last 1)
  Save-Gate 'W7' 'verify-setup' $o ($failed -eq 0) "Failed=$failed $passed"

  if (-not $SkipClaude -and (Get-Command claude -ErrorAction SilentlyContinue)) {
    # ---------- W8 debug log grep ----------
    $dbg = Join-Path $ClaudeHome 'debug'
    $before = Get-Date
    Push-Location $env:USERPROFILE; & claude --debug -p 'Reply OK' --permission-mode plan *> $null; Pop-Location
    Push-Location $RepoPath;        & claude --debug -p 'Reply OK' --permission-mode plan *> $null; Pop-Location
    $logs = @(Get-ChildItem $dbg -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -ge $before | Sort-Object LastWriteTime -Descending | Select-Object -First 2)
    . (Join-Path $PSScriptRoot 'lib/w8-hook-errors.ps1')
    $hits = [System.Collections.Generic.List[string]]::new()
    foreach ($log in $logs) {
      foreach ($line in @(Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) {
        if (Test-HookErrorLine -Line $line) { $hits.Add($line) }
      }
    }
    $o = @("logs=$($logs.Count)") + @($logs.FullName) + "hook_error_lines=$($hits.Count)" + @($hits | ForEach-Object { "$_" })
    Save-Gate 'W8' 'debug-grep' $o ($logs.Count -ge 2 -and $hits.Count -eq 0) "logs=$($logs.Count) hook_error_lines=$($hits.Count)"
  } else { Write-Host 'W8 SKIPPED'; $Results.Add([pscustomobject]@{ gate='W8'; file=''; result='SKIPPED'; pass=$false }) }
}

# ---------- summary ----------
$sum = Join-Path $E "$D-pr1-win-summary-$Phase"
$Results | ConvertTo-Json -Depth 3 | Set-Content "$sum.json" -Encoding utf8
$md = @('| Gate | File (.claude/cache/e2e/) | Result | Verdict |','|---|---|---|---|') +
      ($Results | ForEach-Object { "| $($_.gate) | $($_.file) | $($_.result) | $(if ($_.pass) {'PASS'} else {'FAIL'}) |" })
$md | Set-Content "$sum.md" -Encoding utf8
Write-Host "`nSummary: $sum.md (paste into the PR 'Deferred Windows gates' section)"
if (@($Results | Where-Object { -not $_.pass }).Count) { exit 1 } else { exit 0 }
