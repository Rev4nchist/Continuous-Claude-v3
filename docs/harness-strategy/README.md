# CCv3 refinement — start here

Entry point for picking this work back up. Written 2026-07-29 at the end of a
stabilisation session, against branch `agentic-os`.

Read this, then read the one linked doc for the workstream you're picking up.
Nothing here duplicates those docs; it records **what state each thing is in**,
**what the next concrete action is**, and **what has already been proven false**.

---

## 1. Is the harness stable right now?

Yes, on every gate that exists. Verified 2026-07-29 unless noted, all counts
non-vacuous (each asserts a nonzero denominator, so none can pass by finding
nothing):

| Gate | Command | Result |
|---|---|---|
| Hook registration + output contract + timers | `node scripts/hooks/hook-contract-guard.mjs` | PASS — 86 live entries / 80 names, 80 sources scanned, 55 speak the contract, **0** discarded-output, **9/9** timers safe. ⚠️ these counts predate the `Stop` registration added 2026-08-11 (`ccdd14b`, §4.1) — re-run |
| Braintrust scoring layer can emit | `node scripts/hooks/braintrust-emit-guard.mjs` | PASS — 114 sources, 4 emit sites / 4 hooks, config reachable, 0 dead span sources |
| Suite cannot silently shrink | `node scripts/hooks/suite-count-ratchet.mjs` | PASS — baseline 2164 passed / 2171 collected |
| No module-scope `main()`, no `node:test` | `node scripts/hooks/suite-shape-guard.mjs` | PASS — 114 sources, 109 test files, 0 and 0 |
| Emit-count invariant | `bash scripts/audit-braintrust-emits.sh` | PASS — Found 4, invariant 4 |
| Coordination liveness predicate | `node scripts/coordination/liveness-predicate-guard.mjs` | PASS — 6/6 files, 23 correct predicates, 0 bare-heartbeat tests |
| Hook build actually current | `cd .claude/hooks && npm run build` then `git status --porcelain .claude/hooks/dist` | clean — rebuild changes zero bytes |
| Repo ↔ `~/.claude` drift | see §6 | rules 46/46, agents 66/66, dist 261/261 |

### The test suite is GREEN — and now ratcheted

`npx vitest run` in `.claude/hooks` used to have no exit at all. As of
2026-07-29 it completes in ~10 s and **passes**:

**117 files · 2284 pass · 0 fail** (verified 2026-08-11 with `ccdd14b`; was
**109 files · 2158 pass · 0 fail · 7 skipped** on 2026-07-29).

Verified twice back to back, which matters: one of the fixes was a test that only
passed on the first run in any 5-minute window.

Two ratchets now hold this, each **demonstrated failing on purpose** (a guard
never seen to fail is not yet a guard):

```
node scripts/hooks/suite-count-ratchet.mjs     # 0 failures, and neither passed
                                               # nor COLLECTED may drop below the
                                               # baseline recorded in
                                               # scripts/hooks/suite-baseline.json
node scripts/hooks/suite-shape-guard.mjs       # 0 module-scope main() calls,
                                               # 0 node:test imports
```

The *collected*-count assertion is the one a plain `vitest run` cannot give you:
a file that stops being collected removes its tests from the total while the
suite still reports green. That is how 39 tests ran under no runner at all.

The journey was **93 → 0**: 83 fossils deleted (13 assertions salvaged first),
7 + 2 stale tests retargeted, and **2 live defects the tests were right about** —
see §4.1 and §5.6.

Neither original blocker was a slow test:

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

✅ **Latent hang class — CLOSED. All hooks now carry the `argv[1]` guard**, and
`suite-shape-guard.mjs` keeps it at zero.

> **CORRECTION — the count was 15, then 18, then 27.** This section listed 15
> hooks. The real number was **27**. The list was built from a grep for a bare
> `main();` and missed `main().catch(...)`; a first recount said 18 because
> `/\.catch\([^)]*\)/` cannot match `catch(() => console.log(''))` — nested
> parens. Third time in this workstream that a "verified" list turned out to be
> exactly as wide as the grep behind it, and the second and third narrowings were
> mine. The guard now matches any zero-arg call at column 0, no hardcoded names
> or spellings.

