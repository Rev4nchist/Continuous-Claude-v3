---
date: 2026-07-23
component: coordination
component_name: Cross-Session Coordination
verdict: adopt
headline: The field validates our advisory-lock posture; redirect intra-session fan-out (MS-01) to Claude Code's native `isolation: worktree`, and harden file_claims with lease/TTL + fencing instead of stronger locking.
sources: 7
---

# Cross-Session Coordination — Next-Evolution Proposal (2026-07-23)

## 1. Where CCv3 is today

All claims below traced by reading the files (✓ VERIFIED unless marked).

**Machinery.** Two registered hooks (`~/.claude/settings.json:158` → `file-claims.mjs`, `:368` → `session-register.mjs`) plus a Postgres coordination DB:

- **Session identity** — `.claude/hooks/src/shared/session-id.ts`. Priority chain: `COORDINATION_SESSION_ID` env → persisted file → `BRAINTRUST_SPAN_ID` → timestamp-generated (`session-id.ts:93-112`). The persisted file is a **single global file** `~/.claude/.coordination-session-id` (`session-id.ts:27-37`) — not per-terminal, not per-project. Two concurrent terminals therefore share one persistence slot; the later session's registration overwrites the earlier one's ID, and the earlier session's subsequent hook processes read the *later* session's ID from the file. Consequence (traced from code structure, not observed live): concurrent sessions can collapse into one identity, defeating conflict detection exactly when it matters. This is a concrete mechanism behind the ST-02 "7-implementation split-brain" finding (`docs/system-update/CURRENT-STATE.md:13,19`).
- **File claims** — `.claude/hooks/src/file-claims.ts`. PreToolUse:Edit|Write. Hard-blocks (`permissionDecision: deny`) when another session with a heartbeat <5 min holds the `(file_path, project)` claim (`file-claims.ts:18,57-79`); takes over stale claims (`:80-87`); claims the file on every allowed edit (`:89-93`). Claims are released **only** by stale takeover — no unclaim/delete helper exists anywhere in `db-utils-pg.ts` (verified by full-file read).
- **DB layer** — `.claude/hooks/src/shared/db-utils-pg.ts`. Every query spawns a `uv run python -c` subprocess with a 3-second timeout (`db-utils-pg.ts:68-71`). All coordination checks **fail open**: `checkFileClaim` returns `{claimed:false}` on any error (`:644-646`), and `isSessionActive` returns `false` on error (`:574-579`) — meaning a DB outage or a >3s Python cold-start silently converts the "block" into "allow + stale takeover." Latent bug: the inline connection-string fallbacks are inconsistent — `checkFileClaim`/`claimFile` default to port **5432** (`:607,674`) while `isSessionActive` defaults to port **5434** (`:540`), so with no env var set, a claim can be *found* but its owner can never be seen as *active* → every conflict resolves as stale takeover. Also `CREATE TABLE IF NOT EXISTS` runs on every claim check (`:613-621`).
- **Heartbeats/sessions** — `registerSession` upserts into `sessions` with `last_heartbeat` (`db-utils-pg.ts:390-445`); 5-minute activity window (`:469-470`). Ops reference: `.claude/rules/cross-terminal-db.md`.

**Known limitations (already named in the system docs).** `docs/system-update/CURRENT-STATE.md:15-23` gates multi-session safety on ST-02 (canonical identity + `agent_id`), and names two structural blind spots: (a) subagents share the parent `session_id`, so the lock layer is blind to intra-session fan-out; (b) sync scripts and git ops bypass the Edit/Write-tool lock entirely (the Hook Source Regression came through *sync*). The fix plan is the Tier-2b MS arc (`docs/system-update/BACKLOG.md:74-87`): MS-01 intra-session claims keyed by `(file_path, project, session_id, agent_id)`, MS-02 infra hard-block, MS-03 git/build serialization, plus SG-04+ peer-awareness metrics (`BACKLOG.md:97`).

## 2. Frontier scan

External research delegated to oracle; every source below independently re-fetched and confirmed in this session (2026-07-23).

