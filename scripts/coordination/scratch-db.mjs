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
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DRIZZLE_DIR = join(REPO, 'apps', 'agentic-os', 'drizzle');
const PREFIX = 'lanes_pr1_';
const NAME_RE = /^lanes_pr1_[a-z0-9_]+$/;

/**
 * Same lookup as lane.mjs: `pg` lives in the hooks bundle or apps/agentic-os of this checkout or of the primary
 * (scripts/lib/resolve-deps.mjs). `anchors` (package.json paths) replace the whole lookup; a test uses that to
 * simulate "pg is in none". A miss throws the one ENV error.
 */
export function loadPg(anchors) {
  return requireDep('pg', { repoRoot: REPO, anchors });
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

/**
 * Query keys that name a database. A socket: URL takes its database from `db` (pg-connection-string index.js:47-49), and psql (libpq)
 * reads `dbname`. The path test passes both, so the URL could reach the live database. `database` is the pg config key.
 */
const DB_QUERY_KEYS = new Set(['db', 'dbname', 'database']);

/** Throw unless the URL points at a scratch database. Call before any write. */
export function assertScratchUrl(url) {
  const name = dbNameOf(url);
  if (!name.startsWith(PREFIX) || !NAME_RE.test(name)) {
    throw new Error(`refusing: database name '${name}' does not start with '${PREFIX}'`);
  }
  // searchParams decodes percent-encoding and plus signs; keys are compared in lower case. The message names the key, never the value.
  for (const key of new URL(url).searchParams.keys()) {
    const k = key.toLowerCase();
    if (DB_QUERY_KEYS.has(k)) throw new Error(`refusing: query parameter '${k}' names a database; the name comes from the path only`);
  }
  return name;
}

/** Query parameters of a libpq URL that hold a secret or the path of one. pg-connection-string reads them like userinfo. */
const SENSITIVE_QUERY_KEYS = new Set(['password', 'passfile', 'sslpassword', 'sslkey', 'sslcert']);
const queryKey = (raw) => {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase(); } catch { return raw.toLowerCase(); }
};

/**
 * Hide secrets in a URL before it goes to a log: the userinfo password and the sensitive query parameters
 * (password, passfile, sslpassword, sslkey, sslcert; key match ignores case and percent-encoding).
 * Text based, not `new URL`, so an unparseable string still masks. The stdout JSON of `create` keeps the real URL by contract.
 */
export function maskUrl(url) {
  const s = String(url);
  const q = s.indexOf('?');
  let out = s;
  if (q >= 0) {
    const h = s.indexOf('#', q);
    const end = h < 0 ? s.length : h;
    const query = s.slice(q + 1, end).split('&').map((kv) => {
      const eq = kv.indexOf('=');
      return eq > 0 && SENSITIVE_QUERY_KEYS.has(queryKey(kv.slice(0, eq))) ? `${kv.slice(0, eq)}=***` : kv;
    }).join('&');
    out = `${s.slice(0, q + 1)}${query}${s.slice(end)}`;
  }
  // Userinfo ends at the LAST '@' of the authority (WHATWG URL and pg do the same). Never read past the authority.
  return out.replace(/^([^:/?#]+:\/\/)([^/?#]*)/, (m, scheme, auth) => {
    const at = auth.lastIndexOf('@');
    const colon = at < 0 ? -1 : auth.slice(0, at).indexOf(':');
    return colon < 0 ? m : `${scheme}${auth.slice(0, colon)}:***${auth.slice(at)}`;
  });
}

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

/** Drop a scratch database. `adminUrl` points at the `postgres` maintenance database. */
export async function dropDatabase(adminUrl, name) {
  if (!NAME_RE.test(name)) throw new Error(`refusing: database name '${name}' does not start with '${PREFIX}'`);
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/** CREATE DATABASE, then `build()`. If `build` throws, drop the new database (drop errors are swallowed) and rethrow. */
export async function createDatabase(adminUrl, name, build) {
  if (!NAME_RE.test(name)) throw new Error(`refusing: database name '${name}' does not start with '${PREFIX}'`);
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
  try {
    await build();
  } catch (e) {
    await dropDatabase(adminUrl, name).catch(() => {});
    throw e;
  }
}

async function cmdCreate(through) {
  const name = `${PREFIX}${randomBytes(4).toString('hex')}`;
  assertScratchUrl(urlWithDb(baseConnString(), name));
  const url = urlWithDb(baseConnString(), name);
  console.error(`creating scratch database ${name} on ${new URL(url).host}`);
  await createDatabase(urlWithDb(baseConnString(), 'postgres'), name, () => withClient(url, async (c) => {
    await applyInitSchema(c);
    for (const f of ['001-file-claims-leases.sql', '002-g5-drop-orphan-sessions.sql', '003-sessions-lifecycle.sql']) {
      await runWholeFile(c, `coordination/migrations/${f}`, join(HERE, 'migrations', f));
    }
    for (const tag of journalTags()) {
      if (Number(tag.slice(0, 4)) <= through) await runDrizzleFile(c, `drizzle/${tag}.sql`, join(DRIZZLE_DIR, `${tag}.sql`));
    }
  }));
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
  await dropDatabase(urlWithDb(url, 'postgres'), name);
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
