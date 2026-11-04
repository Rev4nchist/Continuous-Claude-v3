#!/usr/bin/env node
/**
 * scratch-db -- create, migrate, seed and drop a THROWAWAY database on the
 * local server, so a schema migration can be proven without touching the live
 * database (continuous_claude), which running sessions use.
 *
 *   node scratch-db.mjs create [--through <n>]   make lanes_pr1_<8hex>, print {url,name}
 *   node scratch-db.mjs migrate <url> <n>        apply drizzle file number n
 *   node scratch-db.mjs down    <url> <n>        run drizzle/000n_down.sql (rollback)
 *   node scratch-db.mjs seed    <url>            insert a few lanes, sessions, events
 *   node scratch-db.mjs drop    <url>            DROP DATABASE ... WITH (FORCE)
 *
 * SAFETY. Every command except `create` refuses a URL whose database name does
 * not start with `lanes_pr1_`. `create` never writes to any existing database:
 * it connects to the `postgres` maintenance database only to run CREATE
 * DATABASE, then connects to the new database. Nothing here reads the lane.mjs
 * database, and nothing here ever calls `drizzle-kit push`.
 *
 * `create` applies, in order: docker/init-schema.sql, scripts/coordination/
 * migrations/001..003, then the drizzle migrations listed in meta/_journal.json
 * up to `--through` (default 3). Migration 0004 is applied only with
 * `--through 4`. Files are taken from the journal, so 0004_down.sql is never
 * applied by accident.
 *
 * Each drizzle file runs the way drizzle's migrator runs it: one transaction,
 * split on `--> statement-breakpoint`. That matters: `SET LOCAL` has no effect
 * outside a transaction.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DRIZZLE_DIR = join(REPO, 'apps', 'agentic-os', 'drizzle');
const PREFIX = 'lanes_pr1_';
const NAME_RE = /^lanes_pr1_[a-z0-9_]+$/;

/** Same lookup as lane.mjs: `pg` lives in the hooks bundle or apps/agentic-os. */
function loadPg() {
  const anchors = [
    join(REPO, '.claude', 'hooks', 'package.json'),
    join(REPO, 'apps', 'agentic-os', 'package.json'),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(pathToFileURL(anchor)).call(null, 'pg');
    } catch { /* try the next anchor */ }
  }
  throw new Error('cannot resolve the `pg` module. Run `npm install` in .claude/hooks or apps/agentic-os.');
}

