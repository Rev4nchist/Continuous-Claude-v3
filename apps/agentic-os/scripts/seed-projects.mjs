#!/usr/bin/env node
/**
 * Seeds `agentic_os.project` from ../../.claude/project-registry.json and
 * `agentic_os.project_alias` from ./project-aliases.json.
 *
 * Connects with AGENTIC_OS_INDEXER_DATABASE_URL — NOT AGENTIC_OS_DATABASE_URL.
 * `agentic_os_app` (the app's own connection string) is SELECT-only by design;
 * the indexer role holds DML on `agentic_os` (plus SELECT on the shared
 * `public` tables this script reads, e.g. `sessions`).
 *
 * Order is load-bearing: projects BEFORE aliases, in ONE transaction —
 * `project_alias.project_key` is a real FK, so a bad key fails the seed
 * rather than corrupting silently.
 *
 * `--dry-run` runs every assert and the full upsert/insert logic, then rolls
 * back instead of committing, so the printed summary reflects exactly what
 * WOULD happen with no writes actually landing.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// apps/agentic-os/.env.local — hand-parsed, no dotenv dependency. Next.js
// loads this file automatically for the app itself; this script runs outside
// Next, so it has to do the (trivial) parsing itself.
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  const envPath = join(__dirname, '..', '.env.local');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return; // fine if the vars are already exported in the environment
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

const connectionString = process.env.AGENTIC_OS_INDEXER_DATABASE_URL;
if (!connectionString) {
  console.error(
    '[seed-projects] AGENTIC_OS_INDEXER_DATABASE_URL is not set.\n' +
      'Expected it in apps/agentic-os/.env.local. This seeder deliberately does NOT fall back\n' +
      'to AGENTIC_OS_DATABASE_URL: that role (agentic_os_app) is SELECT-only by design and\n' +
      'cannot perform the writes this script makes.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the two data sources.
// ---------------------------------------------------------------------------

/**
 * Mirrors `normalizeProjectKey` in .claude/hooks/src/shared/session-id.ts:213
 * (backslash -> forward slash, strip trailing separator, lowercase). Reimplemented
 * inline rather than imported or extracted to a shared module: aliases are keyed
 * on exact raw `sessions.project` values, so there is no second consumer here,
 * and a second copy that can drift from the hooks-side original is a liability,
 * not reuse.
 */
