# CCv3 PR1: deferred Windows / installed-harness gates (rog-strix)

These are for a Claude Code session that David starts on **rog-strix** (Windows 11, user `dkhay`). Phase pre runs on the PR1 branch checked out in `C:\Users\dkhay\continuous-claude` before merge, per the ccv3-1 plan ("rog-strix step"). Phase post runs after the install (CCV3-INSTALL). They cover the gates the Linux Cloud Agent could not run. Run each step in order and save every output. Then tick the matching box in the PR's "Deferred Windows gates" section and paste each result line.

**Driver:** `pwsh -File run-windows-gates.ps1 -Phase pre`, and after the install `-Phase post`. It runs W0–W9 below and writes the same files. This document is the spec; the script is a convenience.

## Ground rules for the session
- **Bash.** Always use `& 'C:\Program Files\Git\bin\bash.exe' …`. **Never** use bare `bash`, because on this machine it is WSL.
- **Shell.** PowerShell 7 (`pwsh`). Run from the repo root: `cd C:\Users\dkhay\continuous-claude`.
- **Read-only toward `~/.claude`.** The only steps that write to it are the install (runbook §3.4+, done by David or the wizard, not by this checklist) and the harness's own runtime files when `claude` runs or a hook is invoked (sessions, debug logs, hook state). Every sync in this checklist goes to a **temp HOME**.
- **No secrets** are typed, printed or saved. **No git push** of any kind. No force-push.
- **Output folder:** `.claude/cache/e2e/` in the repo (gitignored). Name files `<YYYY-MM-DD>-pr1-win-<name>.txt`. `$D` below means `(Get-Date -Format yyyy-MM-dd)`.
- **Vacuous-pass rule:** read the count before the verdict. A pass over 0 items is a **FAIL**.

```powershell
$GB='C:\Program Files\Git\bin\bash.exe'; $D=Get-Date -Format yyyy-MM-dd
$E='.claude\cache\e2e'; New-Item -ItemType Directory -Force $E | Out-Null
$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'
```

## Phase pre (PR1 branch checked out, before merge and before the install)

**W0 Preflight** → `$E\$D-pr1-win-preflight.txt`
```powershell
& $GB -c 'uname -s; command -v node sha256sum' ; git rev-parse HEAD ; git status --porcelain ; git remote -v
```
Pass when all of these hold:
- `uname` prints `MINGW64…` or `MSYS…`, never `Linux`;
- node and sha256sum both resolve;
- HEAD is the PR1 branch tip (`fix/ccv3-install-blockers`) or the PR1 merge commit;
- `git status --porcelain` is classified. A modified, staged, renamed, or deleted tracked path FAILs and the paths are listed. Untracked-only paths WARN and list the paths. They do not fail the gate. A clean tree has neither warning nor failure from this check. An untracked directory such as `.claudedocs/` is a warning;
- remotes are listed. If `origin` is parcadei, note it. Nothing is pushed.

**W1 Sync cursor test (Git Bash)** → `$D-pr1-win-sync-cursor-test.txt`
```powershell
& $GB scripts/sync-to-active-cursor.test.sh 2>&1 | Tee-Object "$E\$D-pr1-win-sync-cursor-test.txt"
```
It runs the real sync in its own temp home. Pass when the exit code is 0, there are ≥ 1 `PASS` lines and 0 `FAIL` lines. Record the PASS count.

**W2 Temp-HOME sync with the personal profile** → `$D-pr1-win-temp-sync.txt`
```powershell
$T=Join-Path $env:TEMP "ccv3-pr1-home-$D"; New-Item -ItemType Directory -Force $T | Out-Null
$env:CCV3_GATE_HOME=$T
& $GB -c 'H="$(cygpath -u "$CCV3_GATE_HOME")"; HOME="$H" CCV3_MACHINE_PROFILE=personal SYNC_ALLOW_BRANCH=1 "$BASH" scripts/sync-to-active.sh --skip-build; echo "sync_exit=$?";
  echo "files=$(find "$H/.claude" -type f | wc -l)";
  echo "archive_dirs=$(find "$H/.claude" -type d \( -name _snapshots -o -name _archive -o -name .archive -o -name archive -o -name _eval -o -name _sandbox \) | wc -l)";
  for s in fourth-brand-guidelines fourth-presentation-suite fourthos-weekly weekly-report fabric kusto-cli; do test -e "$H/.claude/skills/$s" && echo "SKIPSKILL_PRESENT $s"; done;
  echo "work_paths=$(grep -rIl "david[.-]hayes" "$H/.claude" | wc -l)"'
```
`SYNC_ALLOW_BRANCH=1` is a prefix on that sync command only. It lets a non-main checkout copy into the temp HOME. It is not assigned in the parent PowerShell process, and it is not exported for any later command. Do not set it on the user's real environment or real HOME.

Pass when all of these hold:
- the output shows `sync_exit=0`;
- `files` > 0. `files=0` prints `FAIL: W2 files=0; zero inputs is not a pass` and the gate FAILs. A count of zero is never a pass. A space-padded `wc` count is still that count;
- `archive_dirs=0`;
- there are no `SKIPSKILL_PRESENT` lines;
- `work_paths=0`.

Delete `$T` afterwards.

