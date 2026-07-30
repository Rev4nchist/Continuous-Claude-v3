# CCv3 refinement — start here

Entry point for picking this work back up. Written 2026-07-29 at the end of a
stabilisation session, against branch `agentic-os`.

Read this, then read the one linked doc for the workstream you're picking up.
Nothing here duplicates those docs; it records **what state each thing is in**,
**what the next concrete action is**, and **what has already been proven false**.

---

## 1. Is the harness stable right now?

Yes, on every gate that exists. Verified 2026-07-29, all counts non-vacuous
(each asserts a nonzero denominator, so none can pass by finding nothing):

| Gate | Command | Result |
|---|---|---|
| Hook registration + output contract + timers | `node scripts/hooks/hook-contract-guard.mjs` | PASS — 86 live entries / 80 names, 80 sources scanned, 55 speak the contract, **0** discarded-output, **9/9** timers safe |
| Braintrust scoring layer can emit | `node scripts/hooks/braintrust-emit-guard.mjs` | PASS — 115 sources, 4 emit sites / 4 hooks, config reachable, 0 dead span sources |
| Emit-count invariant | `bash scripts/audit-braintrust-emits.sh` | PASS — Found 4, invariant 4 |
| Coordination liveness predicate | `node scripts/coordination/liveness-predicate-guard.mjs` | PASS — 6/6 files, 23 correct predicates, 0 bare-heartbeat tests |
| Hook build actually current | `cd .claude/hooks && npm run build` then `git status --porcelain .claude/hooks/dist` | clean — rebuild changes zero bytes |
| Repo ↔ `~/.claude` drift | see §6 | rules 46/46, agents 66/66, dist 261/261 |

### The test suite returns a verdict again — and it is not green

`npx vitest run` in `.claude/hooks` used to have no exit at all. As of
2026-07-29 it **completes in ~12 s**:

**113 files · 2163 tests pass · 94 fail · 7 skipped.**

Neither blocker was a slow test:

- **`maestro-detector.ts` ended with a bare `main();`** at module scope, and
  `main()` awaits stdin. Importing it to unit-test its pure helpers ran the hook
  and blocked on a stdin that never closes under vitest — one file's import cost
  the whole suite its verdict. Fixed with the `argv[1]` guard 16 other hooks
  already use.
- **`daemon-client.test.ts` was not hanging, it was paying ~10.4 s six times.**
  Six tests hit `tryStartDaemon`'s real spawn path (`tldr daemon start` at 5 s,
  then up to 10 s waiting for reachability). Because that sits inside a
  **synchronous** `spawnSync`, vitest's `testTimeout` cannot interrupt it: with
  `--testTimeout=4000` those tests still *passed* at 10463 ms each. Now gated by
  an opt-in `CCV3_DAEMON_NO_AUTOSTART=1`.

⚠️ **Latent hang class — 16 hooks still call `main()` unguarded at module scope:**
`agent-verification`, `bus-session-populator`, `code-field-protocol`,
`guardrail-enforcer`, `maestro-enforcer`, `maestro-state-manager`,
`mcp-activity-tracker`, `permission-auto-allow`, `plan-mode-discovery`,
`prd-task-template-enforcer`, `ralph-delegation-enforcer`, `ralph-monitor`,
`ralph-template-inject`, `task-router`, `typescript-preflight`.
`maestro-detector` was simply the only one with a test importing it. **The next
unit test written against any of the other 15 hangs the suite the same way** —
add the `argv[1]` guard first.

Remaining 94 failures, 8 files:

