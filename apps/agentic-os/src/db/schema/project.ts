import { pgSchema, text, integer, timestamp, jsonb, real, index } from 'drizzle-orm/pg-core';

/**
 * Every table in this app lives in the `agentic_os` schema. Nothing is ever
 * declared in `public` here — see src/db/readonly/ for typed views of the
 * shared tables we only read.
 */
export const agenticOs = pgSchema('agentic_os');

/**
 * Canonical project identity. This is the hub every other table joins through.
 *
 * `projectIdHash` is the load-bearing one: it is sha256(absolute_path)[:16] as
 * computed by opc/scripts/core/project_memory.py:85, and it is the ONLY reliable
 * join to `public.archival_memory`. Verified against live data:
 *   sha256(r'C:\Users\david.hayes\continuous-claude')[:16] == 'addc92d926988bb9'
 */
export const project = agenticOs.table(
  'project',
  {
    key: text('key').primaryKey(),
    displayName: text('display_name').notNull(),
    rootPath: text('root_path').notNull(),
    /** lowercased, forward-slashed, no trailing slash — the join form */
    rootPathNorm: text('root_path_norm').notNull(),
    projectIdHash: text('project_id_hash'),
    status: text('status').notNull().default('active'),
    stack: jsonb('stack').$type<string[]>().default([]),
    port: integer('port'),
    url: text('url'),
    description: text('description'),
    registrySource: text('registry_source'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    index('project_root_path_norm_idx').on(t.rootPathNorm),
    index('project_id_hash_idx').on(t.projectIdHash),
  ],
);

/**
 * Maps the distinct raw `public.sessions.project` values onto ~19 real projects.
 * Backslash and forward-slash variants of the same path, trailing slashes,
 * subdirectories, git worktrees and synthetic stress-test rows all collapse here.
 * (`continuous-claude` alone arrives in four spellings differing only by slash
 * direction, case and a trailing slash.)
 *
 * The count is deliberately NOT stated here. It was written as "111", and by the
 * time anyone acted on it the live figure was 115 — a number in a comment is a
 * snapshot that nothing ages out, and this file is read by people deciding
 * whether the seed data is complete. The authoritative count is
 * `SELECT count(DISTINCT project) FROM sessions`, and the seeder asserts that the
 * seed file's raw set matches it EXACTLY in both directions, so drift fails loudly
 * instead of being silently absorbed.
 *
 * This is DATA, not code, deliberately: a wrong mapping is an UPDATE, not a
 * redeploy. Rows are seeded by hand rather than trusted to a normalizer, because a
 * confidently-wrong fleet grid is worse than an obviously-incomplete one. Anything
 * unmatched stays unmatched and is surfaced in the UI.
 *
 * `confidence` carries the REVIEW DECISION, not just a score — 1.0 mapped,
 * 0.5 reviewed and a real project but not yet in the registry, 0.0 reviewed and
 * rejected (temp dirs, installer paths, the user's home). A bare NULL
 * `project_key` would conflate the last two, and they need opposite follow-up.
 */
export const projectAlias = agenticOs.table(
  'project_alias',
  {
    raw: text('raw').primaryKey(),
    projectKey: text('project_key').references(() => project.key),
    /** where this alias was observed: sessions.project | transcript.cwd | registry */
    source: text('source').notNull(),
    confidence: real('confidence').notNull().default(1),
    note: text('note'),
  },
  (t) => [index('project_alias_project_key_idx').on(t.projectKey)],
);
