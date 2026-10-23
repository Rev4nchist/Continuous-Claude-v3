# CCv3 System-Update Backlog — Execution Plan

> The ratified backlog from the Fable-5 deep review. **Work top-down, respect the gates.** Each item carries its finding IDs (trace to `docs/reviews/2026-06-10/findings.json`), the concrete action, and its dependency/gate. Severity legend: **S0** silent-corruption · **S1** wrong hot-path / exploitable / decision-driving false claim · **S2** measurable waste · **S3** polish.

Counts: **190 confirmed** (S0:3 ✅ · S1:41 · S2:108 · S3:38). cross-model: 184 corroborated, 6 single-source, 2 S1→S2 downgrades.

---

## ✅ Wave 0 — S0 Critical (SHIPPED)

| ID | Fix | Commit | Closes |
|----|-----|--------|--------|
| QW-01 | `store_learning.py` `execSync`(shell) → `spawnSync` argv (junk-creator + injection root) | `1788211` | D5a-01/D2c-04/D2d-06/D3a-01 |
| QW-02 | `smart-search-router` hardcoded `/tmp` → `os.tmpdir()` handshake | `89c9e5e` | D2b-05 |
| QW-03 | ROADMAP contamination guard → positive own-project identity + own-plan flip | `f7f3eba` | D2d-01/D2d-02/D2F-03 |

S0 remaining: **0**.

---

## Wave 1 — S1 Quick-Wins (9 items, mostly independent one-field/one-constant/one-rule fixes)

**Order:** do QW-05/06/07/08/09/11/12 first (no cross-deps); **QW-04 LAST** (gated on QW-01 ✅). QW-07 is highest-priority within the independent group (24.6% pollution feeds every downstream consumer).

### ✅ Shipped 2026-06-28 (the 7 independent quick-wins — all verified + pushed to fork)

| ID | Commit | Closes | Verified by |
|----|--------|--------|-------------|
| QW-07 | `b1967ba` | D2c-01/D3b-05/D3c-04 | 21 tests RED→GREEN; live: `<task-notification>` no longer rides recall |
| QW-05 | `3429858` | D2d-03 | revived end-to-end — **also** fixed the dead output field (`systemPromptSuffix`→`additionalContext`); 2 tests |
| QW-09 | `90cb2b9` | D8a-02 | dangerous auto-exec rule defused (block reasons = guidance, not authorization) |
| QW-08 | `f9cdbef` | D7b-01 | 28 ghost entries removed (86→58), each proven no live SKILL.md; both copies |
| QW-06 | `10ee124` | D3b-01/D3b-02/D3b-08 | live: FTS arm 0→50, junk 3→1, hook now emits `MEMORY MATCH (3)` where it returned `continue` before; pytest + vitest |
| QW-11 | `a8b10c5` | D2e-02/D2e-08 | real `node tsc` invocation (no `.cmd` shim); bus `'edited'` before both early-returns; 3 tests |
| QW-12 | `bb96a55` | D2d-09/D2d-10/D2d-13 | relatedness + cwd + path-containment guards (new `shared/roadmap-sync-guards.ts`); 17 tests |

Emit invariant held 4/4 across all. **Remaining in Wave 1:** `QW-04` (matcher flip — LAST), `QW-10` + safe deletions (cleanup batch), and the **D7b-02 / D7b-07 / D8c-06** real-skill follow-ups (split out of QW-08 — they fix *real* skills, not ghosts).

