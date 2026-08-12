# ADR 0001 — Sessions and context are first-class entities

**Status:** Accepted (2026-07-27) · **Extends:** `product-brief.md`

## Context

`product-brief.md` models the system as **runs, workflows, approvals and artifacts**. A
run is something you launch; the brief's entire vocabulary assumes work begins when a
user submits it.

That is not how this machine actually works, and Slice 1 has to render what actually
exists. The real unit of work is a **Claude Code session**: a human-driven, long-lived,
resumable thing that nobody launched through an API, that spans compactions and
handoffs, and that carries context — file claims, memories, transcripts, a working
directory — which outlives any single turn. `public.sessions` holds 2,352 rows today and
predates the run model entirely.

A "run" is not a superset of a session. Modelling sessions as degenerate runs would mean
inventing a workflow id for work no workflow launched, and would make the fleet view — the
whole of Slice 1 — a view of synthetic records.

## Decision

**Session and context are first-class entities in their own right**, not projections of
`run`. Slice 1 reads sessions directly.

- A session is identified by its own id and joined to a project by `project_id_hash`.
- Context (file claims, memories, transcript index) hangs off the session, not off a run.
- `run` remains reserved for API-launched work and is **not** implemented in v1.
- Both may coexist later: a run can *spawn* a session without a session *being* a run.

## Consequences

- The fleet grid and Project Canvas can be built against data that already exists, which
  is why Slice 1 can ship without a worker, a queue or a runner adapter.
- `product-brief.md`'s entity list is incomplete rather than wrong. Anyone extending it
  must add sessions/context rather than reinterpreting runs.
- **A counting hazard that must reach the UI, not a comment:** of those 2,352 `sessions`
  rows, **1,465 are `s-*` coordination heartbeats, not real sessions** — only 887 are
  real. Any user-facing count that does not exclude them is wrong by 165%. Likewise only
  **342 of 494** main transcripts join to a DB session, so join coverage is a number to
  display, not a caveat to bury.
- Reserving `run` costs nothing now and keeps the door open to the governed model without
  a rename.
