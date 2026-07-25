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

*Queue clear above this line — no pending digests. Last sweep: 2026-07-17 (07-14 Agents + 07-15 Workflows + 07-16 Code-Intel posted to Bridge Code→Eve queue as child pages + one-liners, with Tracker auto-mirror rows).*
