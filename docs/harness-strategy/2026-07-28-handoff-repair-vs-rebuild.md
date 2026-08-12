# Handoff → next session: four live bugs, then verify the repair-vs-rebuild proposal

Written 2026-07-28 by session `079ae1e7`. Tracked in git deliberately —
`thoughts/` is gitignored and this must survive the machine.

**Your job is two things, in order.** Fix four bugs that are wrong in production
right now (Part 1). Then run a verification pass on a strategic proposal and
produce the final plan (Part 2). **Part 2 is not implementation.** Do not start
pruning, deleting, or rebuilding anything. The deliverable is a plan Dave
approves.

**Everything below marked VERIFIED was verified by running it.** Everything
marked UNVERIFIED or REPORTED was not, and several REPORTED claims have already
turned out to be wrong. Treat that distinction as load-bearing — this document
exists partly because a previous handoff's confident instruction was wrong and
cost time.

---

## START HERE

```
node scripts/coordination/lane.mjs board
```

`fork/agentic-os` is at **`ee29181`**, divergence `0 0`. Two commits shipped this
session: `aa9ddb0` (session lifecycle + liveness index) and `ee29181` (the health
check that passed by finding nothing).

A dev server runs on **3010, pid 34904**. `taskkill /PID 34904 /T /F` — `/T` is
not optional.

**Use the PowerShell tool for shell work.** The MSYS fork storm killed roughly
half this session's Bash calls (`add_item ... errno 1`). It is annoying, not
dangerous: the crash is in DLL init before bash reads the command. Commits go
through `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>`; it
caught and recovered a real MSYS crash this session on attempt 2.

The `aos-data-hardening` lane is held by `079ae1e7` and will lapse. Claim it or
open a new lane — this work spans the whole harness, so a new lane is probably
right.

---

## PART 1 — Four bugs that are wrong in production right now

Two of these were introduced or left behind by THIS session's work. Fix them
first; they are small, and three of the four are the same defect class the Part 2
proposal is about.

### Bug 1 — the coordination lock classifies working sessions as dead

**The most important one.** Yesterday's fix taught the dashboard that liveness is
`GREATEST(last_heartbeat, last_activity_at)`, because `last_heartbeat` is written
by `heartbeat.ts` on **UserPromptSubmit only** — it measures the human typing,
not the agent working (measured peak staleness: 505s during a 12-agent workflow).

The file-claim lock was never updated. It still keys on bare `last_heartbeat`.

Demonstrated live on the authoring session, VERIFIED:

```
session 079ae1e7   heartbeat age 1521s   activity age 25s
  lock_says_alive  = FALSE
  truth_says_alive = TRUE
```

The user had not typed for 25 minutes while the agent worked continuously. Any
other session could have reclaimed its claims mid-edit.

**Exact sites, VERIFIED by Select-String:**

| file | lines |
|---|---|
| `.claude/hooks/src/shared/db-utils-pg.ts` | 488, 720, 762, 834 |
| `scripts/coordination/lane.mjs` | 170, 210, 239 (and 416, a 2-hour lookback — judgement call) |

Change the staleness predicates to `GREATEST(last_heartbeat, last_activity_at)`.

**Two cautions.** (a) `GREATEST` ignores NULLs and returns NULL only when every
argument is NULL, so rows predating the writer reduce exactly to the old
behaviour — verified against this server. (b) Do **not** blanket-replace line 315
or 326 in `lane.mjs`; those *display* when a holder was last alive, and a
different question is being asked there. Read each site.

Repro to confirm the fix:

```
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -A -F '|' -c "SELECT left(id,8), (last_heartbeat >= NOW() - make_interval(secs=>300)) AS lock_says_alive, (GREATEST(last_heartbeat,last_activity_at) >= NOW() - make_interval(secs=>300)) AS truth_says_alive FROM public.sessions WHERE GREATEST(last_heartbeat,last_activity_at) > NOW() - INTERVAL '30 minutes';"
```

Both columns should agree for a live session. Rebuild hooks after
(`cd .claude/hooks && npm run build`) or the change does not take effect —
`dist/*.mjs` is what runs.

### Bug 2 — the liveness writer is only half-deployed

`periodic-extract` (which hosts `shared/session-touch.ts`, the only writer of
`sessions.last_activity_at`) is registered in the **repo** `.claude/settings.json`
and **not** in `~/.claude/settings.json`. VERIFIED:

