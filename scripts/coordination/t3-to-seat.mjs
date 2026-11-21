#!/usr/bin/env node
/**
 * t3-to-seat -- the one path from T3 Code (the advisory seat) to the Program Seat (card coord-t3-advisory).
 *
 * T3 Code writes a brief under <primary>/.claudedocs/adversarial/ and, after Dave's yes, runs this script. It sends
 * ONE lane DM to the session that holds lane re-program. The DM names the carrier file; the brief stays in the file.
 * T3 Code is no Claude Code session, so the sender is the fixed text id 't3-advisor'. This script never writes a
 * sessions row and never touches a lane row (owner, lease, state).
 *
 *   node t3-to-seat.mjs --kind <premortem|redteam|plan> --file <path> --summary "<one line>"
 *                       [--sha <hex>] [--lane <id>] [--seat <id or name of the seat session>] [--project <key>] [--dry-run]
 *
 * --seat is a check, not a route: it must name the holder of re-program (whole id, id prefix or session name).
 *
 * Order of the checks (each stops the run; nothing is written before the last one passes):
 *   1. arguments                       exit 1
 *   2. carrier file inside the folder  exit 1
 *   3. listed-id scan (M4.13)          exit 3   the list is read from the primary checkout; any read problem refuses
 *   4. DM byte budget (M4.15)          exit 1
 *   5. the seat                        exit 2   no holder of re-program, or --seat names another session than the holder
 *   6. --lane on the board             exit 1
 * Exit 0: one lane_event row (or none with --dry-run). A failed insert prints "not confirmed" and exits 1.
 *
 * No message of this script repeats the summary, the sha or the carrier text before check 3 passes: a refusal must
 * not print the id it refuses.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { countListed, readIdList } from './board-mask.mjs';
import { repoPath } from './canon-home.mjs';
import { DEFAULT_BOARD, resolveBoard } from './lane-board.mjs';
import { assertScratchUrl } from './scratch-db.mjs';
import { label, listIdentities } from './session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

export const SENDER = 't3-advisor';
export const MASTER_CARD_ID = 're-program';
export const KINDS = Object.freeze(['premortem', 'redteam', 'plan']);
export const MAX_DM_BYTES = 2500;
/** A seat this fresh gets the DM between tool calls (M4.7: `say --to` notes a receiver idle for 2 minutes). */
export const ACTIVE_SECONDS = 120;
/** What this writer tells the board trigger of migration 0004 (B6.6), the same value as lane.mjs. */
const CLIENT_VERSION = '2';
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const MSG_LISTED = 'REFUSED: listed holdout/gold id detected; nothing sent';
const MSG_NO_LIST = 'REFUSED: the listed id list could not be read; nothing sent';
const USAGE = 'usage: t3-to-seat.mjs --kind <premortem|redteam|plan> --file <path> --summary "<one line>" '
  + '[--sha <hex>] [--lane <id>] [--seat <id or name of the seat session>] [--project <key>] [--dry-run]';

/** A stop with an exit code. The text holds no value from the summary, the sha or the carrier file. */
class Stop extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
}
const stop = (code, message) => { throw new Stop(code, message); };

const VALUE_FLAGS = new Set(['kind', 'file', 'sha', 'summary', 'lane', 'seat', 'project']);
const BOOL_FLAGS = new Set(['dry-run']);

/** Flags of the command line. A value flag takes the next token, whatever it starts with. Any other token is a usage error. */
export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (key !== null && BOOL_FLAGS.has(key)) flags[key] = true;
    else if (key !== null && VALUE_FLAGS.has(key) && argv[i + 1] !== undefined) flags[key] = argv[++i];
    else stop(1, `bad or incomplete argument at position ${i + 1}\n${USAGE}`);
  }
  return flags;
}

/** Checks kind, summary and sha. Returns { kind, summary, sha } with sha null when none was given. */
export function checkFields(flags) {
  if (!KINDS.includes(flags.kind)) stop(1, `--kind must be one of: ${KINDS.join(', ')}`);
  const summary = typeof flags.summary === 'string' ? flags.summary.trim() : '';
  if (summary === '') stop(1, '--summary is required and must not be empty');
  if (/[\r\n]/.test(summary)) stop(1, '--summary must be one line');
  const sha = flags.sha ?? null;
  if (sha === null && flags.kind === 'redteam') stop(1, '--sha is required for --kind redteam');
  if (sha !== null && !SHA_RE.test(sha)) stop(1, '--sha must be 7 to 40 hex characters');
  return { kind: flags.kind, summary, sha };
}

/**
 * The carrier file: it must exist, be a regular file and sit inside <primary>/.claudedocs/adversarial/ after links are
 * resolved. An argument with a `..` segment is refused before any file access. Returns { abs, rel, text }; rel is the
 * path from the primary checkout with forward slashes.
 */