| Files | Failing | Note |
|---|---|---|
| 5 × `arscontexta-*` | **83** | **FOSSILS — delete the files.** The subsystem does not exist: zero skills, agents or hook sources; the only `arscontexta*` files in the repo are these 5 tests. `f9cdbef` (2026-06-28) purged 61 arscontexta lines from `skill-rules.json` as "28 ghost skill registrations", and these tests assert those registrations are present. Not an investigation |
| `plan-exit-tracker` | 7 | **One root cause, 7 symptoms** — the state file is never written (`writes state file when ExitPlanMode fires` fails first; the other 6 are downstream nulls) |
| `store-learning-injection` | 3 | Asserts the SOURCE SHAPE of `agent-error-capture.ts` (must call `store_learning.py` via `spawnSync`). Either the hook was refactored or the test is a fossil — determine which |
| `braintrust-score` | 1 of 19 | **Possibly a real bug in the OFF switch:** `returns silently when TRACE_TO_BRAINTRUST is "false"` — the fetch mock was called once when it should not have been. Also makes **real network calls** during the suite (`DNS failure`), so it may be flaky: it moved between 93 and 94 total failures across two runs |

Because the suite could not complete, **none of this was visible.** The arscontexta
files have been red since 2026-06-28 — the hang was hiding a month of failure, not
just withholding a verdict.

Fixed this session, no longer in that list: 39 tests that ran under **no runner**
(see §5.4), and two files whose tests asserted the `BRAINTRUST_SESSION_ID` env
var that `2542561` retired — `ralph-task-monitor-braintrust` (4 failed → 12/12,
`e26141c`) and `telemetry-tracker-braintrust` (14 failed → 25/25). In both, some
"returns null" tests had been passing **vacuously**.

`pwsh -File scripts/hooks/test-bisect.ps1` still runs each file in isolation with
a timeout — use it when you need per-file attribution or suspect a new hang.

Also red, and separate: **`npm run check` reports 234 pre-existing `tsc` errors.**
None are in the files touched this session.

Branch was `0 0` against `fork/agentic-os` at session start and is pushed.
`agentic-os` is **103 commits ahead of `fork/main`** — that is the standing
state, not a problem, but it is where a merge decision eventually lives.

**Run these four guards first when you come back.** They are the only
mechanically-enforced invariants in the system, and they are cheap.

---

## 2. The strategic decision (settled — do not relitigate)

**Repair CCv3 with a ratchet. Do not rebuild.**

- Plan: [`2026-07-28-plan-repair-with-ratchet.md`](2026-07-28-plan-repair-with-ratchet.md) — verdict UPHOLD with four amendments, Steps 0–10.
- Handoff that framed it: [`2026-07-28-handoff-repair-vs-rebuild.md`](2026-07-28-handoff-repair-vs-rebuild.md)

Two answers inside it that close off whole branches of investigation:

- **Q1 — is the repo a viable base? YES, verified.** 85/85 live hook
  registrations are reproducible from committed state; 18/18 live-only hooks are
  in HEAD as both src and dist. **The rebuild-from-live branch is closed.**
- **Sequencing is not negotiable: ratchet before prune.** Two of five
  investigations in that document failed on a count read from the wrong place.
  A prune run before the ratchets exist would delete live hooks on no data.

---

## 3. Ratchet plan — step status

| Step | What | State |
|---|---|---|
| 0 | Capture uncommitted config | **DONE** — `.mcp.json` earlier; the 59 `~/.claude/commands` landed this session. One follow-up, §5.1 |
| 1 | Codex Bug-1 propagation | **DONE** — see `scripts/codex-rollout-audit.sh` |
| 2 | RATCHET A: registration reconciliation | **DONE** — folded into `hook-contract-guard.mjs` |
| 3 | RATCHET B: output-contract assertion | **DONE** — the dropped-envelope bug was real and is fixed (`fd906dd`); guard reports 0 |
| 4 | RATCHET C: timer census | **DONE** — guard reports 9/9 |
| 5 | Fix 7 dangling-timer hooks | **DONE** — covered by the 9/9 above |
| 6 | Re-measure hook latency with real payloads | **DONE** — ~1s per tool call, concentrated in 2 processes |
| 7 | Decide on Braintrust tracing | **MEASURED, DECISION OPEN** — see §4.1 |
| 8 | Context lever | **DONE** — 145.6k → 67.4k memory-file tokens/session |
| 9 | Fleet-wide `paths:` frontmatter | **OPEN, unstarted** — verified **0 of 46** rules carry `paths:` |
| 10 | Re-derive prune list, then prune | **OPEN — do LAST** |