| ID | Action | Files | Closes | Gate |
|----|--------|-------|--------|------|
| **QW-07** | `<task-notification>` XML machine-content guard + length cap upstream of `extractIntent`; fix `expandGitQuery` `lower.includes('pr')` substring collision + XML swallow | `memory-awareness` intent path; `expandGitQuery` | D2c-01/D3b-05/D3c-04 | none — **do first** |
| **QW-05** | `epistemic-reminder.ts:44` `input.tool` → `input.tool_name` (one word; revives the claim-verification Grep guard) | `epistemic-reminder.ts` | D2d-03 | none |
| **QW-06** | Recompute/raise `HYBRID_FLOOR` past the decay multiplier; `plainto_tsquery` → `websearch_to_tsquery` | `memory_service_pg.py`, `recall_learnings.py` | D3b-01/D3b-02/D3b-08 | none |
| **QW-08** | Remove 26 `arscontexta-*` + 2 archived entries (~85 ghost keywords) from `skill-rules.json` | `skill-rules.json` (both copies) | D7b-01/D7b-02/D7b-07/D8c-06 | none |
| **QW-09** | Defuse `hook-auto-execute.md` — remove "run unprompted bash from deny-reason" language | `.claude/rules/hook-auto-execute.md` | D8a-02 | none |
| **QW-11** | Fix `post-edit-diagnostics` `tsc` `.cmd` shim → `node tsc.js`; restore bus `'edited'` write before early-return | `post-edit-diagnostics.ts` | D2e-02/D2e-08 | none |
| **QW-12** | `prd-roadmap-sync` relatedness check before marking goal complete; `git-commit-roadmap` cwd verification | `prd-roadmap-sync.ts`, `git-commit-roadmap.ts` | D2d-09/D2d-10/D2d-13 | none |
| **QW-10** | Quarantine 11 tracked `tmpclaude-*-cwd` artifacts + `.ssr_slice.txt` (operator-confirm the latter) | repo root | D1A-007/D2g-10/D7d-06 | none |
| **QW-04** | Flip matcher `'Agent'` → `'Task'` across all 3 settings surfaces for the 12-hook safety+verification chain. **Within QW-04: flip guard/verify hooks first (verify each), inject hooks LAST.** | `settings.json` ×3 (repo+active+template) | D2b-01/D10c-02/D8a-01/D10c-04 | **QW-01 shipped ✅** (re-enabling `agent-error-capture` exposes D2d-06/07 — already fixed) |

**Wave-1 cleanup batch (after the above):** QW-10 + safe deletions DEL-01/03/06/07/08, each gated on a passing `git grep <basename>` static-ref check. Fix `D4b-06` (facade `PROJECT_DIR` `process.cwd()` fallback) in the same change as DEL-01 to stop tmpclaude recurrence.

---

## Tier 2 — Structural Arcs (10 items; **each needs its own plan + premortem**)

| ID | Arc | Closes (theme) | Sequencing |
|----|-----|----------------|------------|
| **ST-02** | 7 → 1 canonical `getSessionId` (`shared/session-id.ts`); `getBusId()` its only composer; delete 4 clones; fix the `shared/index.ts` barrel re-export. **+ Multi-session extension:** make the canonical identity two-level — `session_id` (terminal) **+** `agent_id` (subagent), so the lock/heartbeat layer can tell sessions AND intra-session fan-out apart. **This is the multi-session foundation** — `file-claims`/`heartbeat`/`isSessionActive` are only reliable once identity is single+consistent. | D7d-01 (corr-null 60.7%) | **prerequisite for ST-01, SG-04, AND the MS-* multi-session arc** |
| **ST-01** | `SubagentStop` hook + bus symbol writer (commit `proposed_bus_updates`) | D1A-001/D10c-01 (write-dead bus) | after ST-02; **before SG-04** |
| **ST-05** | Resident recall daemon (kill the per-call uv-run boot tax) | D2b-03 (agent-recall 0-for-78 budget) | **prerequisite for ST-03 and ST-10** |
| **ST-03** | UserPromptSubmit 13-spawn serial → parallel (the 22–32s wall) | D6a-01 | after ST-05 |
| **ST-10** | Fix `agent-recall-injector` 0-for-78 lifetime yield (**DELICATE** — Hook Source Regression history; emit-guard + post-spark verify on every edit) | D2b-03 | after ST-05 |
| **ST-04** | codegraph facade latency 35–88s → budget (freshness-probe redesign + reindex budget) | D4b-01 | **before the C.5 deny-gate flip** |
| **ST-06** | Permission-layer redesign — remove `permission-auto-allow`'s "auto-approve ALL" | D2g-02/GAP3-01 | **before ST-08** (precondition for injection fixes to mean anything — a review finding) |
| **ST-08** | argv-ify the remaining Grep-path shell-injection sites (`smart-search-router`, `daemon-client`) + the shared `storeLearning(content,opts)` helper | D2b-10/GAP4-01/GAP4-02 + D5a/D5b cluster | after ST-06 |
| **ST-07** | Memory sanitizer coverage 2 → 5 injectors (route all 5 through `injectRecall()`) | D5b-01 (poison-then-inject) | after ST-02; independent otherwise |
| **ST-09** | Bus lock + write-amplification hardening (200ms cap redesign) | D4a-02 | after ST-01 (new writer changes contention profile) |