1. **Claude Code ships native worktree isolation — including per-subagent.** Official docs: `claude --worktree <name>` creates an isolated worktree under `.claude/worktrees/`; subagent frontmatter supports `isolation: worktree` ("Each subagent gets a temporary worktree that Claude Code removes automatically when the subagent finishes without changes"); Claude Code runs `git worktree lock` on a subagent's worktree while it runs so concurrent cleanup can't remove it; a periodic sweep cleans abandoned worktrees; `.worktreeinclude` copies gitignored env files in; `worktree.baseRef: "head"` branches subagent worktrees from in-progress work. https://code.claude.com/docs/en/worktrees. The `isolation: worktree` frontmatter shipped ahead of its docs (github.com/anthropics/claude-code/issues/27023 — a docs-gap issue confirming the feature is real as of v2.1.49). Notably, Anthropic ships **no** native cross-terminal session registry or DB-mediated file locking — worktree (filesystem) isolation is their entire answer.
2. **Cursor's production experience: both classic locking disciplines failed; task partitioning won.** Cursor's "Scaling long-running autonomous coding" (https://cursor.com/blog/scaling-agents) reports pessimistic locks collapsed ~20 concurrent agents "to the effective throughput of two or three, with most time spent waiting"; optimistic concurrency ("writes would fail if the state had changed since they last read it") made agents avoid contentious tasks; their working fix was architectural — Planner → Worker → Judge with workers on disjoint assigned tasks — "This solved most of our coordination problems."
3. **Agent merge conflicts are common enough to measure.** AgenticFlict (arXiv:2604.03551): 142K+ agent-authored PRs across 59K+ repos, deterministic merge simulation, **27.67% conflict rate**, 336K+ conflict regions. Companion study (arXiv:2607.04697): conflict rate **41.7% for cross-agent pairs vs 19.8% for same-agent pairs**, and **84.4% of conflicted files are source files** — so scoping protection to config/infra files would miss most real collisions.
4. **Adaptive concurrency control is emerging research, not shipped practice.** ATCC (arXiv:2603.13906) dynamically picks optimistic vs pessimistic execution per transaction via an RL policy, claiming up to four orders of magnitude throughput improvement and 90% tail-latency reduction (their benchmarks, not independently reproduced). Research-stage.
5. **Provenance/attribution is contested, no standard yet.** microsoft/vscode#313962 proposes `Assisted-by:` trailers over `Co-authored-by` for AI agents, referencing the Linux kernel's `Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]` format (https://github.com/microsoft/vscode/issues/313962). [Speculation — reported by the research agent but not independently re-verified here: an IETF 126 BoF (July 2026) is weighing chartering a WG for agent-communication standards with identity/trust in scope; and the closest OSS analog to our Postgres+heartbeat+claims design is a single-maintainer project with no adoption evidence.]
6. **What was NOT found:** no production system using CRDTs or vector clocks for agent-vs-agent *code* coordination (that machinery targets real-time collaborative text editing); no first-party (Anthropic/OpenAI) cross-session peer-coordination protocol.

## 3. Gap analysis

**Where we're ahead.** A Postgres-backed cross-*terminal* session registry + advisory claim layer is something no first-party harness ships (the Claude Code docs cover worktrees, subagents, and agent teams — nothing DB-mediated across independent terminals). Our hybrid MS posture (hard-block infra / warn project / serialize git) is *more* nuanced than anything in the frontier scan, and Cursor's production data retroactively validates its core instinct: don't escalate ordinary project files to global pessimistic locking.

**Where we're behind.**
- **Intra-session fan-out:** MS-01 plans to solve it with finer-grained claims (`agent_id` keying), but the platform now solves it natively and more strongly — `isolation: worktree` gives filesystem-level isolation, automatic cleanup, and `git worktree lock` protection, with zero DB round-trips. Claims *detect* collisions; worktrees *prevent* them. Our own codex/grok workers already hand-roll out-of-repo worktrees for exactly this reason (`.claude/rules/codex-worker-safety.md`).
- **Lease semantics:** our "lock" is heartbeat-staleness only. There's no per-claim TTL and no fencing: after a stale takeover, nothing stops the *original* session's already-in-flight write from landing (classic stale-lease race). Claims also never expire on their own — a session that edits 50 files holds 50 claims until each is individually taken over.
- **Reliability of the primitive itself:** fail-open on a 3s subprocess timeout, the 5432/5434 fallback mismatch, and the single global session-id file mean the current layer can silently degrade to "no coordination" — worse, to *wrong* coordination (identity collapse). The frontier lesson (Cursor) is that the *architecture* matters more than the lock, but a lock that lies is worse than no lock.
- **Measurement:** we have no conflict-rate telemetry. The field now measures 20–28% conflict rates for concurrent agents; we don't know ours (SG-04+ names this but it's unbuilt).

