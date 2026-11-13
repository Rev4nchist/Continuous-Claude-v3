using namespace System.Management.Automation.Language
# Wiring test for the land-outcomes ledger in land-pr.ps1: after a merge THIS run made, one JSON line goes to the ledger.
# Run: pwsh -NoProfile -File scripts/github/land-pr-ledger.test.ps1
#
# land-pr.ps1 runs as a child process (a copy in a temp "own root", as in land-pr-recheck.test.ps1) with stub gh.cmd and node.cmd
# first on PATH, always with -NoSync. No real gh, review, merge or sync runs.
#   stub gh:   serves the PR (labels, branch, head and merge_commit_sha per case). A PUT to .../merge writes merge.flag, prints
#              merge-out.txt (and merge-err.txt on stderr), exits with merge-exit.txt, and can make the remote unreachable.
#              Check runs and statuses are green, so -IgnoreReview can merge.
#   stub node: review-status.mjs prints the case's ready JSON; land-recheck, land-none-check, migration-gate and land-decision answer
#              what the case sets; the read of the required CI job names answers the names read once from review-status.mjs.
#   every gh and node call appends one word to calls.log, so the calls between the merge and the next PR read are known.
# Every case points CCV3_LAND_LOCK, CCV3_LAND_LOCK_LOG, CCV3_SYNC_CURSOR, LOCAL_REVIEW_STATE_DIR and (except L6a) CCV3_LAND_LEDGER at
# its temp folder. decisions.enforce is true in every temp repo. The real ~/.claude/state is never written; L15 only reads whether the
# real ledger file exists, its size and its write time, at the start and at the end.
#
# Failure modes:
#   no line after a merge, a wrong key order or a wrong value                       -> L1a (required coderabbit), L1b (none), L1c (greptile
#                                                                                      plus coderabbit, rounds not a number), L1d (no routing)
#   ts not in the toISOString form (three fraction digits, Z)                        -> L1a
#   labels not sorted ordinal, one label written as a string, [] and absent mixed up -> L1a, L1b, L1c, L2
#   the line is written before the tap is used up                                    -> L1a (the use call sees no ledger file)
#   "not read" under -IgnoreReview written as 0 or [], or the switch as an object    -> L2
#   a failed write stops or changes the land                                         -> L3a (a folder at the path), L3b (a read-only file),
#                                                                                      L3c (a file where the folder goes)
#   a re-run of a merged PR, or -CleanupOnly, adds a line                            -> L4a, L4b
#   a refused land writes a line                                                     -> L5
#   a run with only the lock variable set writes elsewhere (the real home); the ledger variable is ignored -> L6a, L6b
#   the wrong engine record (write time, tie, temp file, trace file, other file type), a slug that leaves the root, an absolute or
#   backslash path                                                                   -> L7a, L7b, L7c, L7d
#   routing present without a required ARRAY read as a list (not "not read")        -> L1e (routing {}: reviewers null)
#   a merge answer that is not JSON breaks the line                                  -> L8a
#   a failed call counted as this run's merge without proof, or the sha of another merge kept: mergeCall "failed-but-merged"
#   needs the checked head and a merged_at no earlier than 120 s before the call     -> L8b (fresh, same head: failed-but-merged + sha),
#                                                                                      L8c (another head), L8e (old merged_at),
#                                                                                      L8f (no merged_at), L8g (merged_at not a date):
#                                                                                      merged-elsewhere, mergeSha null
#   a stderr line in the merge answer hides the sha of the JSON answer                -> L8d
#   two lands run their lines together, or write CR or a BOM                        -> L9
#   a line holds a home path, a drive path or the user name                         -> L10
#   the ledger step starts a program, exits, calls Fail, or changes $LASTEXITCODE   -> L11a (calls.log: only the tap use between the merge
#                                                                                      and the next PR read), L11b (AST scan), L11c (the real
#                                                                                      ledger-step text run alone with $LASTEXITCODE 37)
#   a later line reads $? and so sees the state the ledger step left                -> L11d
#   a merged PR whose fetch fails gets no line                                       -> L12
#   a partial last line (no LF) from an earlier crash runs into the new line         -> L13
#   a reader that holds the ledger with write-share makes the write fail, or another writer's handle does -> L14a, L14b
#   a reader that holds it WITHOUT write-share: the write cannot happen (Windows), so it must warn and leave the land alone -> L14c
#   a run of this test writes the real ledger                                        -> L15
#   the land step's slug drifts from branchSlug in record.mjs (/, space, non-ASCII, the Kelvin sign that a case-blind replace keeps,
#   a surrogate pair, a dot before /, a trailing dot, CON, "..", "a..b", ".", ""); the record files differ from readJsonFiles -> L16
#   a lock value that is a bare file name gives an empty folder, so every land warns -> L17 (the ledger-path statement, read from the
#   syntax tree, run in a temp current folder: the line goes to land-outcomes.jsonl there). Function level, not a full land: the lock
#   code itself refuses a bare name (New-Item -Path '' throws in Enter-LandLock, so the land stops before the merge).
# What L11 cannot prove: L11a sees only gh and node (git is real, not logged); L11b reads the text, so a program started through .NET
# under a name it does not list would pass it; L11c runs the step outside the land, with values set by this file.
# L16 drives Get-LandEngineRecord read from the land step's syntax tree (no copy in this file), not a full land, to keep the run short.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'land-pr.ps1'
$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}

