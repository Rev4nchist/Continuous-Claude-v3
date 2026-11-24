#!/usr/bin/env node
/**
 * Proves the read-only claim list that file-claims uses for SHELL text (card coord-file-claims-all-writers,
 * seat review F13). The statement is LIST_BLOCKING_CLAIMS_SQL in .claude/hooks/src/shared/db-utils-pg.ts, read
 * out of that source at run time (the same rule as claim-sql-probe.mjs: a copy here would be the drift).
 *
 * The list must be the exact negation of the reclaim rule (lease live OR holder alive), must leave out the
 * caller's own claims, must list the newest claims first and must cap at 500.
 *
 * Usage: node scripts/coordination/list-claims-sql-probe.mjs
 * Runs on a scratch database only (rule O3.9): CONTINUOUS_CLAUDE_DB_URL from `scratch-db.mjs create`.
 * Exits non-zero on any failed case. Removes its own fixtures.
 */
import { readFileSync } from 'node:fs';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, safeDbName } from './scratch-db.mjs';

const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
try { assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`list-claims-sql-probe: refusing to run: database '${safeDbName(DB_URL) || '(no name)'}' is not a scratch database. `
    + "Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create' (name starts with lanes_pr1_).\n");
  process.exit(2);
}
let pg;
try { pg = requireDep('pg'); } catch (e) { console.error(`list-claims-sql-probe: ${e.message}`); process.exit(2); }

const PROJECT = '__list_claims_probe__';
const STALE_SECS = 300;

function extractSql() {
  const src = readFileSync(new URL('../../.claude/hooks/src/shared/db-utils-pg.ts', import.meta.url), 'utf-8');
  const marker = 'export const LIST_BLOCKING_CLAIMS_SQL = `';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('list-claims-sql-probe: LIST_BLOCKING_CLAIMS_SQL not found in db-utils-pg.ts. Update this extractor; never paste a copy.');
  let out = '';
  let i = start + marker.length;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '`') { out += '`'; i++; continue; }
    if (c === '`') break;
    out += c;
  }
  if (i >= src.length) throw new Error('list-claims-sql-probe: unterminated literal');
  for (const token of ['file_claims', 'expires_at > NOW()', 'last_activity_at', 'ORDER BY', 'LIMIT 500']) {
    if (!out.includes(token)) throw new Error(`list-claims-sql-probe: extracted SQL is missing ${token}: truncated or changed`);
  }
  return out;
}
const SQL = extractSql();

const results = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}

async function main() {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  c.on('error', () => {});
  await c.connect();
  try {
    await c.query('DELETE FROM file_claims WHERE project = $1', [PROJECT]);
    await c.query("DELETE FROM sessions WHERE id LIKE 'lcprobe-%'");
    await c.query(
      `INSERT INTO sessions (id, project, last_heartbeat, last_activity_at) VALUES
         ('lcprobe-alive', $1, NOW(), NOW()),
         ('lcprobe-stale', $1, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes'),
         ('lcprobe-me',    $1, NOW(), NOW()),
         ('lcprobe-working', $1, NOW() - INTERVAL '25 minutes', NOW())`,
      [PROJECT],
    );
    const claim = (file, session, expires, claimedAgo = '0 minutes') => c.query(
      `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
       VALUES ($1, $2, $3, NOW() - $5::interval, NOW() + $4::interval)`,
      [file, PROJECT, session, expires, claimedAgo],
    );
    await claim('a-live-lease-stale-holder', 'lcprobe-stale', '5 minutes');
    await claim('b-expired-lease-alive-holder', 'lcprobe-alive', '-1 minute');
    await claim('c-expired-lease-stale-holder', 'lcprobe-stale', '-1 minute');
    await claim('d-own-claim', 'lcprobe-me', '5 minutes');
    await claim('e-working-holder-expired', 'lcprobe-working', '-1 minute');
    const list = async () => (await c.query(SQL, ['lcprobe-me', STALE_SECS])).rows.filter((r) => r.project === PROJECT).map((r) => r.file_path).sort();

    check('1 lease live OR holder alive is listed; expired lease with a stale holder is not; own claim is not',
      await list(), ['a-live-lease-stale-holder', 'b-expired-lease-alive-holder', 'e-working-holder-expired']);
    check('2 the row carries the project', (await c.query(SQL, ['lcprobe-me', STALE_SECS])).rows.some((r) => r.project === PROJECT), true);

    // ordering and the cap: 502 live claims of another session, claimed 0..501 minutes ago
    await c.query('DELETE FROM file_claims WHERE project = $1', [PROJECT]);
    await c.query(
      `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
       SELECT 'f' || lpad(g::text, 4, '0'), $1, 'lcprobe-alive', NOW() - (g || ' minutes')::interval, NOW() + INTERVAL '5 minutes'
         FROM generate_series(0, 501) g`,
      [PROJECT],
    );
    const rows = (await c.query(SQL, ['lcprobe-me', STALE_SECS])).rows.filter((r) => r.project === PROJECT);
    check('3 the cap keeps 500 rows', rows.length, 500);
    check('4 newest first: the first row is the claim made 0 minutes ago', rows[0]?.file_path, 'f0000');
    check('5 the two oldest claims are the ones dropped', rows.some((r) => r.file_path === 'f0501' || r.file_path === 'f0500'), false);
  } finally {
    await c.query('DELETE FROM file_claims WHERE project = $1', [PROJECT]).catch(() => {});
    await c.query("DELETE FROM sessions WHERE id LIKE 'lcprobe-%'").catch(() => {});
    await c.end();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} cases passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(`list-claims-sql-probe: ${e.message}`); process.exit(2); });
