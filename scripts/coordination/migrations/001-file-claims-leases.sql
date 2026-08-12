-- 001 -- give file_claims an explicit lease.
--
-- WHY THIS TABLE AND NOT A NEW ONE
-- --------------------------------
-- The general `resource_lease` table (harness:src, git-index:, build:) belongs to
-- MS-02 at step 10. This is step 5 -- "file_claims hardening" -- so the lease is
-- added to the table that already holds the claims rather than introducing a
-- second source of truth that would immediately have to be kept in sync with it.
--
-- WHY public AND NOT agentic_os
-- -----------------------------
-- public.file_claims is created by the hooks themselves (db-utils-pg.ts issues a
-- CREATE TABLE IF NOT EXISTS on the read path) and is read by
-- opc/scripts/core/cleanup_sessions.py. Moving it is a separate, riskier change.
-- Note this database is SHARED with three other applications, so every statement
-- here is additive and none of them rewrites an existing value in place except
-- the explicitly-scoped backfill at the end.
--
-- WHY EVERY COLUMN HAS A DEFAULT
-- ------------------------------
-- So that any INSERT which does not name these columns still produces a row with
-- a coherent lease rather than NULLs that would read as "expired".
--
-- Note the limit of that, because an earlier version of this comment got it
-- wrong: a DEFAULT applies to an INSERT only. It is NOT consulted by
-- ON CONFLICT DO UPDATE. A writer that omits these columns on the update branch
-- therefore leaves a change of custody carrying the PREVIOUS holder's lease --
-- which is a claim that can be born already expired, or an ordinary file that
-- inherits a 60-minute harness lease. Every upsert against this table must name
-- expires_at, fence and lease_class in its DO UPDATE explicitly; defaults will
-- not cover for it.

BEGIN;

-- The fence is a lease GENERATION counter, minted on every change of custody.
--
-- Be precise about what it is not: this is NOT a Kleppmann fencing token, because
-- there is no mediated resource to reject a stale one. Nothing can stop a process
-- from writing to the filesystem with an out-of-date token. It buys DETECTION and
-- EVIDENCE -- a monotonic, gap-free chain of custody per file that timestamps
-- cannot give you (two claims in the same millisecond are indistinguishable by
-- claimed_at, and the clock can move).
CREATE SEQUENCE IF NOT EXISTS coordination_fence_seq AS BIGINT;

ALTER TABLE public.file_claims
  ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS fence       BIGINT,
  ADD COLUMN IF NOT EXISTS lease_class TEXT;

-- Defaults are set separately from ADD COLUMN so re-running this file against a
-- table that already has the columns still (re)establishes them.
--
-- `timestamp without time zone` matches claimed_at rather than being independently
-- correct. The whole table compares against NOW() under a container fixed to
-- Etc/UTC (verified 2026-07-26); mixing a timestamptz column into that would make
-- two columns on one row answer the timezone question differently.
ALTER TABLE public.file_claims
  ALTER COLUMN expires_at  SET DEFAULT NOW() + INTERVAL '10 minutes',
  ALTER COLUMN fence       SET DEFAULT nextval('coordination_fence_seq'),
  ALTER COLUMN lease_class SET DEFAULT 'file';

-- Reclamation reads (expires_at, session_id) for one (file_path, project) key,
-- which the primary key already covers. This index is for the SWEEP direction --
-- "what is expired right now", which the board and any future reaper both want --
-- and it is partial so it stays small.
CREATE INDEX IF NOT EXISTS file_claims_expires_at_idx
  ON public.file_claims (expires_at)
  WHERE expires_at IS NOT NULL;

-- Backfill. Scoped to rows that predate the columns, so re-running is a no-op.
--
-- Existing rows get a lease measured from when they were ACTUALLY claimed, not
-- from now. Most of them are therefore already expired the moment this runs,
-- which is the honest answer: they are old claims whose holders stopped hours
-- ago. Granting them a fresh 10 minutes would be inventing liveness that the
-- table never had.
UPDATE public.file_claims
   SET expires_at  = COALESCE(expires_at, claimed_at + INTERVAL '10 minutes'),
       fence       = COALESCE(fence, nextval('coordination_fence_seq')),
       lease_class = COALESCE(lease_class, 'file')
 WHERE expires_at IS NULL OR fence IS NULL OR lease_class IS NULL;

COMMIT;