Because the guard's failure mode is **inverted** — a guard string absent from
`argv[1]` silently disables a *live* hook, worse than a hanging test — this was
verified three ways rather than asserted:

- Registration computed from the **live** `settings.json` for all 27: **15
  registered**, every one as `<name>.mjs`; **12 not registered at all** (the old
  table named 4 of those). Zero where the guard would not fire.
- **Differential test**: pre-guard bundle from `git HEAD` vs post-guard bundle on
  byte-identical stdin → 13 IDENTICAL and non-empty. Its first version reported
  `guardrail-enforcer` and `lane-context` as broken; they were not — both are
  stateful, so whichever bundle ran *second* emitted less and the test was
  measuring its own call order. Fixed with a fresh TEMP, project dir and session
  id per invocation.
- **Predicate probe** for the two hooks that emit nothing either way
  (`mcp-activity-tracker`, `ralph-monitor`): guard fires **27/27** under the
  production basename, negative control false 27/27. Both write through a
  `try/catch`'d side channel, so no behavioural test can settle them — and
  "inconclusive" on a live hook is not a pass.

Side finding: `mcp-activity-tracker` and `permission-auto-allow` are registered in
the **active** `settings.json` but absent from the repo's — live-only hooks a
fresh bootstrap would not get.

The 93 failures, as they were resolved:

| Files | Was | Outcome |
|---|---|---|
| 5 × `arscontexta-*` | **83** | **DELETED** (`0773a9f`) — fossils, confirmed: 0 skills, 0 agents, 0 hook sources, 0 matches in `skill-rules.json`. But the plan also pre-authorised dropping their **32 passing** tests, and **13 of those were real coverage existing nowhere else**: regex-validity over all 254 `intentPattern`s (the production matcher `try/catch`es a bad pattern, so it silently stops a skill triggering — nothing else checks it), and the suite's **only** E2E spawn of `dist/skill-activation-prompt.mjs`. Salvaged into `skill-rules-integrity.test.ts` (14 tests, each with a positive control), *then* deleted |
| `plan-exit-tracker` | 7 | **FIXED — stale test, one cause.** `331ce8b` made the hook write a project-scoped path; the test still read the session-only name. The **gate was never broken** — `plan-to-ralph-enforcer.ts:155` resolves byte-identically to what the hook writes. Also fixed `afterEach`, which only unlinked the legacy names, and the naming regex, which matched both layouts and so could not have caught the drift |
| `store-learning-injection` | 2 | **FIXED — stale test, over a REAL regression.** It asserted the function *name* `spawnSync`; `09ba655` moved to a detached `spawn` with the security invariant intact. Retargeted to the invariant (`shell:false`, raw argv) — `/spawn\s*\(/` would not work either, since the call goes through an injected seam. **The regression underneath is now FIXED too — §5.6** |
| `braintrust-score` | 1 of 19 | **FIXED — the OFF switch really was broken. See §4.1.** Not flaky: 4/4 red, deterministic. And the `DNS failure` in the log was a **mocked** rejection, not a real network call — that suspicion was wrong |
| `hook-error-pipeline` | (appeared) | **FIXED — this was the 93↔94 flapper.** Not caused by the above: it dedups identical errors for 5 min via a real file in `$TEMP`, keyed on hook+message, so it passed once and failed on every rerun inside the window. Proven: delete marker → 7 pass; rerun immediately → 1 fail. The live marker held 20 entries, some days old. The hook itself was later **archived** as dead code — §5.7 |

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
| 7 | Decide on Braintrust tracing | **MEASURED, DECISION OPEN** — see §4.1. ⚠️ the off switch it assumed did not work until `688228f` |
| 8 | Context lever | **DONE** — 145.6k → 67.4k memory-file tokens/session |
| 9 | Fleet-wide `paths:` frontmatter | **DONE with a finding (2026-08-30)** — 4 of 46 rules scoped, both directions live-probed (headless `claude -p`: scoped rule absent in a neutral dir, present after reading a matching file). The finding that caps it at 4: `paths:` rules load **when Claude reads a matching file** (code.claude.com/docs/en/memory.md), so command-triggered rules — every CLI-safety rule, git workflow, windows-platform — would be DISARMED by scoping, not economized. Scoped: hook-dev-lifecycle, prefer-drizzle-orm, dev-server-cleanup, knowledge-tree-health (~9KB out of non-matching sessions). Candidates pending a Skill-tool-read probe: codex/grok worker safety (~24KB) scoped to their skill dirs |
| 10 | Re-derive prune list, then prune | **QUALIFIED, awaiting Dave (2026-08-30)** — 114 src files, 81 registered names, 35 unregistered. Libraries (keep): daemon-client (11 importers), transcript-parser, skill-router/skill-validation-prompt (chain hangs off skill-activation-prompt, which is repo-registered but retired from ACTIVE 2026-08-19 — reconcile). 33 candidates swept: every reference is docs/audits/backups/archives; zero live consumers in scripts/, package.json, or either settings.json; zero telemetry rows (intel-bus + hook_activity; `diagnostics`' 350 rows are post-edit-diagnostics, a different hook). Deletion blocked on explicit approval per plan |

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

> ⚠️ **The premise this decision rested on was FALSE until `688228f`.** "Keep it
> on, we can turn it off later" assumed `TRACE_TO_BRAINTRUST=false` works. It did
> not. `loadClaudeDotEnv()` merged `~/.claude/.env` (which says `true`) into
> `process.env` **inside** `isTraceEnabled()`, before the comparison — so an
> environment `false`, or one in the `settings.json` `env` block, was silently
> overwritten. Proven by execution: the module POSTed to
> `/v1/project_logs/<file's id>/feedback` using the **file's** API key while
> `process.env.TRACE_TO_BRAINTRUST` was `'false'`. Editing `~/.claude/.env` did
> work — and nothing documented that.
>
> Both layers are fixed (`braintrust-score.ts` **and** `braintrust_hooks.py` —
> patching one would let an env `false` silence scores while the other kept
> minting spans). An explicit environment value now wins for this one variable;
> every other variable still comes from the file, so the default is unchanged.
> Confirmed safe first: `TRACE_TO_BRAINTRUST` appears **0 times** in
> `settings.json` and `settings.local.json`, so the environment is genuinely
> silent in normal launches. Covered by the off-switch test **and** a negative
> control, because "no requests" is also what a dead emitter looks like.
>
> 🔑 **Rotate the Braintrust API key.** The suite read the developer's real
> `~/.claude/.env`, so the failing assertion printed
> `Authorization: Bearer sk-...` into test output. Anywhere that red test was
> pasted — CI log, screenshot, handoff — the live key went with it. Tests are now
> hermetic via `BRAINTRUST_DOTENV_PATH`, but that does not un-leak what already
> escaped.

> **UPDATE 2026-08-11, `ccdd14b` — the traced data itself was wrong, and is now
> fixed. The ON/OFF latency call above is unchanged and still open.**
>
> `braintrust_hooks.py stop` was registered **only** on `SessionEnd`, so it ran
> once per session — while being written for per-turn incremental work (it tracks
> `turn_last_line`). Result: **7,610 of 8,726 turn spans (87%) across 1,637
> sessions were opened and never closed** — open-ended, unbounded duration in the
> Braintrust UI. So the instrument you would judge Steps 9–10 with was recording
> 87% of its turns as never-ending.
>
> `stop` now also fires on a new **`Stop`** event key in **both** `settings.json`
> copies (repo and active), `python … braintrust_hooks.py stop`, timeout 15000 —
> there was no `Stop` key at all before. It **remains** on `SessionEnd`
> (timeout 30000) deliberately, as a safety net for an abrupt exit mid-turn;
> nothing was removed. It no longer writes `current_turn_span_id` (the only
> two-writer key — `user_prompt_submit` owns it exclusively now), and it is
> **idempotent**: it returns early ("already finalized") when the transcript has
> no new lines, replacing the old clear-the-span-id re-entry guard.
>
> Two beliefs that shaped the design were settled by experiment, not inference,
> and both removed planned work:
> - **`Stop` and `UserPromptSubmit` are serialized.** The CLI does not fire
>   `UserPromptSubmit` until every `Stop` hook returns — proven with 90 s and 40 s
>   holds (next prompt at +90,444 ms and +40,327 ms). So the locked merge is not
>   needed (deferred as Option B), and the planned concurrent-writers test was
>   dropped: it would have asserted against a fiction.
> - **Braintrust tolerates a parent span arriving after its children.** A child
>   with a dangling `span_parents` reference is accepted (HTTP 200) and the
>   hierarchy resolves on read. The spool needs no parent-before-child ordering.
>
> Guarded by 3 tests in
> `.claude/hooks/src/__tests__/braintrust-hooks-shutdown.test.ts` (12 tests in
> that file); full hook suite 117 files / 2284 passed / 0 failed. Verified live:
> the STOP HOOK CALLED count incremented, `turn_last_line` appeared, and
> `current_turn_span_id` held the **new** turn's id rather than `""`. Full detail:
> [`../hooks/braintrust-stop-event-scope.md`](../hooks/braintrust-stop-event-scope.md) §3.

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
  authenticated. (That helper failure was root-caused and fixed 2026-08-11 — see
  §6; the inline helper is no longer needed.)

---

## 5. Fix-first items (verified active harm, cheap to fix)

### 5.1 A search router that denies greps using a 143-day-stale index — FIXED 2026-08-30

**Applied (`022d7cf`, branch `harness-repair-finish`):** both deny sites now
allow; context routing survives; symbol/caller lookups are async socket calls
gated on a 250ms reachability probe (was up to 6 PowerShell spawns per Grep —
7.0s → 0.4s measured). The section below is the pre-fix record.

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

### 5.2 TLDR remediation is planned, not applied — APPLIED 2026-08-30

**All 8 changes landed (`022d7cf`, branch `harness-repair-finish`).** Headline
acceptance: daemon DOWN → `{}` in 75ms (was a 31.6s deny); daemon UP → real
TLDR context in 345ms. Threshold 8KB, fail-open probe + negative cache,
exact-path + consume-once handshake, zombie detection, timeouts 30000→30
(seconds), `tldr-context-inject` deregistered from BOTH settings copies (it
was already gone from active — the copies had diverged). The section below is
the pre-fix record.

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

3. ~~The remaining 93 failures~~ — **done**, `0773a9f` + `688228f` + `ea5187e`.
   The plan is
   [`2026-07-29-suite-green-plan.md`](2026-07-29-suite-green-plan.md); all 6 steps
   landed, plus both ratchets. Suite is **0 fail** (§1).

   Two places the plan was wrong, recorded because in both cases the plan was
   confident and the number was checkable in about a minute:
   - it authorised deleting the 5 arscontexta files outright, **including their 32
     passing tests**. 13 of those were live coverage existing nowhere else.
     Salvage first, then delete.
   - the guard mapping said **15** hooks. It was **27**.

   Only `tsc --noEmit` remains excluded — still exactly **234** errors, unchanged,
   none in any file touched this session.

### 5.6 `agent-error-capture` — FIXED 2026-07-29. Three stacked causes, all closed

> **RESOLVED, `24e47a2`.** The store lands rows again, verified end to end through
> the REAL built hook: two **unrelated** failures both stored, hook wall time
> ~300 ms (node startup, not the store). First successful delivery since
> 2026-02-18.
>
> **There were three causes, not two. Each alone sufficient, each silent.**
>
> | # | date | cause | how it was found |
> |---|---|---|---|
> | 1 | 2026-02-18 `05abf54` | content blacklisted by `NOISE_PREFIXES` | SQL + in-process gate probe |
> | 2 | 2026-06-29 `09ba655` | detached store never completed | 4-arm isolation |
> | 3 | 2026-07-29 *(my own fix)* | boilerplate → 0.88 dedup collapse | end-to-end check |
>
> **Cause 2, root-caused rather than guessed.** `unref()` followed by the parent
> exiting in the **same synchronous tick** kills the child. One variable, four arms,
> identical spawn:
>
> | arm | parent exit | row |
> |---|---|---|
> | same tick as spawn (**what the hook did**) | — | **no** |
> | one tick later, on the `spawn` event | — | yes |
> | after a 500 ms grace | — | yes |
> | OS-level breakaway (`cmd start /b`) | — | yes |
>
> That **rules out Windows job-object teardown**, the obvious rival: if job closure
> at parent exit were the killer, the two arms that also exit — just a tick later —
> would have failed too, and only the breakaway would have survived. It is a startup
> race, so one event-loop turn fixes it. `releaseWhenRunning(child)` now releases on
> `spawn`/`error`; Node guarantees exactly one fires, so the loop cannot hang. Cost:
> one turn (~1–5 ms), not the 10 s `spawnSync` that `09ba655` removed.
>
> **Cause 3 was mine, and only the end-to-end check caught it.** The first B1
> wording used a ~95-char fixed lead-in to guarantee the 100-char `FAILED_APPROACH`
> floor. Measured **0.88** embedding similarity between two *unrelated* failures,
> against a 0.85 dedup threshold — so the first failure would land and every later
> one would be skipped as a duplicate, silently. **A boilerplate-dominated record is
> a duplicate of every other record.** Fixed by leading with the distinctive
> material and cutting the boilerplate, which deliberately trades the guaranteed
> floor away: an ultra-terse error can now be dropped as `too_short`, losing **one**
> thin learning, where dedup collision loses **all but the first**. A test bounds
> fixed boilerplate at <80 chars by diffing two captures that differ only in error
> text.
>
> **Verification standard, because this pipeline lies.** A green unit test has never
> meant a row exists here: the in-process gate probe passed all five content shapes
> while production stored zero. The child's real argv had to be captured from the
> process table. And **two of my own harnesses produced false results first** — one
> measured its own call order (stateful hooks), one measured its own teardown (a
> node wrapper exiting and tearing down the tree). Only a row in `archival_memory`
> counts.
>
> **Open follow-up, cosmetic, pre-existing:** `extractErrorContext` returns the
> whole stringified `tool_response`, so stored content begins with a JSON wrapper
> (`{\n  "content": "ENOENT: …"`). Functional but poor for recall readability.

### 5.6-history The original decision and its evidence

> **UPDATE 2026-07-29, `84454e4`. Dave chose B1 (unblock, then measure).** The
> prefix half is fixed and guarded. **A SECOND, INDEPENDENT CAUSE was then found by
> the end-to-end check, and the pipeline is still dead.**
>
> **Fire-and-forget never finishes.** Isolated with one variable, identical spawn in
> both arms:
>
> | arm | parent | row lands |
> |---|---|---|
> | P | exits immediately — **the hook's actual behaviour** | **no** |
> | W | waits 40 s | **yes** |
>
> And the discriminator proving it is not the gate: the **same** invocation, same
> content, same cwd, run synchronously with stdio inherited prints
> `Learning stored (id: …)` and lands a row. Only the detached-with-parent-exit form
> fails — silently, exit 0.
>
> So `09ba655` (2026-06-29, QW-04) made the store `detached` + `unref()` +
> `stdio:'ignore'` to stop a 10 s `spawnSync` blocking Task completion. It fixed the
> latency and broke the delivery. **Two stacked causes, either alone sufficient:**
>
> | date | commit | cause | status |
> |---|---|---|---|
> | 2026-02-18 | `05abf54` | content blacklisted at ingestion | **fixed** `84454e4` |
> | 2026-06-29 | `09ba655` | detached store never completes | **OPEN** |
>
> Mechanism not established — candidates are Windows job-object teardown, the `uv`
> launcher's own python child, or node exiting before `CreateProcess` settles. **Not
> guessing at a fix on the Task hot path**: a durable JSONL queue plus a drainer, a
> bounded synchronous store, and holding the parent briefly trade latency against
> reliability differently, and that is a deliberate call.
>
> Two consequences for the "then measure" half of B1:
> - the row count stays **zero** until delivery is fixed. Do **not** read a flat
>   count as "B1 shows low volume".
> - an end-to-end check is mandatory on this pipeline. The in-process gate probe
>   passed on all five content shapes while production stored nothing. **A green
>   unit test here has never meant a row exists.**

### 5.7 `hook-error-pipeline` — ARCHIVED 2026-07-29 (`24e47a2`)

> **DONE.** Moved to `.claude/hooks/archive/hook-error-pipeline.ts`, its `dist`
> bundle deleted (in the repo **and** the `~/.claude` mirror — the forward sync
> copies but never deletes, so a stale bundle there would keep reading as a live
> hook). Its QW-01 test was removed with it: keeping a security test for a module
> nothing loads is precisely what let the arscontexta fossils sit red for a month.
> The two producers that actually run keep their QW-01 coverage. Suite green after,
> and nothing referenced it — verified before and after.

The investigation that justified it:

Investigated 2026-07-29 (the other half of the 0-for-2 question in §5.6). **The gate
is not the cause: `"Hook '"` is not blacklisted and a realistic failure PASSES
validation.** The cause is that `captureHookError` is **never invoked in
production** — zero importers outside its own test, and not registered in any
`settings.json`.

Verified: 13 different DB query shapes all return 0 (content, tags, context, type),
so the zero is robust and not a wrong `LIKE` pattern; the content template is
unchanged since `7793392` (2026-02-01), so the pattern was never wrong; the only
invocations that ever happened were in the test suite **with `spawnSync` mocked** —
which is the clean discriminator between "rejected" and "never called".

Three independent audits already reached this: the health check lists it under
`orphans` in **35** `health_*.json` files, `hook-audit-2026-04.md:134` files it as
"probably archive", and the 2026-06-10 WF2 review called it `UNREACHABLE / dead
code`. **Recommendation: archive it** — 242 lines of source, a dist artifact, a
test, and a permanent orphan entry, for zero behavioural change.

If the capability is ever wanted it needs **two** fixes, and the second is the
non-obvious one: it cannot be registered as a standalone hook (no stdin handler —
only `wrapWithErrorCapture` at each hook's entry makes it live), **and** its
`--type FAILED_APPROACH` carries a 100-char floor that would silently swallow the
short-message class (`ECONNREFUSED`, a thrown string). `ERROR_FIX` (floor 50) is
both semantically closer and safer. Also latent: a deep repetitive stack trips the
uniqueness-ratio gate at 0.17 vs a 0.25 threshold.

### 5.6b The original decision, for the record

Not a test problem, and the reason the `store-learning-injection` fix above was
deliberately kept narrow: greening that test is precisely what would have buried
this.

The hook builds `` `Agent '${agentType}' error: ${errorContext}` `` and
`store_learning.py`'s `NOISE_PREFIXES` blacklists `"Agent '"`, checked **first**,
before any length or type gate. Commit **`05abf54` (2026-02-18)** added that
blacklist *and* rewrote the producer to emit the prefix it had just blacklisted,
in the same diff — while deleting 138 rows of this output as garbage.

Verified, not inferred:

- `validate_learning_quality()` on the hook's exact content shape returns
  `{"passes": False, "reason": "noise_prefix: Agent '"}` (run in-process)
- SQL: **0 of 622** `archival_memory` rows come from this producer
- the store returns `{"success": True, "skipped": True}` and exits 0; the hook
  spawns with `stdio: 'ignore'`, so **the drop is unobservable from either side**
- the live artifact `~/.claude/hooks/dist/agent-error-capture.mjs:248` carries the
  same blocked string — this is the running hook, not just repo source
- the retrieval-side safety net (`recall_learnings.py`, 7 sites) filters
  `content NOT LIKE 'Agent ''%'' failed when given task:%'` — the **pre-`05abf54`**
  shape, so it now protects nothing and is itself a fossil

Two later commits (`09ba655` fire-and-forget, `a2b211f` crash-regex tuning)
invested in the fidelity of a producer whose output is discarded unconditionally.

**The decision is yours because it is not obvious.** Unblocking restores a
firehose a prior session deliberately closed. Since February the producer gained
two filters (STRUCTURED-only trigger, plus the TS quality scorer), so volume
should be far lower — but that is **unmeasured**.

- **B1 — unblock:** reword the content so it clears the prefix gate, keep the
  quality scorer as the filter. Then watch
  `SELECT count(*) FROM archival_memory WHERE metadata::text LIKE '%agent_failure%'`
  for a week; if it climbs past a few dozen or reads as dumps, revert to B2.
- **B2 — retire:** delete the store path and the fossil retrieval filters, and
  say in the hook that agent failures are deliberately not stored.

Either way the fossil `recall_learnings.py` filters should go.

⚠️ **Open, uninvestigated:** `hook-error-pipeline` also has **0** rows
(`content LIKE 'Hook ''%'' failed with error%'`), yet `Hook '` is **not** in
`NOISE_PREFIXES` — so its zero has a *different* cause. The auto-capture producers
may be 0-for-2.

> **CORRECTION.** An earlier revision of this section called arscontexta "the whole
> remaining ballgame — treat it as a subsystem investigation". That was wrong, and
> wrong in the way this repo keeps being wrong: a confident note written from a
> count without checking what the count referred to. The subsystem had been deleted
> a month earlier. Ninety seconds of `Get-ChildItem` would have caught it, and the
> claim survived a commit because nothing checks a doc's assertions.

### 5.5 The YouTube pipeline is unaudited — CLOSED 2026-08-30 (removed)

`scripts/youtube/` landed this session — it had a registered Windows scheduled
task and poll logs for 07-25 → 07-29 while being entirely untracked. **Not
verified: that those runs are succeeding.** The logs exist; their contents were
never read.

**Resolution.** The logs were finally read on 2026-08-29 and the answer was no:
the task had been failing since 08-28 (`LastTaskResult=2`, every playlist
`Blocked: yt-dlp unavailable`), and no video ever passed the pipeline's own READY
audit. Worse, the task executed a wrapper whose contents differed by checked-out
branch, so what it ran depended on the shared tree's branch at 07:00. The whole
system was removed (`20a800c`) and the task unregistered. This entry stands as the
example: an unaudited scheduled job ran daily for five weeks, failed for the last
two, and nothing noticed because nobody read the logs.

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
- **`git push` failing with "could not read Username" / "Repository not found" is
  FIXED** (2026-08-11, `65d1444`…`351a377`). The old diagnosis here — "the
  credential helper cannot prompt in these shells" — was wrong, and the inline
  `$GITHUB_TOKEN` helper it prescribed is obsolete. **Do not re-add it.** Real
  cause: with no `credential."https://github.com".username`, GCM could not choose
  between the two accounts, and a **second** helper (global `wincred`) answered
  from an ambiguous `git:https://github.com` entry mapping to the **work**
  account — so every personal repo silently authenticated as `david-hayes44` and
  returned "Repository not found", a 404, not a permissions problem.

  `~/.gitconfig` now pins `credential."https://github.com".username = Rev4nchist`
  plus a `url."https://david-hayes44@github.com/fourth/".insteadOf` rewrite; the
  global `wincred` helper is removed and only the system `manager` (GCM) remains.
  Bare `gh` routes itself by directory via `scripts/github/gh-shim.ps1`,
  dot-sourced from both PowerShell profiles (explicit `GH_CONFIG_DIR` beats
  directory; it never throws). Gate:
  `pwsh -File scripts/github/sweep-remotes.ps1` — **25 failures / 64 remotes → 0
  failures / 63 remotes**; `verify-github-accounts.ps1` gained layer 5 (21 → 24
  checks) and passes all 24.

  Three beliefs to unlearn while working near this:
  - **`git remote -v` does NOT stay clean under `insteadOf`** — it prints the
    *rewritten* url. The stored config is untouched:
    `git config --get remote.origin.url`.
  - **Deleting the ambiguous `git:https://github.com` credential does not stay
    done** — GCM recreates it on the next successful auth. The username pin is
    the load-bearing fix; the deletion is hygiene.
  - **A no-username `git credential fill` still returns a credential, and
    should** (the default account). The invariant is *which* account answers.

  Also: revoking the "GitHub CLI" OAuth grant breaks `gh` **and** plain
  `git push` together for that account — both held the same `gho_` token — and
  there is no reissue button in the GitHub UI. Re-run the client login flow.
  Detail: `.claude/rules-src/windows-platform.md`.
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
| Braintrust turn-span finalization (`Stop` scope) | `docs/hooks/braintrust-stop-event-scope.md` |
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
| `github-dual-account` | board says `active`, **LAPSED** | Its board note is stale — the gitconfig/`gh`-routing half SHIPPED on this branch (`65d1444`…`351a377`): bare `git` and bare `gh` route themselves, shared resolution in `scripts/github/accounts-lib.ps1`, `gh-shim.ps1` dot-sourced from both PS profiles, gates `sweep-remotes.ps1` (0 failures / 63 remotes) + `verify-github-accounts.ps1` (24/24). Remaining scope: ssh, `.mcp.json` github server. See §6 |

Serialize commits — one branch, several sessions, and `.git/index.lock` races.