**Where we're even.** Advisory-first posture; git serialization plans (MS-03) match common practice around `.git/index.lock` races.

## 4. Recommendations

1. **ADOPT — Redirect MS-01 (intra-session fan-out) to native `isolation: worktree` as the primary mechanism.** Encode in the delegation rules/orchestrator skills: parallel subagents that write files should be spawned with `isolation: "worktree"` (the Agent tool already accepts it; frontmatter for standing agents). Keep the `agent_id`-keyed claim extension as a *fallback/detector* for non-worktree flows, not the primary defense. Rationale: platform-native, filesystem-strength isolation vs advisory detection; Anthropic's own answer to this exact problem; cheaper than building claim plumbing. Caveat: worktree = merge-later, so pair with the existing "orchestrator reviews each patch" convention.
2. **ADOPT — Keep the advisory/hybrid posture; explicitly reject escalation to global pessimistic blocking.** Cursor's production data (throughput collapse under pessimistic locks; risk-averse agents under pure optimistic CC) is the strongest external evidence yet for the MS posture table as designed (`BACKLOG.md:86`). This is a "we are already right, write it down" outcome — add the citation to the MS arc plan so a future session doesn't "improve" it into a global mutex.
3. **ADOPT — Lease/TTL + fencing on `file_claims`.** Add `expires_at` (short TTL, refreshed on each edit) and a monotonic `fence` integer bumped on every takeover; `claimFile` returns the fence, and takeover invalidates older fences. Fold in the two verified reliability bugs: (a) unify the 5432/5434 connection-string fallbacks in `db-utils-pg.ts` (one shared constant — arguably a quick win independent of everything else); (b) make the session-id persistence file per-terminal (e.g. keyed by PID/PPID or written per-project tmp) as part of ST-02 rather than one global slot. Note: full fencing (rejecting a stale session's write) requires the write path to check the fence — the PreToolUse hook is that checkpoint, so this is implementable without touching the tools themselves.
4. **ADOPT (cheap) — Agent provenance commit trailer.** Adopt an internal `Assisted-by: claude-code:<model> session:<coordination_session_id>` (or `Session-Id:`) trailer convention in the commit skill/auto-commit hooks, giving forensic joins from git history to `sessions`/`file_claims` rows. Aligns with the Linux-kernel-style `Assisted-by` direction (vscode#313962) without betting on an unsettled standard. **WATCH** the standardization track; don't build interop.
5. **ADOPT — Conflict-rate telemetry (fold into SG-04+).** Log every claim-conflict event (who/what/file/resolution) to a JSONL or the DB and compute a local conflict rate; the 19.8–41.7% external rates say this is not a rare edge case worth leaving unmeasured. AgenticFlict-style merge *simulation* is **WATCH** — overkill for local scale.
6. **WATCH — Adaptive concurrency control (ATCC/CoAgent-class).** Research-stage; revisit if we ever run >5 concurrent write-capable sessions routinely.
7. **SKIP — CRDTs / vector clocks.** No evidence of production use for agent code coordination; wrong tool (real-time text collaboration) for discrete file-write coordination.
8. **SKIP — Git-as-coordination-substrate protocols (e.g. "GNAP").** The research pass found its visibility pattern to be cross-posted promotion, not adoption. [Speculation as to motive; the absence of adoption evidence is the operative fact.]

## 5. Integration approach

Sequencing preserved from BACKLOG: **ST-02 remains the gate** — none of the lock hardening is trustworthy while identity is split-brained.

| Item | Files/subsystems | BACKLOG tie | Effort | Risk |
|---|---|---|---|---|
| Port-fallback unification (rec 3a) | `.claude/hooks/src/shared/db-utils-pg.ts` (one `DEFAULT_PG_URL` const replacing ~8 inline fallbacks) | ST-02 adjacent; candidate quick win | ~1 hr + hook rebuild/tests | Very low; behavior only changes when env var absent |
| Per-terminal session-id persistence (rec 3b) | `shared/session-id.ts` (+ `session-register.ts`) | **ST-02** (in scope — it's an identity fix) | Inside ST-02's existing plan | Medium — every consumer of `getSessionId` is affected; needs ST-02's own premortem |
| `isolation: worktree` steering (rec 1) | `.claude/rules/proactive-delegation.md`, ralph/maestro skill docs, agent frontmatter for write-capable parallel agents | **MS-01** (re-scoped: worktree primary, claims fallback) | Doc/config-level, ~half day; no code | Low; worktree cold-start + merge-back cost per agent — keep for genuinely parallel write fan-out only, per the existing worktree-cost guidance |
| Lease/TTL + fencing (rec 3) | `file_claims` schema (`expires_at`, `fence`), `db-utils-pg.ts` claim functions, `file-claims.ts` | **MS-01/MS-02 arc**, after ST-02 | 1–2 days incl. vitest coverage | Medium — fail-open behavior must be preserved deliberately (a guard bug must never brick Edit/Write); takeover semantics change |
| Provenance trailer (rec 4) | commit skill, `git-auto-commit` hook | new small item under MS arc / SG-04+ | ~half day | Low; append-only metadata |
| Conflict telemetry (rec 5) | `file-claims.ts` (log on conflict), small stats script | **SG-04+** (`BACKLOG.md:97` names exactly this) | ~1 day | Low |

**What could go wrong:** (a) worktree steering shifts cost from "conflicts" to "merge-back" — if orchestrators skip patch review, silent semantic conflicts replace loud file conflicts; (b) TTL too short + the 3s subprocess tax could cause claim flapping — TTL must comfortably exceed worst-case hook latency; (c) touching `hooks/src` carries the Hook Source Regression history — run `scripts/audit-braintrust-emits.sh` after every edit per `.claude/rules/hook-dev-lifecycle.md`.

## 6. Benefits

- **Fewer clobbered files with zero new infrastructure** — `isolation: worktree` is already in the installed harness; steering parallel write fan-out to it removes the known MS-01 blind spot (subagents invisible to the lock layer) at documentation cost.
- **A lock layer that stops lying** — the port-fallback fix and per-terminal identity remove two verified mechanisms by which today's layer produces false "stale takeover" outcomes; Dave gets conflict blocks that fire when real and only when real.
- **Faster incident forensics** — commit-trailer provenance joins any regression (e.g. the next Hook Source Regression-class event) back to the exact session and claim rows in minutes instead of an archaeology session.
- **Evidence-based posture** — conflict-rate telemetry converts "we think advisory is enough" into a measured number, and the Cursor citation inoculates the MS arc against a future well-meaning rewrite toward global locking.
- **Avoided cost** — two SKIPs (CRDTs, git-substrate protocols) and one WATCH (adaptive CC) prevent multi-week builds the field gives no evidence for at our scale.

## 7. Open questions

1. Does `isolation: worktree` interact cleanly with our PreToolUse `file-claims` hook (claims would record worktree paths, not repo paths — should the hook normalize `.claude/worktrees/<name>/...` back to repo-relative before claiming, or skip claiming inside worktrees entirely)?
2. Claim release: should SessionEnd delete the session's `file_claims` rows (today they linger until taken over)? Cheap, but SessionEnd hooks have a timeout history (`hook-dev-lifecycle.md` failure table).
3. What TTL fits our latency profile? Needs measurement of real hook round-trip times (the 3s subprocess ceiling suggests TTL ≥ 60s, refresh-on-edit). [Speculation until measured.]
4. Should MS-02's infra hard-block land *before* any of this, per BACKLOG's own "ship first (highest blast radius)" note? Nothing here contradicts that ordering.
5. The desktop app gives "every new session ... its own worktree automatically" (worktrees doc) — if Dave's workflow shifts toward the desktop app, does cross-terminal claim locking shrink to a legacy path? Worth rechecking before investing beyond the MS arc.
