-- 002 -- G5: delete the pre-identity-fix `s-*` session rows.
--
-- DO NOT RUN THIS WITHOUT READING THE PRECONDITIONS BELOW.
-- It is destructive, it is NOT urgent, and it is cosmetic: these rows own
-- nothing and block nothing. The only thing they cost is that every query
-- against `sessions` reads 1,479 rows of noise.
--
-- WHAT THESE ROWS ARE
-- -------------------
-- Before commit ca1a16e (2026-07-26 15:38 local), session-register.ts called
-- generateSessionId() and wrote an `s-<base36>` row at session start, while
-- heartbeat.ts registered the payload id. Every session produced TWO rows, and
-- the `s-*` one never heartbeat again -- its last_heartbeat is byte-identical to
-- its started_at, which is the signature to look for.
--
-- VERIFIED BEFORE WRITING THIS (2026-07-26 20:5x local):
--   - 1,479 rows match `id LIKE 's-%'`.
--   - They own ZERO file_claims (join against file_claims returns 0).
--   - ZERO have a heartbeat inside the 5-minute liveness window.
--   - The newest was created 14:33 local, 65 minutes BEFORE the fix landed at
--     15:38. Nothing has created one since, so this does not grow back.
--
-- THE ONE WAY IT COULD GROW BACK
-- ------------------------------
-- session-start-parallel.ts still contains the original generateSessionId()
-- call. It is NOT registered in either settings.json today, so it is dead code
-- -- but registering it would reinstate the split. Check that before assuming a
-- reappearing `s-*` row means this migration failed.

BEGIN;

-- Preconditions, enforced rather than trusted. Any of these firing aborts the
-- whole transaction and changes nothing -- which is the point: the assertions
-- were all true when this was written, and if one is false now then the
-- situation is not the one this migration was designed for.
DO $$
DECLARE
  owned   BIGINT;
  live    BIGINT;
  renewed BIGINT;
BEGIN
  SELECT count(*) INTO owned
    FROM file_claims fc JOIN sessions s ON s.id = fc.session_id
   WHERE s.id LIKE 's-%';
  IF owned <> 0 THEN
    RAISE EXCEPTION 'ABORT: % file_claims are owned by s-* sessions. They were '
      'supposed to own none -- investigate before deleting their owners.', owned;
  END IF;

  SELECT count(*) INTO live
    FROM sessions WHERE id LIKE 's-%'
      AND last_heartbeat > NOW() - INTERVAL '5 minutes';
  IF live <> 0 THEN
    RAISE EXCEPTION 'ABORT: % s-* sessions are inside the liveness window. '
      'Something is writing them again -- check session-start-parallel.ts.', live;
  END IF;

  -- The defining property: these rows never heartbeat after creation. A row
  -- where the two differ was renewed by something, which means it is not the
  -- kind of row this migration is about.
  SELECT count(*) INTO renewed
    FROM sessions WHERE id LIKE 's-%' AND last_heartbeat <> started_at;
  IF renewed <> 0 THEN
    RAISE EXCEPTION 'ABORT: % s-* sessions were renewed after creation, so they '
      'are not the unrenewable pre-fix rows this migration targets.', renewed;
  END IF;
END $$;

DELETE FROM sessions WHERE id LIKE 's-%';

COMMIT;