```
user settings mentions periodic-extract: False
repo settings mentions periodic-extract: True
```

Project settings apply only when cwd is inside that project, so
`last_activity_at` is written **only for sessions inside continuous-claude**.
Everywhere else, liveness silently degrades to heartbeat-only — i.e. Bug 1's
failure mode, permanently.

This is a genuine gap, but note it interacts with Part 2 step "reconcile config
first". Registering it is a one-line settings edit; do it **via Node atomic
read-modify-write, never the Edit tool** (`~/.claude.json` and `settings.json`
are written continuously by Claude Code — see `windows-platform.md`).

### Bug 3 — the clobbering reverse-sync is still live in the Codex harness

`sync-to-repo` is registered in `~/.codex/hooks.json` on `PostToolUse`
`Write|Edit`. VERIFIED (`registers sync-to-repo: True`).

That is the automatic reverse-sync that was **root-caused and disabled on the
Claude side on 2026-06-01** after it twice clobbered fresh repo edits with stale
active copies (see `.claude/rules/git-sync-workflow.md`). The fix never
propagated to the Codex mirror. It is a live data-loss hazard, and it is most
likely to fire during exactly the kind of mass edit Part 2 contemplates.

Deregister it there. **Note: writing into `~/.codex/` was blocked by the
permission classifier for the authoring session** — you may hit the same gate. If
so, stop and hand Dave the command rather than routing around it.

Related, same directory, decided but not applied: `~/.codex/hooks/dist` holds 103
`.mjs` files of which **99 are dated 2026-05-04 or older and 3 are within the
last week** (VERIFIED). The three coordination hooks
(`session-register`/`heartbeat`/`file-claims`) are in the stale cohort and run the
**old python-subprocess transport** — `uv run python` present,
`connectionTimeoutMillis` absent — which is the transport measured at 6/60
intruders allowed past the file lock. A backup of those three already exists at
`~/.codex/hooks/dist-backup-2026-07-28/`. Dave has the copy commands.

**Correction to an earlier claim, recorded so it does not propagate:** this was
previously described as "a three-month-stale mirror". That over-generalized —
99/103 stale, not all. An adversarial reviewer over-corrected the other way and
called it "actively maintained" on the strength of 3 files. Neither is right.

### Bug 4 — a security control that has never once worked, reporting success

`CCv3-Blocklist-Update` (Windows Task Scheduler, daily 09:00) updates the
supply-chain blocklist that `package-install-guard` enforces. VERIFIED:

```
Status: Ready    Last Run Time: 7/28/2026 9:00:01 AM    Last Result: 0
Next Run Time: 7/29/2026 9:00:00 AM

blocklist-update.log (55,137 lines):
  starts:   28
  [ERROR]:  24
  complete:  0
```

**28 runs, zero successes, exit code 0 every time.** Root cause is visible in the
log tail: `'sleep' is not recognized as an internal or external command` — a Unix
command in a Windows batch context, failing upstream of the build.

Two separate problems: the `sleep` call, and a wrapper that reports success on
failure. Fix both; the second is the more important one and is the same class as
everything else here.

**One thing to know before Part 2 touches anything:** this task runs unattended
at 09:00, and its tail stages `.claude/hooks/src/shared/malicious-packages.json`
and `.claude/hooks/dist/package-install-guard.mjs`, commits, pushes to `fork`,
then runs `sync-to-active.sh` — on whatever branch is checked out. REPORTED by an
adversarial agent, **partially verified** (the task and its failure record are
verified; the exact tail behaviour was not re-read). Verify it before any mass
edit, and consider disabling the task for the migration window.

---

## PART 2 — Verify the proposal, then write the plan

### The proposal you are verifying

A 10-agent workflow (6 independent read-only investigations, 1 synthesis, 3
adversaries) reached: **prune and install a ratchet; do not rebuild.** Two
adversaries upheld it, one refuted it on execution. Its reasoning, compressed:

- **There is no tangle to escape.** All 115 hooks are independent OS processes
  running self-contained esbuild bundles; **no hook imports or spawns another**;
  dispatch is only via `settings.json`. A rebuild's structural payoff is zero —
  you would spend months arriving at "115 independent processes".
- **The 86k-token context load is a configuration bug, not an architecture one.**
  89% is the rules corpus; 64.6% of that is tool-conditional; 0 of 46 rules use
  the native `paths:` frontmatter. ~88% recoverable in days.
