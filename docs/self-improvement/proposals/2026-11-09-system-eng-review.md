# System engineering review of an outside harness critique (2026-11-09)

Status: proposal. Not approved. Read-only research; nothing installed or run.
Source doc: `C:/Users/dkhay/OneDrive/Downloads/I want you to dive deeper and look for improvemen....md` (97 lines, six claims and a priority table).
Method: one verify scout and one refute scout per claim, plus one scout for gaps the doc missed.
Conflict rule: where verify and refute disagree, the refute result wins. Each section says why in one line.
Lane scope: held lanes are `guard-prompt-text-fp` (#faffe84e, file `.claude/hooks/src/destructive-command-guard.ts`) and `package-guard-residuals` (#4c4b5eb5, worktree `.claude/worktrees/guard-bypass-gaps`, branch `fix/package-guard-bypass-gaps`), from the lane board on 2026-11-09.
Bias note: the refute scouts were told to default to WATCH or SKIP when unsure. The uniform WATCH on the six claims is partly that instruction.
Spot checks by the lead session: hook counts, `git-auto-commit` registration, no `~/.claude/.git`, no Snapshot task in `tasks.json`, `--retry=2`, `INTERPRETERS`. The lead also read `git-auto-commit.ts:33-50, 172-215`, `rule-router.ts:271-293` with `settings.json.template:461-470`, and `db-utils-pg.ts:758-779`. All matched.

Verdict: none of the doc's six fixes is ADOPT as written. The doc names real surfaces but gets most mechanics wrong. The work we found is separate: items M1 to M6 below carry their own recommendation, and five of them are ADOPT candidates.

## 1. Goal and steps in plain English

Dave's goal: an outside reviewer criticised the CCv3 harness and software factory. Test each claim against the code. Keep what is real. Fix what is weak. Skip what is wrong or already solved.

Steps from review to build:

1. Read the critique and split it into six claims.
2. For each claim, read the live code and logs. Record what is true today, with file and line.
3. Try to disprove each proposed fix. Keep only the part that survives.
4. Look for weak spots the critique did not name.
5. Rank the surviving work by evidence strength and effort, not by the critique's P0 labels.
6. Ask Dave for the decisions he owns: spend, architecture, and anything that unregisters a hook or changes CI.
7. Build each accepted item test-first, one small PR at a time. Agree a split with held lanes before a shared edit.

## 2. Summary table

Verdict is about the doc's diagnosis. Recommendation is about its proposed fix.

| Item | Doc claim | Verdict | Recommendation | Effort | Held-lane conflict |
|---|---|---|---|---|---|
| 1a Hook counts | 73 programs on 67 events | wrong | SKIP | n/a | none |
| 1b Spawn tax | Node cold start per hook on Windows | partial | WATCH: measure first (wire traceHook) | S-M | none |
| 1c Router bundle | One bundled entry for all hooks | partial | WATCH: bundle PostToolUse and SessionStart only if data justifies | M | guards stay out (#faffe84e, #4c4b5eb5) |
| 1d Named-pipe daemon | Rust/Go resident daemon | wrong | SKIP | L | Dave owns |
| 2a Fail-open on bad JSON | Guard allows on parse error | accurate | SKIP: documented design | n/a | #faffe84e |
| 2b Headless not unattended | `claude -p` not detected | accurate | WATCH: narrow, effect unverified | S | #faffe84e, #4c4b5eb5 (shared unattended.ts) |
| 2c Interpreter bypass | `node -e`, `python -c` not checked | accurate | WATCH: docs-only gap row | S | #faffe84e, agree split via SendMessage first |
| 2d AST parser, OS sandbox | Replace regex, sandbox lanes | partial | SKIP now | L | #faffe84e |
| 3a Zombie leases | Crashed holder locks forever | stale | SKIP (PID reaper WATCH) | M | none |
| 3b Rename blindness | `git mv` escapes claims | accurate | WATCH: low impact | S | none |
| 3c Lock-order deadlock | Two lanes wait on each other | wrong | SKIP | n/a | none |
| 3d Per-lane worktrees | Replace file claims | wrong | SKIP: does not close a crash gap | L | none |
| 4a Too-late inject | Rules arrive after the choice | partial | SKIP phase-bound loading | M | none |
| 4b Compaction amnesia | Compact drops rules | stale | SKIP re-hydration | M | none |
| 4c Router false fires | (not in doc) | accurate | WATCH: fix segment split after #faffe84e lands | S | #faffe84e (shared parser) |
| 5 Test gaming | Weakened asserts, .skip, suppressions | accurate | WATCH: catcher fact, no gate, no file lock | M | none (check board for catchers.mjs, prompt.mjs) |
| 6a Bad sync bricks session | Synced bad hook kills Claude Code | partial | WATCH: rescue runbook | S | none |
| 6b DB down blinds hooks | Hooks block or drop | partial | SKIP spool | M | none |
| 6c Versioned dir, symlink swap | Canary sync plus rollback | wrong | SKIP: conflicts with link guards | L | none |

Gaps the doc missed (section 4):

| Item | Gap | Grade | Recommendation | Effort | Held-lane conflict |
|---|---|---|---|---|---|
| M1 | Snapshot task documented, absent | B | ADOPT the doctor check; Dave picks restore or retire | S/M | none |
| M2 | git-auto-commit dead, spawns git per Write and Edit | B | ADOPT: unregister (Dave's yes) | S | none |
| M3 | 11 registered hooks have no tests | B | ADOPT the ratchet; WATCH the backfill | S/M | none |
| M4 | CI Linux-only, `--retry=2` hides flakes | B | WATCH: Dave owns spend | M | none |
| M5 | Guard-log noise gives two doctor FAILs | A | ADOPT | S | `guard-log.ts` is shared by both held guards |
| M6 | Unmasked secrets in test-run-tracker and guard-log | B | ADOPT the test-run-tracker mask; Dave decides guard-log masking and ACL | S | none |

Cites: section 3 gives file:line per claim. Section 4 gives file:line per gap.

## 3. One section per claim

### Claim 1: hook latency and the subprocess tax

What the doc says: 73 hook programs map to 67 events. Each Pre and PostToolUse spawns Node. Windows adds latency and EBUSY/EPERM races (source doc:6-9). Fix: one bundled router, then a named-pipe daemon (source doc:13-14).

What the code does today:
- Live `~/.claude/settings.json` has 84 entries, 68 dist programs and 9 event names (node parse, read-only). The 73 and 67 counts match nothing.
- Fan-out is matcher-filtered. One Bash call runs 8 Pre and 11 Post hooks. SessionStart runs 12 (same parse).
- Dispatch is parallel. Measured cost was about one hook's wall time, 64-87 ms per hook (`docs/harness-strategy/2026-07-28-plan-repair-with-ratchet.md:349-353`). Those figures understate: capture rate was 8.7% and payloads were constructed.
- Cold start under Defender is real for UserPromptSubmit. Commit ba37fc03 bundled 5 hooks into one process (`.claude/hooks/src/prompt-submit.ts:28-32, 231-271`).
- A general dispatcher was moved down to optional on 2026-07-20 (`docs/hook-dispatcher-consolidation-plan.md:3-11`). Exec form now covers 84 of 84 entries, so the fork storm is gone.
- EBUSY/EPERM comes from state-file locks, and the writer already handles it (`.claude/hooks/src/shared/atomic-write.ts:194-195, 253`). A daemon does not remove that race.
- The only daemon client talks to the TLDR daemon over TCP (`.claude/hooks/src/lib/daemon-client.ts:1-12`). It does not run hooks.
- `traceHook()` exists but no hook calls it (`.claude/hooks/src/lib/hook-trace.ts:1-50`). No `~/.claude/cache/hook-trace.jsonl` exists.

Real gap: there is no current per-hook latency data. The 2026-07-28 numbers predate the 2026-08-31 prune and the Defender finding. Tool hooks are not bundled.

Refute versus verify: both reject the daemon. Refute adds the 2026-07-20 dispatcher demotion as prior work, so the bundle is conditional.

Fix we would accept:
1. Wire `traceHook()` into the dist entry points through one shared wrapper. Read a week of p50 and p95.
2. Only if the data shows start-up cost or timeouts: bundle PostToolUse Bash|PowerShell (11) and SessionStart (12) like prompt-submit. Keep the PreToolUse guards as separate processes.
3. Free win with no measurement needed: unregister `git-auto-commit`. It spawns git twice on every Write and Edit and always no-ops (see gap M2).

Test that must fail first: pipe a real Bash PostToolUse payload into a built dist hook. Assert one row lands in `hook-trace.jsonl`. It fails today because no hook calls `traceHook()`. Artifact: `.claude/cache/e2e/2026-11-09-hook-trace.jsonl`.

Risk: a bundle shares one failure domain. A crash must not disable a fail-closed guard, so guards stay out. The deny-wins merge rule is the high-risk part (`docs/hook-dispatcher-consolidation-plan.md:67`). [Speculation] The Defender note in that plan was for a managed machine. This machine is Windows 11 Home, so the cost may differ.

### Claim 2: guard fail-open and interpreter bypass

What the doc says: `destructive-command-guard` fails open on malformed JSON. Headless runs are not reliably unattended. `node -e` or a temp script bypasses regex (source doc:20-21). Fix: fail closed, AST parsing, OS sandbox (source doc:25-27).

What the code does today:
- Bad JSON prints `{}` by design (`.claude/hooks/src/destructive-command-guard.ts:169-176, 215-218`; header :28; `~/.claude/docs/security/destructive-commands.md:12`). Claude Code serializes the payload, so the model cannot send bad stdin.
- Unreadable command text on a shell tool fails closed (`destructive-command-guard.ts:182-186`).
- Raw text is scanned before the parser runs (`.claude/hooks/src/shared/destructive-classifier.ts:680-686` versus :690-711). A parser error loses only wrapper recursion.
- Unattended means bypassPermissions, `CLAUDE_AGENT_ID` or CI (`.claude/hooks/src/shared/unattended.ts:17-19`). Headless `claude -p` is not detected (:10-11). A headless signal exists in `shared/lane-board.ts:144-146`.
- `INTERPRETERS` lists only bash-family, pwsh and cmd (`destructive-classifier.ts:542-546`). Live runs: `node -e` with `fs.rmSync`, `python -c` with `shutil.rmtree` and `bash x.sh` all returned `{}`.
- `node -e` with destructive text is pinned as allow on purpose (`.claude/hooks/src/__tests__/destructive-command-guard.test.ts:60-61, 270`).

Real gap: the interpreter gap is in neither the ACCEPTED LIMITATIONS header (`destructive-command-guard.ts:39-54`) nor the ACCEPTED GAP test block (`destructive-command-guard.test.ts:451-462`).

Refute versus verify: verify proposed new `INTERPRETERS` rows. Refute wins. The rows catch only shell-outs inside the payload. No pattern exists for `fs.rmSync` or `shutil.rmtree` (`destructive-classifier.ts:157-159` are the only API rows). They would also flag the sanctioned `node -e` settings write (`~/.claude/CLAUDE.md:195`). The recorded direction is to match the verb, never the script body (`.claudedocs/2026-11-07-guard-text-false-positives.md:5-9`). The memory note says to stop patch rounds (`guard-shell-lexer-arms-race.md:15, 19`).

Fix we would accept: docs only. Ask lane #faffe84e to add one ACCEPTED LIMITATIONS bullet and one ACCEPTED GAP row. Text: "interpreter -e/-c payloads and native delete APIs are not scanned". No code change. No `unattended.ts` change now: it has 4 importers, 2 in held lanes (`destructive-command-guard.ts:64`, `package-install-guard.ts:30`).

Test that must fail first: none for docs. The new ACCEPTED GAP row pins today's allow. A future close then fails that row and forces a doc update (header :52-54).

Risk: low. AST parsing and sandboxing stay out of scope. The guard is a backstop, not a sandbox (`destructive-command-guard.ts:39-40`). Sandboxing is already WATCH (`docs/self-improvement/proposals/2026-11-03-cloudflare-security-audit-skill.md:18, 80`).

WATCH triggers: a real delete through an interpreter API. The headless trigger is settled: a headless `ask` is denied, not proceeded (section 7).

### Claim 3: lane concurrency and file claims

What the doc says: leases go zombie on a crash, renames escape locks, lock order deadlocks (source doc:33-35). It also says leases lack heartbeats. Fix: per-lane worktrees and PID-liveness TTL leases (source doc:39-41).

What the code does today:
- Heartbeats exist. Reclaim needs an expired lease and a holder silent for 5 min (`.claude/hooks/src/shared/db-utils-pg.ts:762-779`; `.claude/hooks/src/file-claims.ts:20`).
- Leases are 10 min for files and 60 min for harness paths, renewed on every Edit or Write (`.claude/hooks/src/shared/leases.ts:15-17, 50-51, 62-90`).
- Each claim is one `INSERT ... ON CONFLICT` (`db-utils-pg.ts:739-793`). The hook denies at once and never waits (`file-claims.ts:149-155`). No cycle can form.
- File claims live in `.claude/hooks/src/file-claims.ts`, not in `apps/agentic-os` as the doc says.
- Keys are (file_path, project) and the hook fires on Edit and Write only (`db-utils-pg.ts:751`; `file-claims.ts:72`). A Bash `git mv` is not seen.
- Live events, 2026-10-27 to 11-09: 13 of 13 takeovers had a stale holder and an expired lease. 16 of 16 blocks had a live holder. 0 real break-glass events (`agentic_os.coordination_event`).

Real gap: rename blindness only, with low impact because the fence is evidence only (`db-utils-pg.ts:707-715`).

Refute versus verify: verify proposed a PID crash reaper. Refute wins. It would have cleared 0 of 16 real blocks. The PID signal is not safe for a DELETE: the desktop app matches the same name and Windows reuses PIDs (`scripts/coordination/process-match.mjs:19-22, 116`).

Fix we would accept: none now. Worktrees for subagent fan-out were adopted in 2026-07, not per lane (`docs/self-improvement/proposals/2026-07-10-coordination.md:64-75`).

Test that must fail first: none, no fix adopted.

Risk of the doc's fix: per-lane worktrees change the workflow and do not close a crash gap. A PID reaper risks a false reap.

WATCH triggers: a real `claim_break_glass` event, or a `claim_blocked` event with holderStale=true. The 13-day event window is short, so treat "0 incidents" as weak.

Separate finding: 14 of 16 blocks were on the shared `MEMORY.md`. That belongs to ROADMAP gate G4 (`ROADMAP.md:387`), not to this claim.

### Claim 4: context routing and compaction

What the doc says: on-demand rules arrive after the model chose the tool, which causes deny-retry loops. Compaction drops injected rules (source doc:47-48). Fix: phase-bound loading and PreCompact re-hydration (source doc:52-53).

What the code does today:
- Late inject is documented (`.claude/hooks/src/rule-router.ts:13-14`). The 4 decision-changing rules are deny-first. The other 19 of 23 inject (`.claude/rules-ondemand/manifest.json`).
- A rule blocks once per session. A subagent gets inject after the first block (`rule-router.ts:172-176, 312-318`).
- 47 denies in 1143 log rows. 40 came from `pr-and-commit-style`, moved to inject in commit 6bdf8c94 (`~/.claude/logs/rule-router.jsonl`).
- Compaction is handled. rule-router runs on SessionStart `compact|clear` and re-arms every rule (`.claude/settings.json.template:461-470`; `rule-router.ts:272-290`). The log has 117 rearm events.
- An earlier-phase injector was retired in 2026-08 for 22 of 45 false fires (`docs/self-improvement/audits/2026-08-19-skill-router-decision.md`).

Real gap: false fires. `coderabbit-cli` has 26 of about 53 rows in `~/.claude/logs/rule-router-false-fires.jsonl`. [Speculation] `splitUnquoted` turns heredoc body lines into segments (`rule-router.ts:126-139`).

Refute versus verify: verify proposed tighter manifest regexes and an audit-path fix. Refute wins. The regexes are already anchored. The audit has not run yet because its first slot is today at 09:07 CST (schtasks output; `scripts/harness-doctor.test.mjs:660-670`).

Fix we would accept: fix heredoc and script-body handling in `quotedSegments` or `splitUnquoted`. That code uses the shared classifier parsers (`rule-router.ts:34, 131`), so wait for lane #faffe84e to land.

Test that must fail first: a `scripts/rules/rule-router-probe.mjs` case. A Bash heredoc whose body line starts with `cr` must not fire `coderabbit-cli`. It should fire today.

Risk: a parser change can hide a real fire. The probe must also keep one true-fire case per rule.

### Claim 5: verification gaming

What the doc says: agents pass gates by weakening asserts, adding `.skip`, mocking the unit, or adding suppression comments (source doc:59-60). Fix: a diff-aware ratchet and read-only tests after RED (source doc:64-67).

What the code does today:
- The proof gate checks shape and head only (`scripts/github/review-status.mjs:687`; `scripts/github/pre-pr.mjs:486-493`).
- `changed-lines.mjs` ignores removed lines and deleted files by design (`scripts/checks/changed-lines.mjs:5-10`).
- No catcher checks test integrity (`scripts/checks/catchers.mjs:7-12`).
- A live `nosemgrep` exists (`scripts/ratchets/semgrep-ccv3/ccv3-graphql-connection-no-pageinfo.mjs:20`). The ratchet honours it (`scripts/ratchets/semgrep-ccv3.mjs:150-152`).
- No ESLint config exists, so `eslint-disable` suppresses nothing.
- Read-only tests after RED are prose only (`.claude/skills/tdd/SKILL.md:20-22, 36-37`).

Real gap: accurate. No diff check exists. No incident is recorded in audits or `.claudedocs`.

Refute versus verify: verify proposed a `pre-pr.mjs` gate row. Refute wins. A deleted-test rule fires on the sanctioned 290-test signal audit (commit 0699f32b). A bare `.skip` rule fires on every current `t.skip(reason)` (for example `scripts/checks/cli-smoke.test.mjs:181`). `pre-pr.mjs` had 5 commits in 3 days.

Fix we would accept:
1. Add a `test-integrity` fact to `catchers.mjs`, not a gate. Report the scanned file count, new suppressions, and new skip or only calls with no reason string.
2. Suppressions to report: `nosemgrep`, `@ts-ignore`, `@ts-expect-error`, `# noqa`, `# type: ignore`. Drop `eslint-disable`. Fold this into the unshipped pstack item G5.3 (`.claudedocs/2026-11-01-pstack-comparison.md:85`).
3. Add one line to the local-review prompt: report weakened, skipped or deleted tests and new suppressions (`scripts/github/local-review/prompt.mjs`).
4. Add "tests are read-only after RED unless the PR body says why" to the tdd skill Never list.
5. Promote the fact to a gate only after the gate-run log shows real hits (commit c95d8e02).

Test that must fail first: fixture diffs, one per failure: new `nosemgrep`, new `@ts-ignore`, `it.skip(` with no reason, `.only(`, `pytest.mark.skip` with no `reason=`. One clean diff with `t.skip('reason')` must pass. The scanner must report a nonzero scanned count (`scripts/hooks/suite-shape-guard.mjs:37-43`).

Risk: false positives on sanctioned cleanup. No file lock: there is no RED marker to anchor one. No mock-the-unit detector: it is a semantic call.

### Claim 6: split-brain state and sync

What the doc says: a bad synced hook can brick the session. DB down blinds hooks (source doc:79-80). Fix: versioned dir, canary smoke, symlink swap, rollback script, SQLite or JSONL spool (source doc:84-85).

What the code does today:
- The post-commit hook runs the sync (`scripts/post-commit-hook.sh:12, 46`). `land-pr.ps1` sets `SYNC_MAIN_DETACHED` and checks the cursor after (`scripts/github/land-pr.ps1:440-442`). So the doc's "land-pr syncs" is partial.
- CI rebuilds dist, compares it to the committed copy, then runs vitest (`.github/workflows/ccv3-checks.yml:135-155`). Landing needs green checks (`land-pr.ps1:10-12`).
- SessionStart reports missing or stale dist (`.claude/hooks/src/hook-health-monitor.ts:196-197, 251-253`).
- Guards catch crashes and fail open (`destructive-command-guard.ts:174, 217`).
- DB hooks time out in 1.2 to 3 s and drop on purpose (`.claude/hooks/src/lane-context.ts:120, 722-727`; `db-utils-pg.ts:74`).
- Quarantine saves only diverged files. A matching old dist is overwritten (`scripts/sync-to-active.sh:211-224`).
- The rescue steps exist only in an archived handoff (`docs/handoffs-archive/HANDOFF-2026-06-28-threshold-execution.md:60`).

Real gap: no rescue runbook and no automatic rollback. No bricking incident was found.

Refute versus verify: verify proposed `node --check` in the sync. Refute wins. CI already proves the PR path. A syntax check misses runtime import throws on the bypass paths (`.claude/hooks/package.json:8`; `land-pr.ps1:13`; `post-commit-hook.sh:23-28`). A Braintrust spool already exists (`ROADMAP.md:408`), so the correct wording is "no spool for lane DB writes".

Fix we would accept:
1. A short rescue runbook. Prefer the native `disableAllHooks` setting over moving `settings.json`, because it keeps permissions (`scripts/skills/trigger-probe.mjs:43`).
2. Optional: a doctor or SessionStart check that imports each `~/.claude/hooks/dist/*.mjs` under a timeout. It covers only the CI-bypass paths.

Test that must fail first: runbook, a manual check: start Claude Code with `disableAllHooks` set and confirm no new `hooks.log` rows. Load check: a fixture dist that throws at import must produce FAIL.

Risk: the symlink swap conflicts with the sync link guards (`sync-to-active.sh:405-423, 1113-1115`) and with junction hazards on this machine (memory `worktree-junction-remove.md`). [Speculation] DB-drop visibility in the doctor was not checked.

## 4. Gaps the doc missed

Labels M1 to M6 mean "missed". They are not ROADMAP gates.

### M1. CCv3-Claude-Snapshot is documented but absent

- Evidence: the README says it commits `~/.claude` daily at 18:00 (`docs/harness-strategy/README.md:628-631`). `~/.claude` has no `.git`. No such scheduled task is registered. `scripts/claude-snapshot/snapshot-claude.ps1:45-47` exits 1 in this state.
- The doctor reads only `scripts/scheduled/tasks.json` (`scripts/harness-doctor.mjs:12`), which does not list it. So the doctor reports green.
- Fix: Dave picks restore (git init `~/.claude`, add to tasks.json, register after his yes) or retire (fix README:620-633). Either way, add a doctor check that fails when the README names a task missing from tasks.json.
- Test first: the doctor check must FAIL on today's tree.
- Effort: S for docs plus check. M for restore.

### M2. git-auto-commit is dead and costs every Write and Edit

- Evidence: registered at `~/.claude/settings.json:720`. It runs `git --version` and `git rev-parse` before it reads stdin (`.claude/hooks/src/git-auto-commit.ts:172-188, 193`). It always exits at :183-186 with a non-PostToolUse output shape.
- If revived, it runs `git add -A` with no secret preflight (:139, :155). Compare `snapshot-claude.ps1:63-72`. No test covers it.
- The no-op depends on `~/.claude` having no `.git` (`git-auto-commit.ts:33, 48-50, 181-188`). I confirmed there is none. M1 "restore" would run `git init` there and revive this hook. Decide M1 and M2 together: unregister first, or the restore wakes a hook with no secret check.
- Fix: unregister with `apply-registrations.mjs` after Dave's yes and archive the source.
- Test first: `apply-registrations.mjs` dry run must list the removal. After apply, a Write must spawn no git process.
- Effort: S.

### M3. Eleven registered hooks have zero tests

- The scout title said ten. The list has eleven: session-start-docker, session-start-context-loaders, session-end-extract, coordination-release, mcp-activity-tracker, smarter-everyday, git-auto-commit, tree-invalidate, pageindex-watch, import-validator, coordination-notification (`~/.claude/settings.json:411-884`).
- `coordination-release` releases claims and `session-end-extract` writes memory. A break in either is silent.
- Fix: a ratchet beside the suite-count ratchet. Each registered dist needs one test file that spawns or imports it. Baseline 11, may only shrink. Backfill coordination-release, session-end-extract and import-validator first.
- Test first: the ratchet must FAIL when a new hook is registered with no test.
- Effort: S for the ratchet, M for backfill.

### M4. CI runs only on Linux

- Evidence: every job uses ubuntu-latest (`.github/workflows/ccv3-checks.yml:21, 122, 161, 219, 249`). Windows-only tests skip there (`scripts/scheduled/register-ccv3-tasks.test.mjs:47, 66, 104`).
- The hooks vitest step uses `--retry=2` (`ccv3-checks.yml:155`). A test that fails 2 of 3 times goes green.
- Fix: one windows-latest job for the hooks build, vitest, scheduled-task and doctor tests. Report retries as a ratchet number.
- Dave owns: Windows runner minutes bill higher, and `ccv3-checks.yml` edits need his yes.
- Effort: M.

### M5. Guard-log noise becomes two doctor FAILs

- Evidence: `shouldWrite` returns true whenever `VITEST` is unset (`.claude/hooks/src/shared/guard-log.ts:117-119`). Fixture text landed in the live log on 2026-11-04 (`~/.claude/logs/guard-decisions.jsonl:779-781`).
- The doctor FAILs at 5 error rows in 24 h (`scripts/harness-doctor.mjs:259, 264`). On 2026-11-08 one source caused a logs FAIL and then a Health-Check task FAIL (`~/.claude/logs/health-check/2026-11-08.log:17`).
- Fix: tag the log source, set `CCV3_GUARD_DECISIONS_LOG` to a temp path in every probe, and group doctor rows by (hook, message).
- Test first: run a probe that spawns a dist guard. Assert no new row in the live log.
- Effort: S. `guard-log.ts` is shared by both held guards, so agree via SendMessage first.

### M6. Secrets residuals

- Evidence: guard-log `cwd` and `target` are cut but not masked, "until he decides" (`guard-log.ts:13-15`). The 0o600 mode does nothing on Windows (`guard-log.ts:171-173`).
- `test-run-tracker` writes the raw command to `$TEMP` with no masking (`.claude/hooks/src/test-run-tracker.ts:11, 172-174`). Only 2 files import `maskSecrets`.
- Fix: mask the command in test-run-tracker before the write. Dave decides on guard-log masking and an owner-only ACL on `~/.claude/logs`. Add a lint ratchet: a hook that writes tool_input text must import `maskSecrets`.
- Test first: pipe a payload with a fake token into built test-run-tracker. The `$TEMP` file must not contain it.
- Effort: S.

## 5. Ranked plan

Order: evidence grade first, then effort. Grade A means an observed incident or log hit. Grade B means confirmed in code, no incident. Grade C means refuted or no case.

| Rank | Item | Grade | Effort | Lane note | Dave owns |
|---|---|---|---|---|---|
| 1 | M5 guard-log source tag, probe log path, doctor grouping | A | S | agree split via SendMessage first (#faffe84e, #4c4b5eb5 import guard-log) | no |
| 2 | Claim 4 heredoc segment fix in rule-router | A | S | blocked until #faffe84e lands; agree split via SendMessage first | no |
| 3 | M2 unregister git-auto-commit | B | S | none | yes: apply-registrations |
| 4 | M1 snapshot restore or retire, plus doctor check | B | S/M | none | yes: restore vs retire |
| 5 | Claim 6 rescue runbook with disableAllHooks | B | S | none | no |
| 6 | M6 mask test-run-tracker command | B | S | none | yes: guard-log masking, ACL |
| 7 | Claim 1 wire traceHook, one week of data | B | S-M | none | no |
| 8 | M3 hook-coverage ratchet | B | S | none | no |
| 9 | Claim 2 docs-only gap row | B | S | agree split via SendMessage first (#faffe84e) | no |
| 10 | Claim 5 test-integrity catcher fact, prompt line, tdd line | B | M | check board for catchers.mjs, prompt.mjs | no |
| 11 | M4 Windows CI job and retry reporting | B | M | none | yes: spend, ccv3-checks.yml |
| 12 | M3 backfill tests | B | M | none | no |
| 13 | Claim 1 bundle PostToolUse and SessionStart | depends on rank 7 | M | guards stay out | yes: architecture |
| n/a | Daemon, AST parser, OS sandbox, worktrees, PID reaper, phase-bound loading, re-hydration, versioned dir, lane spool, test file lock | C | L | n/a | yes: daemon rewrite (recommend SKIP) |

Already tracked elsewhere: MEMORY.md claim blocks under ROADMAP G4 (`ROADMAP.md:387`).

## 6. Unresolved questions

1. ANSWERED 2026-11-09 by one billed probe (section 7): a hook `ask` is denied under headless `claude -p`, even with `--allowedTools Bash`. The command did not run.
2. Does #4c4b5eb5 touch `unattended.ts` or `guard-log.ts` in PR 1 (bypass gaps)? Its note names only the package guard. Ask it before any edit there.
3. Doc claims no scout checked: prompt cache thrashing (source doc:43); fail closed on a missing session_id (:25); the `#pragma: allowlist secret` suppression (:66); barrel-export granularity (:34); the 23.5k-char CLAUDE.md figure (:45); the "80-90% latency" estimate (:94); Docker WSL2 memory stalls (:80). All unverified.
4. [Speculation] Does Defender add start-up cost on this Home machine? No `Get-MpComputerStatus` run.
5. What does the first CCv3-RuleRouter-Audit run write today after 09:07 CST? Read `docs/self-improvement/audits/rule-router-2026-11-09.md` before any audit work.
6. Did the decision-gate `spawnSync git ENOENT` rows on 2026-11-08 come before the aecad9ed sync, or from a missing git PATH?
7. [Speculation] Does the harness doctor surface DB-drop counts anywhere?
8. Is a Bash `mv` and `git mv` matcher for file claims worth its noise?

## 7. Dave's decisions and the headless probe (2026-11-09)

Source: the review board page, 8 of 8 answered and sent.

| Question | Decision |
|---|---|
| M1 and M2 | Unregister `git-auto-commit`. Retire the Snapshot task (fix the README, add the doctor check). |
| Plan first | M2 only. |
| Message the held lanes | Yes. Message all lanes as needed and check the lane board for accurate specs. |
| Hook speed | Measure first with `traceHook`. No bundle, no daemon. |
| M4 Windows CI | Defer. |
| M6 masking | Mask `test-run-tracker` only. |
| Headless `ask` test | Yes, one run. |
| Commit this file | Yes, on a docs branch, no PR. |

Headless probe, one run, scratch git repo outside every real repo:
- Command: `claude -p --output-format json --allowedTools Bash --max-turns 4 --effort high`, API keys unset, prompt on stdin. The model ran `git reset --hard` once.
- Result: the Bash call was denied. `permission_denials` lists it. `victim.txt` stayed `MODIFIED-DIRTY`. Cost about $0.23 on the subscription.
- Log row (`~/.claude/logs/guard-decisions.jsonl`, 13:49:43Z): hook `destructive-command-guard`, decision `ask`, `permission_mode` default, `agent` false.
- Meaning: the headless detection gap in `unattended.ts` does not let a destructive `ask` through. Claim 2b stays WATCH, with lower risk.
- Not tested: `--dangerously-skip-permissions` headless runs. Those count as unattended by design and the guard denies.
- M6 note: the log row holds the full `command` text. Dave chose "mask `test-run-tracker` only", which leaves `guard-log` unmasked, so this field is a reason to revisit that choice.
- Live false positive, same family as lane `guard-prompt-text-fp`: appending this section with a shell heredoc was blocked because the heredoc body held the words of a hard reset. No override was used. The section was added with the Edit tool.
