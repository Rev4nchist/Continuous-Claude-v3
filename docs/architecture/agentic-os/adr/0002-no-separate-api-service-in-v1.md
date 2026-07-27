# ADR 0002 — No separate API service in v1

**Status:** Accepted (2026-07-27) · **Supersedes:** the `services/agentic-os-api` deployment unit in `target-architecture.md`, **for v1 only**

## Context

`target-architecture.md` specifies a standalone API service as its own deployment unit,
with the dashboard as a client of it. That shape is correct for a multi-tenant service
with third-party callers, independent scaling and an auth boundary at the network edge.

Slice 1 has none of those. It is one Next.js app, on localhost, for one user, reading a
database on the same machine, and **writing nothing**. A separate HTTP service between
the app and the database would add a process to run, a contract to version, a
serialization hop, and a second place for the read model to drift — in exchange for an
isolation boundary that nothing crosses.

## Decision

**`src/server/queries/*.ts` is the API boundary in v1.** There is no separate service and
no HTTP API.

The boundary is enforced structurally rather than by convention:

- **No component imports `db`.** Every read goes through a function in
  `src/server/queries/`. This is the rule that makes the decision reversible.
- Query modules take typed arguments and return typed DTOs — they do not leak Drizzle
  builders or row shapes to callers.
- The existing `opc/scripts/dashboard/frontend/src/types/index.ts` (369 LOC of already
  designed DTO shapes) is the starting vocabulary, not a fresh invention.

## Consequences

- Extracting a real API service later is a mechanical change: each query function becomes
  a route handler, and callers change their import. That is only true while the no-direct-
  `db`-import rule holds, so it is enforced in Slice 1 or never.
- No versioned API contract, no OpenAPI surface, no separate deploy in v1.
- **This is a v1 decision, not a repudiation.** When there is a second client, or a caller
  that is not this app, `target-architecture.md`'s service unit is the target again.
- Polling lives behind a single `useLiveData()` hook for the same reason: swapping 5s
  polling for SSE in Slice 3 must not touch components.
