-- IF NOT EXISTS added by hand. drizzle-kit creates this schema itself before
-- running migrations, because drizzle.config.ts sets migrations.schema to
-- 'agentic_os' (it must, since the default journal location is owned by another
-- application). Without IF NOT EXISTS the first migration always fails with
-- "schema agentic_os already exists". Re-apply this edit if 0000 is regenerated.
CREATE SCHEMA IF NOT EXISTS "agentic_os";
--> statement-breakpoint
CREATE TABLE "agentic_os"."project" (
	"key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"root_path" text NOT NULL,
	"root_path_norm" text NOT NULL,
	"project_id_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"stack" jsonb DEFAULT '[]'::jsonb,
	"port" integer,
	"url" text,
	"description" text,
	"registry_source" text,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agentic_os"."project_alias" (
	"raw" text PRIMARY KEY NOT NULL,
	"project_key" text,
	"source" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "agentic_os"."project_alias" ADD CONSTRAINT "project_alias_project_key_project_key_fk" FOREIGN KEY ("project_key") REFERENCES "agentic_os"."project"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_root_path_norm_idx" ON "agentic_os"."project" USING btree ("root_path_norm");--> statement-breakpoint
CREATE INDEX "project_id_hash_idx" ON "agentic_os"."project" USING btree ("project_id_hash");--> statement-breakpoint
CREATE INDEX "project_alias_project_key_idx" ON "agentic_os"."project_alias" USING btree ("project_key");