**Dependency summary:** `ST-02 → ST-01 → SG-04` · `ST-02 → MS-01/02/03 → SG-04` · `ST-05 → ST-03 + ST-10` · `ST-04 before C.5` · `ST-06 → ST-08`.

---

## Tier 2b — Multi-Session Coordination (MS arc; gated on ST-02; **each needs its own plan + premortem**)

> **Goal:** clear, reliable, **enforceable** guardrails when multiple Claude Code sessions (and their subagent teams) work the same repo and/or branch — in CCv3 **and any repo CCv3 is active in**. Hybrid posture: **HARD-BLOCK** shared infra · **WARN** ordinary project files · **SERIALIZE (queue)** git-index + build/dist. Portable by construction — hooks live in `~/.claude/` (global) and coordination is Postgres-backed + **project-scoped** (`project` column), so cross-repo sessions never false-conflict and no CCv3 paths are hardcoded (the infra-block set is a per-repo setting, default `.claude/**` + repo-critical config).
>
> **Current machinery that already FIRES (verified 2026-06-28):** session-register + heartbeat (Postgres `sessions`); `file-claims.ts` (PreToolUse:Edit|Write) hard-blocks edits when another *active* session (heartbeat <5min) holds a `(file_path, project)` claim, takes over stale claims. The MS arc makes that machinery *trustworthy* (ST-02 identity), *complete* (close bypasses), and *posture-correct* (hybrid).

| ID | Arc | Closes / fixes | Posture | Gate |
|----|-----|----------------|---------|------|
| **MS-01** | Intra-session file assignment + sub-agent claims — claims keyed by `(file_path, project, session_id, agent_id)`; orchestrator helper declares each fanned-out agent's owned files and warns on same-session collision (systematizes the manual disjoint-file assignment used in Wave 1) | subagents share parent `session_id` → lock layer blind to fan-out | WARN orchestrator | after ST-02 (needs `agent_id` identity) |
| **MS-02** | Infra lock-bypass guard — HARD-BLOCK cross-session writes to a configurable infra set (default `.claude/hooks/**`, `settings.json`, sync targets) **regardless of write path**; make the **sync script** claim-aware (the Hook Source Regression came through *sync*, dodging the Edit-tool lock) | Hook Source Regression root (multi-session clobber via sync) | HARD BLOCK | after ST-02; **ship first (highest blast radius)** |
| **MS-03** | Git + build serialization — cross-session advisory mutex (Postgres advisory lock / lockfile) that **queues** git-index ops and `npm run build`/dist writes; + stale-lock auto-recovery for `.git/index.lock` (a 17h-stale one blocked startup 2026-06-28) | concurrent git index.lock race; concurrent dist build race | SERIALIZE (queue) | after ST-02 |

