CREATE TABLE "agentic_os"."lane" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"track" text DEFAULT 'unsorted' NOT NULL,
	"scope" text,
	"branch" text,
	"state" text DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"owner_session_id" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"fence" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentic_os"."lane_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lane_id" text,
	"kind" text NOT NULL,
	"session_id" text NOT NULL,
	"to_session_id" text,
	"body" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentic_os"."lane_watermark" (
	"session_id" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lane_state_idx" ON "agentic_os"."lane" USING btree ("state");--> statement-breakpoint
CREATE INDEX "lane_owner_idx" ON "agentic_os"."lane" USING btree ("owner_session_id");--> statement-breakpoint
CREATE INDEX "lane_track_priority_idx" ON "agentic_os"."lane" USING btree ("track","priority");--> statement-breakpoint
CREATE INDEX "lane_event_occurred_at_idx" ON "agentic_os"."lane_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "lane_event_lane_idx" ON "agentic_os"."lane_event" USING btree ("lane_id");--> statement-breakpoint
CREATE INDEX "lane_event_to_session_idx" ON "agentic_os"."lane_event" USING btree ("to_session_id");