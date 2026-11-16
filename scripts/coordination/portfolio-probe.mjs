#!/usr/bin/env node
/**
 * portfolio-probe -- the end-to-end gate for render-portfolio.mjs (coord-portfolio-seat-view).
 *
 * Runs the REAL render-portfolio.mjs as a child process against a SCRATCH database (lanes_pr1_*, made by
 * scratch-db.mjs create). It seeds two boards, two master cards held by two sessions (lease 80 minutes ahead on a,
 * 30 on b), and one review lane on b. The boards come from a temp registry (probe-boards.mjs), never the real one.
 * The clock is fixed at 10:00 local today (PORTFOLIO_NOW) so the tick hours do not depend on when the probe runs.
 *
 *   CONTINUOUS_CLAUDE_DB_URL=<scratch url> node scripts/coordination/portfolio-probe.mjs
 *
 * Exit 0: all checks pass. Exit 1: a check failed. Exit 2: not a scratch database, or no pg.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, dbNameOf, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RENDER = join(HERE, 'render-portfolio.mjs');
const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || '';

// Rule O3.9: this probe writes, so it runs on a scratch database only. Refuse before any connection or child process.
try { assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`portfolio-probe: refusing to run: database '${dbNameOf(DB_URL) || '(no name)'}' is not a scratch database. `
    + "Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create --through 6' (name starts with lanes_pr1_).\n");
  process.exit(2);
}

let Client;
try { ({ Client } = requireDep('pg', { repoRoot: REPO })); } catch (e) {
  console.error(`portfolio-probe: the pg package is not available (${e.message}).`);
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`); };

const SID = { a: 'aaaaaaaa-0000-4000-8000-0000000000a1', b: 'bbbbbbbb-0000-4000-8000-0000000000b2', c: 'cccccccc-0000-4000-8000-0000000000c3' };
const SECRET = 'PROBE-NOTE-SECRET-777';
const NOW = new Date(); NOW.setHours(10, 0, 0, 0);
const leaseAt = (minutes) => new Date(NOW.getTime() + minutes * 60000).toISOString();

async function seed(db, keys) {
  await db.query(`SELECT set_config('lane.client_version', '2', false)`);
  // Rows of an earlier run (scratch database only, checked at the top): clear them so a second run does not hit the lane key.
  await db.query(`DELETE FROM agentic_os.lane_event WHERE project_key = ANY($1::text[])`, [Object.values(keys)]);
  await db.query(`DELETE FROM agentic_os.lane WHERE project_key = ANY($1::text[])`, [Object.values(keys)]);
  // ON CONFLICT: a second run on the same scratch database must not fail on the fixed session ids.
  for (const s of ['a', 'b', 'c']) await db.query(`INSERT INTO sessions (id, project) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [SID[s], `/zz-pfprobe/${s}`]);
  // Board c: the holder has no heartbeat and no activity time at all (both columns NULL), so its age is NULL.
  // A NULL age must count as quiet, as in lane.mjs; with a lapsed lease the card then shows no holder.
  await db.query(`UPDATE sessions SET last_heartbeat = NULL, last_activity_at = NULL WHERE id = $1`, [SID.c]);
  const lane = (key, id, state, owner, lease) => db.query(
    `INSERT INTO agentic_os.lane (project_key, id, title, state, owner_session_id, lease_expires_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [key, id, `title ${id}`, state, owner, lease, SECRET]);
  await lane(keys.a, `${keys.a}-program`, 'active', SID.a, leaseAt(80));
  await lane(keys.b, `${keys.b}-program`, 'active', SID.b, leaseAt(30));
  await lane(keys.b, `${keys.b}-review-1`, 'review', null, null);
  await lane(keys.c, `${keys.c}-program`, 'active', SID.c, leaseAt(-10));
  // One event on card a, 15 minutes before the fixed clock: the last-event cell must read 15.
  await db.query(`INSERT INTO agentic_os.lane_event (project_key, lane_id, kind, session_id, body, occurred_at) VALUES ($1, $2, 'note', $3, $4, $5)`,
    [keys.a, `${keys.a}-program`, SID.a, SECRET, new Date(NOW.getTime() - 15 * 60000).toISOString()]);
}

/** The cells of the table row that names `key`, or null. */
function rowOf(html, key) {
  const tr = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]).find((t) => t.includes(`<td>${key}</td>`));
  return tr ? [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]) : null;
}

function verify(html, keys) {
  const a = rowOf(html, keys.a); const b = rowOf(html, keys.b); const c = rowOf(html, keys.c);
  check('three seat rows, each with all 8 cells (no "read failed" row)', [a, b, c].every((r) => r && r.length === 8)
    && (html.match(/<td>zz-pfprobe-[abc]<\/td>/g) || []).length === 3 && !html.includes('read failed'));
  check('row c: lapsed lease and a quiet holder show no holder', !!c && c[2] === 'no holder', c ? c.join(' | ') : 'no row');
  check('row a: holder shown, last event cell reads 15', !!a && a[2] === '#aaaaaaaa' && a[4] === '15', a ? a.join(' | ') : 'no row');
  check('the page never shows a lane title', !html.includes('title zz-pfprobe'));
  check('row b has NO TICK', !!b && b.includes('NO TICK'), b ? b.join(' | ') : 'no row');
  check('row b counts one review lane', !!b && b[7] === '1', b ? `cell=${b[7]}` : 'no row');
  check('row a has no word', !!a && !a.includes('NO TICK'), a ? a.join(' | ') : 'no row');
  check('row a counts no review lane', !!a && a[7] === '0', a ? `cell=${a[7]}` : 'no row');
  check('the page never shows a lane note', html.length > 0 && !html.includes(SECRET));
}

async function main() {
  console.log(`scratch database: ${maskUrl(DB_URL)}`);
  const bs = makeBoards('zz-pfprobe', ['a', 'b', 'c']);
  const keys = { a: bs.boards.a.key, b: bs.boards.b.key, c: bs.boards.c.key };
  const out = join(bs.tmp, 'portfolio.html');
  const db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
    await seed(db, keys);
    const env = laneEnv(DB_URL, bs, { PORTFOLIO_NOW: NOW.toISOString(), PORTFOLIO_MASTER_LANES: `${keys.a}-program,${keys.b}-program,${keys.c}-program` });
    const r = spawnSync(process.execPath, [RENDER, '--out', out], { encoding: 'utf8', env, timeout: 60_000 });
    console.log(`render-portfolio exit ${r.status}: ${(r.stdout || r.stderr || '').trim().split('\n').pop()}`);
    check('render-portfolio exits 0', r.status === 0);
    let html = '';
    try { html = readFileSync(out, 'utf8'); } catch { /* no page: the checks below fail */ }
    verify(html, keys);
  } finally {
    await db.end().catch(() => {});
    bs.cleanup();
  }
}

try { await main(); } catch (err) { check('probe ran to the end', false, err.message); }
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
