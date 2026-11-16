#!/usr/bin/env node
/**
 * render-portfolio -- the live read behind portfolio.html: one row per program seat (portfolio.mjs), built from the lane database.
 *
 *   node scripts/coordination/render-portfolio.mjs [--out <file>] [--master-lanes <id,id>]
 *
 * READ-ONLY. The session sets default_transaction_read_only and a 5 s statement timeout, and every statement is a SELECT.
 * It selects ids, states, owners, lease times and event times only: never a lane note, title, scope or event body.
 * It never publishes. One read per active board of the project registry (LANE_REGISTRY_PATH, else ~/.claude/project-registry.json).
 * A board whose read fails gets a "read failed" row, and the script exits 1 after it writes the page.
 *
 *   --out <file>          default <repo>/portfolio.html (the same repo folder rule as render-board.mjs; gitignored)
 *   --master-lanes <ids>  comma list of master card ids; env PORTFOLIO_MASTER_LANES; default MASTER_LANES of tick-marker.mjs
 *   PORTFOLIO_NOW         a fixed clock (an ISO time) for a probe, so the tick hours do not depend on when it runs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { loadRegistry } from './lane-board.mjs';
import { writeAtomic } from './render-board-args.mjs';
import { listIdentities } from './session-label.mjs';
import { renderHtml, seatRows } from './portfolio.mjs';
import { MASTER_LANES } from './tick-marker.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATEMENT_TIMEOUT_MS = 5000;

const usage = (msg) => { console.error(`${msg}\nusage: node scripts/coordination/render-portfolio.mjs [--out <file>] [--master-lanes <id,id>]`); process.exit(2); };

function parseArgs(argv) {
  const out = { out: null, masterLanes: process.env.PORTFOLIO_MASTER_LANES || null };
  for (let i = 0; i < argv.length; i++) {
    const key = { '--out': 'out', '--master-lanes': 'masterLanes' }[argv[i]];
    const value = argv[++i];
    if (!key) usage(`unknown argument: ${argv[i - 1]}`);
    if (!value || value.startsWith('--')) usage(`${argv[i - 1]} needs a value`);
    out[key] = value;
  }
  return out;
}

/** Board keys of every active registry entry, once each, in registry order. */
function activeBoards(registry = loadRegistry()) {
  return [...new Set(registry.filter((e) => e.status.toLowerCase() !== 'inactive').map((e) => e.board))];
}

/** One board: its lanes (id, state, owner, lease), its owners' ages, and the latest event time per master card. SELECT only. */
async function readBoard(c, board, masterLanes, now) {
  const lanes = (await c.query(
    `SELECT project_key, id, state, owner_session_id, lease_expires_at FROM agentic_os.lane WHERE project_key = $1::text AND state <> 'done'`, [board])).rows;
  const owners = [...new Set(lanes.map((l) => l.owner_session_id).filter(Boolean))];
  // Age in seconds, computed by the server: sessions.last_heartbeat has no zone, so a client-side parse would shift it.
  const ages = (await c.query(
    `SELECT id, EXTRACT(EPOCH FROM (now() - GREATEST(last_heartbeat, last_activity_at)))::float8 AS age_s FROM sessions WHERE id = ANY($1::text[])`, [owners])).rows;
  const events = (await c.query(
    `SELECT project_key, lane_id, max(occurred_at) AS occurred_at FROM agentic_os.lane_event
      WHERE project_key = $1::text AND lane_id = ANY($2::text[]) GROUP BY project_key, lane_id`, [board, masterLanes])).rows;
  // A NULL age (no heartbeat, no activity) is a quiet session, as in lane.mjs: never "alive now".
  const sessions = ages.map((r) => ({ id: r.id, last_alive: r.age_s == null ? null : new Date(now.getTime() - r.age_s * 1000).toISOString() }));
  return { lanes, sessions, events };
}

async function connect() {
  const { Client } = requireDep('pg', { repoRoot: REPO });
  const c = new Client({
    connectionString: process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL
      || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude',
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  await c.query(`SET default_transaction_read_only = on`);
  await c.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  return c;
}

/** Reads every board. A board that throws goes to `failed`; a connection that fails fails every board. */
async function readAll(boards, masterLanes, now) {
  const got = { lanes: [], sessions: [], events: [], failed: [] };
  let c;
  try { c = await connect(); } catch (err) { console.error(`portfolio: no database connection: ${err.message}`); return { ...got, failed: [...boards] }; }
  for (const board of boards) {
    try {
      const r = await readBoard(c, board, masterLanes, now);
      got.lanes.push(...r.lanes); got.sessions.push(...r.sessions); got.events.push(...r.events);
    } catch (err) {
      console.error(`portfolio: board '${board}' read failed: ${err.message}`);
      got.failed.push(board);
    }
  }
  await c.end().catch(() => {});
  return got;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const masterLanes = args.masterLanes ? args.masterLanes.split(',').map((s) => s.trim()).filter(Boolean) : MASTER_LANES;
  const now = process.env.PORTFOLIO_NOW ? new Date(process.env.PORTFOLIO_NOW) : new Date();
  if (!Number.isFinite(now.getTime())) usage('PORTFOLIO_NOW is not a time');
  const boards = activeBoards();
  if (!boards.length) { console.error('portfolio: no active board in the project registry; nothing written'); process.exit(1); }
  const got = await readAll(boards, masterLanes, now);
  const rows = seatRows({ lanes: got.lanes, sessions: got.sessions, events: got.events, masterLanes, identities: listIdentities(), now });
  const out = args.out || join(REPO, 'portfolio.html');
  writeAtomic(out, renderHtml(rows, { builtAt: now, failedBoards: got.failed }));
  const noTick = rows.filter((r) => r.tick).length;
  console.log(`portfolio: ${boards.length} boards, ${rows.length} seats, ${noTick} no tick, ${got.failed.length} failed -> ${out}`);
  process.exit(got.failed.length ? 1 : 0);
}

await main();
