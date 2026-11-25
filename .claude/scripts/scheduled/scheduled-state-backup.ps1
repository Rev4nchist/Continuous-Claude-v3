# Nightly state backup (Task Scheduler: CCv3-State-Backup, daily 03:10 local time with a catch-up at 07:40, conhost.exe --headless powershell.exe -File <this file>).
# Card ops-state-backup-nightly. The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs ONE command: `node scripts/scheduled/backup-state.mjs --repo <repo root>`. The command dumps the lane database (docker exec pg_dump),
# zips the decision files and the seat notes, runs a restore drill on a scratch database, uploads the four files to Notion and writes one row.
# llm=false in tasks.json: no model reads the dump. tasks.json sets battery=true, so the job also runs on battery.
# This wrapper prints no file content and no token. Its log holds the output lines of the command, which are masked by the command itself.
#
# Exit code: the command exit code (0 ok; 1 a failed night, the row names the Status; 2 no credential or no database id yet),
# 124 when the command ran past its limit, 3 when backup-state.mjs is not found (nothing runs).
# tasks.json allowedExit [0] makes the health check report any other code.
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at ~/.claude/scripts/scheduled/ (with profile-paths.ps1
# and slot-guard.ps1 beside it). backup-state.mjs lives in the repo (scripts\scheduled\) and is not synced, so this file finds the repo root first:
#   CCV3_STATE_BACKUP_REPO_ROOT (override) > machine profile repoRoot (profile-paths.ps1) > the default checkout.
# The notes under .claudedocs are git-excluded: only the primary checkout holds them, so the root must be the primary checkout.
#
# Environment overrides, for a test that must not touch the real ~/.claude or the primary checkout:
#   CCV3_STATE_BACKUP_REPO_ROOT    repo that holds scripts\scheduled\backup-state.mjs
#   CCV3_STATE_BACKUP_LOG          log file path (default ~/.claude/logs/state-backup/<yyyy-MM-dd>.log)
#   CCV3_STATE_BACKUP_TIMEOUT_SEC  command time limit in seconds (default 720; the task limit is 15 minutes)
#   CCV3_STATE_BACKUP_EXTRA_ARGS   extra arguments, e.g. --dry-run --out <dir>

$logPath = if ($env:CCV3_STATE_BACKUP_LOG) { $env:CCV3_STATE_BACKUP_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\state-backup\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# Repo root: the override wins. Else the machine profile. If that checkout has no backup script, the default checkout.
$scriptRel = 'scripts\scheduled\backup-state.mjs'
$R = $env:CCV3_STATE_BACKUP_REPO_ROOT
if (-not $R) {
  try {
    . (Join-Path $PSScriptRoot 'profile-paths.ps1')
    $R = (Get-Ccv3Paths 3>$null).RepoRoot
  } catch { $R = $null }
  if (-not ($R -and (Test-Path -LiteralPath (Join-Path $R $scriptRel)))) { $R = Join-Path $env:USERPROFILE 'continuous-claude' }
}

$branch = 'unknown'
try { $b = (& git -C $R rev-parse --abbrev-ref HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $b) { $branch = "$b".Trim() } } catch { }

# Slot guard (card sched-tasks-failing-1109): the 07:40 catch-up reruns a night the 03:10 run already finished. Skip when the last
# 03:10 slot has a completed run. A missing slot-guard.ps1 (sync lag) turns the guard off and the run goes as before.
$slotHhmm = '03:10'
$slotMarker = $null
$slotNow = Get-Date
$slotFile = Join-Path $PSScriptRoot 'slot-guard.ps1'
if (Test-Path -LiteralPath $slotFile) {
  . $slotFile
  $slotNow = Get-SlotNow
  $slotMarker = Join-Path (Get-SlotStateDir $logDir ([bool]$env:CCV3_STATE_BACKUP_LOG)) 'state-backup.done.json'
  if (Test-SlotDone $slotMarker (Get-LastSlot $slotNow $slotHhmm)) {
    Write-Log "skip: slot $slotHhmm of $((Get-LastSlot $slotNow $slotHhmm).ToString('s')) already done at $((Read-SlotDoneAt $slotMarker).ToString('s'))"
    exit 0
  }
}

$script = Join-Path $R $scriptRel
Write-Log "backup starting, repo $R, branch $branch"
if (-not (Test-Path -LiteralPath $script)) {
  Write-Log "ERROR: backup-state.mjs not found at $script"
  exit 3
}

# Subscription auth: the command starts no model, but an API key in the environment must not reach any child.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

# Bounded run. A Task Scheduler limit kill does not reap the child tree on this machine, so the limit lives here:
# wait, then kill the one child pid. Never taskkill /T. $p.Handle is read first because without it .ExitCode can come back empty.
$secs = 720
if ($env:CCV3_STATE_BACKUP_TIMEOUT_SEC) { $secs = [int]$env:CCV3_STATE_BACKUP_TIMEOUT_SEC }
$argText = '"' + $script + '" --repo "' + $R + '"'
if ($env:CCV3_STATE_BACKUP_EXTRA_ARGS) { $argText = $argText + ' ' + $env:CCV3_STATE_BACKUP_EXTRA_ARGS }
# Credential at rest (seat ruling 2026-11-24 19:17). The Notion token sits in ONE file as DPAPI text (ConvertFrom-SecureString: bound to this
# Windows user on this machine). This wrapper decrypts it and gives it to the one child in one env variable. It is never on argv and never in a
# log. A file that is plain text fails closed: the child gets no token and the state "not-protected" (a named status, exit 2). The wrapper owns
# the credential (the variables die with this process; no other child is started): a token already in the environment is dropped first, so nothing else can reach the child. No file: the child has none and
# reports no-credential. The file is made once by Dave's yes: "<token>" | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
Remove-Item Env:CCV3_BACKUP_NOTION_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CCV3_BACKUP_CREDENTIAL_STATE -ErrorAction SilentlyContinue
$tokenFile = if ($env:CCV3_BACKUP_TOKEN_FILE) { $env:CCV3_BACKUP_TOKEN_FILE } else { Join-Path $env:USERPROFILE '.claude\state\backup-notion-token' }
if (Test-Path -LiteralPath $tokenFile) {
  $blob = ''
  try { $blob = (Get-Content -LiteralPath $tokenFile -Raw -ErrorAction Stop).Trim() } catch { $blob = '' }
  if ($blob -notmatch '^01000000d08c9ddf0115d1118c7a00c04fc297eb[0-9a-fA-F]+$') {
    $env:CCV3_BACKUP_CREDENTIAL_STATE = 'not-protected'
    Write-Log 'credential file is not DPAPI protected: not used'
  } else {
    try {
      $secure = ConvertTo-SecureString -String $blob -ErrorAction Stop
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $env:CCV3_BACKUP_NOTION_TOKEN = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    } catch {
      $env:CCV3_BACKUP_CREDENTIAL_STATE = 'unreadable'
      Write-Log 'credential file could not be decrypted for this user'
    }
  }
}
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $node -ArgumentList $argText -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$null = $p.Handle
if ($p.WaitForExit($secs * 1000)) {
  $rc = $p.ExitCode
} else {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Log 'TIMEOUT: backup killed'
  $rc = 124
}
foreach ($f in @($outFile, $errFile)) {
  try { Get-Content -LiteralPath $f -ErrorAction Stop | ForEach-Object { Write-Log "$_" } } catch { }
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
}
Write-Log "backup finished, exit $rc"

# A completed run (exit 0) closes the slot. A failed or killed run leaves the marker as it was, so the next trigger retries.
if ($slotMarker -and $rc -eq 0) { Set-SlotDone $slotMarker $slotHhmm $slotNow }

# Keep 14 days of dated logs. Only files named yyyy-MM-dd.log are touched.
Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit $rc