$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ('land-pr-ledger-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$oldPath = $env:PATH
# Every variable this file sets. The caller's values are saved, cleared for the run, and put back at the end.
$envNames = 'CCV3_LAND_LOCK', 'CCV3_LAND_LOCK_LOG', 'CCV3_SYNC_CURSOR', 'LOCAL_REVIEW_STATE_DIR', 'CCV3_LAND_LEDGER'
$oldEnv = @{}
foreach ($n in $envNames) { $oldEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
$sha = '0123456789abcdef0123456789abcdef01234567'
$mergeSha = 'fedcba9876543210fedcba9876543210fedcba98'
$againSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
$otherHead = '9999999999999999999999999999999999999999'
$repoName = 'Rev4nchist/Continuous-Claude-v3'
$prUrl = "repos/$repoName/pulls/7"
$keyOrder = 'schema,ts,pr,repo,headSha,mergeSha,mergeCall,method,band,labels,reviewers,engineRecord,crRounds,ignoreReview,waiver'
$ledgerFiles = [System.Collections.Generic.List[string]]::new()
$readOnly = [System.Collections.Generic.List[string]]::new()
$defaultReady = @{ routing = @{ required = @('coderabbit') }; coderabbitReviews = 1; coderabbitRounds = 2 }
# L15: the real ledger, read only. Exists, size and write time at the start; the end must match.
$realLedger = Join-Path $HOME '.claude\state\land-outcomes.jsonl'
function Get-RealLedgerState {
  $i = if (Test-Path -LiteralPath $realLedger -PathType Leaf) { Get-Item -LiteralPath $realLedger -Force } else { $null }
  if ($i) { "exists size=$($i.Length) time=$($i.LastWriteTimeUtc.ToString('o'))" } else { 'absent' }
}
$realBefore = Get-RealLedgerState

# A stub dir plus a throwaway repo with a bare remote `fork`, so a merge that goes through can finish.
#   -Labels      label names of the PR (-NoLabels: no labels field at all)
#   -Merged      the PR is already merged before this run
#   -MergeOut    what the merge call prints; -MergeErr a line it prints on stderr; -MergeExit its exit code
#   -AgainSha    the merge_commit_sha of the PR read after a merge; -AgainHead the head sha of that read (default: the checked head)
#   -AgainAt     the merged_at of that read: 'now' (the UTC time when the case is made, just before its run), a literal text, or '' (none)
#   -BreakRemote the merge call renames the bare remote, so every later fetch fails
#   -Ready       the ready-check JSON fields on top of ready/head/mergeable_state/reasons
function New-Case([string]$name, [string]$Branch = 'fix/ledger-wiring', [string[]]$Labels = @('risk:r2', 'alpha', 'Zeta'), [switch]$NoLabels,
  [switch]$Merged, [string]$MergeOut = '', [string]$MergeErr = '', [int]$MergeExit = 0, [string]$AgainSha = '', [string]$AgainHead = '',
  [string]$AgainAt = '', [switch]$BreakRemote, [hashtable]$Ready = $null, [int]$RecheckExit = 0) {
  $dir = Join-Path $work $name; $stub = Join-Path $dir 'stub'; $repo = Join-Path $dir 'repo'; $remote = Join-Path $dir 'fork.git'
  New-Item -ItemType Directory -Force -Path $stub, $repo | Out-Null
  git init -q -b main $repo 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
  git -C $repo add -A 2>&1 | Out-Null
  git -C $repo -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c core.hooksPath=NUL commit -q -m init 2>&1 | Out-Null
  git init -q --bare -b main $remote 2>&1 | Out-Null
  git -C $repo remote add fork $remote
  git -C $repo push -q fork main 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'review-router.config.json') -Value '{ "decisions": { "enforce": true } }'
  $pull = {
    param($m)
    $o = [ordered]@{ merged = $m; head = [ordered]@{ ref = $Branch; sha = $(if ($m -and $AgainHead) { $AgainHead } else { $sha }) } }
    if (-not $NoLabels) { $o.labels = @($Labels | ForEach-Object { @{ name = $_ } }) }
    if ($m -and $AgainSha) { $o.merge_commit_sha = $AgainSha }
    if ($m -and $AgainAt) { $o.merged_at = $(if ($AgainAt -eq 'now') { [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) } else { $AgainAt }) }
    $o | ConvertTo-Json -Compress -Depth 5
  }
  Set-Content -LiteralPath (Join-Path $stub 'pull.json') -Value (& $pull ([bool]$Merged))
  Set-Content -LiteralPath (Join-Path $stub 'merged.json') -Value (& $pull $true)
  if ($null -eq $Ready) { $Ready = $defaultReady }
  $st = [ordered]@{ ready = $true; head = $sha; mergeable_state = 'clean'; reasons = @() }
  foreach ($k in $Ready.Keys) { $st[$k] = $Ready[$k] }
  Set-Content -LiteralPath (Join-Path $stub 'status.json') -Value ($st | ConvertTo-Json -Compress -Depth 5)
  if (-not $MergeOut) { $MergeOut = '{"sha":"' + $mergeSha + '","merged":true,"message":"Pull Request successfully merged"}' }
  Set-Content -LiteralPath (Join-Path $stub 'merge-out.txt') -Value $MergeOut
  if ($MergeErr) { Set-Content -LiteralPath (Join-Path $stub 'merge-err.txt') -Value $MergeErr }
  if ($BreakRemote) { Set-Content -LiteralPath (Join-Path $stub 'break-remote.flag') -Value 'x' }
  Set-Content -LiteralPath (Join-Path $stub 'merge-exit.txt') -Value $MergeExit
  Set-Content -LiteralPath (Join-Path $stub 'recheck-exit.txt') -Value $RecheckExit
  Set-Content -LiteralPath (Join-Path $stub 'runs-slurp.json') -Value $greenRunsSlurp
  Set-Content -LiteralPath (Join-Path $stub 'req-names.json') -Value $requiredNamesJson
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    "if `"%~1`"==`"api`" if `"%~2`"==`"--paginate`" if `"%~3`"==`"--slurp`" if `"%~4`"==`"repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/check-runs?per_page`" goto runs",
    "if `"%~1`"==`"api`" if `"%~2`"==`"--paginate`" if `"%~3`"==`"--slurp`" if `"%~4`"==`"repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/status?per_page`" goto status",
    'echo stub gh: unexpected arguments: %* 1>&2',
    'echo gh-unexpected>> "%~dp0calls.log"',
    'exit /b 1',
    ':runs',
    'echo gh-runs>> "%~dp0calls.log"',
    'type "%~dp0runs-slurp.json"',
    'exit /b 0',
    ':status',
    'echo gh-status>> "%~dp0calls.log"',
    'echo [{"state":"success","total_count":0,"statuses":[]}]',
    'exit /b 0',
    ':merge',
    'echo gh-merge>> "%~dp0calls.log"',
    'echo merged> "%~dp0merge.flag"',
    'if exist "%~dp0break-remote.flag" ren "%~dp0..\fork.git" fork-gone.git',
    'if exist "%~dp0merge-err.txt" type "%~dp0merge-err.txt" 1>&2',
    'type "%~dp0merge-out.txt"',
    'set /p mcode=<"%~dp0merge-exit.txt"',
    'exit /b %mcode%',
    ':pull',
    'echo gh-pull>> "%~dp0calls.log"',
    'if exist "%~dp0merge.flag" (type "%~dp0merged.json") else (type "%~dp0pull.json")',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"review-status" >nul && goto rs',
    'echo %~1| findstr /c:"land-recheck" >nul && goto lr',
    'echo %~1| findstr /c:"land-none-check" >nul && goto ln',
    'echo %~1| findstr /c:"migration-gate" >nul && goto mg',
    'echo %~1| findstr /c:"land-decision" >nul && goto ld',
    'echo %~1| findstr /c:"input-type" >nul && goto rq',
    'echo stub node: unexpected arguments: %* 1>&2',
    'echo node-unexpected>> "%~dp0calls.log"',
    'exit /b 9',
    ':rq',
    'echo node-names>> "%~dp0calls.log"',
    'type "%~dp0req-names.json"',
    'exit /b 0',
    ':rs',
    'echo node-status>> "%~dp0calls.log"',
    'type "%~dp0status.json"',
    'exit /b 0',
    ':lr',
    'echo node-recheck>> "%~dp0calls.log"',
    'echo re-check stub: PR 7',
    'set /p code=<"%~dp0recheck-exit.txt"',
    'exit /b %code%',
    ':mg',
    'echo node-gate>> "%~dp0calls.log"',
    'echo migration gate: stub answer',
    'exit /b 0',
    ':ld',
    'echo node-ld-%~2>> "%~dp0calls.log"',
    'if "%~2"=="use" (if exist "%~dp0merge.flag" (echo use-after-merge>> "%~dp0ld-order.txt") else (echo use-before-merge>> "%~dp0ld-order.txt"))',
    'if "%~2"=="use" (if exist "%CCV3_LAND_LEDGER%" (echo ledger-before-use>> "%~dp0ld-ledger.txt") else (echo no-ledger-at-use>> "%~dp0ld-ledger.txt"))',
    'if "%~2"=="use" exit /b 0',
    'echo land decision: stub ok',
    'exit /b 0',
    ':ln',
    'echo node-none>> "%~dp0calls.log"',
    'exit /b 0')
  $state = Join-Path $dir 'state'
  [pscustomobject]@{
    Dir = $dir; Stub = $stub; Repo = $repo; State = $state; Records = (Join-Path $dir 'local-review')
    Ledger = (Join-Path $dir 'ledger\land-outcomes.jsonl'); BesideLock = (Join-Path $state 'land-outcomes.jsonl')
    Merge = (Join-Path $stub 'merge.flag'); LdOrder = (Join-Path $stub 'ld-order.txt'); LdLedger = (Join-Path $stub 'ld-ledger.txt'); Calls = (Join-Path $stub 'calls.log')
  }
}

