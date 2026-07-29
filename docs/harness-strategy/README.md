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

### The test suite is NOT green — and it cannot complete

This is the one place "stable" needs qualifying. Every mechanised guard above
passes, but `npx vitest run` in `.claude/hooks` **never finishes**. Inventoried
2026-07-29 by running all 113 files in isolation with a 45 s cap, via
`pwsh -File scripts/hooks/test-bisect.ps1`:

**99 pass · 12 fail · 2 hang.**

| Class | Files | Note |
|---|---|---|
| **Hangs** — why the full suite never returns | `daemon-client.test.ts`, `maestro-detector.test.ts` | Both exceed 45 s in isolation. Cause not investigated |
| **Never collected by vitest** | `extractLedgerSection`, `findSessionHandoff`, `mainHandoffFirst` | Import `describe/it` from **`node:test`**, not `vitest`. Vitest loads them, registers no suite, reports "No test suite found" — **39 test cases** that run under no runner at all. They also fail under `node --test`. Zero coverage while appearing to exist |
| **Real assertion failures** | 5 × `arscontexta-*` | e.g. keyword-matching: repeated "expected false to be true" |
| **Narrow real failures** | `braintrust-score` (1 of 19 — a mock asserted not-called was called once), `telemetry-tracker-braintrust`, `plan-exit-tracker`, `store-learning-injection` | |

Fixed this session and no longer in that list: `ralph-task-monitor-braintrust`
was 4 failed / 6 passed because the tests still asserted the
`BRAINTRUST_SESSION_ID` env var that `2542561` retired a day earlier — and its
two "returns null" tests were passing **vacuously**. Now 12/12 (`e26141c`).

**Do not read a passing `npx vitest run <file>` as suite health**, and do not
wait on a full run — it will sit at ~0 CPU indefinitely. Until the two hangs are
fixed, the per-file harness is the only way to get a complete signal.

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

### 4.2 Two destructive items deliberately left undone

- The fossil `.claude/scripts/sync-claude.sh` and its `~/.claude` mirror still
  await the June review's recommended deletion (D7d-02, D8a-03).
- `.claude/settings.local.json` **is still tracked** (`git ls-files` returns it)
  even though `.gitignore` carries a dated 2026-07-28 note saying it was
  untracked because it held 21 permission grants and zero deny entries. The
  documented intent is not in effect. Secret-scanned clean today — no rotation
  needed. Fix is `git rm --cached .claude/settings.local.json`, which is a
  tracked-state change on a config file, so: your call.

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

### 5.3 The `commands` copy does not sync

Landed this session as a backup. No sync script handles it (0 mentions across
all nine `scripts/sync*` files; `SYNC_DIRS="agents skills scripts docs"`), so
the repo copy can go stale. Wiring is one word:

```
SYNC_DIRS="agents skills scripts docs commands"
```

Left undone deliberately — `sync-to-active.sh` is shared, load-bearing, and in
the declared scope of the `harness-security` lane. Bounded failure mode: a stale
snapshot can mislead a human, never the harness, which reads `~/.claude/commands`.

### 5.4 The two suite hangs, and 39 tests running under no runner

Highest-leverage test work, in order:

1. **`daemon-client.test.ts` and `maestro-detector.test.ts` hang.** Fixing these
   two restores a whole-suite verdict, which nothing else can substitute for.
2. **Point the 3 `node:test` files at vitest** (`extractLedgerSection`,
   `findSessionHandoff`, `mainHandoffFirst`) — 39 test cases currently collected
   by nothing. Mechanical: swap the import, translate `node:assert` to `expect`.
   Expect some to then fail for real; that is the point.
3. The 5 `arscontexta-*` failures, then the 4 narrow ones.

A guard belongs here once (1) and (2) are done — assert the pass count never
drops and that no test file imports from `node:test`. Adding it before then would
just pin the current red state.

### 5.5 The YouTube pipeline is unaudited

`scripts/youtube/` landed this session — it had a registered Windows scheduled
task and poll logs for 07-25 → 07-29 while being entirely untracked. **Not
verified: that those runs are succeeding.** The logs exist; their contents were
never read.

---

## 6. Things that will bite you

Every one of these cost real time already.

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
