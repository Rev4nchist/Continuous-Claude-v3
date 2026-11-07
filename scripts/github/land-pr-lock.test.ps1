# Wiring test for the one-lander lock and the hard sync line in land-pr.ps1.
# Run: pwsh -NoProfile -File scripts/github/land-pr-lock.test.ps1
#
# land-pr.ps1 runs as a child process with stub gh.cmd, node.cmd (and bash.cmd, git.cmd where a case needs them)
# first on PATH. No real gh, review, merge or sync runs. Every case points the lock, the lock log and the sync cursor at
# a temp folder through CCV3_LAND_LOCK, CCV3_LAND_LOCK_LOG and CCV3_SYNC_CURSOR: the real ~/.claude/state is never read.
# The lock is taken just before the merge call and released right after the sync-cursor check.
#
# Failure modes (one or more checks each):
#   a fresh lock of a live process does not stop a second lander         -> A1 (STOPPED text, exit 1, no merge, lock untouched)
#   the lock is taken before the ready check, so reads queue behind it   -> A0 (a refusal before the merge never meets the lock)
#   a lock of a dead process blocks every later land                     -> B
#   a live holder is robbed because its lock is old (a hung lander)      -> C (same host: the pid decides, at any age)
#   a reused pid blocks every later land                                 -> C3 (process started after the lock's `started`)
#   another host's lock is never freed, or freed by a pid that means nothing here -> C4 (age), C5 (dead pid, young lock: held)
#   two landers that start together both proceed                         -> D1; two takeovers of one stale lock both proceed -> D2
#   the takeover mutex is missing (D2 can miss: the window is a few ms)  -> D3 (the real lock functions, 6 threads, 25 rounds)
# The holder process (a pwsh this test starts and kills) is the live pid that cases C and C3 name in a lock.
#   a failure or error in the held section leaves the lock behind        -> I1 (error raised), I2 (fast-forward refused)
#   a takeover is silent                                                 -> B, C, G3 (printed line and log line)
#   we delete a lock that another run owns                               -> F
#   an empty or half written lock is stolen from a racer mid-write       -> G1, G2 (G3: old enough, taken over)
#   the sync cursor is not compared, or an unsynced main exits 0         -> H1, H2, H3 (LANDED line first, exit non-zero)
#   -NoSync prints a sync verdict                                        -> H4
#   a cleanup failure keeps the lock, or changes the exit code           -> J (git worktree remove fails with 'Permission denied')
#   a cleanup step that raises is not a warning, or claims "synced" wrongly -> J2, J3, J4
#   an unreadable sync cursor crashes the run before cleanup             -> H5
#   a network blip on a fetch after the merge strands the PR             -> K1 (one failure, retry succeeds), K2 (all fail: 4 calls, then STOPPED)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'land-pr.ps1'
$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}