Step 10's telemetry exists and is live: `.claude/logs/intel-bus.jsonl`, 764 KB,
written today. (It is in the **repo** tree, not `~/.claude/logs` — checking the
wrong path makes it look missing.)

---

## 4. Open decisions that are yours, not ours

### 4.1 Braintrust tracing — a measured trade, awaiting a call

A/B on real turns, 12 per arm: tracing ON p50 **955 ms**, OFF **317 ms**, so
**~640–690 ms per tool call**, on *every* PostToolUse. Disabling leaves a ~264 ms
floor; deregistering the hook saves the full ~955 ms.

Against that: tracing is the only telemetry the harness has that isn't dead
(`hook-trace.jsonl` has been dead since 2026-05-18). Detail in the plan, Step 7.

### 4.2 Resolved 2026-07-29 (was: decisions pending)

All four are closed. Recorded because each was a standing item, not because the
work was interesting:

- **Braintrust tracing: STAYS ON.** ~690 ms/tool call is accepted for now — it is
  the only live telemetry, and killing it mid-refinement removes the instrument
  you'd judge Steps 9–10 with. Revisit after the suite is green and the prune is
  done. The measurement is in the plan, Step 7; nothing to re-derive.
- **`.claude/settings.local.json`: untracked.** `git rm --cached`, file untouched
  on disk, ignore rule already present at `.gitignore:295`. Was tracked despite a
  dated note saying otherwise; secret-scanned clean, so no rotation.
- **Fossil `.claude/scripts/sync-claude.sh`: deleted**, repo copy and `~/.claude`
  mirror (D7d-02, D8a-03). Verified beforehand that it is a *different file* from
  the live reverse-sync at `scripts/sync-claude.sh` (3698 vs 6586 bytes, distinct
  hashes) and that only docs referenced the fossil path, while 4 rules reference
  the live one. The live script still parses (`bash -n`, exit 0).
- **`sites/fastmcp-v3` has a remote:** `Rev4nchist/fastmcp-v3`, **private**,
  pushed `0 0` at `e6c2ae9`. It is no longer a single-copy repository. The push
  needed an ephemeral inline credential helper reading `$GITHUB_TOKEN` — the
  configured helper fails with "could not read Username" though `gh` is
  authenticated (see §6).

---

## 5. Fix-first items (verified active harm, cheap to fix)

### 5.1 A search router that denies greps using a 143-day-stale index

**Verified today, not inferred:** `smart-search-router` is registered in live
`settings.json`; it emits `permissionDecision: 'deny'` at two sites
(`smart-search-router.ts:563` and `:648`); and the semantic index it gates on,
`.tldr/cache/semantic/index.faiss` (6.8 MB), was last written **2026-03-08 —
143 days ago**.

So greps get denied and redirected toward results derived from a 4.7-month-old
index. This is the active-harm case the code-intel proposal measures
([`../self-improvement/proposals/2026-07-29-code-intel.md`](../self-improvement/proposals/2026-07-29-code-intel.md),
verdict **skip** — the 2026-07-24 cut was right and should not be reversed, it
was just left half-finished). Read that before search-heavy work here.

### 5.2 TLDR remediation is planned, not applied

[`2026-07-29-tldr-remediation-plan.md`](2026-07-29-tldr-remediation-plan.md) —
hardened by a cross-model premortem, 8 changes. **Not applied:** plan item 4 is
"deregister `tldr-context-inject`", and it is still registered in live
`settings.json`. Findings it rests on:
[`2026-07-29-tldr-token-savings-findings.md`](2026-07-29-tldr-token-savings-findings.md).

Headline from the findings, because it inverts the obvious conclusion: the
saving is **monotonic in file size** — under 5 KB it *loses* ~10k tokens, over
50 KB it wins. So retarget the threshold (3 KB → 8 KB), don't cut the tool.

### 5.3 The `commands` copy now syncs — DONE

`SYNC_DIRS="agents skills scripts docs commands"`. Verified a no-op on the first
run (`commands: OK (59 files)`, 0 files changed), because the repo and active
copies were hash-identical when the backup landed.

