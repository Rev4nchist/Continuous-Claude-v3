# Agentic OS — Architecture Decision Records

Five decisions the approved plan requires to be written down **before Slice 1 code**.
They exist because Slice 1 deliberately contradicts the 2026-07-18 design package in
this same directory, and an undocumented contradiction is indistinguishable from a
mistake six weeks later.

| ADR | Decision | Supersedes |
|---|---|---|
| [0001](0001-sessions-and-context-are-first-class.md) | Sessions and context are first-class entities | extends `product-brief.md` |
| [0002](0002-no-separate-api-service-in-v1.md) | No separate API service in v1 | `services/agentic-os-api` in `target-architecture.md`, **v1 only** |
| [0003](0003-agentic-os-schema-in-shared-db.md) | `agentic_os` schema in the shared database | — |
| [0004](0004-replace-dont-extend-the-fastapi-dashboard.md) | Replace, don't extend, the FastAPI dashboard | — |
| [0005](0005-local-first-cut.md) | Local-first cut — no auth, OIDC, RLS or `workspace_id` | most of `contracts.md`'s tenancy model, **v1 only** |
| [0006](0006-code-to-code-traffic-local-notion-stays-cross-assistant.md) | Code-to-Code traffic moves local; Notion stays for cross-assistant traffic (proposed 2026-10-27) | task rule in `notion-operating-model.md`, **Code-to-Code only** |

## The context all five share

There are **two plans on disk and only one is in force.**

- `docs/architecture/agentic-os/` (2026-07-18) — a governed multi-tenant production run
  service. OIDC, RLS, `workspace_id` on every table, dashboard at Phase 4 of 6.
- `~/.claude/plans/i-am-ready-to-noble-wilkinson.md` (2026-07-25) — **approved with Dave**.
  A local read-first Mission Control. No auth. Dashboard as Slice 1 of 4. It says in its
  own words that it *"deliberately inverts the documented phase order."*

The design package is **not wrong and not deleted** — it is the destination. These ADRs
record where v1 departs from it and what re-converging would cost. Read the superseded
document as a design, never as a specification of what to build now.

**Scope discipline:** every "v1 only" above is load-bearing. None of these ADRs argues
that the governed model was a bad idea; they argue it is not what a localhost read-only
dashboard needs to carry.
