# Next-Session Plan — ST-05 + S2/S3 backlog (post review-remediation)

> ## ▶ FINAL SESSION — START HERE (planned 2026-06-29, approved) · ✅ EXECUTED 2026-06-30 (see "FINAL SESSION — EXECUTED" below)
>
> This is the **last session of the CCv3 system-update cycle**. The code foundation is hardened
> and live (Session 2, below). One task remains: **bring the handoff materials to a clean,
> single-entry-point state + close the few bounded loose ends** (NOT net-new structural arcs).
> Full approved plan: `~/.claude/plans/if-we-are-now-tingly-beaver.md` (this banner is self-sufficient).
>
> **Approved scope** (most-thorough): materials cleanup IN FULL + FH-01 (warm tldr daemon at
> session start **and** fix the health-check severity) + FH-02 (SG-01 re-baseline) + commit the viz
> files + Judge-Batch triage. **All Tier-2/3 structural arcs stay in [`BACKLOG.md`](./BACKLOG.md)
> (net-new — out of scope).**
>
> **Execution order:**
> 1. **Docs cleanup (no build):** rewrite [`README.md`](./README.md) as the accurate hub (current
>    snapshot/SHA; reading order leads with THIS file; status = Wave 0+1 ✓ / ST-05 ✓ / Session-2 ✓;
>    next-action → this file's "Remaining for next session"). Fix `ROADMAP.md` lines 6–7 (Handoff →
>    this file; drop the superseded 06-28 pointer; reading order `README → NEXT-SESSION-PLAN →
>    BACKLOG → RESOURCE-MAP`). Add a "DATED SNAPSHOT (2026-06-27) — see NEXT-SESSION-PLAN for
>    current" banner to [`CURRENT-STATE.md`](./CURRENT-STATE.md) (no body rewrite). Add a "Resident
>    recall daemon / foundation" file group to [`RESOURCE-MAP.md`](./RESOURCE-MAP.md): `embedding_daemon.py`,
>    `recall_learnings.py`, `db/postgres_pool.py`, `shared/{embedding-client,host-ram}.ts`,
>    `memory-awareness.ts`, `scripts/start-embedding-daemon.ps1`, the `CCv3-Embedding-Daemon[-Daily]`
>    tasks, `~/.claude/run/ccv3-embedding.json`.
> 2. **Handoff archive:** `git mv` the 3 superseded handoffs (`HANDOFF-2026-06-27`, both `-06-28-*`)
>    into `docs/handoffs-archive/`; keep `HANDOFF-2026-06-29`; **THIS file is the canonical handoff.**
> 3. **FH-01:** (a) extend a SessionStart hook (e.g. `session-start-init-check.ts`) to fire-and-forget
>    an idempotent, Windows-safe `tldr daemon start <projectDir>` (array-arg spawn, detached, skip if
>    already running) → `cd .claude/hooks && npm run build` + `bash scripts/audit-braintrust-emits.sh`
>    (4/4); (b) downgrade the `tldr-daemon-running` check in `opc/scripts/health_check.py` from HIGH to
>    WARN/INFO (it's an on-demand daemon; the scheduled weekly check has no session to warm it).
>    Verify `/health-check` is no longer HIGH.
> 4. **Judge-Batch triage:** `CCv3-Judge-Batch` `LastResult=0x80070…` — fix if obvious, else BACKLOG note.
> 5. **viz commit:** commit the auto-output `architecture.json` + `index.html` so the tree is clean.
> 6. **FH-02 re-baseline:** re-run the `memory-recall.jsonl` analysis (≥50 `recall_via:daemon` events
>    should exist now); record numbers here + in BACKLOG; mark **ST-03/ST-10 unblocked**; mark the
>    cycle **WRAPPED**.
>
> **Constraints:** push `fork` not `origin`; never change the BGE model/dim; Windows-safe; commit
> with `git commit -F` (never backtick `-m`); do NOT touch `feature/cma-integration`; targeted edits
> to `memory-awareness.ts` (overwrite history). **Preflight:** ping the daemon
> (`~/.claude/run/ccv3-embedding.json` → port) for `recall_ready:true, loop_ok:true`; branch synced
> to `fork` at `dfaab16`+.

## FINAL SESSION — EXECUTED (2026-06-30)

All FINAL-session deliverables shipped + pushed `fork` (commits `965a5d1` docs/archive · `80b1b0f` FH-01 · `eaa5b43` viz · + the FH-02 telemetry commit below).

1. **Materials cleanup ✓** — README/ROADMAP/CURRENT-STATE/RESOURCE-MAP rewired so `NEXT-SESSION-PLAN.md` is the single canonical entry; the 3 superseded handoffs (06-27, both 06-28) moved to `docs/handoffs-archive/`; RESOURCE-MAP gained the "Resident recall daemon (the foundation)" group.
2. **FH-01 ✓** — `session-start-init-check.warmTldrDaemon` fire-and-forget warms `tldr daemon start --project <dir>` each startup (critic-approved 0-critical, 8/8 tests, real warm → `status: ready`). `health_check.check_tldr_daemon_running` now CATCHES the `subprocess.TimeoutExpired` that made it crash → FAIL/HIGH and reports the on-demand daemon as **INFO** (verified WARN/INFO). No path can reach FAIL/HIGH.
3. **Judge-Batch (FH-03) ✓** — root cause = a **missed schedule** (Event 153), not a script error; enabled `StartWhenAvailable` (`False → True` verified). The separate 6/28 `0x80070001` one-off is deferred (6/20–6/27 all ran exit 0).
4. **viz commit ✓** — `architecture.json` + `index.html` committed; tree clean.
5. **FH-02 re-baseline — DATA-GATED → ST-03/ST-10 stay GATED (NOT unblocked).** Re-running `memory-recall.jsonl` (395 events) shows the `recall_via` instrumentation is still new: only **4 of 395** events carry it — **2 daemon, 2 uv** — far below the ≥50-daemon threshold. Evidence:
   - **Daemon legs (n=2, 06-29):** 1.7 s & 3.4 s, both hit (kept 3/3), 0 timeout.
   - **Live socket probe THIS session:** warm daemon recall **~160–250 ms** (cold first-call ~4.7 s); `recall_ready:true, loop_ok:true`, model/dim correct — the ST-05 ≤3 s / ~136 ms warm target HOLDS.
   - **Anomaly root-caused (NOT a regression):** the 2 recalls today logged `daemon_ready:true` + `recall_via:uv` + ~20 s timeout. `daemon_ready` logs `probe.ready` (model loaded); routing uses `probe.recallReady` (recall pool). At those moments `recallReady` was false (pool re-warming after a daemon restart) → correct uv fallback. The log couldn't distinguish "recall pool cold" from "daemon recall errored."
   - **Fix shipped this session:** added a `recall_ready` field to the recall log + Braintrust metadata (`memory-awareness.ts`; build OK, 16/16 tests, emit 4/4) so the NEXT re-baseline can attribute every uv fallback.
   - **Next session:** accumulate ≥50 `recall_via:daemon` events, confirm `daemon_ready:true + recall_ready:true + recall_via:uv` NEVER appears (that would be a real routing bug), then unblock **ST-03** + **ST-10**.

**Cycle status: WRAPPED on code + materials.** The only open thread is the data-gated FH-02 re-baseline (ST-03/ST-10), now instrumented to be measurable.

> Branch `snapshot/ccv3-system-update`, tip `39379ac`. Read first:
> [`../HANDOFF-2026-06-29-review-remediation.md`](../HANDOFF-2026-06-29-review-remediation.md).
> The 4 review-found S1 SAFE gaps are fixed + live. This plan covers what remains.
>
> **Run Phase 0 (the F4 gate smoke test) FIRST, in DEFAULT (non-bypass) mode.** Everything
> else can run in any mode. Per-fix protocol: TDD (write failing test → implement → run the
> ONE test file) → `cd .claude/hooks && npm run build` → `bash scripts/audit-braintrust-emits.sh`
> (must be `Found: 4 | Invariant: 4`) → commit with **`git commit -F <file>`** (NEVER backtick
> `-m` — see the incident in the handoff) → sync the changed dist to active → push `fork`.

## Phase 0 — F4 interactive-gate smoke test ✅ DONE 2026-06-29 (default mode)

The destructive-command-guard returns `permissionDecision: 'ask'` interactively. We needed to
confirm that `ask` actually surfaces a prompt and isn't swallowed by `permission-auto-allow`.

**Result: PASS.** Ran `git clean -fdn` in a default-mode session; a permission PROMPT appeared
(not a silent auto-approve) and the command completed with no output (no untracked files; `-n`
is dry-run). This also confirms the F3 split-flag fix (`-fdn`). SAFE fully confirmed for the
interactive path — no deeper `permission-auto-allow` / PermissionRequest fix needed.

## Phase 1 — Quick S2 hardening ✅ DONE 2026-06-29

Shipped: `09ba655` (agent-error-capture fire-and-forget + tightened trigger), `5a9abe5`
(destructive-guard wrapper/substitution recursion + xargs rm), then a white-box adversarial
verify sweep → round-2 remediation `3707420` (guard FPs fixed: `rm --force`/`git rebase
--abort`/`git branch -d`/`shred`-as-arg; + new coverage: rsync --delete, find -execdir, git
push --mirror/:refspec, git restore/switch/worktree, Windows rd/del, wipefs/blkdiscard,
env -i prefix; + documented accepted limitations) and `a2b211f` (capture crash-regex +
ECONNRESET). All tested, emit 4/4, LIVE-verified. Original sub-items (now done) below.

## Phase 1 (original sub-items — all addressed above)

1. **agent-error-capture → fire-and-forget** (USABLE; review S2). QW-04 made it live on every
   Task completion with a synchronous 10s-timeout store to archival_memory. Make the store
   detached/async (don't block Task completion) and tighten the error-pattern gating so it
   doesn't pollute recall. File: `.claude/hooks/src/agent-error-capture.ts`.
2. **destructive-guard coverage gaps** (SAFE; review S2). Either recurse the classifier into
   `bash -c "…"` / `sh -c "…"` / `powershell -Command "…"` payloads (the quote-strip blind
   spot — same class as the commit-message backtick incident), or document it explicitly as
   accepted. Add `find … | xargs rm` and remaining split-flag git/docker forms. Extend
   `destructive-command-guard.test.ts`. File: `.claude/hooks/src/destructive-command-guard.ts`.

## Phase 2 — ST-05 resident recall daemon ✅ SHIPPED + VERIFIED 2026-06-29

Done: `/plan` → `/premortem` (9 findings folded into v2) → implement (kraken Python
layer + orchestrator TS layer) → end-to-end verified on the live daemon. Commits `a9dd226`
(Python recall op + query_vector seam), `624c876` (TS probeDaemon + recallViaDaemon +
memory-awareness routing), `31ffd8d` (live-script import fix the e2e gate caught). Warm
recall **136ms** (was ~10s), daemon ids == uv ids exactly, emit 4/4. Full record +
premortem v2 + the import-fix lesson in [`ST-05-DESIGN.md`](./ST-05-DESIGN.md). Original
arc notes below.

## Phase 2 (original arc notes — completed above)

**Why:** the only path to the USABLE ≤3s target. The memory hot-path is ~10s because
`memory-awareness.checkDbMemory` spawns `uv run python recall_learnings.py` per prompt
(~4-10s uv+python+psycopg boot). The BGE embedding daemon already keeps the MODEL resident
for embeds; ST-05 makes the whole RECALL path resident too. Prereq for ST-03 + ST-10.

Recommended approach — **extend the existing embedding daemon** (don't build a sibling):
1. **Research** the current daemon: `opc/scripts/core/` (embedding daemon + `recall_learnings.py`
   hybrid RRF), `~/.claude/run/ccv3-embedding.json`, and `shared/embedding-client.ts` /
   `shared/daemon-client.ts`. Confirm the daemon's socket/lifecycle/health-probe pattern.
2. **Design:** add a `recall` op to the resident daemon that runs the full hybrid query
   (embed + pgvector + FTS + RRF + cosine gate) in-process, holding a persistent psycopg
   connection — returns the same shape `recall_learnings.py --json` does today.
3. **Client:** `recallViaDaemon(query)` in the embedding/recall client; `memory-awareness`
   routes `checkDbMemory` through it when the daemon is ready. **Keep** the `uv run --text-only`
   fallback + fire-and-forget warm when the daemon is cold (no recall regression).
4. **Premortem (review):** corpus staleness (daemon must see new learnings), connection leaks,
   cold-start, multi-session concurrency on one daemon, the BGE-model/dim invariant
   (`BAAI/bge-large-en-v1.5`, 1024 — never change).
5. **Implement (kraken/TDD)** → **verify:** warm hot-path ≤3s, recall quality identical to the
   `uv run` path (same RRF), emit invariant 4/4, MEMORY MATCH still fires.

This is a structural arc: do it as its own `/plan` → `/premortem` → `/ralph` or a Workflow,
not a quick edit.

## Phase 3 — S3 polish + regression insurance

1. **Integration test for the 12 revived Task hooks** (review's missing regression insurance):
   replay representative PreToolUse:Task + PostToolUse:Task events through each, asserting no
   malformed output, nonzero exit, or latency-budget breach.
2. **settings-template-validation.test.ts:** add assertions that each registered hook's
   event+matcher matches active (not just that the dist exists).
3. **Dead-code + docs:** remove the now-unreferenced `checkLocalMemory` definition from
   `memory-awareness.ts`; fix the `memory-sanitize` header ("Both injection sites" → 5);
   rename/clarify `agent-model-guard` (it is the chain's hard-deny existence guard).

## Sequencing

**Phases 0, 1, 2, 3 are DONE (2026-06-29).** Phase 3 shipped: 3a `task-hooks-integration.test.ts`
(14 Task-matcher hooks, 18/18) + 3b settings event+matcher contract (`90f8d7a`); 3c dead-code
(checkLocalMemory + LOCAL_SCORE_NORMALIZE) + memory-sanitize header (6 sites) + agent-model-guard
misnomer note (`44c2653`). The original "Remaining" items are now addressed — see
**Foundation Hardening (Session 2)** below.

## Foundation Hardening — Session 2 (2026-06-29) ✅ SHIPPED

Reframed goal: make the foundation safe to run UNATTENDED for weeks. Preflight found the
core sound (branch synced, Postgres up, daemon live + routing recall, reverse-sync is the
only auto-writer, no stray Ralph loop — `.ralph/state.json` was inert from May 31, archived).
Shipped + pushed `fork` (`237c72e`, `501365e`, `1fd155c`):

- **A1–A4 daemon multi-week resilience** (`237c72e`, Python; 41 tests; live-verified after a real
  daemon restart → recall_ready+loop_ok in ~12s, socket recall ok:true both legs):
  - **A1** explicit `max_inactive_connection_lifetime=300` in the asyncpg pool. NOTE: verified
    asyncpg 0.31.0 ALREADY defaults to 300.0 (idle conns auto-evict) — the scout's "never evicts /
    permadegrade" premise was WRONG; this is future-proofing, not a live-bug fix.
  - **A2** `_recycle_pool_best_effort()` (`Pool.expire_connections`) before the H3 retry → a full
    Postgres restart (all pooled conns dead) recovers immediately, not gradually.
  - **A3** in-process recall-loop watchdog (daemon thread, 60s): H2 only DETECTED a dead loop;
    the watchdog RESTARTS it (idempotent) so the resident fast path self-heals over a long uptime.
  - **A4** `_acquire_startup_slot()` checks for a healthy peer before contending the OS lock.
    **VERIFIED the OS lock already guarantees ≤1 model-loading daemon** (msvcrt LK_NBLCK repro:
    1 ACQUIRED / 2 BLOCKED; committed-mem confirmed only the lock holder loads the 2.8 GB model).
    The observed 10-daemon "storm" was cheap transient `uv run` husks, NOT multiple resident
    models — the catastrophic case cannot happen. Killed the surplus operationally.
- **B host-memory-pressure gate RESTORED** (`501365e`, `memory-awareness.ts`, 4 targeted edits;
  3 RED tests → green, 22 host-ram unit tests green, 16/16 memory-awareness no-regression, emit 4/4).
  Correction: the wiring was NEVER committed (not "lost in an overwrite"). Integrated with ST-05:
  the RAM gate sits BEFORE `probeDaemon` → under pressure it skips the probe AND the spawn (never
  thrashes the ~1.3 GB model), forces text-only, logs `host_memory_pressure`/`free_ram_bytes`/
  `embed_fallback_reason`. Fail-open (+Infinity on probe failure).
- **A6 auto-start/recovery hardening** (system config): disabled the dead `ClaudeMemoryDaemon`
  scheduled task (its target `.claude\scripts\core\core\memory_daemon.py` does not exist) +
  registered `CCv3-Embedding-Daemon-Daily` (idempotent backstop; verified no-op when healthy).
  Auto-recovery is now three-layered: logon trigger + lazy `ensureDaemonRunning` + A3 watchdog,
  with the daily task as belt-and-suspenders.
- **D tldr-context-inject latency** (`1fd155c`, 8/8 tests): subagent_type narrow (skip non-code
  agents) + git-freshness cache (HEAD sha + dirty marker + query; cold-start paid once per
  working-tree state) + guarded module-level `main()` so the file is importable (fixed a
  pre-existing vitest hang).
- **SG-01 re-baseline (partial)**: hit-rate 27.4% (review) → **32.8% all-time, 40% last-50** (the
  QW-06/07 math fixes worked). The uv-subprocess era shows p50 11.6 s / 40% `db_subprocess_timed_out`;
  the resident-daemon era is only n=2 logged so far (3.4 s, 100% hit, 0% timeout — strong but tiny
  sample). Full re-baseline needs the daemon era to accumulate.

## Remaining for next session

- **SG-01 / FH-02 full re-baseline — DATA-GATED (updated 2026-06-30, see "FINAL SESSION — EXECUTED").**
  The FINAL session re-ran the analysis: still only **2 `recall_via:daemon` events** logged (live socket
  probe confirmed warm daemon recall ~160-250 ms — ST-05 target holds). Added the `recall_ready` log
  field so uv fallbacks are now attributable. NEXT: accumulate ≥50 `recall_via:daemon` events, confirm
  no `daemon_ready:true + recall_ready:true + recall_via:uv` rows (a real routing bug), then unblock
  **ST-03** (UPS 13-spawn serial→parallel) and **ST-10** (agent-recall-injector 0-for-78), both ST-05-gated.
- **tldr daemon stays-up** (health-check `tldr-daemon-running` HIGH: `tldr daemon status` times
  out 5 s). D's cache/narrow cut the per-Task cold-start but did NOT fix the daemon not persisting.
  Root-cause why `tldr daemon` won't stay resident on Windows (DEFER option from the D recon) — or
  make the health check tolerate its absence. See BACKLOG.
- **Backlog (unchanged):** the Tier-2/2b/3 structural arcs (ST-02 identity, ST-01 bus writer, the
  MS-01/02/03 multi-session arc, SG-02/03/04) remain in [`BACKLOG.md`](./BACKLOG.md).

## Known-good / no-action (verified this session)
- init-project "broken ref" (`references/sdk-setup.md`) is a **health-check false positive** — the
  ref points to `.claude/skills/sentry-cli/references/sdk-setup.md`, which EXISTS; the checker
  resolves cross-skill paths against the wrong dir.
- Failing weekly scheduled tasks (`CCv3-Health-Check` = the tldr-daemon HIGH above; `CCv3-Judge-Batch`
  = Braintrust observability) are tangential to the daemon/memory/sync foundation — triage later.
