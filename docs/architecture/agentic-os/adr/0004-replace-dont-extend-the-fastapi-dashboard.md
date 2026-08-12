# ADR 0004 — Replace, don't extend, the FastAPI dashboard

**Status:** Accepted (2026-07-27) · **Retirement: deliberately not scheduled**

## Context

A working dashboard already exists and **is running right now** on port 3434:
`opc/scripts/dashboard/` — FastAPI (16 routers, 14 services, WebSocket, an NSSM service
installer) plus React/Vite/shadcn, ~9,310 LOC across 14 pillar components, serving real
data. Last feature commit 2026-03-07.

"There is already a dashboard, extend it" is the obvious move and it is the wrong one.
The decisive argument is **the domain model, not the language**. `services/base.py`'s
`BasePillarService` abstraction organizes the system into independent *pillars*, each
answering questions about its own subsystem. Slice 1's premise is the opposite: **the
fleet is the home view**, and every pillar is a drill-in from a project. Retrofitting a
cross-cutting project identity into a pillar-shaped app means rewriting the abstraction
that defines it — which is a rewrite wearing an extension's clothes, with the added cost
of keeping the old thing working throughout.

## Decision

**Build the new app rather than extend the old one. Do not delete the old one.**

The two coexist: 3434 (Python) and 3010 (Next). The new app **does not duplicate** the old
one's four unique pillars — PageIndex, Braintrust, the skills catalog, and MCP-server
status. None of those is needed for v1, and all of them would be lost for nothing.

**Retirement is explicitly removed from Slice 3** (resolved with Dave). Revisit only after
living with the replacement for a couple of weeks. The cost of waiting is one idle Python
process.

## Consequences

- No migration phase, no compatibility layer, no dual-write. The new app reads the same
  database directly.
- **What must be ported, not reinvented:** the session status thresholds in
  `services/sessions.py`. What must be *avoided* from the same file: its unbounded-query
  pattern.
- Two dashboards on one machine is a real cost, paid deliberately. The failure mode to
  watch is not disk or CPU, it is **a human reading a stale number off 3434** and
  believing it. If that happens, retirement becomes urgent — that is the retirement
  trigger, in place of a date.
- Retirement conditions, when the question is reopened: the four unique pillars are either
  ported or explicitly abandoned; ROADMAP goal counts have been **A/B'd directly against
  the Python service on the same file**; and `curl :3434` failing is a verification step,
  not an assumption.
