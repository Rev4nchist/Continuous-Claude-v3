/**
 * Barrel for the `agentic_os` schema.
 *
 * TWO RULES, both load-bearing.
 *
 * 1. THIS FILE IS INSIDE DRIZZLE-KIT'S GLOB. `drizzle.config.ts` globs
 *    `./src/db/schema/*.ts`, so anything re-exported here is a table drizzle-kit
 *    will try to MANAGE. Never re-export `../readonly/public.js` from this file.
 *    Those are typed views of tables owned by three other applications, and
 *    Drizzle table declarations are NOT inert to drizzle-kit even when
 *    schema-filtered — pulling them into this glob is how you get generated SQL
 *    that touches `public`. The app-side composition of both lives in
 *    `src/db/index.ts`, which drizzle-kit never reads.
 *
 * 2. THE FILES BELOW ARE HAND-WRITTEN AND CARRY THEIR DESIGN RATIONALE IN THEIR
 *    COMMENTS. `lane.ts` in particular is LIVE COORDINATION INFRASTRUCTURE — it
 *    is the board that concurrent sessions on this branch claim work through.
 *    Regenerating `src/db/schema/` wholesale from a scaffold tool destroys it and
 *    takes the board down for every running session. Add to this barrel; never
 *    rewrite what it points at.
 */

// Extensionless specifiers are REQUIRED here, not stylistic. tsconfig uses
// moduleResolution "bundler": it rewrites './project.js' to './project.ts' so
// `tsc --noEmit` passes, but Turbopack does not, and the app 500s at runtime
// with "Module not found". A .js extension in this directory is a bug that
// type-checking cannot catch.
export { agenticOs, project, projectAlias } from './project';
export { LANE_STATES, lane, laneEvent, laneWatermark } from './lane';
export { coordinationEvent } from './coordination-event';