- **The real disease is one class:** an unbound contract between two artifacts
  where only one side was implemented, failing SILENT (PASS / green / exit 0).
  Longest instance 186 days.
- **A rebuild does not cure it.** `apps/agentic-os` is two days old, small and
  lean, and produced four instances of the identical class immediately.
- **Therefore:** fix the live bugs, reconcile the config, install a mechanical
  ratchet, cut context, prune by evidence — in that order.

### What is already VERIFIED (do not re-derive; spend your time elsewhere)

| fact | value |
|---|---|
| hook sources / dist / test files | 115 / 115 / 113 |
| skills / agents / rules / scripts | 151 / 37 / 46 / 142 |
| hook TS lines / opc python lines | 70,291 / 66,429 |
| hook commands in `~/.claude/settings.json` | 85 (80 `.mjs` + 5 python) |
| rules byte-identical across both trees | 46 of 46, SHA256 |
| always-on bytes | 335.5 KB ≈ **85,901 tokens (bytes/4 ESTIMATE)** |
| `hook-trace.jsonl` | 181 lines, 2026-04-26 → **2026-05-18**, 12 names, **11 are test fixtures**, only `memory-awareness` real |
| `claude doctor` | **exists natively in 2.1.220** |
| native memory / CCv3 postgres memory | 62 files, 212.5 KB / 617 rows, 22 in last 7d |
| Codex mirror dist | 103 files, 99 ≤ 2026-05-04, 3 within 7 days |

### The verification pass — five questions, in priority order

The proposal named exactly what would falsify it. Answer these, then write the
plan. **Each answer must be measured, not reasoned.**

**Q1. Is the repo a viable base? (cheapest, and it can flip the whole verdict.)**
Live `~/.claude/settings.json` carries **79–85 distinct registrations** against
**63–69 in the repo copy** — roughly **17 hooks running that the repo does not
know about** (reported: `package-install-guard`, `plan-mode-approval-gate`,
`post-edit-diagnostics`, `telemetry-tracker`, `sentry-error-context`,
`hook-health-monitor`, +11), and 1 repo-only (`periodic-extract`). Also
`.claude/hooks/package.json` shows ` D` in git status — **deleted in the working
tree**, so the documented `npm run build` cannot run from source. And
`~/.claude/hooks/src` holds a ~251-file fossil dated 2026-07-11 that is never
executed.

Determine: **can the live 85-registration config be reproduced from anything
committed?** Include `settings.local.json`, `.mcp.json`, and the ~59 files in
`~/.claude/commands/` that are reportedly absent from the repo. **If it cannot,
the repo is not a viable base and rebuild-from-live becomes the coherent path —
this is the single finding most likely to change the answer.**

**Q2. Is the 86k figure real?** Every token number above is `bytes/4`. If the
loader de-duplicates identical content, deleting the duplicate rules recovers
nothing and the largest cheap win evaporates. **Run `/context` before and after a
trial change and measure.** Do not trust the estimate — including mine.

**Q3. What does the hook layer cost per turn?** Nobody measured latency. Static
fan-out from live `settings.json` was reported as **13 hook processes per Bash
call, 11 per Edit/Write, 15 per Task**. Cross that with this machine's spawn
pathology and `~/.claude/logs/msys-crash.jsonl` (**74 events, 46 in 48 hours,
most recent 13:49 on 2026-07-28**). If each turn pays seconds of hook latency,
the argument shifts from "context is a liability" to "the hook layer taxes every
interaction" — a much stronger case for a lean rebuild than anything in the
context findings. **This is computable today without any telemetry window.**

**Q4. Do the advisory hooks matter?** Only ~11 of the registered hooks can deny
anything; the rest are advisory and fail silent by construction. If a large
fraction of the 68 advisory hooks materially shape behaviour, the prune thesis
weakens sharply. If they are near-silent, the prune gets far more aggressive.
**Caution before trusting any telemetry here — see the traceHook trap below.**

**Q5. Recompute the dead set against ALL THREE registries.** The "36 unregistered
hooks" figure was computed against the Claude registries only. REPORTED: **5 of
them are registered in `~/.codex/hooks.json`** (`auto-build`, `navigator-safety`,
`pageindex-navigator`, `periodic-extract`, `sync-to-repo`). Deleting those orphans
live registrations. Verify before any deletion.

### Corrections already made to the proposal — carry these forward