**MS posture table (encoded):** infra (`.claude/**`, settings, sync) → HARD BLOCK · ordinary project files → WARN + show who/what · git-index / build / dist → SERIALIZE (queue) · intra-session fan-out → WARN orchestrator. Tunable: a repo may opt into hard-block-all via the infra-set config.

---

## Tier 3 — Strategic Programs (4 items)

| ID | Program | Depends on |
|----|---------|-----------|
| **SG-02** | 3-way settings/template drift reconciliation + source-of-truth enforcement (18 hooks live in active but absent from tracked repo, incl. `package-install-guard`, `permission-auto-allow`); extend `/sync-drift` with a drift gate; fix bootstrap template still registering the deregistered `navigator-safety` | can start **parallel with Wave 1** |
| **SG-01** | Memory recall floor + corpus-health SLO; re-baseline the 27.4% hit rate after the math fixes + daemon | after QW-06/QW-07 + ST-05 |
| **SG-03** | Elegance / pruning program — collapse the named duplication clusters; owns the operator-confirm deletion items | after Wave 1 hygiene stabilizes |

---

## Deletions (12 items — quarantine-first, per-item `git grep` static-ref check)

- **Safe batch (Wave 1 cleanup):** DEL-01 (`tmpclaude-*`), DEL-03 (`test-build.ts` console.log stub), DEL-06 (dead lib dupes), DEL-07 (`memory-client` triple-dead + python3 caller), DEL-08 (`handoff-index` + `better-sqlite3` build dep).
- **Higher-risk (two-step / config-first):** DEL-09 (`.claude/scripts/core` stale mirror — **remove from SYNC_DIRS first**, then `git rm`), DEL-05 (26 dead hook prototypes — **relocate 6 live-misfiled shared libs first**, then archive true-dead).
- **Operator-confirm (defer to SG-03):** DEL-02, DEL-11 (doc-coupled agents), DEL-12 (per-item-grep skills, incl. the 4 memory rule-stubs once the memory SKILL is confirmed to cover their content).

---

## The C.5 deny-flip gate (the substrate end-state milestone)

Flip `code-intel-enforcer` to **deny-mode** only when **all three** are green:
1. In-facade routing **≥80%** measured in `intel-bus.jsonl` (needs ST-04 latency fix + the `tldr-cli.md` instruction-surface patch + QW-04 reviving the spawn chain to raise facade invocations).
2. Enforcer switched default-OFF → warn-mode, **wrong matcher corrected**, telemetry flowing.
3. `intel-bus-stats.mjs` built and computing §9 metrics (real denominator, not zero).

Only then is the facade-bypass rate an enforced invariant.

---

## Foundation Hardening — Session 2 (2026-06-29)

Stability-first pass to make the system run UNATTENDED for weeks. Full record in
[`NEXT-SESSION-PLAN.md`](./NEXT-SESSION-PLAN.md) → "Foundation Hardening — Session 2".

**Shipped + pushed `fork`:** A1–A4 daemon multi-week resilience (`237c72e`: explicit asyncpg
idle-lifetime, `expire_connections` retry-recycle, in-process recall-loop watchdog, cheap
redundant-spawn exit — with the **verified** finding that the OS lock already caps resident
daemons at 1, so the multi-daemon "storm" was cheap husks, not multiple 2.8 GB models) · **B**
host-memory-pressure gate restored + integrated with ST-05 `probeDaemon` (`501365e`) · **A6**
disabled dead `ClaudeMemoryDaemon` task + added idempotent daily daemon backstop · **D**
tldr-context-inject git-freshness cache + code-agent narrow (`1fd155c`).

**New follow-ups (not in the original deep-review backlog):**