$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ('land-pr-lock-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
# Run a copy of land-pr.ps1 from a temp "own root" with no review-router.config.json: the script reads decisions.enforce from its own checkout too,
# so the config of this checkout (true after the flag flip) must not turn the land check on in these lock cases.
$ownGithub = Join-Path $work 'own\scripts\github'
New-Item -ItemType Directory -Force -Path $ownGithub | Out-Null
Copy-Item -LiteralPath $script -Destination (Join-Path $ownGithub 'land-pr.ps1') -Force
$script = Join-Path $ownGithub 'land-pr.ps1'
$oldPath = $env:PATH
$realGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$sha = '0123456789abcdef0123456789abcdef01234567'
$branch = 'fix/lock-wiring'
$prUrl = 'repos/Rev4nchist/Continuous-Claude-v3/pulls/7'
$hostName = [Environment]::MachineName
$gitq = @('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL')

function New-Case([string]$name, [int]$recheckExit = 0, [switch]$Sleep, [string]$StealJson = '', [string]$MergedBody = '', [switch]$GitStub, [switch]$Worktree, [int]$FetchFails = 0, [string]$WtList = '') {
  # A stub dir plus a throwaway repo with a bare remote `fork`, so a merge that goes through can finish.
  #   -Sleep      the first read of the PR after the merge waits ~6 s: the lock is held long enough for a racer to meet it.
  #   -StealJson  the same read overwrites the lock file with this text: another run "took" the lock while we held it.
  #   -MergedBody what the stub serves as the merged PR (default: valid JSON). Garbage makes land-pr raise inside the held section.
  #   -GitStub    git.cmd passes through to the real git, except `worktree remove` without --force: it fails with 'Permission denied'
  #               and records whether the lock file existed at that moment.
  #   -Worktree   a clean worktree on the PR branch, so the cleanup step reaches `git worktree remove`.
  #   -FetchFails the first N calls of `git fetch fork --prune` fail (exit 1); fetch-count.txt counts every call. Uses the git stub.
  #   -WtList     what `git worktree list --porcelain` prints (a bad path makes the cleanup step raise). Uses the git stub.
  $dir = Join-Path $work $name; $stub = Join-Path $dir 'stub'; $repo = Join-Path $dir 'repo'; $remote = Join-Path $dir 'fork.git'
  New-Item -ItemType Directory -Force -Path $stub, $repo | Out-Null
  git init -q -b main $repo 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
  git -C $repo add -A 2>&1 | Out-Null
  git -C $repo @gitq commit -q -m init 2>&1 | Out-Null
  git init -q --bare -b main $remote 2>&1 | Out-Null
  git -C $repo remote add fork $remote
  git -C $repo push -q fork main 2>&1 | Out-Null
  if ($Worktree) { git -C $repo worktree add -q (Join-Path $repo '.claude\worktrees\wiring') -b $branch main 2>&1 | Out-Null }
  $pull = { param($merged) (@{ merged = $merged; head = @{ ref = $branch; sha = $sha } } | ConvertTo-Json -Compress) }
  Set-Content -LiteralPath (Join-Path $stub 'pull.json') -Value (& $pull $false)
  Set-Content -LiteralPath (Join-Path $stub 'merged.json') -Value $(if ($MergedBody) { $MergedBody } else { & $pull $true })
  Set-Content -LiteralPath (Join-Path $stub 'status.json') -Value (@{ ready = $true; head = $sha; mergeable_state = 'clean'; reasons = @() } | ConvertTo-Json -Compress)
  Set-Content -LiteralPath (Join-Path $stub 'recheck-exit.txt') -Value $recheckExit
  if ($Sleep) { Set-Content -LiteralPath (Join-Path $stub 'sleep.txt') -Value 'x' }
  if ($StealJson) { Set-Content -LiteralPath (Join-Path $stub 'steal.json') -Value $StealJson }
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    'echo stub gh: unexpected arguments: %* 1>&2',
    'exit /b 1',
    ':merge',
    'echo merged> "%~dp0merge.flag"',
    'echo merged>> "%~dp0merge.log"',
    'echo {}',
    'exit /b 0',
    ':pull',
    'if exist "%~dp0merge.flag" goto post',
    'type "%~dp0pull.json"',
    'exit /b 0',
    ':post',
    'if exist "%~dp0after.flag" goto read',
    'echo x> "%~dp0after.flag"',
    'if exist "%~dp0steal.json" copy /y "%~dp0steal.json" "%CCV3_LAND_LOCK%" >nul',
    'if exist "%~dp0sleep.txt" ping -n 7 127.0.0.1 >nul',
    ':read',
    'type "%~dp0merged.json"',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"review-status" >nul && goto rs',
    'echo %~1| findstr /c:"land-recheck" >nul && goto lr',
    'echo %~1| findstr /c:"land-none-check" >nul && goto ln',
    'echo %~1| findstr /c:"migration-gate" >nul && goto mg',
    'echo stub node: unexpected arguments: %* 1>&2',
    'exit /b 9',
    ':rs',
    'type "%~dp0status.json"',
    'exit /b 0',
    ':lr',
    'echo re-check stub: PR 7',
    'set /p code=<"%~dp0recheck-exit.txt"',
    'exit /b %code%',
    ':mg',
    'exit /b 0',
    ':ln',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'bash.cmd') -Encoding ascii -Value @('@echo off', 'echo stub git bash: sync not run', 'exit /b 0')
  if ($GitStub -or $FetchFails -or $WtList) {
    # One git.cmd for all three modes; each mode is switched on by a file in the stub dir. Everything else goes to the real git.
    if ($GitStub) { Set-Content -LiteralPath (Join-Path $stub 'wt-fail.flag') -Value 'x' }
    if ($FetchFails) { Set-Content -LiteralPath (Join-Path $stub 'fetch-fail-max.txt') -Value $FetchFails }
    if ($WtList) { Set-Content -LiteralPath (Join-Path $stub 'wtlist.txt') -Value $WtList }
    Set-Content -LiteralPath (Join-Path $stub 'git.cmd') -Encoding ascii -Value @(
      '@echo off',
      'echo %*| findstr /c:"fetch fork --prune" >nul && goto fetch',
      'echo %*| findstr /c:"worktree list --porcelain" >nul && goto wl',
      'echo %*| findstr /c:"worktree remove --force" >nul && goto pass',
      'echo %*| findstr /c:"worktree remove" >nul && goto wr',
      ':pass',
      "`"$realGit`" %*",
      'exit /b %errorlevel%',
      ':fetch',
      'if not exist "%~dp0fetch-fail-max.txt" goto pass',
      'set n=0',
      'if exist "%~dp0fetch-count.txt" set /p n=<"%~dp0fetch-count.txt"',
      'set /a n+=1',
      '>"%~dp0fetch-count.txt" echo %n%',
      'set /p max=<"%~dp0fetch-fail-max.txt"',
      'if %n% LEQ %max% exit /b 1',
      'goto pass',
      ':wl',
      'if not exist "%~dp0wtlist.txt" goto pass',
      'type "%~dp0wtlist.txt"',
      'exit /b 0',
      ':wr',
      'if not exist "%~dp0wt-fail.flag" goto pass',
      'if exist "%CCV3_LAND_LOCK%" (echo held> "%~dp0lock-held-at-cleanup.flag") else (echo free> "%~dp0lock-free-at-cleanup.flag")',
      "echo error: failed to delete 'node_modules': Permission denied 1>&2",
      'exit /b 1')
  }
  [pscustomobject]@{ Name = $name; Stub = $stub; Repo = $repo; Merge = (Join-Path $stub 'merge.flag'); MergeLog = (Join-Path $stub 'merge.log') }
}

# One lock file, one lock log and one cursor file per case, all under $work.
function New-Paths([string]$name) {
  $d = Join-Path $work "$name-state"; New-Item -ItemType Directory -Force -Path $d | Out-Null
  [pscustomobject]@{ Lock = (Join-Path $d 'land.lock'); Log = (Join-Path $d 'land-lock.log'); Cursor = (Join-Path $d 'sync-cursor') }
}
function Set-LandEnv($case, $paths, [string]$staleMin = '') {
  $env:PATH = "$($case.Stub);$oldPath"
  $env:CCV3_LAND_LOCK = $paths.Lock; $env:CCV3_LAND_LOCK_LOG = $paths.Log; $env:CCV3_SYNC_CURSOR = $paths.Cursor
  $env:CLAUDE_CODE_GIT_BASH_PATH = Join-Path $case.Stub 'bash.cmd'
  if ($staleMin) { $env:CCV3_LAND_LOCK_STALE_MIN = $staleMin } else { Remove-Item Env:\CCV3_LAND_LOCK_STALE_MIN -ErrorAction SilentlyContinue }
  $found = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($found -ne (Join-Path $case.Stub 'gh.cmd')) { throw "harness: gh resolves to '$found', not the stub; stopping before any real gh call" }
}
function Invoke-Land($case, $paths, [string[]]$extra = @('-NoSync'), [string]$staleMin = '') {
  Set-LandEnv $case $paths $staleMin
  $out = & pwsh -NoProfile -File $script -Pr 7 -RepoPath $case.Repo @extra 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
}
function Write-Lock($paths, [int]$lockPid, [datetime]$started, [string]$session = '', [string]$lockHostName = $hostName) {
  $rec = [ordered]@{ pid = $lockPid; host = $lockHostName; pr = 41; started = $started.ToUniversalTime().ToString('o') }
  if ($session) { $rec.session = $session }
  Set-Content -LiteralPath $paths.Lock -Value ($rec | ConvertTo-Json -Compress)
}
function Get-DeadPid {
  $p = Start-Process -FilePath cmd.exe -ArgumentList '/c', 'exit 0' -PassThru -WindowStyle Hidden
  $p.WaitForExit()
  $p.Id
}
function Read-Text([string]$path) { if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw } else { '' } }

$holder = $null
try {
  # A live process this test started and owns: the "holder" whose pid and start time a lock can name (cases C, C3).
  # It starts BEFORE the dead pid is taken, so Windows cannot hand the dead pid to it (case B would then see a live process).
  $holder = Start-Process -FilePath pwsh -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 900' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Check 'harness: the holder process is alive' (-not $holder.HasExited)
  $dead = Get-DeadPid
  Check 'harness: the dead pid is really gone and is not the holder' ((-not (Get-Process -Id $dead -ErrorAction SilentlyContinue)) -and $dead -ne $holder.Id)

  # A1: a fresh lock of a live process (the test itself) stops a second lander at the merge, and is not touched.
  $c = New-Case 'a1'; $p = New-Paths 'a1'
  Write-Lock $p $PID ([DateTime]::UtcNow) 'sess-other'
  $before = Read-Text $p.Lock
  $r = Invoke-Land $c $p
  Check 'A1 held: exit 1' ($r.Code -eq 1)
  Check 'A1 held: STOPPED text names the PR, the pid and the start time' ($r.Text -match "STOPPED: another land is in progress \(PR 41, pid $PID, started \d{4}-\d\d-\d\dT[^)]*\)\. Wait for it to finish, then run again\.")
  Check 'A1 held: no merge call' (-not (Test-Path $c.Merge))
  Check 'A1 held: the lock file is byte-identical' ((Read-Text $p.Lock) -eq $before)

  # A0: the lock is taken at the merge, not before the ready check. A refusal before it never meets the lock or creates one.
  $c = New-Case 'a0' 1; $p = New-Paths 'a0'
  Write-Lock $p $PID ([DateTime]::UtcNow)
  $r = Invoke-Land $c $p
  Check 'A0 scope: a re-check refusal under a held lock still reports the re-check, not STOPPED: another land' ($r.Text -match 'pre-merge re-check refused' -and $r.Text -notmatch 'another land is in progress')
  $c = New-Case 'a0b' 1; $p = New-Paths 'a0b'
  $r = Invoke-Land $c $p
  Check 'A0 scope: a refusal before the merge leaves no lock file' (-not (Test-Path $p.Lock))

  # B: a lock of a dead process is taken over, printed, logged; the run lands; the lock is gone after.
  $c = New-Case 'b'; $p = New-Paths 'b'
  Write-Lock $p $dead ([DateTime]::UtcNow.AddSeconds(-30)) 'sess-dead'
  $r = Invoke-Land $c $p
  Check 'B dead pid: the run lands and exits 0' ($r.Code -eq 0 -and (Test-Path $c.Merge) -and $r.Text -match 'LANDED #7')
  Check 'B dead pid: one takeover line with pid, session, start and reason dead-pid' ($r.Text -match "land lock: took over stale lock \(pid $dead, session sess-dead, started \d{4}-[^,]+, reason dead-pid\)")
  Check 'B dead pid: the same line is appended to the lock log' ((Read-Text $p.Log) -match "took over stale lock \(pid $dead, session sess-dead, .*reason dead-pid\)")
  Check 'B dead pid: the lock is released after the run' (-not (Test-Path $p.Lock))

  # C: a lock written on THIS host is judged by its pid, never by its age. The holder is a live process that started before
  # the lock's `started`, and the age limit is far below the lock's age: still HELD (a hung lander is not robbed).
  $holderStart = $holder.StartTime.ToUniversalTime()
  $c = New-Case 'c'; $p = New-Paths 'c'
  Write-Lock $p $holder.Id $holderStart.AddSeconds(1)
  $before = Read-Text $p.Lock
  $r = Invoke-Land $c $p @('-NoSync') '0.01'
  Check 'C live holder, lock older than the age limit: STOPPED, no merge, lock untouched' ($r.Code -eq 1 -and $r.Text -match "another land is in progress \(PR 41, pid $($holder.Id)," -and -not (Test-Path $c.Merge) -and (Read-Text $p.Lock) -eq $before)
  # C3: the pid is alive but its process started AFTER the lock's `started`: the pid was reused. Taken over, reason pid-reused.
  $c = New-Case 'c3'; $p = New-Paths 'c3'
  Write-Lock $p $holder.Id $holderStart.AddMinutes(-10) 'sess-old'
  $r = Invoke-Land $c $p
  Check 'C3 pid reuse: taken over with reason pid-reused, run lands, lock released' ($r.Code -eq 0 -and $r.Text -match "took over stale lock \(pid $($holder.Id), session sess-old, started [^,]+, reason pid-reused\)" -and (Test-Path $c.Merge) -and -not (Test-Path $p.Lock))
  Check 'C3 pid reuse: the reason is in the lock log' ((Read-Text $p.Log) -match 'reason pid-reused\)')
  # C4: a lock from ANOTHER host: its pid means nothing here, so only the age rule applies. Old: taken over (reason age).
  $c = New-Case 'c4'; $p = New-Paths 'c4'
  Write-Lock $p $dead ([DateTime]::UtcNow.AddMinutes(-5)) '' 'other-host'
  $r = Invoke-Land $c $p @('-NoSync') '1'
  Check 'C4 other host, older than the limit: taken over with reason age, run lands' ($r.Code -eq 0 -and $r.Text -match 'took over stale lock \(pid \d+, session -, started [^,]+, reason age\)' -and (Test-Path $c.Merge) -and -not (Test-Path $p.Lock))
  # C5: the same other-host lock with a dead pid, but younger than the default limit: held. The dead pid is not consulted.
  $c = New-Case 'c5'; $p = New-Paths 'c5'
  Write-Lock $p $dead ([DateTime]::UtcNow.AddMinutes(-5)) '' 'other-host'
  $r = Invoke-Land $c $p
  Check 'C5 other host, younger than the 30 minute limit: STOPPED even though its pid is dead here' ($r.Code -eq 1 -and $r.Text -match 'another land is in progress' -and -not (Test-Path $c.Merge))

  # D1: two landers start together: exactly one lands, the other stops. The winner waits ~6 s in the held section.
  $c = New-Case 'd1' -Sleep; $p = New-Paths 'd1'
  Set-LandEnv $c $p
  $procs = foreach ($i in 1, 2) {
    Start-Process -FilePath pwsh -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work "d1-$i.out") -RedirectStandardError (Join-Path $work "d1-$i.err") `
      -ArgumentList @('-NoProfile', '-File', $script, '-Pr', '7', '-NoSync', '-RepoPath', $c.Repo)
  }
  $procs | Wait-Process -Timeout 120
  $o = @(1, 2 | ForEach-Object { Read-Text (Join-Path $work "d1-$_.out") })
  $landed = @($o | Where-Object { $_ -match 'LANDED #7' }).Count
  $stopped = @($o | Where-Object { $_ -match 'STOPPED: another land is in progress' }).Count
  $merges = @((Read-Text $c.MergeLog) -split "`n" | Where-Object { $_.Trim() }).Count
  Check 'D1 race: exactly one run lands, exactly one stops' ($landed -eq 1 -and $stopped -eq 1)
  Check 'D1 race: exactly one merge call' ($merges -eq 1)
  Check 'D1 race: the lock is released at the end' (-not (Test-Path $p.Lock))

  # D2: two landers meet one stale lock: exactly one takes it over.
  $c = New-Case 'd2' -Sleep; $p = New-Paths 'd2'
  Write-Lock $p $dead ([DateTime]::UtcNow.AddSeconds(-30))
  Set-LandEnv $c $p
  $procs = foreach ($i in 1, 2) {
    Start-Process -FilePath pwsh -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work "d2-$i.out") -RedirectStandardError (Join-Path $work "d2-$i.err") `
      -ArgumentList @('-NoProfile', '-File', $script, '-Pr', '7', '-NoSync', '-RepoPath', $c.Repo)
  }
  $procs | Wait-Process -Timeout 120
  $o = @(1, 2 | ForEach-Object { Read-Text (Join-Path $work "d2-$_.out") })
  $landed = @($o | Where-Object { $_ -match 'LANDED #7' }).Count
  $stopped = @($o | Where-Object { $_ -match 'STOPPED: another land is in progress' }).Count
  $merges = @((Read-Text $c.MergeLog) -split "`n" | Where-Object { $_.Trim() }).Count
  $takeovers = @((Read-Text $p.Log) -split "`n" | Where-Object { $_ -match 'took over stale lock' }).Count
  Check 'D2 stale race: exactly one run lands, exactly one stops' ($landed -eq 1 -and $stopped -eq 1)
  Check 'D2 stale race: exactly one merge call and one logged takeover' ($merges -eq 1 -and $takeovers -eq 1)

  # D3: the takeover under pressure. Two processes (D2) rarely hit the few milliseconds between "judged stale" and "delete + create",
  # so this loads the real lock functions from land-pr.ps1 and races 6 threads at one stale lock, 25 rounds, from a spin barrier.
  # Exactly one thread may win each round. Without the takeover mutex a second thread deletes the winner's fresh lock and also "wins".
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
  $names = 'Get-LockInfo', 'Get-LockState', 'New-LockFile', 'Enter-LandLock'
  $fnText = ($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true) | ForEach-Object { $_.Extent.Text }) -join "`n"
  Check 'D3 harness: the four lock functions were found in land-pr.ps1' ((@($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)).Count) -eq 4)
  $d3 = New-Paths 'd3'
  $fnCount = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)).Count
  $rounds = 25; $badRounds = $(if ($fnCount -eq 4) { 0 } else { $rounds })   # functions missing: every round counts as bad, nothing is raced
  foreach ($round in $(if ($fnCount -eq 4) { 1..$rounds } else { @() })) {
    Remove-Item -LiteralPath $d3.Lock -Force -ErrorAction SilentlyContinue
    Write-Lock $d3 $dead ([DateTime]::UtcNow.AddSeconds(-30))
    $go = [DateTime]::UtcNow.AddMilliseconds(1500).Ticks
    $wins = @(1..6 | ForEach-Object -ThrottleLimit 6 -Parallel {
        $lockHost = $using:hostName; $lockStaleMin = 30.0; $lockUnreadableMin = 2.0; $lockLogPath = $using:d3.Log
        Invoke-Expression $using:fnText
        $content = '{"pid":' + $PID + ',"host":"' + $lockHost + '","pr":7,"started":"' + [DateTime]::UtcNow.ToString('o') + '"}'
        while ([DateTime]::UtcNow.Ticks -lt $using:go) { }
        $v = @(Enter-LandLock $using:d3.Lock $content) | Select-Object -Last 1
        if (($v -is [bool]) -and $v) { 'won' }
      } | Where-Object { $_ -eq 'won' }).Count
    if ($wins -ne 1) { $badRounds++ }
  }
  Check "D3 stale takeover race: exactly one of 6 threads wins, in every one of $rounds rounds (bad rounds: $badRounds)" ($badRounds -eq 0)

  # I1: an error raised inside the held section (the post-merge PR read is not JSON) still releases the lock.
  $c = New-Case 'i1' -MergedBody 'this is not json {'; $p = New-Paths 'i1'
  $r = Invoke-Land $c $p
  Check 'I1 error in the held section: the merge happened, the run failed, the lock is released' ((Test-Path $c.Merge) -and $r.Code -ne 0 -and $r.Text -notmatch 'LANDED' -and -not (Test-Path $p.Lock))
  # I2: the fast-forward of main is refused (main diverged): STOPPED, and the lock is released.
  $c = New-Case 'i2'; $p = New-Paths 'i2'
  $clone = Join-Path $work 'i2-clone'
  git clone -q $(Join-Path $work 'i2\fork.git') $clone 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $clone 'remote.txt') -Value 'remote side'
  git -C $clone add -A 2>&1 | Out-Null; git -C $clone @gitq commit -q -m remote 2>&1 | Out-Null; git -C $clone push -q origin main 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $c.Repo 'local.txt') -Value 'local side'
  git -C $c.Repo add -A 2>&1 | Out-Null; git -C $c.Repo @gitq commit -q -m local 2>&1 | Out-Null
  $r = Invoke-Land $c $p
  Check 'I2 STOPPED in the held section: fast-forward refused, exit 1, lock released' ($r.Code -eq 1 -and $r.Text -match 'could not fast-forward' -and -not (Test-Path $p.Lock))

  # F: another run owns the lock file by the time we exit: we must not delete it.
  $steal = (@{ pid = 99999; host = 'other-host'; pr = 55; started = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)
  $c = New-Case 'f' -StealJson $steal; $p = New-Paths 'f'
  $r = Invoke-Land $c $p
  Check 'F foreign lock: the run itself lands' ($r.Code -eq 0 -and $r.Text -match 'LANDED #7')
  Check 'F foreign lock: the lock file the other run wrote is still there, unchanged' ((Read-Text $p.Lock) -match '"pid":99999' -and (Read-Text $p.Lock) -match '"pr":55')

  # G1/G2: an empty or unreadable lock younger than 2 minutes may be a racer mid-write: not stolen.
  foreach ($kind in 'empty', 'garbage') {
    $c = New-Case "g-$kind"; $p = New-Paths "g-$kind"
    Set-Content -LiteralPath $p.Lock -Value $(if ($kind -eq 'empty') { '' } else { 'not json at all' }) -NoNewline
    $before = Read-Text $p.Lock
    $r = Invoke-Land $c $p
    Check "G $kind lock under 2 minutes: STOPPED, no merge, file untouched" ($r.Code -eq 1 -and $r.Text -match 'STOPPED: another land is in progress \(lock file unreadable' -and -not (Test-Path $c.Merge) -and (Test-Path $p.Lock) -and (Read-Text $p.Lock) -eq $before)
  }
  # G3: the same empty lock, last written 3 minutes ago: taken over.
  $c = New-Case 'g3'; $p = New-Paths 'g3'
  Set-Content -LiteralPath $p.Lock -Value '' -NoNewline
  (Get-Item -LiteralPath $p.Lock).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-3)
  $r = Invoke-Land $c $p
  Check 'G3 empty lock older than 2 minutes: taken over (pid ?), run lands, lock released' ($r.Code -eq 0 -and $r.Text -match 'took over stale lock \(pid \?, session -, started \?, reason age\)' -and -not (Test-Path $p.Lock))

  # H: the sync line. These runs sync (through the stub Git Bash), so land-pr reads the cursor.
  $mainSha = ''
  $c = New-Case 'h1'; $p = New-Paths 'h1'
  $mainSha = "$(git -C $c.Repo rev-parse main)".Trim()
  Set-Content -LiteralPath $p.Cursor -Value $mainSha -NoNewline
  $r = Invoke-Land $c $p @()
  Check 'H1 cursor equals main: SYNC CONFIRMED with the 8 character sha, after LANDED, exit 0' ($r.Code -eq 0 -and $r.Text -match "SYNC CONFIRMED: cursor $($mainSha.Substring(0,8)) equals main" -and $r.Text.IndexOf('LANDED #7') -ge 0 -and $r.Text.IndexOf('LANDED #7') -lt $r.Text.IndexOf('SYNC CONFIRMED'))
  Check 'H1 cursor equals main: the lock is released' (-not (Test-Path $p.Lock))
  $c = New-Case 'h2'; $p = New-Paths 'h2'
  Set-Content -LiteralPath $p.Cursor -Value 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee' -NoNewline
  $mainSha = "$(git -C $c.Repo rev-parse main)".Trim()
  $r = Invoke-Land $c $p @()
  Check 'H2 cursor differs: LANDED first, then the exact mismatch and the by-hand fix, exit non-zero' ($r.Code -ne 0 -and $r.Text.IndexOf('LANDED #7') -ge 0 -and $r.Text.IndexOf('LANDED #7') -lt $r.Text.IndexOf('NOT confirmed synced') -and
    $r.Text -match "NOT confirmed synced: cursor aaaaaaaa main $($mainSha.Substring(0,8))\." -and $r.Text -match 'merge already happened' -and $r.Text -match 'SYNC_MAIN_DETACHED=1')
  Check 'H2 cursor differs: the merge happened and the lock is released first' ((Test-Path $c.Merge) -and -not (Test-Path $p.Lock))
  $c = New-Case 'h3'; $p = New-Paths 'h3'
  $r = Invoke-Land $c $p @()
  Check 'H3 cursor missing: NOT confirmed synced with cursor missing, exit non-zero' ($r.Code -ne 0 -and $r.Text -match 'NOT confirmed synced: cursor missing main [0-9a-f]{8}\.' -and $r.Text.IndexOf('LANDED #7') -lt $r.Text.IndexOf('NOT confirmed synced'))
  $c = New-Case 'h4'; $p = New-Paths 'h4'
  $r = Invoke-Land $c $p @('-NoSync')
  Check 'H4 -NoSync: no sync verdict at all, exit 0' ($r.Code -eq 0 -and $r.Text -notmatch 'SYNC CONFIRMED' -and $r.Text -notmatch 'NOT confirmed synced')

  # J: cleanup fails after the sync ('Permission denied' on the worktree): a warning, exit 0, and the lock was already free.
  $c = New-Case 'j' -GitStub -Worktree; $p = New-Paths 'j'
  $mainSha = "$(git -C $c.Repo rev-parse main)".Trim()
  Set-Content -LiteralPath $p.Cursor -Value $mainSha -NoNewline
  $r = Invoke-Land $c $p @()
  Check 'J cleanup failure: exit 0, LANDED and SYNC CONFIRMED printed, a warning names the worktree' ($r.Code -eq 0 -and $r.Text -match 'LANDED #7' -and $r.Text -match 'SYNC CONFIRMED' -and $r.Text -match 'could not remove worktree')
  Check 'J cleanup failure: the cleanup ran after the lock was released' ((Test-Path (Join-Path $c.Stub 'lock-free-at-cleanup.flag')) -and -not (Test-Path (Join-Path $c.Stub 'lock-held-at-cleanup.flag')) -and -not (Test-Path $p.Lock))

  # J2-J4: the cleanup step RAISES (the stub lists a worktree path that is too long to resolve). It is still only a warning.
  # The wording says "merged" always, and "and synced" only when the cursor check passed.
  $badWt = "worktree C:\a`nHEAD 0123`nbranch refs/heads/main`n`nworktree C:\" + ('a' * 33000) + "`nHEAD 0123`nbranch refs/heads/$branch`n"
  $c = New-Case 'j2' -WtList $badWt; $p = New-Paths 'j2'
  Set-Content -LiteralPath $p.Cursor -Value "$(git -C $c.Repo rev-parse main)".Trim() -NoNewline
  $r = Invoke-Land $c $p @()
  Check 'J2 cleanup raises, sync confirmed: exit 0, warning says "merged and synced", LANDED printed, lock released' ($r.Code -eq 0 -and $r.Text -match 'WARNING: cleanup did not finish' -and $r.Text -match 'is merged and synced;' -and $r.Text -match 'LANDED #7' -and $r.Text -match 'SYNC CONFIRMED' -and -not (Test-Path $p.Lock))
  $c = New-Case 'j3' -WtList $badWt; $p = New-Paths 'j3'
  $r = Invoke-Land $c $p @('-NoSync')
  Check 'J3 cleanup raises under -NoSync: exit 0 and the warning says "merged" only' ($r.Code -eq 0 -and $r.Text -match 'WARNING: cleanup did not finish' -and $r.Text -match 'is merged;' -and $r.Text -notmatch 'merged and synced')
  $c = New-Case 'j4' -WtList $badWt; $p = New-Paths 'j4'
  Set-Content -LiteralPath $p.Cursor -Value 'aaaaaaaabbbbbbbb' -NoNewline
  $r = Invoke-Land $c $p @()
  Check 'J4 cleanup raises, sync NOT confirmed: the warning says "merged" only; the run still exits non-zero for the sync' ($r.Code -ne 0 -and $r.Text -match 'is merged;' -and $r.Text -notmatch 'merged and synced' -and $r.Text -match 'NOT confirmed synced')

  # H5: the cursor cannot be read (the path is a directory). Not a crash: LANDED and cleanup still happen, the verdict names the reason.
  $c = New-Case 'h5' -Worktree; $p = New-Paths 'h5'
  New-Item -ItemType Directory -Path $p.Cursor | Out-Null
  $r = Invoke-Land $c $p @()
  Check 'H5 unreadable cursor: LANDED printed, then NOT confirmed synced with cursor unreadable, exit 1, lock released' ($r.Code -eq 1 -and $r.Text -match 'LANDED #7' -and $r.Text.IndexOf('LANDED #7') -lt $r.Text.IndexOf('NOT confirmed synced: cursor unreadable (') -and -not (Test-Path $p.Lock))
  Check 'H5 unreadable cursor: the cleanup still ran (the PR worktree is removed)' (-not (Test-Path (Join-Path $c.Repo '.claude\worktrees\wiring')))

  # K: both fetches in the held section retry (they run after the merge). K1: the first call fails, the retry succeeds.
  $c = New-Case 'k1' -FetchFails 1; $p = New-Paths 'k1'
  $r = Invoke-Land $c $p
  $n = (Read-Text (Join-Path $c.Stub 'fetch-count.txt')).Trim()
  Check 'K1 fetch retry: one failed call, then success: exit 0, LANDED, the retry is announced, 2 calls' ($r.Code -eq 0 -and $r.Text -match 'LANDED #7' -and $r.Text -match 'retry 1 of 3' -and $n -eq '2' -and -not (Test-Path $p.Lock))
  # K2: every call fails: 1 try + 3 retries = 4 calls, then STOPPED (git fetch failed), merge already done, lock released.
  $c = New-Case 'k2' -FetchFails 99; $p = New-Paths 'k2'
  $r = Invoke-Land $c $p
  $n = (Read-Text (Join-Path $c.Stub 'fetch-count.txt')).Trim()
  Check 'K2 fetch retry: all calls fail: 4 calls, STOPPED git fetch failed, exit 1, lock released' ($r.Code -eq 1 -and $n -eq '4' -and $r.Text -match 'retry 3 of 3' -and $r.Text -match 'STOPPED: git fetch failed' -and (Test-Path $c.Merge) -and -not (Test-Path $p.Lock))
  if ($fail) { Write-Host '---- last output ----'; Write-Host $r.Text; Write-Host '---- end ----' }
}
finally {
  if ($holder -and -not $holder.HasExited) { $holder.Kill() }   # the process this test started above
  $env:PATH = $oldPath
  Remove-Item Env:\CCV3_LAND_LOCK, Env:\CCV3_LAND_LOCK_LOG, Env:\CCV3_SYNC_CURSOR, Env:\CCV3_LAND_LOCK_STALE_MIN, Env:\CLAUDE_CODE_GIT_BASH_PATH -ErrorAction SilentlyContinue
  $full = [System.IO.Path]::GetFullPath($work)
  if ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-lock-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "passed=$pass failed=$fail"
exit $fail
