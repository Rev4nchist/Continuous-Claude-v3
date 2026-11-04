-- Rollback for 0004_per_project_lanes.sql. Drizzle has no down migrations, so this
-- file is documentation and a runnable rollback. It is NOT in meta/_journal.json.
-- Run it in ONE transaction, like the migrator does (SET LOCAL needs one).
--
-- DATA LOSS WARNING: dropping project_key discards which board each lane and
-- event belonged to. Rows for any board other than 'continuous-claude' then look
-- like CCv3 lanes. Back up agentic_os.lane and agentic_os.lane_event first if a
-- second board has been registered.
-- Drizzle's own journal row for 0004 in agentic_os.__migrations must be removed
-- by hand if you want `drizzle-kit migrate` to apply 0004 again.
--
-- Result: the schema matches 0003 (lane_track_priority_idx on (track, priority)).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP TRIGGER IF EXISTS lane_guard_foreign_board ON agentic_os.lane;--> statement-breakpoint
DROP FUNCTION IF EXISTS agentic_os.lane_guard_foreign_board();--> statement-breakpoint
DROP INDEX IF EXISTS agentic_os.lane_event_project_id_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agentic_os.lane_project_id_uniq;--> statement-breakpoint
DROP INDEX IF EXISTS agentic_os.lane_project_state_priority_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agentic_os.lane_track_priority_idx;--> statement-breakpoint
ALTER TABLE agentic_os.lane_event DROP COLUMN IF EXISTS project_key;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS project_key;--> statement-breakpoint
CREATE INDEX lane_track_priority_idx ON agentic_os.lane USING btree (track, priority);
