// Database access for the program verbs. Read-only by construction: every client has default_transaction_read_only=on
// and, after connect, runs SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY (a URL option cannot undo that).
// Writes go through lane.mjs (lib/lane-cli.mjs), never through this file.
// pg is loaded lazily through scripts/lib/resolve-deps.mjs (a linked worktree has no node_modules), so a pure test never needs pg.
// A database URL never goes into output with its password: use maskDbUrl or scrubUrls.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

// postgresql://***@host:port/db. Always this form: no user, no password, no query string.
export function maskDbUrl(url) {
  try {
    const u = new URL(String(url));
    return `postgresql://***@${u.host}${u.pathname}`;
  } catch {
    return 'postgresql://***@<unreadable>';
  }
}

// Masks every database URL inside a free text (a child's stderr, a driver message).
export function scrubUrls(text) {
  return String(text).replace(/\bpostgres(?:ql)?:\/\/[^\s'"`<>]*/g, (m) => maskDbUrl(m));
}

// Pure. The options of every client this file opens.
export function clientOptions(url) {
  return {
    connectionString: url,
    connectionTimeoutMillis: 4000,
    query_timeout: 15000,
    options: '-c default_transaction_read_only=on',
  };
}

async function newClient(url) {
  const { requireDep } = await import('../../lib/resolve-deps.mjs');
  const pg = requireDep('pg', { repoRoot: REPO });
  const Client = pg.Client || pg.default?.Client;
  return new Client(clientOptions(url));
}

export const READ_ONLY_SESSION = 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY';
export const SNAPSHOT_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

// A URL such as ?options=-c%20default_transaction_read_only%3Doff can override the option in clientOptions, so every
// opener also runs READ_ONLY_SESSION on the live session. makeClient is a test seam: tests pass a fake pg client.
async function connect(url, makeClient = newClient) {
  const client = await makeClient(url);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`cannot connect to ${maskDbUrl(url)}: ${scrubUrls(e.message)}`);
  }
  try {
    await client.query(READ_ONLY_SESSION);
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// A connected client inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY: one snapshot for every read. The caller ends it.
export async function openReadOnly(url, makeClient) {
  const client = await connect(url, makeClient);
  try {
    await client.query(SNAPSHOT_BEGIN);
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// A connected read-only client with no transaction: each query sees the latest commit. For the read-back after writes.
export const openAutocommitRO = (url, makeClient) => connect(url, makeClient);

// Migration 0006 (lane_dep) is applied. A missing row reads as false.
export async function hasLaneDep(client) {
  const res = await client.query(`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS ok`);
  return res.rows[0]?.ok === true;
}