export function readCarrier(fileArg, primary, cwd = process.cwd()) {
  if (typeof fileArg !== 'string' || fileArg.trim() === '') stop(1, '--file is required');
  if (fileArg.split(/[\\/]/).includes('..')) stop(1, '--file must not hold a ".." segment');
  const folder = join(primary, '.claudedocs', 'adversarial');
  let folderReal;
  let fileReal;
  try { folderReal = realpathSync.native(folder); } catch { stop(1, `the carrier folder does not exist: ${folder}`); }
  try { fileReal = realpathSync.native(resolve(cwd, fileArg)); } catch { stop(1, '--file does not exist'); }
  const inside = relative(folderReal, fileReal);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    stop(1, `--file must be inside ${folder}`);
  }
  if (!statSync(fileReal).isFile()) stop(1, '--file must be a regular file');
  const rel = ['.claudedocs', 'adversarial', ...inside.split(sep)].join('/');
  return { abs: fileReal, rel, text: readFileSync(fileReal, 'utf8') };
}

/** The DM body in the M4.13 shape. */
export function buildDm({ kind, summary, rel, sha }) {
  return `[T3-ADVISOR] ${kind} — ${summary}\nFile: ${rel}\nSHA: ${sha ?? 'none'}\nReply via ## Seat Disposition in carrier file.`;
}

/** The text as a reader sees it (the reader view of board-mask.mjs): fullwidth forms folded, invisible marks gone, white space collapsed. */
const readerView = (s) => s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/g, ' ');

/**
 * M4.13, fail closed. Reads the listed ids of the primary checkout and counts them in each text and in its reader view.
 * Any problem with the list (absent, bad, empty) refuses, and so does any count above 0. The messages are fixed and name no id.
 */
export function assertNoListedId(primary, texts, read = readIdList) {
  let ids;
  try { ids = read(primary); } catch { stop(3, MSG_NO_LIST); }
  if (!Array.isArray(ids) || ids.length === 0) stop(3, MSG_NO_LIST);
  const hits = texts.reduce((n, t) => n + countListed(t, ids) + countListed(readerView(t), ids), 0);
  if (hits > 0) stop(3, MSG_LISTED);
}

function connString() {
  return process.env.CONTINUOUS_CLAUDE_DB_URL
    || process.env.DATABASE_URL
    || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

/**
 * CCV3_USER_HOME moves the primary checkout, and with it the listed-id list. That is a test seam. On any database that is
 * not a scratch database it would let a run scan against another list, so it is refused there.
 */
function assertRealPrimary(url) {
  if (!(process.env.CCV3_USER_HOME ?? '').trim()) return;
  try { assertScratchUrl(url); } catch {
    stop(1, 'refusing: CCV3_USER_HOME (a stand-in home) is set and the database is not a scratch database');
  }
}

/** True when `want` names the session `owner`: its whole id, the start of its id (8 or more hex characters, a leading # allowed) or its session name. */
export function namesSession(want, owner, ids) {
  const w = String(want).trim().toLowerCase();
  const id = String(owner).toLowerCase();
  if (w === id) return true;
  const prefix = w.replace(/^#/, '');
  if (/^[0-9a-f-]{8,}$/.test(prefix) && id.startsWith(prefix)) return true;
  const name = ids.get(owner)?.name;
  return typeof name === 'string' && name.trim() !== '' && name.trim().toLowerCase() === w;
}

/**
 * The holder of re-program on the board. Exit 2 when there is none. The receiver is ALWAYS that holder: the charter lets
 * T3 Code reach the Program Seat only, so --seat is a check, not a route. It must name the holder, else exit 2. A
 * --seat that could name any session would be a direct path to a builder (CodeRabbit CLI, 2026-11-21; Dave: restrict).
 */
async function resolveSeat(c, board, seatFlag, ids) {
  const { rows } = await c.query(
    'SELECT owner_session_id FROM agentic_os.lane WHERE id = $1 AND project_key = $2', [MASTER_CARD_ID, board],
  );
  const owner = rows[0]?.owner_session_id ?? null;
  if (!owner) stop(2, `no live Seat holds ${MASTER_CARD_ID} on board ${board}; nothing sent`);
  if (typeof seatFlag === 'string' && !namesSession(seatFlag, owner, ids)) {
    stop(2, `--seat does not name the session that holds ${MASTER_CARD_ID} on board ${board}; nothing sent`);
  }
  return owner;
}

/**
 * Seconds since the seat was last alive, or null (no sessions row, or no time in it). Computed in SQL: the two columns
 * are TIMESTAMP without zone, and a JS Date made from them can be off by the local offset.
 */
async function idleSeconds(c, seatId) {
  const { rows } = await c.query(
    `SELECT EXTRACT(EPOCH FROM (now() - GREATEST(s.last_heartbeat, s.last_activity_at)))::int AS idle_s
       FROM sessions s WHERE s.id = $1`,
    [seatId],
  );
  const v = rows[0]?.idle_s;
  return Number.isInteger(v) ? Math.max(0, v) : null;
}

/** The status sentence of M4.7. `sent` false gives the dry-run wording. */
export function statusLine(seatLabel, idleS, sent = true) {
  const active = idleS !== null && idleS <= ACTIVE_SECONDS;
  const idle = idleS === null ? 'idle unknown' : `idle ${Math.floor(idleS / 60)}m`;
  if (!sent) {
    return active
      ? `Seat ${seatLabel} is active (${idleS}s ago): a send would be DELIVERED.`
      : `Seat ${seatLabel} is idle (${idle.slice(5)}): a send would be QUEUED.`;
  }
  return active
    ? `DELIVERED to Seat ${seatLabel} (active ${idleS}s ago — injects between tool calls)`
    : `QUEUED for Seat ${seatLabel} (${idle} — nudge Seat terminal or wait for CronList tick)`;
}

async function withDb(url, fn) {
  const { Client } = requireDep('pg', { repoRoot: REPO });
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 4000, query_timeout: 8000 });
  await client.connect();
  try {
    await client.query(`SELECT set_config('lane.client_version', $1, false)`, [CLIENT_VERSION]);
    const set = (await client.query(`SELECT current_setting('lane.client_version', true) AS v`)).rows[0]?.v;
    if (set !== CLIENT_VERSION) stop(1, 'lane.client_version could not be set; nothing sent');
    return await fn(client);
  } finally { await client.end().catch(() => {}); }
}

