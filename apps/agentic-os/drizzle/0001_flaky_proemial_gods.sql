CREATE TABLE "agentic_os"."coordination_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"session_id" text NOT NULL,
	"project" text,
	"file_path" text,
	"holder_session_id" text,
	"tool_name" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "coordination_event_occurred_at_idx" ON "agentic_os"."coordination_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "coordination_event_kind_idx" ON "agentic_os"."coordination_event" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "coordination_event_session_idx" ON "agentic_os"."coordination_event" USING btree ("session_id");