function normalizeProjectKey(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

const registryPath = join(__dirname, '..', '..', '..', '.claude', 'project-registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

const aliasesPath = join(__dirname, 'project-aliases.json');
const aliasRows = JSON.parse(readFileSync(aliasesPath, 'utf8'));

const projects = registry.projects.map((p) => ({
  key: slugify(p.name),
  displayName: p.name,
  rootPath: p.path,
  rootPathNorm: normalizeProjectKey(p.path),
  status: p.status ?? 'active',
  stack: Array.isArray(p.stack) ? p.stack : [],
  port: typeof p.port === 'number' ? p.port : null,
  url: p.url ?? null,
  description: p.description ?? null,
  registrySource: 'project-registry.json',
}));

const projectKeys = new Set(projects.map((p) => p.key));

// ---------------------------------------------------------------------------
// Pre-flight asserts. Every one of these must fail loudly and abort BEFORE
// any write. See the approved plan for why each is load-bearing.
// ---------------------------------------------------------------------------

function assertNoDuplicateRaw() {
  const raws = aliasRows.map((r) => r.raw);
  const uniq = new Set(raws);
  if (uniq.size !== raws.length) {
    // `raw` is project_alias's primary key: a duplicate in the file would not
    // error at insert time, it would silently DEDUP, and one of the two
    // mappings would quietly win while the identity layer still looked balanced.
    const seen = new Set();
    const dupes = [];
    for (const r of raws) {
      if (seen.has(r)) dupes.push(r);
      seen.add(r);
    }
    throw new Error(
      `project-aliases.json has ${raws.length - uniq.size} duplicate "raw" value(s): ` +
        `${JSON.stringify(dupes)}`,
    );
  }
}

async function assertRawSetMatchesDb(pool) {
  const { rows } = await pool.query('SELECT DISTINCT project FROM public.sessions');
  const dbRaws = new Set(rows.map((r) => r.project));
  const fileRaws = new Set(aliasRows.map((r) => r.raw));

  const inFileNotDb = [...fileRaws].filter((r) => !dbRaws.has(r));
  const inDbNotFile = [...dbRaws].filter((r) => !fileRaws.has(r));

  if (inFileNotDb.length || inDbNotFile.length) {
    throw new Error(
      'project-aliases.json raw set does not exactly equal SELECT DISTINCT project FROM sessions.\n' +
        `  in file but not in DB (${inFileNotDb.length}): ${JSON.stringify(inFileNotDb)}\n` +
        `  in DB but not in file (${inDbNotFile.length}): ${JSON.stringify(inDbNotFile)}\n` +
        'A raw value in the file that no longer exists in the DB is a typo, not history.',
    );
  }
}

function assertNoteRequiredWhenUnmapped() {
  const bad = aliasRows.filter((r) => r.projectKey === null && !r.note);
  if (bad.length) {
    throw new Error(
      `${bad.length} alias row(s) have projectKey=null but no note: ` +
        JSON.stringify(bad.map((r) => r.raw)),
    );
  }
}

function assertProjectKeysExist() {
  const bad = aliasRows.filter((r) => r.projectKey !== null && !projectKeys.has(r.projectKey));
  if (bad.length) {
    throw new Error(
      `${bad.length} alias row(s) reference a projectKey not in project-registry.json: ` +
        JSON.stringify(bad.map((r) => ({ raw: r.raw, projectKey: r.projectKey }))),
    );
  }
}

// ---------------------------------------------------------------------------
// Seed.
// ---------------------------------------------------------------------------

async function main() {
  assertNoDuplicateRaw();
  assertNoteRequiredWhenUnmapped();
  assertProjectKeysExist();

  const pool = new Pool({ connectionString, application_name: 'agentic-os-seed-projects' });

  try {
    await assertRawSetMatchesDb(pool);

    const client = await pool.connect();
    let projectsInserted = 0;
    let projectsUpdated = 0;
    let aliasesInserted = 0;
    let aliasesSkipped = 0;

    try {
      await client.query('BEGIN');

      // Projects BEFORE aliases — project_alias.project_key is a real FK.
      for (const p of projects) {
        const { rows } = await client.query(
          `INSERT INTO agentic_os.project
             (key, display_name, root_path, root_path_norm, status, stack, port, url, description, registry_source)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
           ON CONFLICT (key) DO UPDATE SET
             display_name    = EXCLUDED.display_name,
             root_path        = EXCLUDED.root_path,
             root_path_norm   = EXCLUDED.root_path_norm,
             status           = EXCLUDED.status,
             stack            = EXCLUDED.stack,
             port             = EXCLUDED.port,
             url              = EXCLUDED.url,
             description      = EXCLUDED.description,
             registry_source  = EXCLUDED.registry_source
           -- project_id_hash, first_seen_at, last_seen_at are deliberately NOT in
           -- this SET list: they are not registry-sourced fields, and re-running
           -- the seed must never clobber a value set later by another process.
           RETURNING (xmax = 0) AS inserted`,
          [
            p.key,
            p.displayName,
            p.rootPath,
            p.rootPathNorm,
            p.status,
            JSON.stringify(p.stack),
            p.port,
            p.url,
            p.description,
            p.registrySource,
          ],
        );
        if (rows[0]?.inserted) projectsInserted += 1;
        else projectsUpdated += 1;
      }

      // Aliases — ON CONFLICT (raw) DO NOTHING, deliberately NOT DO UPDATE.
      // A wrong mapping is fixed by an UPDATE run directly against the DB; an
      // upserting seeder would clobber that hand-fix the next time this runs.
      for (const row of aliasRows) {
        const { rows } = await client.query(
          `INSERT INTO agentic_os.project_alias (raw, project_key, source, confidence, note)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (raw) DO NOTHING
           RETURNING raw`,
          [row.raw, row.projectKey, 'sessions.project', row.confidence, row.note],
        );
        if (rows.length > 0) aliasesInserted += 1;
        else aliasesSkipped += 1;
      }

      if (DRY_RUN) {
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const confidenceBreakdown = aliasRows.reduce((acc, r) => {
      const k = String(r.confidence);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    console.log(`[seed-projects]${DRY_RUN ? ' (dry run — rolled back, no writes applied)' : ''}`);
    console.log(`  projects:  ${projectsInserted} inserted, ${projectsUpdated} updated (of ${projects.length} total)`);
    console.log(`  aliases:   ${aliasesInserted} inserted, ${aliasesSkipped} already present (of ${aliasRows.length} total)`);
    console.log(`  confidence breakdown: ${JSON.stringify(confidenceBreakdown)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed-projects] FAILED:', err.message);
  process.exit(1);
});