**Its step 3 was INVERTED and would have been a safety regression.** It said
"stop syncing rules into user scope". VERIFIED counter-evidence: continuous-claude
is the **only** project with its own `.claude/rules/`; **17 of 19 registered
projects rely on the user-scope copy as the ONLY copy** of
`destructive-commands`, `windows-platform`, `codex-worker-safety`,
`notion-cli-safety`, `no-haiku`. Worse, the proposed acceptance test (`/context`
measured *inside* continuous-claude) would have **hidden** the regression, because
the project copy still loads there. **The correct fix is the inverse: keep user
scope, drop the project copy or gate it with `paths:` frontmatter.**

That is the defect class biting the plan written to cure the defect class. Weight
it accordingly.

**Ordering was the main adversarial objection, not direction.** All three
adversaries attacked sequencing. The ratchet (count-assertion lint) should come
**before** the telemetry window and the prune, not after — otherwise a dead sensor
and a silent hook are indistinguishable, and live hooks get deleted on no data.

### Traps, all verified or dated

**The traceHook trap — read this before instrumenting anything.** The proposal
leans on wiring the existing `traceHook` into all registered hooks. REPORTED with
commit citations: it **was** wired into `memory-awareness` by `81464f8`
(2026-04-25), produced real telemetry, and was silently deleted the next day by
`dd6c602` (2026-04-26) — an unrelated hook rename. Detection lag ~80 days. That
matches the independently VERIFIED trace contents exactly (54 `memory-awareness`
records, then nothing but test fixtures, dead since 2026-05-18). Also REPORTED:
every `sessionId` in the trace is a bare PID because `CLAUDE_SESSION_ID` is unset
in hook processes, and `traceHook` records only invocation/duration/exit — never
whether a hook allowed, denied or injected. **Fix the session key and put the
tracer itself under a count assertion before wiring 79 call sites**, or you build
the prune on an instrument that has already died once.

**Prose is not enforcement.** REPORTED: an always-on prose ban on `Explore`
failed **81 times** while the hook caught all 81. Where something must not happen,
keep the hook and delete the duplicate prose — not the mechanism. This cuts
against the "trust the model, drop enforcement" instinct.

**A green check with a subject count of zero is the house defect.** Five instances
surfaced in one day: the ESLint boundary linting zero files; `hook-registrations-valid`
passing on 0 of 85; `hook-orphans` reporting 114 false positives from the same
fault; `hook-trace-file-present` passing on a 10-week-dead file; the blocklist
task exiting 0 after 28 failures. The one guard with a catch record
(`scripts/audit-braintrust-emits.sh`, six regressions) works because it asserts a
nonzero **count**. That mechanism is the proposed ratchet.

**Verify before you repeat.** Two claims in this document's own lineage were
wrong: the "generate → db:check → migrate" migration path in the previous handoff
(drizzle cannot see `public.*` at all), and "three-month-stale mirror" above.
Reported ≠ verified.

### Deliverable

A plan Dave approves, containing: the answer to each of Q1–Q5 with its
measurement, a recommendation (uphold / amend / reverse the proposal), an ordered
step list with acceptance criteria per step, and an explicit list of what you did
**not** verify. If Q1 fails, say so loudly and lead with it.

---

## Guardrails (carried forward, all still true)

- **NEVER `drizzle-kit push`.** Shared DB, 40 `public` tables owned by three other
  apps. And `drizzle-kit` cannot see `public.*` at all — those declarations live
  in `src/db/readonly/`, deliberately outside the schema glob. DDL on the shared
  schema is hand-written, per `scripts/coordination/migrations/`.
- **`scripts/project-cards/state.json` is USER-OWNED** — read it, never commit it.
- **`sites/fastmcp-v3/`** is a nested independent git repo plus ~29,728
  `node_modules` files. Do not `git add` it.
- **`fork` = Rev4nchist. Never push `origin`** (parcadei, third-party upstream).
- **Prefer `git commit --only <paths>`.** Exposure starts at `add`, not commit.
  New files need `git add -N` first.
- **A lane note is a snapshot with no expiry.** Verify a note's claims before
  working from them, and re-note when you falsify one.
- **The full hooks vitest suite does not complete** — it hangs at
  `agent-error-capture.test.ts` (detached-spawn) and
  `arscontexta-graph-resolution.test.ts` is already red. Run targeted files.
  `coordination-transport.test.ts` is the one covering the coordination transport
  (15/15). Piping vitest through `Select-Object` buffers the whole run, so a
  0-byte log means unfinished, not hung.