**W9 Scheduled-task scripts** → `$D-pr1-win-ps1-parse.txt`
```powershell
Get-ChildItem .claude\scripts -Recurse -Filter *.ps1 | % { $e=$null; [void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$e); "$($e.Count) errors  $($_.FullName)" }
Select-String -Path .claude\scripts\*.ps1,.claude\scripts\scheduled\*.ps1,scripts\scheduled-health-check.bat -Pattern 'david[.-]hayes'
Select-String -Path scripts\scheduled-health-check.bat -Pattern 'report-registry'   # must be 0 (harness-only, David 2026-10-22)
Get-Content scripts\scheduled\tasks.json | ConvertFrom-Json | ft
```
Pass when all of these hold:
- every file reports `0 errors`;
- there are 0 `david.hayes` matches;
- there are 0 `report-registry` references in `scheduled-health-check.bat` (harness checks only);
- `tasks.json` parses, lists ≥ 1 task with the `personal` profile, and lists no other profile.

**Do not register tasks here.** That happens in runbook §3.9.

## Install (not part of this checklist)
Run `03-MACHINE-STATE-AND-RUNBOOK.md` §3.4 onward: the wizard in copy mode with `--profile personal`. After it, `~/.claude/state/machine-profile` should read `personal`. Record the size of `~/.claude` before and after (AC3).

## Phase post (after the install)

**W3 Render check against the live settings** → `$D-pr1-win-render-check.txt`
```powershell
node scripts/settings/render-settings.mjs --check
```
Pass when the exit code is 0, the output reports no (event, hook, matcher) drift, overlay entries are listed separately, and the count of hooks compared is > 0.

**W4 Active manifest** → `$D-pr1-win-manifest.txt`
```powershell
node scripts/hook-manifest-check.mjs
```
Pass when the exit code is 0, every registered dist file exists, and the registration count is > 0. Also run:
```powershell
node -e "const s=require(process.env.USERPROFILE+'/.claude/settings.json');let n=0,b=0;for(const g of Object.values(s.hooks))for(const m of g)for(const h of m.hooks){n++;if(h.timeout>120)b++};console.log('timeouts',n,'over120',b);if(!('mcpServers' in s))console.log('no mcpServers')"
```
Pass when it prints `over120 0` and `no mcpServers`.

**W5 PowerShell payloads into changed hooks** → `$D-pr1-win-hook-payloads.txt`

Do this for each of `commit-preflight`, `test-run-tracker` (PostToolUseFailure), `pr-opened-coderabbit-loop` and `periodic-extract`:
1. Read its event and matcher from `~/.claude/settings.json`.
2. Build a payload that uses that event and the `PowerShell` tool where the matcher allows it, with the harmless command `git status`.
3. Run it from a temp working directory:
```powershell
'{"hook_event_name":"PreToolUse","tool_name":"PowerShell","tool_input":{"command":"git status"},"cwd":"'+$env:TEMP.Replace('\','/')+'"}' | node "$env:USERPROFILE\.claude\hooks\dist\commit-preflight.mjs"; "exit=$LASTEXITCODE"
```
Pass when each hook exits 0 (or with its documented verdict code), stdout is empty or valid JSON, and stderr has no stack trace.

**W6 Headless behaviour checks** (needs a signed-in `claude`; run from `$env:TEMP`, plan mode) → `$D-pr1-win-claude-p-<n>.json`
```powershell
claude -p "Using the hook-scaffold skill: what timeout value goes in settings.json for a simple regex-check hook? Number and unit only." --output-format json --permission-mode plan
claude -p "Which bash executable must run scripts/sync-to-active.sh on this machine? Path only." --output-format json --permission-mode plan
claude -p "What is the path of my user-scope Claude settings.json? Path only." --output-format json --permission-mode plan
```
Pass when all of these hold:
- (1) answers `3` with seconds, never `3000`/ms;
- (2) names `C:\Program Files\Git\bin\bash.exe`;
- (3) names `C:\Users\dkhay\.claude\settings.json`;
- no answer contains `david.hayes`.

**W7 verify-setup** → `$D-pr1-win-verify-setup.txt`
```powershell
& $GB scripts/verify-setup.sh
```
Pass when the output shows `Failed: 0`. List the warnings.

**W8 Debug log has no hook errors** → `$D-pr1-win-debug-grep.txt`

Run one prompt in `~` and one in the repo:
```powershell
claude --debug -p "Reply OK" --permission-mode plan
```
Then match the newest two files in `~\.claude\debug\` with the shared matcher (`docs/ccv3-1/lib/w8-hook-errors.ps1`, `Test-HookErrorLine`). The pattern text is identical to `$script:W8HookErrorPattern`:

`(?i)(\[ERROR\][^\r\n]*\bhook\b[^\r\n]*\b(fail(ed|ure)?|timed out|ENOENT|non-zero|exit code (?!0\b)\d+)\b|(?<!Hook stdout:[^\r\n]*)(?<![\w-])(Hook error:|Hook failed\b|Failed to run hook\b|Error running hook\b|Hook timed out\b|Hook command timed out\b)|completed with status (?!0\b)\d+|status code (?!0\b)\d+|spawn\S*\s+ENOENT)`

```powershell
. docs/ccv3-1/lib/w8-hook-errors.ps1
Get-ChildItem ~\.claude\debug | Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object { Get-Content -LiteralPath $_.FullName } | Where-Object { Test-HookErrorLine $_ }
```
Pass when there are 0 matches. Save the matcher output along with the file names.

## Report back
For each W-step, paste one line into the PR in the form `W# · file · result line · PASS/FAIL` (the driver writes `<date>-pr1-win-summary-<phase>.md` for this). `.claude/cache/` is gitignored: do not commit the outputs unless David explicitly asks (then `git add -f` on the PR branch, normal push to Rev4nchist, never force). On any FAIL, stop and report it. Do not patch `~/.claude` by hand.