| ID | Item | Notes |
|----|------|-------|
| **FH-01a/b** ✅ | **tldr daemon warm at session start + health-check no longer HIGH** | DONE (FINAL session): `session-start-init-check.warmTldrDaemon` fire-and-forget warms `tldr daemon start --project <dir>` each startup (idempotent via the daemon's pidfile lock; kill-switch `CCV3_TLDR_WARM_OFF`). `health_check.check_tldr_daemon_running` now CATCHES the `subprocess.TimeoutExpired` that made it crash → HIGH (root cause) and reports the on-demand daemon as **INFO**. Critic-approved (0 critical), 8/8 tests, emit 4/4, real warm verified (`status: ready`). **DEFERRED:** root-causing why `tldr daemon` won't stay *resident* on Windows — the per-session warm is the accepted mitigation. |
| **FH-03** ✅ | **CCv3-Judge-Batch scheduled task failing** | Triaged (FINAL session): current `LastResult=0x800710E0` is a **missed schedule** (Event 153) — task was *Interactive-only* with no missed-start recovery, so it missed 6:15 AM on 6/29 and never ran. **FIXED:** enabled `StartWhenAvailable` (same pattern `CCv3-Blocklist-Update` uses) — verified `False → True`. **DEFERRED (one-off):** the separate `0x80070001` exit on 6/28 (transient; 6/20–6/27 all ran exit 0) — if it recurs, run `cd opc; uv run python -m scripts.core.judge_session --scan-since <yesterday> --max-sessions 10` and check claude auth. |
| **FH-02** ⏳ | **SG-01 re-baseline — DATA-GATED** | Re-ran 2026-06-30: still only **2 `recall_via:daemon` events** of 395 (the `recall_via` instrumentation is new). Daemon legs 1.7 / 3.4 s, both hit; a live socket probe this session confirmed warm recall **~160-250 ms** (cold first-call ~4.7 s) — the ST-05 target holds. **Anomaly root-caused (NOT a regression):** 2 recalls today logged `daemon_ready:true` + `recall_via:uv` + ~20 s timeout — `daemon_ready` logs `probe.ready` (model loaded) while routing uses `probe.recallReady` (recall pool); the pool was cold post-restart → correct uv fallback. **Shipped this session:** added `recall_ready` to the recall log + Braintrust metadata so the next re-baseline can attribute every uv fallback. **STILL GATED:** accumulate ≥50 daemon events, confirm no `daemon_ready:true + recall_ready:true + recall_via:uv` rows, then unblock **ST-03** + **ST-10**. |

---

## Self-Improvement Loop — Ratified Proposals

Net-new arcs the operator ratified from the daily self-improvement research loop (`docs/self-improvement/`). Distinct from the Fable-5 review backlog above; source proposal linked per item.

| ID | Arc | Source | Sequencing / gate |
|----|-----|--------|-------------------|
| **SI-01** | **Wire the existing cross-encoder reranker (`bge-reranker-v2-m3`, `_apply_rerank`) into the hot recall path.** It is built but DORMANT — opt-in `--rerank` only, hybrid-only, and absent from `do_recall` (the ST-05 daemon path, `recall_learnings.py:1587`) and the `memory-awareness` proactive-injection hook — so the hit-rate-driving surface runs unreranked. Wire it on the warm-daemon path only (pre-warm like the tldr daemon per FH-01a; fail-open to RRF top-K, which `_apply_rerank` already does at `recall_learnings.py:1463/1478`; reuse the `isHostMemoryPressured` gate to skip under RAM pressure). Frontier names rerank as *the* gain after hybrid (Anthropic contextual retrieval: 49%→67% retrieval-failure reduction). | [`docs/self-improvement/proposals/2026-06-30-memory.md`](../self-improvement/proposals/2026-06-30-memory.md) — R1, verdict ADOPT | after **ST-05** (shipped) + the **FH-02** ≥50-daemon-event gate (so before/after is measurable); pairs with **SG-01** re-baseline (R2/R3 usefulness metric). Effort ~M (plumbing + warm-up + a flag); risk = warm-path latency, mitigated by fail-open + the existing host-RAM gate. Needs its own `/plan` + `/premortem`. |
