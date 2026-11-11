SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "agentic_os"."lane_dep" (
	"lane_id" text NOT NULL,
	"depends_on" text NOT NULL,
	"project_key" text NOT NULL,
	CONSTRAINT "lane_dep_pkey" PRIMARY KEY("lane_id","depends_on"),
	CONSTRAINT "lane_dep_no_self_check" CHECK ("agentic_os"."lane_dep"."lane_id" <> "agentic_os"."lane_dep"."depends_on")
);
-- Everything above is drizzle-kit output (plus the SET LOCAL lock_timeout on line 1). Re-apply that line if 0006 is regenerated.
-- Expand-only. One new table and nothing else: no existing table, column or index changes.
-- No foreign key, so this takes no lock on lane or lane_event. A dependency on an id with no lane row must count as open, and a foreign key would refuse that row.
-- No IF NOT EXISTS, as in 0004 and 0005: the drizzle journal applies a file once, and a silent skip would hide a table of the wrong shape.
-- No default on project_key on purpose: a writer that forgets the board must fail at once (23502).
-- Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, point 1.