That change surfaced a separate live bug, which is now §6's first entry: the
forward sync was **silently not syncing `project-registry.json`** and blaming the
file for it.

### 5.4 Test backlog — items 1 and 2 are DONE

1. ~~The two suite hangs~~ — **done**, see §1. The suite returns a verdict.
2. ~~39 tests collected by no runner~~ — **done**. `extractLedgerSection`,
   `findSessionHandoff` and `mainHandoffFirst` imported `describe/it` from
   `node:test`; all three carried the header `Run with: npx tsx --test`, but
   **`tsx` is not installed** (absent from devDependencies *and* node_modules), so
   the documented command never worked here. Converted to vitest: 78 assert calls
   across 4 APIs, via a paren- and quote-aware transform rather than a regex,
   because 12 were multi-line with nested calls and commas.

   `mainHandoffFirst` then failed 9/9 on one shared Windows bug: its helper ran
   ``execSync(`echo '${json}' | CLAUDE_PROJECT_DIR="${dir}" node "${hook}"`)`` —
   POSIX-only twice over, since Windows `execSync` uses cmd.exe where
   `echo '{...}'` emits literal quotes and a `VAR="x" cmd` prefix is not valid
   syntax. Replaced with `spawnSync` piping stdin. All 39 now pass.

**Remaining work is planned in full — see
[`2026-07-29-suite-green-plan.md`](2026-07-29-suite-green-plan.md).** It is one
session's worth, with the arscontexta block correctly sized (a deletion, not an
investigation), the 4 real root causes identified, the 15-hook guard mapping
pre-computed, and the tsc errors deliberately excluded.

> **CORRECTION.** An earlier revision of this section called arscontexta "the whole
> remaining ballgame — treat it as a subsystem investigation". That was wrong, and
> wrong in the way this repo keeps being wrong: a confident note written from a
> count without checking what the count referred to. The subsystem had been deleted
> a month earlier. Ninety seconds of `Get-ChildItem` would have caught it, and the
> claim survived a commit because nothing checks a doc's assertions.

### 5.5 The YouTube pipeline is unaudited

`scripts/youtube/` landed this session — it had a registered Windows scheduled
task and poll logs for 07-25 → 07-29 while being entirely untracked. **Not
verified: that those runs are succeeding.** The logs exist; their contents were
never read.

---

## 6. Things that will bite you

Every one of these cost real time already.

- **`bash` on this machine is WSL, not Git Bash — and WSL has no node.**
  `bash` resolves to `C:\WINDOWS\system32\bash.exe`: `/mnt/c/…` paths, **no node
  on PATH**. Git's hooks use `…\Git\bin\bash.exe`: `/c/…` paths, node at
  `/c/Program Files/nodejs`. So the same shell script behaves differently
  depending on who runs it, and a node-dependent step silently degrades when you
  run it by hand.

  This was live: `sync-to-active.sh` printed *"repo project-registry.json is
  invalid JSON -- NOT synced"* for a file that node and PowerShell both parse
  fine. The real cause was `command -v node` failing under WSL, and the message
  blamed the file. The post-commit path (Git Bash) synced it correctly, which is
  why it went unnoticed. The check now distinguishes *cannot validate* from
  *invalid* and names the shell. **When a shell script misbehaves, check which
  bash ran it before debugging the script.**

- **The MSYS fork storm is live and frequent.** Two Bash-tool deaths in this
  session alone (`add_item ... errno 1`). Fall back to the **PowerShell tool**
  for git and network ops, and commit through
  `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>` — it recovered
  on attempt 2 twice today. Root cause is **not** established; the lane's own
  log is structurally blind to Bash-tool crashes. See
  `.claude/rules/windows-platform.md`.
- **Hung test runners accumulate silently.** Found a vitest tree from
  **2026-07-28 13:33 still alive 29 hours later** at ~0 CPU with a 0-byte output
  file. `Stop-Process` misses the descendants; use `taskkill /PID <n> /T /F`, or
  `pwsh -File scripts/msys/reap.ps1` (dry-run, then `-Force`). Check for these
  *before* concluding your own suite is hung.
