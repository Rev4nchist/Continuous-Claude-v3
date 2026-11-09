# Rescue runbook: a hook breaks every session

Checked 2026-11-09 on Claude Code 2.1.321, Windows 11. Evidence: `.claudedocs/e2e-rescue-runbook/` (files 01 to 12; local, gitignored).
Source claim: `docs/self-improvement/proposals/2026-11-09-system-eng-review.md`, Claim 6.
"Docs only" means the claim comes from the Claude Code docs and was not run here.

## 1. When to use it

Use it when a hook crashes or blocks every session start.
No bricking incident was found in the repo history. This runbook is a precaution.

## 2. Fastest rescue: turn hooks off for one run

`--settings` sits above user, project and local settings. A `disableAllHooks: false` in a project file cannot undo it. Permissions stay as they are.

1. Start Claude Code with inline JSON (documented form):
```powershell
claude --settings '{"disableAllHooks": true}'
```
You should see the status line gone (docs only).
Proof: headless `claude -p` ran 0 hooks with the flag and 13 without it (26 started and response events, files 04 and 05).
A SessionStart hook in the same settings file did not run (file 06).
The interactive start was not tested.

2. If the inline form fails in PowerShell, use a file. It is the same mechanism as `scripts/skills/trigger-probe.mjs:41-43`.
```powershell
Set-Content -LiteralPath "$env:TEMP\no-hooks.json" -Value '{"disableAllHooks": true}'
claude --settings "$env:TEMP\no-hooks.json"
```

Other place: `"disableAllHooks": true` in `~/.claude/settings.json`. Docs only.
A `false` in a project `.claude/settings.json` overrides it.
Never edit `settings.json` with the Edit tool. Use Node (docs only, not tested):
```powershell
node -e "const f=process.env.USERPROFILE+'/.claude/settings.json',fs=require('fs'),s=JSON.parse(fs.readFileSync(f,'utf8'));s.disableAllHooks=true;fs.writeFileSync(f,JSON.stringify(s,null,2))"
```
To undo, run the same line with `delete s.disableAllHooks` in place of `s.disableAllHooks=true`.

The flag also turns off the status line (docs only). It stays off until you remove the flag.

## 3. Find the bad hook

Run these with the flag on. The SessionStart health check is a hook, so it is silent while hooks are off.

1. List the SessionStart hooks (not tested):
```powershell
node -e "const s=require(process.env.USERPROFILE+'/.claude/settings.json');for(const g of s.hooks.SessionStart||[])for(const h of g.hooks)console.log(h.command)"
```
2. Run each suspect alone to see its stack (not tested). Replace `<hook>`:
```powershell
'{"hook_event_name":"SessionStart","source":"startup","session_id":"rescue","cwd":"C:\\Users\\dkhay\\continuous-claude"}' | node "$HOME\.claude\hooks\dist\<hook>.mjs"
```
3. Read the log `~/.claude/logs/hooks.log`. One JSON row per line with `ts`, `level`, `hook`, `msg`:
```powershell
Select-String -LiteralPath "$HOME\.claude\logs\hooks.log" -Pattern '"level":"(error|warn)"' | Select-Object -Last 20
```
Most hooks write no row. A normal run of 13 hooks added none (file 01). No match does not clear a hook.
Only a hook that calls `log.info`, `log.warn` or `log.error` writes there (`.claude/hooks/src/shared/logger.ts`).
Do not use "no new `hooks.log` rows" as the proof that hooks are off. Count hook events instead.
4. Run the doctor. It is not a hook, so the flag does not stop it. See step 5.
5. The health line finds only a missing or stale dist file, not a crash at run time (`.claude/hooks/src/hook-health-monitor.ts`).
   With hooks on it goes to stderr, which shows only with `claude --debug`. A problem also goes into the session context:
   - `Hook Health: N/M healthy, K issue(s) found`
   - `MISSING: <hook>.mjs (fix: npm run build)`
   - `STALE: <hook>.mjs (content differs from the build manifest, fix: npm run build)`

## 4. Fix

The repo is canonical. The **Active** copy in `~/.claude` is a copy. Never build in `~/.claude/hooks`.
A rebuild of bad source makes the same bad dist. Fix the source first. The dist is tracked in git, and the sync copies only what is on `main`.

1. On a branch, fix the source, or revert the bad commit with `git revert <sha>`.
2. Rebuild the dist in the **Repo**:
```powershell
Set-Location -LiteralPath 'C:\Users\dkhay\continuous-claude\.claude\hooks'
npm run build
```
3. Commit the source and the dist. Open a PR. Merge to `main` only after Dave says yes.
4. Sync **Active** from `main` in the primary checkout. The sync skips any other branch (`scripts/sync-to-active.sh:96-124`):
```powershell
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/Users/dkhay/continuous-claude && scripts/sync-to-active.sh --changed'
```
You should see the script list the files it copied. `bash` on PATH is WSL, so use the full path above.

Notes:
- `--changed` copies files changed since the last synced commit (`~/.claude/state/sync-cursor`). It does not restore an **Active** file broken outside a commit. For that, run the full mirror with no flag. It is slow on Windows.
- The **Clobber-guard quarantine** saves a file in `~/.claude/.sync-quarantine/<timestamp>/` only when it differs from the repo and from the hash the last sync wrote. A bad dist that came in through a sync is overwritten with no copy.
- The sync never copies `settings.json` (`scripts/sync-to-active.sh:199`). A bad registration there, such as a wrong matcher or dist path, needs `node scripts/settings/apply-registrations.mjs` as a dry run first. Use `--apply --only <hook>` only after Dave says yes.
- Do not move `~/.claude/settings.json` (`docs/handoffs-archive/HANDOFF-2026-06-28-threshold-execution.md:60`). It drops permissions, env, model and every hook registration for the run. `disableAllHooks` keeps them.

## 5. Undo the flag and check

1. Close the session. Start a normal one without `--settings`. If you edited `settings.json`, remove the key.
2. Run the doctor:
```powershell
Set-Location -LiteralPath 'C:\Users\dkhay\continuous-claude'
node scripts/harness-doctor.mjs
```
You should see a last line `harness: N pass / N warn / N fail` and exit code 0. Look at the `hooks:`, `sync:cursor` and `logs:` rows first.
3. Start a normal session. Hooks run again when the status line returns.

## 6. What it does not rescue

- A broken `settings.json`. The flag is read from settings. In `-p` mode a broken file is skipped, so the flag in it is lost. Interactive mode shows a Settings Error dialog. Run `claude doctor` to find the file. Use the `--settings` form above or `claude --safe-mode`. Docs only, not tested.
- **Managed** hooks. Only `disableAllHooks` at the managed level turns them off.
- A bad MCP server. 28 of 29 servers were still listed with the flag (file 12). `ccv3-mods` was missing, so `pr_checkpoint` and `pr_watch` are gone for that run. `claude --safe-mode` loads none.
- A bad `CLAUDE.md` or global rule. They still load. Only `--safe-mode` skipped `CLAUDE.md`.
- Skills and plugins. 148 skills and 13 plugins still loaded with the flag. `--safe-mode` cut them to 19 and 10.
- Permissions, env, model and effort settings, `apiKeyHelper`: not hook settings, so unchanged.
- A broken status line script. The flag stops it from running. It does not repair it.
- Anything outside the Claude Code process: scheduled `.bat` wrappers, git hooks, the shell. Hook-written state files that other tools expect may be missing.
- Not tested: an interactive run. The check was headless only.