# Run the land step on a case. -Ledger overrides the case's ledger path; -NoLedgerVar leaves CCV3_LAND_LEDGER unset (L6a).
function Invoke-Land($case, [string[]]$extra = @(), [string]$Ledger = '', [switch]$NoLedgerVar) {
  $env:PATH = "$($case.Stub);$oldPath"
  $found = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($found -ne (Join-Path $case.Stub 'gh.cmd')) { $env:PATH = $oldPath; throw "harness: gh resolves to '$found', not the stub; stopping before any real gh call" }
  $env:CCV3_LAND_LOCK = Join-Path $case.State 'land.lock'; $env:CCV3_LAND_LOCK_LOG = Join-Path $case.State 'land-lock.log'
  $env:CCV3_SYNC_CURSOR = Join-Path $case.State 'sync-cursor'; $env:LOCAL_REVIEW_STATE_DIR = $case.Records
  if ($NoLedgerVar) { Remove-Item -LiteralPath Env:\CCV3_LAND_LEDGER -ErrorAction SilentlyContinue; $ledgerFiles.Add($case.BesideLock) }
  else { $env:CCV3_LAND_LEDGER = $(if ($Ledger) { $Ledger } else { $case.Ledger }); $ledgerFiles.Add($env:CCV3_LAND_LEDGER) }
  # The script runs from a copy in a temp "own root" (<case>\own\scripts\github), so the config of this checkout never decides decisions.enforce.
  $ownGithub = Join-Path $case.Dir 'own\scripts\github'
  New-Item -ItemType Directory -Force -Path $ownGithub | Out-Null
  Copy-Item -LiteralPath $script -Destination (Join-Path $ownGithub 'land-pr.ps1') -Force
  try { $out = & pwsh -NoProfile -File (Join-Path $ownGithub 'land-pr.ps1') -Pr 7 -NoSync -RepoPath $case.Repo @extra 2>&1; $code = $LASTEXITCODE }
  finally { $env:PATH = $oldPath }
  $lines = @($out | ForEach-Object { "$_" })
  [pscustomobject]@{
    Code = $code; Text = ($out | Out-String); Lines = $lines
    Landed = (@($lines | Where-Object { $_ -like '*LANDED #7:*' }) | Select-Object -First 1)
    Warn = @($lines | Where-Object { $_ -match 'WARNING: land ledger not written \(' })
    LedgerText = @($lines | Where-Object { $_ -match 'land ledger|land-outcomes' })
  }
}
function Get-LedgerLines([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }
  @([System.IO.File]::ReadAllText($path) -split "`n" | Where-Object { $_ -ne '' })
}
function ConvertFrom-Line([string]$line) { try { $line | ConvertFrom-Json -ErrorAction Stop } catch { $null } }
function Read-Text([string]$path) { if (Test-Path -LiteralPath $path) { (Get-Content -LiteralPath $path -Raw).Trim() } else { '' } }
function Set-WriteTime([string]$dir, [string]$name, [datetime]$utc) {
  $f = Join-Path $dir $name
  Set-Content -LiteralPath $f -Value '{}'
  (Get-Item -LiteralPath $f -Force).LastWriteTimeUtc = $utc
}
# One merged land with one line: exit 0, merge.flag, a LANDED line and exactly one ledger line. Returns the raw line ('' when not one).
function Get-OneLine($id, $case, $run, [string]$path) {
  $lines = @(Get-LedgerLines $path)
  Check "$id the land goes on: exit 0, merge call made, LANDED printed" ($run.Code -eq 0 -and (Test-Path -LiteralPath $case.Merge) -and $run.Landed)
  Check "$id exactly one ledger line, and it parses as JSON" ($lines.Count -eq 1 -and $null -ne (ConvertFrom-Line $lines[0]))
  if ($lines.Count -eq 1) { $lines[0] } else { Write-Host "---- $id output ----"; Write-Host $run.Text; '' }
}
function Test-Has([string]$line, [string[]]$parts) { foreach ($p in $parts) { if (-not $line.Contains($p)) { return $false } }; $true }