- **`--reporter=basic` no longer exists in vitest 4.** It fails as a "Startup
  Error / Failed to load custom Reporter", which reads exactly like a broken
  test setup. Use `default` or `dot`.
- **Gates that measure something adjacent to what they claim.** Three instances
  now on record: `/health-check` reporting `PASS | 0 registrations` while 85
  hooks fired; a "VERIFIED by grep" list that was 7 wide when reality was 13;
  and the session-start "dist is stale" warning that fired on a freshly built
  tree for months (fixed this session, `7da2884`). **Read the count before the
  verdict.**
- **Every acceptance criterion needs a positive control.** Both new tests added
  this session initially "passed" for the wrong reason — the hook was returning
  early and never reaching the code under test. Their paired control caught it.
  Prove a new test can fail by reconstructing the old behaviour.
- **`~/.claude` drift recurs by design** after every forward sync. If it ever
  matters the fix is a scheduled snapshot commit, not a hook — `PostToolUse`
  cannot see shell-copy writes.
- **Do not run `scripts/msys/repro.ps1` unattended.** It deliberately storms the
  machine and has twice left dozens of blocked processes behind.
- **`git push` fails with "could not read Username" though `gh` is authenticated.**
  The configured credential helper cannot prompt in these shells. Route around it
  per-command without touching config (a peer session owns the dual-account lane):
  `git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' push …`
  — token comes from env, never appears in argv, nothing persisted.
- **A synchronous `spawnSync`/`execSync` cannot be interrupted by a test timeout.**
  `--testTimeout=4000` let tests *pass* at 10463 ms each. If a suite is slow but
  green, look for blocking sync calls before believing the timings.

---

## 7. Where the material lives

| Thing | Path |
|---|---|
| Strategy + measurement docs (this dir) | `docs/harness-strategy/` |
| Self-improvement proposals + verdict index | `docs/self-improvement/INDEX.md` |
| Hook concurrency plan | `docs/hook-dispatcher-consolidation-plan.md` |
| Session handoffs (YAML, newest last) | `thoughts/shared/handoffs/<lane>/` |
| Architecture entry point | `docs/architecture/INDEX.md` |
| Mechanised guards | `scripts/hooks/`, `scripts/coordination/`, `scripts/audit-braintrust-emits.sh` |
| Live hook telemetry | `.claude/logs/intel-bus.jsonl` |
| Coordination lane board | `node scripts/coordination/lane.mjs board` |

Most recent handoffs, in order:
`thoughts/shared/handoffs/context-lever/2026-07-29_19-40_session-wrap.yaml`,
then `..._18-05_phase2-complete.yaml`, then
`thoughts/shared/handoffs/agentic-os/2026-07-27_09-35_lane-bus-live-and-gpu-crashes.yaml`.

`/recall` now works for project-scoped rows — it was hashing the CWD instead of
the matched project root, so the documented `cd $CLAUDE_OPC_DIR && recall`
invocation derived a project id no row carries (fixed `92600ef`). **Any recall
result from before that commit is suspect.**

---

## 8. Lane map

`node scripts/coordination/lane.mjs board` is authoritative; lane notes are
snapshots with no expiry, so **verify a note's factual claims before working
from them** — four notes had already gone stale by 2026-07-27.

Relevant to CCv3 refinement specifically:

| Lane | State | Note |
|---|---|---|
| `harness-security` | ready | scope `sync-to-active.sh` · `settings.json` — owns §5.3 |
| `msys-fork-storm` | done, unresolved | instrumented, root cause NOT established |
| `conflict-events` | ready | `claim_degraded` exists but nothing emits it |
| `self-improvement-triage` | backlog | |
| `reporting-phase-2` | backlog | |
| `aos-project-canvas` | backlog | unblocked; the drill-in half of the dashboard |
| `github-dual-account` | active (peer) | scope: gitconfig · ssh · gh config · `.mcp.json` github server |

Serialize commits — one branch, several sessions, and `.git/index.lock` races.
