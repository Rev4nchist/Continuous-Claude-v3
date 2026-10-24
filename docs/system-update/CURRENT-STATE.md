# CCv3 Current State — Snapshot 2026-06-27 (Review SHA `86b8f60`)

> **⚠ DATED SNAPSHOT (2026-06-27).** This file describes CCv3 as it looked at review time. For the current state and the live plan, see **[NEXT-SESSION-PLAN.md](./NEXT-SESSION-PLAN.md)** (the canonical handoff). Wave 0+1, ST-05 (resident recall daemon), and Session-2 foundation hardening have shipped since this snapshot — several seams below are now fixed.

The system at a glance: a **sound spine wrapped in a dead/mis-wired periphery.** The SQL layer, secret handling, path-traversal defenses, and the L3 boundary/bus *design* are cleared. The enforcement and intelligence *periphery* is largely dead or mis-wired. Elegance verdict: **MIXED.** Dominant failure pattern: **registration/wiring drift + consolidatable duplication.**

> Source of every number below: `docs/reviews/2026-06-10/` (190 confirmed findings, `findings.json`) and `docs/reviews/2026-06-10/wf3/synthesis.json`. Visual: https://rev4nchist.github.io/ai-enablement-decks/ccv3-state-of-rework/

## The three structural seams that are active *today*

1. **The entire agent safety + verification chain (12 hooks) never fires.** All are registered under matcher `'Agent'` while the live Claude Code tool emits `'Task'`. Zero pre-spawn guard, zero post-spawn verification on every subagent spawn. (`D2b-01`, `D10c-02`) — fixed by `QW-04`.
2. **The context-bus symbol layer is write-dead.** `SubagentStop` has **zero** event registrations anywhere (repo + active + template). codegraph computes `proposed_bus_updates` on every facade call and they are silently dropped. `bus-focus.ts` reads always-empty `focus_symbols` today. (`D1A-001`, `D10c-01`) — fixed by `ST-01`.
3. **Seven competing `getSessionId` implementations** produce non-joinable telemetry → **60.7% corr-null** on intel-bus rows. The `shared/index.ts` barrel re-exports the wrong ppid-scheme under the canonical name. (`D7d-01`) — fixed by `ST-02`. **This is also the multi-session foundation** (see below).

## Multi-session coordination — machinery exists, gated on ST-02 (added 2026-06-28)

Multiple Claude Code sessions (each with its own subagent team) on the same repo/branch is a first-class concern. The **substrate already FIRES** (verified 2026-06-28): session-register + heartbeat (Postgres `sessions`) and `file-claims.ts` (PreToolUse:Edit|Write) — which hard-blocks an edit when another *active* session (heartbeat <5min) holds a `(file_path, project)` claim, and takes over stale claims. But three structural gaps make it unreliable today:

- **Identity is broken (ST-02).** Locking/heartbeat correctness depends on one consistent `getSessionId`; the 7-impl split-brain makes cross-session conflict detection give false-negatives/positives. **Multi-session safety is gated on ST-02.**
- **The lock is blind to intra-session fan-out.** Subagents share the parent's `session_id` (RULES.md: "cannot distinguish orchestrator from sub-agents on a shared session_id"), so `file-claims` would NOT catch two of one session's own parallel agents editing the same file (handled manually in Wave 1).
- **Sync + git writes bypass the lock.** `file-claims` only gates the Edit/Write *tools*; the **Hook Source Regression** clobbered shared hook files via the *sync script*, and concurrent **git** ops race `.git/index.lock`.

→ The plan: **ST-02 reframed as the foundation (+ `agent_id` identity)**, then the **MS-01/02/03 arc** (intra-session claims · infra lock-bypass guard · git+build serialization) under a hybrid posture (block infra · warn project · serialize git/build), folded into **[BACKLOG.md → Tier 2b](./BACKLOG.md)**.

## The three highest-leverage single fixes

1. **Agent→Task matcher flip** (`QW-04`) — one settings change revives **12 dead hooks** at once.
2. **Canonical `getSessionId`** (`ST-02`) — unblocks the 60.7% corr-null telemetry, making §9 metrics measurable.
3. **Shared `storeLearning(argv)` helper** (`ST-08` / cluster) — closes the S0 junk-creator class *and* the poison-inject seam at every call site simultaneously.

## Six Pillars — per-pillar health

