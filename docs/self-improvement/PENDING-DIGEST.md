# Pending Self-Improvement Digests → Notion Bridge (Code→Eve queue)

Unattended research runs cannot reliably reach the Notion Bridge (headless + fragile HTML/mention
format). Each entry below is a proposal digest awaiting sweep into the Bridge Code→Eve queue by the
next interactive session. After posting one, delete its block from this file.

---

## 2026-07-18 — observability (Braintrust Observability)

- **Date:** 2026-07-18
- **Component:** observability — Braintrust Observability
- **Verdict:** ADOPT
- **Headline:** Keep the deterministic-first/judge-second split (frontier-validated); the real gap is step-level scoring of sub-agent work — extend the judges from session-outcome to step/trajectory once ST-02 makes ids joinable, and skip judge panels (verified evidence they add ~nothing).
- **Proposal:** `docs/self-improvement/proposals/2026-07-18-observability.md`
- **Note:** Notion MCP tool call was auto-denied (headless ungranted tool) — digest parked here for the next interactive sweep.

---

## 2026-07-19 — doc-rag (Doc-RAG / PageIndex)

- **Date:** 2026-07-19
- **Component:** doc-rag — Doc-RAG (PageIndex)
- **Verdict:** SKIP
- **Headline:** Our doc-RAG already quietly pivoted to the frontier-consensus hybrid shape (FTS+vector RRF over tree nodes) and is correctly dormant for our sub-200K-token markdown corpus — do NOT build reasoning-tree RAG; fix the SKILL's 98.7%/"reasoning" overclaim (the default path is hybrid RRF, not the LLM tree-walk), and only if the pillar is kept, reuse the already-built SI-01 reranker.
- **Proposal:** `docs/self-improvement/proposals/2026-07-19-doc-rag.md`
- **Note:** Headless run — Notion Bridge not reached; parked here for the next interactive sweep.

---

## 2026-07-20 — skills (Skills System)

- **Date:** 2026-07-20
- **Component:** skills — Skills System
- **Verdict:** ADOPT
- **Headline:** Our 150+-skill catalog sits in the range where routing measurably degrades (F1 drops 16–23pp past ~100 tools, per verified June-2026 production study); adopt an FP/FN-driven single-rewrite description optimizer inside the existing `_eval/` harness, a frontmatter→skill-rules drift guard (kills the QW-08 ghost-entry class permanently), and refresh the 4-month-stale eval (97/150 skills covered); embedding-shortlist routing stays WATCH pending an offline prototype.
- **Proposal:** `docs/self-improvement/proposals/2026-07-20-skills.md`
- **Note:** Headless run — Notion Bridge not written (shared-surface write risk unattended); parked here for the next interactive sweep.

---

## 2026-07-23 — coordination (Cross-Session Coordination)

