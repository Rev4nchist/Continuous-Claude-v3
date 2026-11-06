SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "band" text;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "remind_state" text;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "action_id" text;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "notion_page_id" text;--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD COLUMN "notion_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "lane_due_idx" ON "agentic_os"."lane" USING btree ("project_key","due_at") WHERE "agentic_os"."lane"."due_at" IS NOT NULL AND "agentic_os"."lane"."state" <> 'done';--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD CONSTRAINT "lane_band_check" CHECK ("agentic_os"."lane"."band" IN ('P0','P1','P2'));--> statement-breakpoint
ALTER TABLE "agentic_os"."lane" ADD CONSTRAINT "lane_remind_state_check" CHECK ("agentic_os"."lane"."remind_state" IN ('scheduled','due','needs_dave','failed','acked'));
-- Everything above is drizzle-kit output (plus the SET LOCAL lock_timeout on line 1). Re-apply that line if 0005 is regenerated.
-- Expand-only. The seven columns are nullable with no default, so ADD COLUMN changes the catalog and rewrites nothing.
-- The index is non-concurrent on purpose: the migrator runs this file in one transaction, and CONCURRENTLY cannot.
-- It is partial (open reminders only), so the build scans the lane table once and stores almost nothing.