| Pillar | Health | State |
|--------|--------|-------|
| **Memory** | honing | BGE-large-en-v1.5 (1024-dim), Postgres pgvector, hybrid RRF. Hit rate **27.4%** (281 events). 3 co-dominant suppressors: `HYBRID_FLOOR=0.01` applied after a decay multiplier (`D3b-01`); `plainto_tsquery` AND-semantics empties the FTS arm (`D3b-02`); **24.6% of recall queries are `<task-notification>` XML blobs** (`D2c-01`). Sub-agent recall: **0 of 281 rows** — agent layer is memory-blind. |
| **Hooks** | gap | 111 TS srcs → 111 dist; **76 registered, 35 never fire.** The agent safety+verification chain dead (matcher split-brain). UPS hot-path serializes 13 spawns, **22–32s** worst case. `epistemic-reminder` reads `input.tool` not `input.tool_name` — never fires (`D2d-03`). |
| **PageIndex** | honing | Per-prompt hook disabled 2026-06-01 (0/16 query-hits at up to 15.8s/prompt). ~4.8K LOC + Postgres `pageindex_*` intact. **On-demand only** now. |
| **Workflows** | honing | Ralph core delegation works. `ralph-task-monitor` dead (Agent matcher). `maestro-enforcer` never fired (Agent matcher dead, `D10c-03`) — RULES.md asserts C:10 blocking that is **false**. `plan-to-ralph-enforcer` + `plan-exit-tracker` active. |
| **Braintrust** | honing | 4 active `await emitBraintrustScore()` (invariant enforced by `audit-braintrust-emits.sh`). `agent_task_success` dead (Agent matcher). 7 `getSessionId` schemes → 60.7% corr-null. |

## WS-2 Substrate

| Component | Health | State |
|-----------|--------|-------|
| **Context Bus L2** (`shared/context-bus.ts`) | partial | Single-writer, atomic O_EXCL lock. Intent + partial `files_in_play` writes active. `focus_symbols` / `recent_findings`: **zero production writers** (`D10c-01`). 158 slow / 14 dropped writes; lock cap leaky (200ms design vs 2293ms observed, `D4a-02`). `CCV3_KILLSWITCH` does not short-circuit the bus as documented (`D1A-002`). |
| **/code-intel Facade L4** (`scripts/code-intel.mjs`) | partial | Routing correct, codegraph wired (Phase C.2). **In-facade routing 45.7% vs ≥80% C.5 gate** (`D9-03`). `code-intel-enforcer` default-OFF, wrong matcher, logs zero events. `tldr-cli.md` (always in context) still routes symbol search to TLDR, contradicting the boundary contract (`D1A-003`). Median latency **~62s** (one full codegraph process per dirty file, `D4b-01`). |
| **codegraph L3** (`@colbymchenry/codegraph@0.9.9`) | sound | SQLite WAL. Platform contract **C.1 GREEN 12/12** on Windows 11 / Node 24.4.1. Cold index 9.0s, warm query 2.85s (Node+WASM startup dominated). Incremental-sync cross-file edge orphaning is a known correctness limit; Serena escalation hint mitigates. |

## Elegance gaps (consolidation targets)

**Duplication clusters:** 7 session-id implementations (4 fallback semantics) · 6 sync-script copies (stale fork missing the 2026-06-01 clobber guard) · Python script-tree triplication (`recall_learnings.py` ×3, the `.claude/scripts/core` mirror is ~4 months stale) · ~46MB Fourth-presentation skill family (bit-identical 6.2MB PDF, a 5.6MB self-zip) · 4 `store_learning.py` shell-string call sites · memory-recall injectors sanitized at only **2 of 5** (`session-start-continuity.ts` + `pre-plan-memory.ts` inject raw recall on decision-driving surfaces — the poison-then-inject seam).

**Dead weight:** 35/111 hook srcs never register (26 safe-dead prototypes; 4 stale lib dupes that must *relocate* not delete) · 30/36 agents never recalled + a 16-file dead `.json` agent layer · 28 ghost skill registrations in `skill-rules.json` (26 `arscontexta-*` + 2 archived, ~85 live keywords firing "SKILL ACTIVATION CHECK" for nonexistent skills) · 4 memory rule-stubs loaded verbatim into every global session for zero behavioral content.

→ The fix plan for all of the above is **[BACKLOG.md](./BACKLOG.md)**.