- **Date:** 2026-07-23
- **Component:** coordination — Cross-Session Coordination
- **Verdict:** ADOPT
- **Headline:** The field validates our advisory-lock posture (Cursor's production data: pessimistic locks collapse throughput, pure optimistic CC makes agents risk-averse); redirect intra-session fan-out (MS-01) to Claude Code's now-native `isolation: worktree`, harden `file_claims` with lease/TTL + fencing, and fix two verified reliability bugs (5432/5434 port-fallback mismatch in db-utils-pg.ts; single global `.coordination-session-id` file collapsing concurrent-terminal identity).
- **Proposal:** `docs/self-improvement/proposals/2026-07-23-coordination.md`
- **Note:** Headless run — Notion Bridge not written (shared-surface write risk unattended, per loop convention); parked here for the next interactive sweep.

---

## 2026-07-25 — memory (Memory)

- **Date:** 2026-07-25
- **Component:** memory — Memory
- **Verdict:** ADOPT
- **Headline:** A forgotten 2026-05-21 offline eval already proves the dormant reranker's precision lift (+107% NDCG@5, found-rate 57%→83% on a 42-pair labeled set) — re-run it on the warm daemon and wire `--rerank` into manual `/recall` now, while the day-old routing fix (early read 6/6 daemon-routed, zero fallbacks) accumulates data for the ~07-31 re-baseline.
- **Proposal:** `docs/self-improvement/proposals/2026-07-25-memory.md`
- **Note:** Headless run — Notion Bridge not written (shared-surface write risk unattended, per loop convention); parked here for the next interactive sweep.

---

## 2026-08-04 — coordination (Cross-Session Coordination)

- **Date:** 2026-08-04
- **Component:** coordination — Cross-Session Coordination
- **Verdict:** ADOPT
- **Headline:** The field converged on worktree-per-agent isolation while CCv3's fenced pessimistic lock layer is ahead of shipped products on write-time safety (and 2026 data — 27.67% measured merge-conflict rate on 142K agentic PRs — vindicates keeping it); close the fan-out gap via Claude Code's native `isolation: worktree` for parallel implementation subagents (MS-01 reframe) and reconfirm MS-02 (sync bypass, ship first) + MS-03 (git/build advisory-lock serialization) unchanged.
- **Proposal:** `docs/self-improvement/proposals/2026-08-04-coordination.md`
- **Continuity:** Second pass on this component — the 2026-07-23 proposal's lease/TTL + fencing recommendations have since SHIPPED (verified live in `db-utils-pg.ts`/`leases.ts` today); this pass re-baselines against the hardened layer and adds 5 newly verified 2026 sources (STORM, CoAgent, CAID, AgenticFlict, CodeCRDT).
- **Note:** Headless run — Notion MCP tool call auto-denied (ungranted tool, non-interactive); parked here for the next interactive sweep.

---

## 2026-07-26 — hooks (Hooks)

- **Date:** 2026-07-26
- **Component:** hooks — Hooks
- **Verdict:** adopt
- **Headline:** The 2026-07-01 proposal's top complaint is fixed (QW-04 shipped — subagent guards verifiably fire again), but the hook layer's own config/artifact surface has since become a documented CVE-bearing attack surface that Anthropic has declined to close at the model level, and CCv3 actively amplifies it — `sync-to-active.sh:283` overwrites the GLOBAL `mcpServers` from a repo-tracked file with zero validation on every post-commit, which is precisely the CVE-2025-59536 primitive.
- **Proposal:** `docs/self-improvement/proposals/2026-07-26-hooks.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-07-28 — workflows (Workflows)

- **Date:** 2026-07-28
- **Component:** workflows — Workflows
- **Verdict:** adopt
- **Headline:** Three passes (07-03, 07-15, 07-28) have now proposed the same five workflow items and verified all five still unshipped — so the recommendation changes from "propose" to "ship the two ~1-hour items or formally close them", plus one newly-verified simplification: a 9-judge panel carries ~2 independent votes and the best single judge matches or beats the panel, which argues our /review fan-out should be pruned to cross-FAMILY reviewers rather than grown.
- **Proposal:** `docs/self-improvement/proposals/2026-07-28-workflows.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-07-29 — code-intel (Code Intelligence)

- **Date:** 2026-07-29
- **Component:** code-intel — Code Intelligence
- **Verdict:** skip
- **Headline:** The 2026-07-24 cut was right and should NOT be reversed — but it was left half-finished: a 4.7-month-stale FAISS embedding index is still live-wired into `smart-search-router` and DENIES greps to serve obsolete results (the exact active-harm failure arXiv:2605.14478 measures), the BACKLOG still gates work on the deleted facade, and the cut deleted the very telemetry that justified it.
- **Proposal:** `docs/self-improvement/proposals/2026-07-29-code-intel.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-07-30 — observability (Braintrust Observability)

- **Date:** 2026-07-30
- **Component:** observability — Braintrust Observability
- **Verdict:** adopt
- **Headline:** The sub-agent correlation CCv3 deferred as "Phase 4" is now available first-party — Claude Code's beta OTel traces nest subagent spans under the parent and stamp session.id on every signal, and Braintrust ingests OTLP directly — so the twice-approved-never-run native-OTel spike now attacks the 60.7% corr-null, the sub-agent blind spot, and the measured ~690 ms/tool-call synchronous emit cost with one experiment; meanwhile the calibration gap finally has a named method with public code (PPI / Rogan–Gladen, arXiv:2601.05420) instead of just "build a gold set".
- **Proposal:** `docs/self-improvement/proposals/2026-07-30-observability.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-07-31 — doc-rag (Doc-RAG (PageIndex))

- **Date:** 2026-07-31
- **Component:** doc-rag — Doc-RAG (PageIndex)
- **Verdict:** skip
- **Headline:** The read path is dormant but the WRITE path is not — a registered hook fires a reindex across a broad doc-edit surface for an index that is 96% stale and has no measured reader, so the action is to cut the write path and park the pillar, not to evolve it.
- **Proposal:** `docs/self-improvement/proposals/2026-07-31-doc-rag.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-08-01 — skills (Skills System)

- **Date:** 2026-08-01
- **Component:** skills — Skills System
- **Verdict:** adopt
- **Headline:** The routing precision both prior skills proposals called unmeasurable was measurable all along from the transcripts on disk — 1,489 hook skill-suggestions produced 118 skill loads (~8%), 40 of 59 suggested skills were never loaded once, and the hard-blocking branch that carries this noise went live 4 days ago after ~186 days inert — so fix the blocker's matching before anything else and use the census to prune, not a router.
- **Proposal:** `docs/self-improvement/proposals/2026-08-01-skills.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-08-02 — cli-integration (CLI Integration Layer)

- **Date:** 2026-08-02
- **Component:** cli-integration — CLI Integration Layer
- **Verdict:** adopt
- **Headline:** The frontier still validates our CLI-first decision tree, so the work is not strategy — it is that our second-largest integration pattern ("Python harness via uv run", 9 live skills) is dead at config load (proved by execution this session), and the "32x fewer tokens" law those decisions rest on has circular, unsourced provenance that even a dedicated frontier sweep could not trace to a primary benchmark.
- **Proposal:** `docs/self-improvement/proposals/2026-08-02-cli-integration.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

## 2026-08-03 — learning-loop (Self-Improvement / Learning Extraction)

- **Date:** 2026-08-03
- **Component:** learning-loop — Self-Improvement / Learning Extraction
- **Verdict:** adopt
- **Headline:** Our learning loop is now a well-built one-way street — the 2026-07-24 cycle fixed the write side, but nothing anywhere records whether a stored learning ever helped, and the recall log does not even record WHICH rows were returned; instrument that link first (small, verified-dead `was_helpful` column already exists), because every frontier utility/pruning technique is gated on a signal we do not yet emit.
- **Proposal:** `docs/self-improvement/proposals/2026-08-03-learning-loop.md`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---

*Queue clear above this line — no pending digests. Last sweep: 2026-07-17 (07-14 Agents + 07-15 Workflows + 07-16 Code-Intel posted to Bridge Code→Eve queue as child pages + one-liners, with Tracker auto-mirror rows).*
