SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP INDEX "agentic_os"."lane_track_priority_idx";--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "project_key" text DEFAULT 'continuous-claude' NOT NULL;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane_event" ADD COLUMN "project_key" text DEFAULT 'continuous-claude' NOT NULL;--> statement-breakpoint
CREATE INDEX "lane_project_state_priority_idx" ON "agentic_os"."lane" USING btree ("project_key","state","priority","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_project_id_uniq" ON "agentic_os"."lane" USING btree ("project_key","id");--> statement-breakpoint
CREATE INDEX "lane_event_project_id_idx" ON "agentic_os"."lane_event" USING btree ("project_key","id");--> statement-breakpoint
CREATE INDEX "lane_track_priority_idx" ON "agentic_os"."lane" USING btree ("project_key","track","priority");--> statement-breakpoint
-- Everything above is drizzle-kit output. Everything below is added by hand.
-- Re-apply this block if 0004 is regenerated.
--
-- T3 fence. A lane.mjs copy that predates per-project boards never sets
-- lane.client_version. It keeps working on CCv3 lanes, but it cannot change or
-- delete a lane that belongs to another board. The setting is a cooperative flag,
-- not a security boundary: any writer can set it. New lane.mjs runs
-- SET LOCAL lane.client_version = '2' in every write transaction.
-- OLD.project_key is checked: a DELETE has no NEW row.
CREATE OR REPLACE FUNCTION agentic_os.lane_guard_foreign_board() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_key <> 'continuous-claude'
     AND coalesce(current_setting('lane.client_version', true), '') = '' THEN
    RAISE EXCEPTION 'lane % belongs to board %: this lane.mjs predates per-project boards; rebase the worktree onto main', OLD.id, OLD.project_key
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS lane_guard_foreign_board ON agentic_os.lane;--> statement-breakpoint
CREATE TRIGGER lane_guard_foreign_board BEFORE UPDATE OR DELETE ON agentic_os.lane FOR EACH ROW EXECUTE FUNCTION agentic_os.lane_guard_foreign_board();