export async function main(argv, out = (s) => process.stdout.write(`${s}\n`)) {
  const flags = parseArgs(argv);
  const { kind, summary, sha } = checkFields(flags);
  const url = connString();
  assertRealPrimary(url);
  const primary = repoPath();
  const carrier = readCarrier(flags.file, primary);
  const dmBody = buildDm({ kind, summary, rel: carrier.rel, sha });
  assertNoListedId(primary, [carrier.text, dmBody]);
  const bytes = Buffer.byteLength(dmBody, 'utf8');
  if (bytes > MAX_DM_BYTES) stop(1, `the DM is ${bytes} bytes; the budget is ${MAX_DM_BYTES} (M4.15). Shorten --summary; nothing sent`);

  let board;
  try {
    board = resolveBoard(process.cwd(), { cli: true, projectFlag: typeof flags.project === 'string' ? flags.project : undefined })?.key ?? DEFAULT_BOARD;
  } catch (e) { stop(1, e.message); }

  await withDb(url, async (c) => {
    const ids = listIdentities();
    const seatId = await resolveSeat(c, board, flags.seat, ids);
    let laneId = null;
    if (typeof flags.lane === 'string') {
      const hit = await c.query('SELECT 1 FROM agentic_os.lane WHERE id = $1 AND project_key = $2', [flags.lane, board]);
      if (hit.rows.length === 0) stop(1, `--lane is not a lane on board ${board}; nothing sent`);
      laneId = flags.lane;
    }
    const idleS = await idleSeconds(c, seatId);
    const seatLabel = label(seatId, ids);

    if (flags['dry-run'] === true) {
      out('DRY RUN: nothing written.');
      out(`--- DM (${bytes} of ${MAX_DM_BYTES} bytes) to ${seatLabel} on board ${board} ---`);
      out(dmBody);
      out('--- end DM ---');
      out(statusLine(seatLabel, idleS, false));
      out(`lane.client_version=${CLIENT_VERSION}`);
      return;
    }

    let eventId;
    try {
      eventId = (await c.query(
        `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
         VALUES ($1, 'note', $2, $3, $4, $5::jsonb, $6) RETURNING id`,
        [laneId, SENDER, seatId, dmBody, JSON.stringify({ source: SENDER, kind, file: carrier.rel, sha }), board],
      )).rows[0].id;
    } catch (e) {
      stop(1, `not confirmed: ${e.message}`);
    }
    out(statusLine(seatLabel, idleS));
    out(`event ${eventId} on board ${board}, ${bytes} bytes, lane.client_version=${CLIENT_VERSION}`);
  });
}

/** True when this file is the program that node started. Windows paths compare without case: a silent no-op would read as "sent". */
function isDirectRun() {
  if (!process.argv[1] || !existsSync(process.argv[1])) return false;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(realpathSync(process.argv[1])) === fold(realpathSync(fileURLToPath(import.meta.url)));
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`t3-to-seat: ${e instanceof Stop ? e.message : `error: ${e.message}`}\n`);
    process.exit(e instanceof Stop ? e.exitCode : 1);
  });
}
