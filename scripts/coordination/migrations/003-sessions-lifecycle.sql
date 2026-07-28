-- 003 -- give `sessions` an END, and give the liveness query an index.
--
-- Additive and idempotent. No row is modified, no column is dropped, nothing is
-- deleted. Safe to re-run; safe to run while sessions are live.
--
-- Fresh databases get the same shape from docker/init-schema.sql, which
-- docker-compose mounts. This file is for the already-provisioned one.
--
--   docker exec -i continuous-claude-postgres psql -U claude -d continuous_claude \
--     < scripts/coordination/migrations/003-sessions-lifecycle.sql
--
-- (PowerShell has no `<` redirect. Use `Get-Content file | docker exec -i ...`,
-- or run the statements with -c.)
--
--
-- WHY: THE TABLE COULD NEVER SAY A SESSION WAS OVER
-- -------------------------------------------------
-- `sessions` records four kinds of beginning-or-middle -- started_at,
-- last_heartbeat, last_activity_at, memory_extracted_at -- and no kind of end.
-- coordination-release.ts has run on SessionEnd since the leases landed, and it
-- releases file claims and then throws away the one fact nobody else can
-- reconstruct: that this session is finished, and Claude Code's own word for why.
--
-- The consequence is not academic. Liveness is inferred ENTIRELY from a 15-minute
-- read-side window, so a terminal you closed deliberately reads "active" for up to
-- fifteen minutes, and a session that crashed is indistinguishable from one that
-- exited cleanly -- forever, not just for fifteen minutes. That is tolerable for a
-- dashboard you look at. It is not tolerable for one you act from.
--
--
-- WHAT ended_at DOES AND DOES NOT MEAN
-- ------------------------------------
-- NOT NULL  =>  a SessionEnd hook ran and said so. This is a POSITIVE signal and
--               it is trustworthy.
--
-- NULL      =>  UNKNOWN. It does NOT mean "still running" and it must never be
--               rendered as "crashed". Three different things produce NULL:
--                 1. the session is genuinely still running;
--                 2. the process was killed outright, so SessionEnd never fired
--                    (the lease expiry is the backstop for that, and remains so);
--                 3. the row predates this migration -- which is ALL 2,453 rows
--                    at the moment it is applied.
--               Case 3 is the same shape as last_activity_at's history, and it
--               gets the same treatment: absence is reported as unknown, never
--               back-filled with a guess.
--
-- There is deliberately NO `status` column. Status is derivable from these facts
-- plus the clock, and a stored status is a fact that can rot when a writer misses
-- an update. Store what was observed; derive what it means at read time.
--
--
-- WHY NO WRITER HAS TO CLEAR ended_at
-- -----------------------------------
-- A session can come back: `claude --resume` re-registers the same id, and hooks
-- can race. If "ended" meant "ended_at IS NOT NULL", a resumed session would be
-- invisible while working -- a new confidently-wrong failure introduced by the fix
-- for an old one.
--
-- So "ended" is defined RELATIVELY, at read time:
--
--     ended_at IS NOT NULL AND ended_at >= GREATEST(last_heartbeat, last_activity_at)
--
-- i.e. the last thing that happened to this session was the end of it. Any later
-- sign of life un-ends it automatically, with no clearing write, and therefore no
-- ordering requirement between hooks. session-register.ts and heartbeat.ts are
-- untouched by this migration precisely because they do not need to be.
--
--
-- WHY THE INDEX (measured, not assumed)
-- -------------------------------------
-- Before, on this database, EXPLAIN (ANALYZE, BUFFERS) of the dashboard's liveness
-- query -- which runs every 5 seconds, forever, against a table three other
-- applications also use:
--
--     Seq Scan on sessions  (cost=0.00..106.77 rows=320) (actual rows=3)
--       Rows Removed by Filter: 2450
--     Buffers: shared hit=48        Execution Time: 0.412 ms
--
-- 0.412 ms is fine. This is the silently-degrading shape, not an outage: the cost
-- is linear in a table that only ever grows and is never pruned. Note also
-- `rows=320` against `actual rows=3` -- the planner has no statistics on the
-- GREATEST expression, and an expression index gives it those as a side effect.
--
-- The index is PARTIAL on `id NOT LIKE 's-%'` because the query always carries
-- that predicate and those rows are the majority of the table.
--
-- It is keyed on GREATEST of THREE columns, ended_at included. That expression is
-- "the most recent thing known about this session", which is what the window
-- should admit on -- otherwise a session that sat idle for an hour and was then
-- closed would never appear as recently-ended, because its last heartbeat is
-- outside the window even though it ended ten seconds ago. For a live session
-- (ended_at NULL) GREATEST of three reduces exactly to GREATEST of two, so the
-- live path is unchanged. Postgres GREATEST ignores NULLs and returns NULL only
-- when every argument is NULL.

BEGIN;

-- Preconditions, enforced rather than trusted. Any failure aborts the whole
-- transaction and changes nothing.
DO $$
BEGIN
  IF to_regclass('public.sessions') IS NULL THEN
    RAISE EXCEPTION 'public.sessions does not exist -- wrong database?';
  END IF;

  -- If a `status` column ever appears, someone chose the stored-status design
  -- this migration argues against, and the two must be reconciled by a human
  -- rather than silently coexisting.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'public.sessions already has a status column -- reconcile by hand';
  END IF;
END $$;

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS ended_at   TIMESTAMP;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS end_reason TEXT;

COMMENT ON COLUMN public.sessions.ended_at IS
  'Set by coordination-release.ts on SessionEnd. NOT NULL means an end was observed; NULL means UNKNOWN (still running, killed outright, or written before 2026-07-28). Never render NULL as crashed.';
COMMENT ON COLUMN public.sessions.end_reason IS
  'Claude Code''s own reason string for the session ending, verbatim and unconstrained. Falls back to session_end when the payload omits it.';

CREATE INDEX IF NOT EXISTS sessions_last_signal_idx
  ON public.sessions (GREATEST(last_heartbeat, last_activity_at, ended_at) DESC)
  WHERE id NOT LIKE 's-%';

COMMIT;

-- Verification. Expect: two new columns, one new index, and an Index Scan rather
-- than a Seq Scan in the plan below.
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='sessions'
--      AND column_name IN ('ended_at','end_reason');
--
--   EXPLAIN (ANALYZE, BUFFERS) SELECT s.id FROM public.sessions s
--    WHERE s.id NOT LIKE 's-%' AND s.last_heartbeat IS NOT NULL
--      AND GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at)
--          > (now() AT TIME ZONE 'UTC') - make_interval(mins => 15)
--    ORDER BY GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at) DESC LIMIT 51;
