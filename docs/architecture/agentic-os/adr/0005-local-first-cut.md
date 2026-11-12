# ADR 0005 — Local-first cut: no auth, OIDC, RLS or `workspace_id`

**Status:** Accepted (2026-07-27) · **Supersedes:** the tenancy model in `contracts.md`, **for v1 only**

## Context

`contracts.md` specifies a governed multi-tenant system. **All 14 of its write-model
tables carry `workspace_id`** — `principal`, `role_binding`, `definition_version`, `run`,
`run_attempt`, `task`, `event`, `approval`, `tool_grant`, `tool_operation`, `artifact`,
`evaluation`, `checkpoint`, `outbox`. Uniqueness keys, including request and operation
idempotency keys, are workspace-scoped. It states plainly that "Phase 0 must choose and
test an RLS strategy; application filters alone are not an isolation boundary."

That is correct for the product it describes. Slice 1 is a **localhost dashboard for one
person that writes nothing**. There is no second tenant to isolate from, no untrusted
caller, and no write path an RLS policy could govern. Building the isolation machinery
first would mean implementing, testing and carrying an auth boundary whose only user is
its own test suite — while the actual question (does the fleet grid tell the truth?) goes
unanswered.

## Decision

**Cut tenancy from v1 entirely.** No auth, no OIDC, no RLS, no `workspace_id` column on
any `agentic_os` table.

Isolation in v1 is provided by two things that are real:

- **The app binds to localhost.** The network is the boundary. The bind address is `127.0.0.1`.
  Three places set it: the `dev` and `start` scripts in `apps/agentic-os/package.json` (`-H`) and
  the launcher `scripts/agentic-os/start-fleet.ps1` (`--hostname`). Without the flag `next` listens
  on every network interface.
- **The app's database role is read-only on `public`.** This is a *verification step*, not
  a claim: `psql` as `agentic_os_reader` must prove `INSERT INTO public.sessions` is
  denied. The role also carries `statement_timeout` and `lock_timeout`.

**The shape survives the cut.** Every new table gets a surrogate primary key and an
`occurred_at`. Adding a scope column later is therefore **additive, not a PK rewrite** —
which is the whole reason this is a deferral rather than a fork.

## Consequences

- Slice 1 can ship. That is the point.
- **What re-adding it would cost**, honestly stated so nobody mistakes this for free:
  an identity provider and session handling; a `workspace_id` column plus backfill on
  every table then in existence; workspace-scoping every uniqueness constraint and
  idempotency key; RLS policies plus the isolation test suite `contracts.md` requires; and
  a per-request principal threaded through every `src/server/queries/` function. Days of
  work, not hours — but **additive** days, because of the surrogate-PK rule above.
- **The trigger to reverse this is not a date, it is a second reader.** The moment this
  app is reachable by anyone but Dave on this machine — a tunnel, a deploy, a shared host
  — every assumption here is void and the cut must be reversed *before* that exposure, not
  after.
- v1 must not claim otherwise. No login screen, no user menu, nothing implying an identity
  the system does not have. A UI that looks authenticated and is not is worse than one
  that visibly is not.