/** The server to create scratch databases on: same env chain as lane.mjs. */
function baseConnString() {
  return process.env.CONTINUOUS_CLAUDE_DB_URL
    || process.env.DATABASE_URL
    || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

/** Database name of a connection URL, or '' when it has none. */
export function dbNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/** Throw unless the URL points at a scratch database. Call before any write. */
export function assertScratchUrl(url) {
  const name = dbNameOf(url);
  if (!name.startsWith(PREFIX) || !NAME_RE.test(name)) {
    throw new Error(`refusing: database name '${name}' does not start with '${PREFIX}'`);
  }
  return name;
}

/** Hide the password in a URL before it goes to a log. The stdout JSON of `create` keeps the real URL by contract. */
export const maskUrl = (url) => String(url).replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@');

const urlWithDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

async function withClient(url, fn) {
  const { Client } = loadPg();
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

/** Send a whole file as one simple-protocol query (DO blocks and BEGIN/COMMIT stay intact). */
async function runWholeFile(c, label, path) {
  try {
    await c.query(readFileSync(path, 'utf8'));
    console.error(`  applied ${label}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw new Error(`${label} failed: ${e.message}${e.position ? ` (position ${e.position})` : ''}`);
  }
}

function journalTags() {
  const j = JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'));
  return j.entries.map((e) => e.tag);
}

const fileFor = (n) => {
  const tag = journalTags().find((t) => Number(t.slice(0, 4)) === n);
  if (!tag) throw new Error(`no drizzle migration numbered ${n} in meta/_journal.json`);
  return { tag, path: join(DRIZZLE_DIR, `${tag}.sql`) };
};

/** Run a drizzle SQL file as drizzle's migrator does: one transaction, split on the breakpoint marker. */
async function runDrizzleFile(c, label, path) {
  const chunks = readFileSync(path, 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
  await c.query('BEGIN');
  try {
    for (const chunk of chunks) await c.query(chunk);
    await c.query('COMMIT');
    console.error(`  applied ${label} (${chunks.length} statements)`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw new Error(`${label} failed and was rolled back: ${e.message}`);
  }
}

/** Minimal DDL lane.mjs needs: the fence sequence, sessions and file_claims. Mirrors docker/init-schema.sql. */
export const MINIMAL_INIT = `
CREATE SEQUENCE IF NOT EXISTS coordination_fence_seq AS BIGINT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, working_on TEXT,
  started_at TIMESTAMP DEFAULT NOW(), last_heartbeat TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP, memory_extracted_at TIMESTAMP, ended_at TIMESTAMP, end_reason TEXT);
CREATE TABLE IF NOT EXISTS file_claims (
  file_path TEXT NOT NULL, project TEXT NOT NULL, session_id TEXT, claimed_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '10 minutes', fence BIGINT DEFAULT nextval('coordination_fence_seq'),
  lease_class TEXT DEFAULT 'file', PRIMARY KEY (file_path, project));`;

/** Apply init-schema.sql whole. If it fails (for example the pgvector extension is missing), say so loudly and
 *  apply only what lane.mjs needs. The failure is never hidden. */
async function applyInitSchema(c) {
  try {
    await runWholeFile(c, 'docker/init-schema.sql', join(REPO, 'docker', 'init-schema.sql'));
  } catch (e) {
    console.error(`WARNING: ${e.message}
  Falling back to the minimal schema (sessions, file_claims, coordination_fence_seq). Optional tables are NOT created.`);
    await c.query(MINIMAL_INIT);
    console.error('  applied minimal init schema');
  }
}

async function cmdCreate(through) {
  const name = `${PREFIX}${randomBytes(4).toString('hex')}`;
  assertScratchUrl(urlWithDb(baseConnString(), name));
  const url = urlWithDb(baseConnString(), name);
  console.error(`creating scratch database ${name} on ${new URL(url).host}`);
  await withClient(urlWithDb(baseConnString(), 'postgres'), (c) => c.query(`CREATE DATABASE "${name}"`));
  await withClient(url, async (c) => {
    await applyInitSchema(c);
    for (const f of ['001-file-claims-leases.sql', '002-g5-drop-orphan-sessions.sql', '003-sessions-lifecycle.sql']) {
      await runWholeFile(c, `coordination/migrations/${f}`, join(HERE, 'migrations', f));
    }
    for (const tag of journalTags()) {
      if (Number(tag.slice(0, 4)) <= through) await runDrizzleFile(c, `drizzle/${tag}.sql`, join(DRIZZLE_DIR, `${tag}.sql`));
    }
  });
  console.log(JSON.stringify({ url, name }));
}

async function cmdMigrate(url, n) {
  assertScratchUrl(url);
  console.error(`target: ${maskUrl(url)}`);
  const { tag, path } = fileFor(n);
  await withClient(url, (c) => runDrizzleFile(c, `drizzle/${tag}.sql`, path));
}

async function cmdDown(url, n) {
  assertScratchUrl(url);
  console.error(`target: ${maskUrl(url)}`);
  const { tag } = fileFor(n);
  await withClient(url, (c) => runDrizzleFile(c, `drizzle/${tag.slice(0, 4)}_down.sql`, join(DRIZZLE_DIR, `${tag.slice(0, 4)}_down.sql`)));
}

/** Eight lanes on two tracks, two sessions, a few events and watermark rows. Works before and after 0004. */
async function cmdSeed(url) {
  assertScratchUrl(url);
  console.error(`target: ${maskUrl(url)}`);
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO public.sessions (id, project, working_on, last_heartbeat)
        VALUES ('zz-seed-sa','c:/users/dkhay/continuous-claude','seed a', now()),
               ('zz-seed-sb','c:/users/dkhay/continuous-claude','seed b', now() - interval '2 hours')`);
      const lanes = [
        ['seed-harness-1', 'harness', 'ready', 10], ['seed-harness-2', 'harness', 'backlog', 20],
        ['seed-harness-3', 'harness', 'active', 30], ['seed-harness-4', 'harness', 'done', 40],
        ['seed-agentic-1', 'agentic-os', 'ready', 10], ['seed-agentic-2', 'agentic-os', 'blocked', 20],
        ['seed-agentic-3', 'agentic-os', 'review', 30], ['seed-agentic-4', 'agentic-os', 'backlog', 40],
      ];
      for (const [id, track, state, priority] of lanes) {
        const owner = state === 'active' ? 'zz-seed-sa' : null;
        await c.query(
          `INSERT INTO agentic_os.lane (id, title, track, state, priority, owner_session_id, claimed_at, lease_expires_at, fence)
           VALUES ($1, $2, $3, $4, $5, $6::text, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
                   CASE WHEN $6::text IS NULL THEN NULL ELSE now() + interval '90 minutes' END, CASE WHEN $6::text IS NULL THEN 0 ELSE 1 END)`,
          [id, `Seed lane ${id}`, track, state, priority, owner],
        );
      }
      const ev = [
        ['seed-harness-3', 'claimed', 'zz-seed-sa', null, 'claimed'],
        [null, 'note', 'zz-seed-sa', null, 'broadcast from a'],
        [null, 'note', 'zz-seed-sb', 'zz-seed-sa', 'direct message b to a'],
        ['seed-agentic-1', 'state_changed', 'zz-seed-sb', null, 'ready'],
        ['seed-harness-4', 'done', 'zz-seed-sb', null, 'done'],
      ];
      for (const [laneId, kind, sid, to, body] of ev) {
        await c.query('INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body) VALUES ($1,$2,$3,$4,$5)', [laneId, kind, sid, to, body]);
      }
      await c.query(`INSERT INTO agentic_os.lane_watermark (session_id, last_event_id) VALUES ('zz-seed-sa', 2), ('zz-seed-sb', 0)`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
    const n = (await c.query('SELECT count(*)::int AS n FROM agentic_os.lane')).rows[0].n;
    console.log(JSON.stringify({ seeded_lanes: n }));
  });
}

async function cmdDrop(url) {
  const name = assertScratchUrl(url);
  console.error(`dropping ${name}`);
  await withClient(urlWithDb(url, 'postgres'), (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  console.log(JSON.stringify({ dropped: name }));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'create': {
      const i = rest.indexOf('--through');
      const through = i >= 0 ? Number(rest[i + 1]) : 3;
      if (!Number.isInteger(through) || through < 0) throw new Error('--through needs a whole number');
      return cmdCreate(through);
    }
    case 'migrate': return cmdMigrate(rest[0], Number(rest[1]));
    case 'down': return cmdDown(rest[0], Number(rest[1]));
    case 'seed': return cmdSeed(rest[0]);
    case 'drop': return cmdDrop(rest[0]);
    default:
      throw new Error('usage: scratch-db.mjs create [--through n] | migrate <url> <n> | down <url> <n> | seed <url> | drop <url>');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
