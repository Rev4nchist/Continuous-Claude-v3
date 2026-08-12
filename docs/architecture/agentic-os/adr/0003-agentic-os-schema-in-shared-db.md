# ADR 0003 — `agentic_os` schema in the shared database

**Status:** Accepted (2026-07-27) · **Already implemented** in `apps/agentic-os/drizzle.config.ts`

## Context

There is one PostgreSQL database and it is **not ours alone**. `public` holds 40 tables;
only 6 belong to Continuous Claude, and **none of them are managed by this project**. The
rest belong to Fourth Canvas, the ai-reporting MCP server and vibe-trading.

Two specific hazards, both verified rather than assumed:

1. **The migration slot is already taken.** A `drizzle.__drizzle_migrations` journal
   already exists in this database with a row owned by **a different application**. A
   default-configured drizzle-kit would write into another app's journal — the
   *foreign-journal finding*.
2. **`drizzle-kit` diffs what it can see.** Without a schema filter it sees 40 unmanaged
   tables as drift and emits `DROP TABLE` for all of them. This is the single largest
   footgun in the whole plan, and it is a footgun that destroys other people's data.

A separate database was considered and rejected: Slice 1's entire value is *joining*
`agentic_os` tables to `public.sessions`, `public.file_claims` and
`public.archival_memory`. Cross-database joins would mean giving that up or replicating.

## Decision

Own **a schema, not a database**. All new tables live in `agentic_os`; `public` is
read-only to us, always.

```ts
schemaFilter: ['agentic_os'],
migrations: { schema: 'agentic_os', table: '__migrations' },
```

Four rules, in priority order:

1. **`schemaFilter: ['agentic_os']`**, and **do not take it on trust** — read the emitted
   SQL. It must contain no `DROP`, no `ALTER`, and no `CREATE` naming any `public` object.
   If it ever misbehaves, fall back to hand-written SQL; the schema is small and
   `drizzle-orm`'s query builder is unaffected.
2. **Private migration journal** at `agentic_os.__migrations` — never the foreign default.
3. **Never `drizzle-kit push`.** It diffs against the live database and is the command
   that can actually destroy the other apps' tables. `generate` → read the SQL →
   `migrate`. `npm run db:check` enforces this.
4. **`public` declarations stay out of the migration glob.** Drizzle table declarations
   are **not inert to drizzle-kit** even when schema-filtered, so the read-only types live
   in `src/db/readonly/public.ts`, outside `schema:`.

## Consequences

- The joins Slice 1 needs stay ordinary SQL.
- Every migration carries a review step that cannot be automated away: a human reads the
  generated SQL before it runs. The check greps for any `CREATE`/`ALTER`/`DROP` naming a
  non-`agentic_os` object — not just `DROP TABLE`; extensions, enums, indexes and
  privileges count.
- **Cleaning the graveyard is explicitly out of scope.** CCv3's own `plans`(0),
  `continuity`(0) and `agent_runs`(0) are genuinely dead, but dropping them is a separate
  ADR and a separate PR. Conflating schema cleanup with a dashboard build is how you break
  someone else's app.
- Invariant for every verification run: `\dt public.*` shows **40 tables before and after**.
