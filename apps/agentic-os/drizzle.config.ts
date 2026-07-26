import { defineConfig } from 'drizzle-kit';

/**
 * SAFETY-CRITICAL CONFIG. Read before changing anything here.
 *
 * This app shares one PostgreSQL database with three unrelated applications
 * (Fourth Canvas, the ai-reporting MCP server, vibe-trading). There are 40 tables
 * in `public`, only 6 of which belong to Continuous Claude, and NONE of which are
 * managed by this project.
 *
 * Three non-negotiables:
 *
 * 1. `schemaFilter` restricts drizzle-kit to the `agentic_os` schema. Without it,
 *    drizzle-kit sees 40 unmanaged tables and can emit DROP TABLE for all of them.
 *
 * 2. `migrations.schema`/`table` are overridden. The default location
 *    (`drizzle.__drizzle_migrations`) ALREADY EXISTS in this database and is owned
 *    by a different application. Writing there would corrupt their journal.
 *
 * 3. NEVER run `drizzle-kit push`. It diffs against the live database and is the
 *    command that can actually destroy the other applications' tables. Only
 *    `generate` (which diffs against our own snapshots) then `migrate`, and only
 *    after reading the generated SQL. `npm run db:check` enforces this.
 *
 * Note also: `public` table declarations deliberately live OUTSIDE this glob, in
 * src/db/readonly/, because drizzle table declarations are NOT inert to drizzle-kit
 * even when schema-filtered.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  schemaFilter: ['agentic_os'],
  migrations: {
    schema: 'agentic_os',
    table: '__migrations',
  },
  dbCredentials: {
    url: process.env.AGENTIC_OS_DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
