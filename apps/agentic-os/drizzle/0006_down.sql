-- Rollback for 0006_lane_dep.sql. Drizzle has no down migrations, so this
-- file is documentation and a runnable rollback. It is NOT in meta/_journal.json.
-- Run it in ONE transaction, like the migrator does (SET LOCAL needs one).
--
-- ORDER: revert the gate-2 code on main FIRST (the code that reads and writes lane_dep),
-- then run this file. Code that names lane_dep fails once the table is gone.
--
-- DATA LOSS WARNING: dropping the table discards every dependency edge. The lane rows
-- themselves stay. A seed from the Waves table restores the edges.
-- Drizzle's own journal row for 0006 in agentic_os.__migrations must be removed
-- by hand if you want `drizzle-kit migrate` to apply 0006 again.
-- To re-apply with the scratch tool: node scripts/coordination/scratch-db.mjs migrate <url> 6
--
-- Result: the schema matches 0005. The drop removes the key and the CHECK with the table.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP TABLE IF EXISTS agentic_os.lane_dep;