try {
  New-Item -ItemType Directory -Path $work | Out-Null
  foreach ($n in $envNames) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
  # Stubs only: the -IgnoreReview branch needs every required CI job green on the head and a read of their names. The names come from
  # review-status.mjs of this checkout, read once with the real node (this file holds no copy), as land-pr-recheck.test.ps1 does.
  $realNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $reviewStatusUrl = ([Uri](Join-Path $PSScriptRoot 'review-status.mjs')).AbsoluteUri
  $requiredNamesJson = ('import(process.argv.at(-1)).then(m => console.log(JSON.stringify(m.REQUIRED_CHECK_RUNS)))' | & $realNode --input-type=module - $reviewStatusUrl) -join ''
  $requiredNames = @($requiredNamesJson | ConvertFrom-Json)
  if ($requiredNames.Count -lt 1) { throw 'harness: could not read REQUIRED_CHECK_RUNS from review-status.mjs' }
  $greenRuns = @($requiredNames | ForEach-Object -Begin { $i = 100 } -Process { $i++; @{ id = $i; name = $_; status = 'completed'; conclusion = 'success'; app = @{ slug = 'github-actions' }; details_url = "https://github.com/Rev4nchist/Continuous-Claude-v3/actions/runs/500/job/$i" } })
  $greenRunsSlurp = '[' + (@{ total_count = $greenRuns.Count; check_runs = $greenRuns } | ConvertTo-Json -Compress -Depth 6) + ']'

  # L1a: the ready path with routing.required = [coderabbit] and one finished CodeRabbit review: all 15 keys, in order, with the stub values.
  $c = New-Case 'l1a'
  $t0 = [DateTime]::UtcNow; $r = Invoke-Land $c; $t1 = [DateTime]::UtcNow
  $line = Get-OneLine 'L1a' $c $r $c.Ledger
  $o = ConvertFrom-Line $line
  Check 'L1a the keys are the 15 keys of schema 1, in order' ($o -and ($o.PSObject.Properties.Name -join ',') -ceq $keyOrder)
  Check 'L1a schema, pr, repo, headSha, mergeSha (from the merge answer), mergeCall ok and method are the stub values' (Test-Has $line @('"schema":1,', '"pr":7,', "`"repo`":`"$repoName`"", "`"headSha`":`"$sha`"", "`"mergeSha`":`"$mergeSha`"", '"mergeCall":"ok"', '"method":"merge"'))
  Check 'L1a labels are sorted ordinal (upper case first)' ($line.Contains('"labels":["Zeta","alpha","risk:r2"]'))
  Check 'L1a reviewers is [coderabbit] once (required and a finished review do not double it)' ($line.Contains('"reviewers":["coderabbit"]'))
  Check 'L1a crRounds is the ready-check coderabbitRounds (2)' ($line.Contains('"crRounds":2,'))
  Check 'L1a band, waiver and engineRecord (no record folder) are null; ignoreReview is false' (Test-Has $line @('"band":null', '"waiver":null', '"engineRecord":null', '"ignoreReview":false'))
  $m = [regex]::Match($line, '"ts":"([^"]*)"')
  $ts = [DateTime]::MinValue
  $tsOk = $m.Success -and $m.Groups[1].Value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -and
    [DateTime]::TryParse($m.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$ts)
  Check 'L1a ts is the toISOString form (three fraction digits, Z), UTC, inside the run' ($tsOk -and $ts.Kind -eq [DateTimeKind]::Utc -and $ts -ge $t0.AddSeconds(-5) -and $ts -le $t1.AddSeconds(5))
  Check 'L1a the tap was used up after the merge, and no ledger file existed when it was' ((Read-Text $c.LdOrder) -eq 'use-after-merge' -and (Read-Text $c.LdLedger) -eq 'no-ledger-at-use')
  Check 'L1a a good write prints no ledger text' ($r.LedgerText.Count -eq 0)
  # L11a: the ledger step starts no gh and no node: between the merge call and the next PR read only the tap use runs.
  $calls = @(Get-Content -LiteralPath $c.Calls | ForEach-Object { $_.Trim() })
  $iMerge = [array]::IndexOf($calls, 'gh-merge')
  $iPull = if ($iMerge -ge 0) { [array]::IndexOf($calls, 'gh-pull', $iMerge) } else { -1 }
  $between = if ($iMerge -ge 0 -and $iPull -gt $iMerge + 1) { @($calls[($iMerge + 1)..($iPull - 1)] | Where-Object { $_ }) } else { @('<no merge, no later PR read, or nothing between>') }
  Check 'L11a between the merge call and the next PR read only the tap use runs (no gh, no node from the ledger step)' (($between -join ',') -eq 'node-ld-use')

  # L1b: routing.required empty and no finished CodeRabbit review: reviewers [none]; crRounds 0 is a real 0; one label stays an array.
  $c = New-Case 'l1b' -Labels @('solo') -Ready @{ routing = @{ required = @() }; coderabbitReviews = 0; coderabbitRounds = 0 }
  $line = Get-OneLine 'L1b' $c (Invoke-Land $c) $c.Ledger
  Check 'L1b reviewers is [none], crRounds is 0, and one label is still an array' (Test-Has $line @('"reviewers":["none"]', '"crRounds":0,', '"labels":["solo"]'))

  # L1c: required [greptile] plus two finished CodeRabbit reviews: coderabbit is added; rounds that are not a number give null; no labels gives [].
  $c = New-Case 'l1c' -Labels @() -Ready @{ routing = @{ required = @('greptile') }; coderabbitReviews = 2; coderabbitRounds = 'x' }
  $line = Get-OneLine 'L1c' $c (Invoke-Land $c) $c.Ledger
  Check 'L1c reviewers is [greptile, coderabbit], crRounds is null, labels is []' (Test-Has $line @('"reviewers":["greptile","coderabbit"]', '"crRounds":null', '"labels":[]'))

  # L1d: a ready-check JSON without routing and without coderabbitRounds: reviewers and crRounds are null (not read), never [] or 0.
  $c = New-Case 'l1d' -Ready @{ coderabbitReviews = 1 }
  $line = Get-OneLine 'L1d' $c (Invoke-Land $c) $c.Ledger
  Check 'L1d reviewers and crRounds are null when the ready JSON has no routing' (Test-Has $line @('"reviewers":null', '"crRounds":null'))

  # L1e: routing present but without a required array (routing {}): reviewers is "not read" (null), not [none].
  $c = New-Case 'l1e' -Ready @{ routing = @{}; coderabbitReviews = 1; coderabbitRounds = 1 }
  $line = Get-OneLine 'L1e' $c (Invoke-Land $c) $c.Ledger
  Check 'L1e routing {} gives reviewers null' ($line.Contains('"reviewers":null'))

  # L2: -IgnoreReview: nothing of the review was read, so crRounds and reviewers are null; ignoreReview is a real true; no labels field gives null.
  $c = New-Case 'l2' -NoLabels
  $line = Get-OneLine 'L2' $c (Invoke-Land $c @('-IgnoreReview')) $c.Ledger
  $o = ConvertFrom-Line $line
  Check 'L2 crRounds and reviewers are null, ignoreReview is true (a bool, not a switch object)' ((Test-Has $line @('"crRounds":null', '"reviewers":null', '"ignoreReview":true')) -and $o -and $o.ignoreReview -is [bool])
  Check 'L2 a PR with no labels field gives labels null' ($line.Contains('"labels":null'))

  # L3: a failed write never changes the land. Each case lands once with a good ledger, then again (merge.flag removed) with a bad one.
  foreach ($sub in 'a', 'b', 'c') {
    $id = "L3$sub"
    $c = New-Case "l3$sub"
    $good = Invoke-Land $c
    Check "$id harness: the good run landed with one line and printed no ledger text" ($good.Code -eq 0 -and $good.Landed -and @(Get-LedgerLines $c.Ledger).Count -eq 1 -and $good.LedgerText.Count -eq 0)
    Remove-Item -LiteralPath $c.Merge, $c.LdOrder -ErrorAction SilentlyContinue
    $blocker = Join-Path $c.Dir 'blocker'
    switch ($sub) {
      'a' { $bad = Join-Path $c.Dir 'ledger-is-a-folder'; New-Item -ItemType Directory -Path $bad | Out-Null }
      'b' { $bad = Join-Path $c.Dir 'read-only.jsonl'; [System.IO.File]::WriteAllText($bad, ''); (Get-Item -LiteralPath $bad).IsReadOnly = $true; $readOnly.Add($bad) }
      'c' { Set-Content -LiteralPath $blocker -Value 'a file where the ledger folder goes'; $bad = Join-Path $blocker 'sub\land-outcomes.jsonl' }
    }
    $r = Invoke-Land $c -Ledger $bad
    Check "$id exit 0 and the merge call was made" ($r.Code -eq 0 -and (Test-Path -LiteralPath $c.Merge))
    Check "$id the tap was used up after the merge" ((Read-Text $c.LdOrder) -eq 'use-after-merge')
    Check "$id the LANDED line is byte-equal to the run with a good ledger" ($r.Landed -and $r.Landed -ceq $good.Landed)
    Check "$id exactly one line says the ledger was not written" ($r.Warn.Count -eq 1)
    $rest = @($r.Lines | Where-Object { $_ -notmatch 'WARNING: land ledger not written \(' }) -join "`n"
    Check "$id apart from that line, the console text is byte-equal to the run with a good ledger" ($rest -ceq ($good.Lines -join "`n"))
    $noLine = switch ($sub) {
      'a' { (Test-Path -LiteralPath $bad -PathType Container) -and @(Get-ChildItem -LiteralPath $bad -Force).Count -eq 0 }
      'b' { (Get-Item -LiteralPath $bad).Length -eq 0 }
      'c' { (Test-Path -LiteralPath $blocker -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $blocker 'sub')) }
    }
    Check "$id no ledger line was added" ([bool]$noLine)
    if ($sub -eq 'b') { (Get-Item -LiteralPath $bad).IsReadOnly = $false }
    if ($fail) { Write-Host "---- $id output ----"; Write-Host $r.Text }
  }

  # L4: a run on an already merged PR, and a -CleanupOnly run, make no merge and add no line.
  foreach ($v in @(@('l4a', @()), @('l4b', @('-CleanupOnly')))) {
    $id = 'L4' + $v[0].Substring(2)
    $c = New-Case $v[0] -Merged
    $r = Invoke-Land $c $v[1]
    Check "$id the run lands (exit 0, LANDED) without a merge call" ($r.Code -eq 0 -and $r.Landed -and -not (Test-Path -LiteralPath $c.Merge))
    Check "$id no ledger file" (-not (Test-Path -LiteralPath $c.Ledger))
  }

  # L5: a refused land (the re-check exits 1) merges nothing and writes no line.
  $c = New-Case 'l5' -RecheckExit 1
  $r = Invoke-Land $c
  Check 'L5 the land is refused: exit 1, no merge call' ($r.Code -eq 1 -and -not (Test-Path -LiteralPath $c.Merge) -and $r.Text -match 'pre-merge re-check refused')
  Check 'L5 no ledger file' (-not (Test-Path -LiteralPath $c.Ledger))

  # L6: the path rule. Only the lock variable set: the ledger is beside the lock. The ledger variable set: the file is there, and nothing is beside the lock.
  $c = New-Case 'l6a'
  $r = Invoke-Land $c -NoLedgerVar
  [void](Get-OneLine 'L6a' $c $r $c.BesideLock)
  $c = New-Case 'l6b'
  $custom = Join-Path $c.Dir 'custom\out.jsonl'
  $r = Invoke-Land $c -Ledger $custom
  [void](Get-OneLine 'L6b' $c $r $custom)
  Check 'L6b nothing is written beside the lock when the ledger variable is set' (-not (Test-Path -LiteralPath $c.BesideLock))

  # L7a: branch "fix/a b" maps to slug fix-a-b. The newer write time wins over the greater name; a record still being written
  # (.<runId>.<pid>.tmp, the form record.mjs writes), a trace file and a non-json file are no record.
  $c = New-Case 'l7a' -Branch 'fix/a b'
  $rec = Join-Path $c.Records "fix-a-b\$sha"; New-Item -ItemType Directory -Force -Path $rec | Out-Null
  Set-WriteTime $rec 'b-run.json' ([datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
  Set-WriteTime $rec 'a-run.json' ([datetime]::new(2026, 1, 2, 0, 0, 0, [DateTimeKind]::Utc))
  foreach ($n in '.c-run.1234.tmp', 'z-run.trace.json', 'zz-run.txt') { Set-WriteTime $rec $n ([datetime]::new(2026, 1, 3, 0, 0, 0, [DateTimeKind]::Utc)) }
  $line = Get-OneLine 'L7a' $c (Invoke-Land $c) $c.Ledger
  Check 'L7a engineRecord is slug/head/file of the newest record, with forward slashes' ($line.Contains("`"engineRecord`":`"fix-a-b/$sha/a-run.json`""))
  Check 'L7a reviewers then holds engine after the bots' ($line.Contains('"reviewers":["coderabbit","engine"]'))
  # L7b: a tie on write time: the greater name by ordinal compare wins ("m" > "N" ordinal; a case-blind compare picks "N"). Under -IgnoreReview reviewers is [engine].
  $c = New-Case 'l7b' -Branch 'plain-branch'
  $rec = Join-Path $c.Records "plain-branch\$sha"; New-Item -ItemType Directory -Force -Path $rec | Out-Null
  foreach ($n in 'N-run.json', 'm-run.json') { Set-WriteTime $rec $n ([datetime]::new(2026, 1, 5, 0, 0, 0, [DateTimeKind]::Utc)) }
  $line = Get-OneLine 'L7b' $c (Invoke-Land $c @('-IgnoreReview')) $c.Ledger
  Check 'L7b a tie on write time picks the greater name (ordinal)' ($line.Contains("`"engineRecord`":`"plain-branch/$sha/m-run.json`""))
  Check 'L7b -IgnoreReview with a record: reviewers is [engine], crRounds null' (Test-Has $line @('"reviewers":["engine"]', '"crRounds":null'))
  # L7c: a branch with ".." gives null (branchSlug refuses it), even when a folder of that name holds a record; the land goes on.
  $c = New-Case 'l7c' -Branch 'a..b'
  $rec = Join-Path $c.Records "a..b\$sha"; New-Item -ItemType Directory -Force -Path $rec | Out-Null
  Set-WriteTime $rec 'r.json' ([datetime]::new(2026, 1, 6, 0, 0, 0, [DateTimeKind]::Utc))
  $line = Get-OneLine 'L7c' $c (Invoke-Land $c) $c.Ledger
  Check 'L7c a branch with ".." gives engineRecord null and no engine reviewer' (Test-Has $line @('"engineRecord":null', '"reviewers":["coderabbit"]'))
  # L7d: a branch whose slug is only dots gives null; without that rule "." would read <root>\<head>.
  $c = New-Case 'l7d' -Branch '.'
  $rec = Join-Path $c.Records $sha; New-Item -ItemType Directory -Force -Path $rec | Out-Null
  Set-WriteTime $rec 'r.json' ([datetime]::new(2026, 1, 6, 0, 0, 0, [DateTimeKind]::Utc))
  $line = Get-OneLine 'L7d' $c (Invoke-Land $c) $c.Ledger
  Check 'L7d a slug of only dots gives engineRecord null' ($line.Contains('"engineRecord":null'))

  # L8a: a merge answer that is not JSON: one line, mergeSha null, mergeCall ok (the call itself exited 0).
  $c = New-Case 'l8a' -MergeOut 'merge accepted (stub text, not JSON)'
  $line = Get-OneLine 'L8a' $c (Invoke-Land $c) $c.Ledger
  Check 'L8a mergeSha is null and mergeCall is ok' (Test-Has $line @('"mergeSha":null', '"mergeCall":"ok"'))
  # L8b: the merge call exits non-zero but the PR read after it says merged at the checked head, with a merged_at taken just before
  # the run (inside the 120 s margin before the call): failed-but-merged, and mergeSha is that read's merge_commit_sha.
  $c = New-Case 'l8b' -MergeOut 'HTTP 502: Bad Gateway (stub)' -MergeExit 1 -AgainSha $againSha -AgainAt 'now'
  $line = Get-OneLine 'L8b' $c (Invoke-Land $c) $c.Ledger
  Check 'L8b a fresh merged_at at the checked head: mergeCall failed-but-merged, mergeSha the second read''s sha' (Test-Has $line @("`"mergeSha`":`"$againSha`"", '"mergeCall":"failed-but-merged"'))
  # L8c, L8e, L8f, L8g: the merge cannot be tied to this run: merged-elsewhere, mergeSha null, headSha the checked head, the land goes on.
  #   c: the second read shows another head (fresh merged_at); e: merged_at is old; f: no merged_at; g: merged_at is not a date.
  foreach ($v in @(@('c', $otherHead, 'now'), @('e', '', '2020-01-01T00:00:00Z'), @('f', '', ''), @('g', '', 'not a date'))) {
    $id = "L8$($v[0])"
    $c = New-Case "l8$($v[0])" -MergeOut 'HTTP 502: Bad Gateway (stub)' -MergeExit 1 -AgainSha $againSha -AgainHead $v[1] -AgainAt $v[2]
    $line = Get-OneLine $id $c (Invoke-Land $c) $c.Ledger
    Check "$id mergeCall merged-elsewhere, mergeSha null, headSha the checked head" (Test-Has $line @('"mergeSha":null', '"mergeCall":"merged-elsewhere"', "`"headSha`":`"$sha`""))
  }
  # L8d: the merge call prints its JSON answer and a notice on stderr: mergeSha is still the JSON sha (only text lines are parsed).
  $c = New-Case 'l8d' -MergeErr 'notice: stub line on stderr'
  $line = Get-OneLine 'L8d' $c (Invoke-Land $c) $c.Ledger
  Check 'L8d a stderr line beside the JSON answer: mergeSha is the JSON sha' ($line.Contains("`"mergeSha`":`"$mergeSha`""))

  # L9: two lands into one ledger: two lines, LF only, no BOM, each line parses alone.
  $shared = Join-Path $work 'l9-shared\land-outcomes.jsonl'
  $c = New-Case 'l9a'; $r9a = Invoke-Land $c -Ledger $shared
  $c = New-Case 'l9b'; $r9b = Invoke-Land $c -Ledger $shared
  $bytes = if (Test-Path -LiteralPath $shared) { [System.IO.File]::ReadAllBytes($shared) } else { [byte[]]@() }
  $lf = @($bytes | Where-Object { $_ -eq 10 }).Count
  Check 'L9 both lands exit 0' ($r9a.Code -eq 0 -and $r9b.Code -eq 0)
  Check 'L9 the file holds two lines and ends with LF' ($bytes.Length -gt 0 -and $lf -eq 2 -and $bytes[-1] -eq 10)
  Check 'L9 no CR and no BOM' (-not ($bytes -contains 13) -and -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF))
  $nine = @(Get-LedgerLines $shared)
  Check 'L9 each line parses alone' ($nine.Count -eq 2 -and @($nine | Where-Object { $null -eq (ConvertFrom-Line $_) }).Count -eq 0)

  # L12: a merged PR whose fetch fails (the stub merge makes the remote unreachable) still gets its line: it is written before the fetch.
  $c = New-Case 'l12' -BreakRemote
  $r = Invoke-Land $c
  Check 'L12 the fetch fails after the merge: exit 1, "git fetch failed", merge call made' ($r.Code -eq 1 -and $r.Text -match 'git fetch failed' -and (Test-Path -LiteralPath $c.Merge))
  Check 'L12 exactly one ledger line, and it parses' (@(Get-LedgerLines $c.Ledger).Count -eq 1 -and $null -ne (ConvertFrom-Line @(Get-LedgerLines $c.Ledger)[0]))

  # L13: an earlier partial last line (no LF) gets its LF first, so the new line stands alone.
  $c = New-Case 'l13'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $c.Ledger) | Out-Null
  [System.IO.File]::WriteAllText($c.Ledger, 'partial-no-lf', [System.Text.UTF8Encoding]::new($false))
  $r = Invoke-Land $c
  $text = if (Test-Path -LiteralPath $c.Ledger) { [System.IO.File]::ReadAllText($c.Ledger) } else { '' }
  $tail = if ($text.StartsWith("partial-no-lf`n", [StringComparison]::Ordinal)) { $text.Substring(14) } else { '' }
  Check 'L13 the land goes on (exit 0)' ($r.Code -eq 0 -and $r.Warn.Count -eq 0)
  Check 'L13 the file is the partial text, an LF, then one whole line that parses and ends with LF' ($tail.EndsWith("`n") -and ($tail.TrimEnd("`n")).IndexOf("`n") -lt 0 -and -not $tail.Contains("`r") -and $null -ne (ConvertFrom-Line $tail.TrimEnd("`n")))

  # L14: another process holds the ledger open during the land (this test process holds it; the land is a child process).
  # a: a reader with write-share; b: a handle with write access and write-share. Both: the line is written, no WARNING.
  # c: a reader WITHOUT write-share. Windows then refuses every writer, so the line cannot be written: one WARNING, the land goes on.
  foreach ($v in @(@('a', 'Read', 'ReadWrite'), @('b', 'ReadWrite', 'ReadWrite'), @('c', 'Read', 'Read'))) {
    $id = "L14$($v[0])"
    $c = New-Case "l14$($v[0])"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $c.Ledger) | Out-Null
    [System.IO.File]::WriteAllText($c.Ledger, '')
    $held = [System.IO.File]::Open($c.Ledger, 'Open', $v[1], $v[2])
    try { $r = Invoke-Land $c } finally { $held.Dispose() }
    if ($v[0] -ne 'c') {
      [void](Get-OneLine $id $c $r $c.Ledger)
      Check "$id held with access $($v[1]) and share $($v[2]): no WARNING" ($r.Warn.Count -eq 0)
    } else {
      Check "$id held with share Read only: exit 0, LANDED, exactly one WARNING, no line" ($r.Code -eq 0 -and $r.Landed -and $r.Warn.Count -eq 1 -and (Get-Item -LiteralPath $c.Ledger).Length -eq 0)
    }
  }

  # L11b: the ledger functions and the ledger step, read from the land step's syntax tree, run only plain cmdlets: no program, no & or .,
  # no Fail, no exit. The step is the nearest try statement around the Add-LandOutcome call outside a function, with the line before
  # it and the line after it (the save and the restore of $LASTEXITCODE).
  $tokens = $null; $perr = $null
  $ast = [Parser]::ParseFile($script, [ref]$tokens, [ref]$perr)
  $ledgerFns = 'Get-LandEngineRecord', 'Get-LandMergeCall', 'Get-LandOutcome', 'Add-LandOutcome'
  $fnAsts = @($ast.FindAll({ param($n) $n -is [FunctionDefinitionAst] -and $n.Name -in $ledgerFns }, $true))
  $inFn = { param($n) for ($p = $n.Parent; $p; $p = $p.Parent) { if ($p -is [FunctionDefinitionAst]) { return $true } }; $false }
  # The nearest try statement around the one Add-LandOutcome call outside a function (the held section's outer try also holds it).
  $stepCalls = @($ast.FindAll({ param($n) $n -is [CommandAst] -and $n.GetCommandName() -eq 'Add-LandOutcome' -and -not (& $inFn $n) }, $true))
  $tries = @($stepCalls | ForEach-Object { $p = $_.Parent; while ($p -and $p -isnot [TryStatementAst]) { $p = $p.Parent }; $p } | Where-Object { $_ })
  Check 'L11 harness: the land step parses, and the four ledger functions and one ledger step are found' ($perr.Count -eq 0 -and $fnAsts.Count -eq 4 -and $stepCalls.Count -eq 1 -and $tries.Count -eq 1)
  if ($tries.Count -eq 1 -and $fnAsts.Count -eq 4) {
    $stmts = @($tries[0].Parent.Statements); $iTry = [array]::IndexOf($stmts, $tries[0])
    $step = @($stmts[[Math]::Max(0, $iTry - 1)..[Math]::Min($stmts.Count - 1, $iTry + 1)])
    $bad = foreach ($a in @($fnAsts) + $step) {
      foreach ($cmd in $a.FindAll({ param($n) $n -is [CommandAst] }, $true)) {
        $name = $cmd.GetCommandName()
        if ($cmd.InvocationOperator -ne [TokenKind]::Unknown) { "invocation operator: $($cmd.Extent.Text)" }
        elseif (-not $name) { "dynamic command: $($cmd.Extent.Text)" }
        elseif ($name -in $ledgerFns) { }
        elseif ($name -in 'Start-Process', 'Invoke-Expression', 'Invoke-Command', 'Start-Job', 'Start-ThreadJob' -or -not (Get-Command -Name $name -CommandType Cmdlet -ErrorAction SilentlyContinue)) { "not a plain cmdlet: $name" }
      }
      foreach ($e in $a.FindAll({ param($n) $n -is [ExitStatementAst] }, $true)) { "exit: $($e.Extent.Text)" }
      if ($a.Extent.Text -match 'Diagnostics\.Process|ProcessStartInfo') { 'a .NET process start' }
    }
    Check 'L11b the ledger functions and step start no program, use no & or ., and never exit or call Fail' (@($bad).Count -eq 0)
    @($bad) | ForEach-Object { Write-Host "  found: $_" }
    # L11c: the real ledger-step text, run alone in a child pwsh with $LASTEXITCODE 37, leaves 37 behind, on a good and on a failed write.
    foreach ($v in @(@('good', (Join-Path $work 'l11\good.jsonl')), @('failed', (Join-Path $work 'l11\is-a-folder')))) {
      New-Item -ItemType Directory -Force -Path (Join-Path $work 'l11') | Out-Null
      if ($v[0] -eq 'failed') { New-Item -ItemType Directory -Force -Path $v[1] | Out-Null } else { $ledgerFiles.Add($v[1]) }
      $q = { param($s) "'" + $s.Replace("'", "''") + "'" }
      $pullJson = @{ merged = $false; head = @{ ref = 'fix/ledger-wiring'; sha = $sha }; labels = @(@{ name = 'risk:r2' }) } | ConvertTo-Json -Compress -Depth 5
      $readyJson = @{ ready = $true; head = $sha; routing = @{ required = @('coderabbit') }; coderabbitReviews = 1; coderabbitRounds = 1 } | ConvertTo-Json -Compress -Depth 5
      $body = @(
        '$ErrorActionPreference = ''Stop'''
        @($fnAsts | ForEach-Object { $_.Extent.Text })
        "`$ledgerPath = $(& $q $v[1])"
        "`$pull = $(& $q $pullJson) | ConvertFrom-Json"
        "`$res = $(& $q ('{"sha":"' + $mergeSha + '"}'))"
        '$again = $null; $mergeCallFailed = $false; $mergeCallAt = [DateTime]::UtcNow'
        "`$script:readyJson = $(& $q $readyJson) | ConvertFrom-Json"
        "`$Pr = 7; `$Repo = $(& $q $repoName); `$Method = 'merge'; `$IgnoreReview = [switch]`$false"
        '$global:LASTEXITCODE = 37'
        @($step | ForEach-Object { $_.Extent.Text })
        'Write-Output "EXIT=$global:LASTEXITCODE"'
      ) -join "`n"
      $iso = Join-Path $work "l11\step-$($v[0]).ps1"
      [System.IO.File]::WriteAllText($iso, $body, [System.Text.UTF8Encoding]::new($false))
      $env:LOCAL_REVIEW_STATE_DIR = Join-Path $work 'l11\local-review'
      $isoOut = @(& pwsh -NoProfile -File $iso 2>&1 | ForEach-Object { "$_" })
      $exitLine = @($isoOut | Where-Object { $_ -match '^EXIT=' }) | Select-Object -First 1
      $warn = @($isoOut | Where-Object { $_ -match 'WARNING: land ledger not written \(' }).Count
      $wrote = @(Get-LedgerLines $v[1]).Count
      $okSide = if ($v[0] -eq 'good') { $wrote -eq 1 -and $warn -eq 0 } else { $warn -eq 1 }
      Check "L11c $($v[0]) write: `$LASTEXITCODE is still 37 after the ledger step" ($exitLine -eq 'EXIT=37' -and $okSide)
      if ($exitLine -ne 'EXIT=37' -or -not $okSide) { $isoOut | ForEach-Object { Write-Host "  step: $_" } }
    }
  }
  # L11d: the land step never reads $?, so the success flag the ledger step leaves is never seen. Comments do not count (tokens only).
  Check 'L11d the land step reads $? nowhere' (@($tokens | Where-Object { $_ -is [VariableToken] -and $_.Name -eq '?' }).Count -eq 0)

  # L16 (K5): the drift gate. branchSlug of scripts/github/local-review/record.mjs (this checkout, real node) names the record folder;
  # Get-LandEngineRecord, read from the land step's syntax tree, must find the record there, or give null where branchSlug throws.
  # The names go to node as base64 of UTF-8 JSON, so no argument or pipe encoding can change a non-ASCII name.
  $names = [ordered]@{
    'slash and space' = 'feat/x y'; 'non-ASCII' = "caf$([char]0xE9)"; 'Kelvin sign' = "$([char]0x212A)elvin"
    'surrogate pair' = "emoji$([char]::ConvertFromUtf32(0x1F600))"; 'dot before slash' = 'fix./a'; 'trailing dot' = 'fix.'
    'CON' = 'CON'; 'two dots' = '..'; 'a..b' = 'a..b'; 'one dot' = '.'; 'empty' = ''
  }
  $nameList = [string[]]@($names.Values)
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $nameList -Compress)))
  $recordUrl = ([Uri](Join-Path $PSScriptRoot 'local-review\record.mjs')).AbsoluteUri
  $slugJs = 'import(process.argv.at(-1)).then(m => { const names = JSON.parse(Buffer.from(process.argv.at(-2), "base64").toString("utf8")); console.log(JSON.stringify(names.map((n) => { try { return m.branchSlug(n); } catch { return null; } }))); }, e => { console.error(e.message); process.exit(1); })'
  $slugOut = ($slugJs | & $realNode --input-type=module - $b64 $recordUrl) -join ''
  $nodeSlugs = $slugOut | ConvertFrom-Json -NoEnumerate
  $engineFn = @($fnAsts | Where-Object { $_.Name -eq 'Get-LandEngineRecord' })
  Check 'L16 harness: node answered one slug (or null) per name, and Get-LandEngineRecord was found' ($nodeSlugs -is [array] -and $nodeSlugs.Count -eq $nameList.Count -and $engineFn.Count -eq 1)
  if ($nodeSlugs -is [array] -and $nodeSlugs.Count -eq $nameList.Count -and $engineFn.Count -eq 1) {
    . ([scriptblock]::Create($engineFn[0].Extent.Text))
    $labels = @($names.Keys)
    for ($k = 0; $k -lt $nameList.Count; $k++) {
      $root = Join-Path $work "l16\$k"; New-Item -ItemType Directory -Force -Path $root | Out-Null
      $env:LOCAL_REVIEW_STATE_DIR = $root
      $want = $nodeSlugs[$k]
      if ($null -ne $want) { $recDir = Join-Path (Join-Path $root $want) $sha; New-Item -ItemType Directory -Force -Path $recDir | Out-Null; Set-Content -LiteralPath (Join-Path $recDir 'r.json') -Value '{}' }
      $got = Get-LandEngineRecord $nameList[$k] $sha
      $ok = if ($null -eq $want) { $null -eq $got } else { $got -ceq "$want/$sha/r.json" }
      Check "L16 $($labels[$k]): the land step finds the record where branchSlug puts it (node: $(if ($null -eq $want) { 'throws' } else { $want }))" $ok
      if (-not $ok) { Write-Host "  land step gave: $got" }
    }
    # The record files are those readJsonFiles in record.mjs reads: a dot-named *.json counts (no dot-file skip), a trace file does not.
    $root = Join-Path $work 'l16\files'; $recDir = Join-Path $root "plain\$sha"; New-Item -ItemType Directory -Force -Path $recDir | Out-Null
    $env:LOCAL_REVIEW_STATE_DIR = $root
    Set-WriteTime $recDir 'a.json' ([datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
    Set-WriteTime $recDir '.b.json' ([datetime]::new(2026, 1, 2, 0, 0, 0, [DateTimeKind]::Utc))
    Set-WriteTime $recDir 'c.trace.json' ([datetime]::new(2026, 1, 3, 0, 0, 0, [DateTimeKind]::Utc))
    Check 'L16 files: a dot-named *.json is a record (as in record.mjs), a trace file is not' ((Get-LandEngineRecord 'plain' $sha) -ceq "plain/$sha/.b.json")
  }

  # L17 (S1): a lock value that is a bare file name. The land step's own ledger-path statements (the "$ledgerPath = $null" line and the
  # try after it, read from the syntax tree) and Add-LandOutcome run in a child pwsh whose current folder is a temp folder.
  $pathTries = @($ast.FindAll({ param($n) $n -is [TryStatementAst] -and -not (& $inFn $n) -and @($n.Body.Statements | Where-Object { $_ -is [AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$ledgerPath' }).Count -eq 1 }, $true))
  $addFn = @($fnAsts | Where-Object { $_.Name -eq 'Add-LandOutcome' })
  Check 'L17 harness: one ledger-path try statement and Add-LandOutcome are found' ($pathTries.Count -eq 1 -and $addFn.Count -eq 1)
  if ($pathTries.Count -eq 1 -and $addFn.Count -eq 1) {
    $pStmts = @($pathTries[0].Parent.Statements); $iP = [array]::IndexOf($pStmts, $pathTries[0])
    $cwd = Join-Path $work 'l17-cwd'; New-Item -ItemType Directory -Force -Path $cwd | Out-Null
    $body = @(
      '$ErrorActionPreference = ''Stop'''
      $addFn[0].Extent.Text
      "Set-Location -LiteralPath '$($cwd.Replace("'", "''"))'"
      '$env:CCV3_LAND_LOCK = ''land.lock''; Remove-Item -LiteralPath Env:\CCV3_LAND_LEDGER -ErrorAction SilentlyContinue'
      @($pStmts[[Math]::Max(0, $iP - 1)..$iP] | ForEach-Object { $_.Extent.Text })
      'Add-LandOutcome -Path $ledgerPath -Record ([ordered]@{ schema = 1 })'
      'Write-Output "PATH=$ledgerPath"'
    ) -join "`n"
    $iso = Join-Path $work 'l17-step.ps1'
    [System.IO.File]::WriteAllText($iso, $body, [System.Text.UTF8Encoding]::new($false))
    $isoOut = @(& pwsh -NoProfile -File $iso 2>&1 | ForEach-Object { "$_" })
    $want = Join-Path $cwd 'land-outcomes.jsonl'
    $pathLine = @($isoOut | Where-Object { $_ -like 'PATH=*' }) | Select-Object -First 1
    $ok = $pathLine -eq "PATH=$want" -and @(Get-LedgerLines $want).Count -eq 1 -and @($isoOut | Where-Object { $_ -match 'WARNING: land ledger not written' }).Count -eq 0
    Check 'L17 a bare lock name puts the ledger in the current folder (land-outcomes.jsonl), one line, no WARNING' $ok
    if (-not $ok) { $isoOut | ForEach-Object { Write-Host "  step: $_" } }
  }

  # L10 (K2): no line written in this test holds a drive path, a home folder or the user name (also in JSON-escaped form).
  $all = @($ledgerFiles | Select-Object -Unique | ForEach-Object { Get-LedgerLines $_ })
  $homeTexts = @(@($env:USERPROFILE, $HOME) | Where-Object { $_ } | ForEach-Object { $_; $_.Replace('\', '\\') })
  if ($env:USERNAME -and $env:USERNAME.Length -ge 3) { $homeTexts += $env:USERNAME }
  $leaks = @($all | Where-Object { $l = $_; $_ -match '[A-Za-z]:[\\/]' -or $_ -match 'Users' -or @($homeTexts | Where-Object { $l.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count })
  Check "L10 harness: lines were written to scan ($($all.Count))" ($all.Count -ge 20)
  Check 'L10 no ledger line holds a drive path, Users, the home folder or the user name' ($leaks.Count -eq 0)
  if ($leaks.Count) { $leaks | ForEach-Object { Write-Host "  leak: $_" } }
}
finally {
  $env:PATH = $oldPath
  foreach ($n in $envNames) {
    if ($null -eq $oldEnv[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($n, $oldEnv[$n]) }
  }
  foreach ($f in $readOnly) { try { if (Test-Path -LiteralPath $f) { (Get-Item -LiteralPath $f).IsReadOnly = $false } } catch { } }
  $full = [System.IO.Path]::GetFullPath($work)
  if ((Test-Path -LiteralPath $full) -and $full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-ledger-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
# L15: this run did not create, grow or touch the real ledger (read only: exists, size, write time).
$realAfter = Get-RealLedgerState
Check "L15 the real ledger is unchanged ($realBefore)" ($realAfter -ceq $realBefore)

Write-Host "passed=$pass failed=$fail"
exit $fail
