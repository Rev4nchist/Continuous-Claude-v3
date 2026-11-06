-- Rollback for 0005_lane_reminders.sql. Drizzle has no down migrations, so this
-- file is documentation and a runnable rollback. It is NOT in meta/_journal.json.
-- Run it in ONE transaction, like the migrator does (SET LOCAL needs one).
--
-- DATA LOSS WARNING: dropping the columns discards every reminder (due time,
-- priority, state, fired time, action id and the Notion page link). The lane rows
-- themselves stay. A Notion row that was already created is not touched, but it
-- loses its link to the lane. Back up agentic_os.lane first if a reminder is open.
-- Drizzle's own journal row for 0005 in agentic_os.__migrations must be removed
-- by hand if you want `drizzle-kit migrate` to apply 0005 again.
--
-- Result: the schema matches 0004.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP INDEX IF EXISTS agentic_os.lane_due_idx;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP CONSTRAINT IF EXISTS lane_remind_state_check;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP CONSTRAINT IF EXISTS lane_band_check;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS notion_synced_at;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS notion_page_id;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS action_id;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS fired_at;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS remind_state;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS band;--> statement-breakpoint
ALTER TABLE agentic_os.lane DROP COLUMN IF EXISTS due_at;
