// The six database verbs of program.mjs: ready, sync-board, check --board, check --claims, check --orphans, status.
// Each one reads the board through an injected reader, calls a pure function, and renders. program.mjs loads this file lazily,
// so the table verbs never load pg.
//
// io (injected; the CLI tests pass a fake, realIo() is the default):
//   io.env                      the environment: the database URL variables and CLAUDE_CODE_SESSION_ID
//   io.open(url)                a snapshot reader: { hasLaneDep(), board(board, ids), foreign(board, ids), edges(board, ids),
//                               programSeed(board), events(board, ids), end() }
//   io.fresh(url)               a reader for sync-board --apply: { lanes(board, ids) -> Map id -> { state, owner }, end() }
// Order in every verb: read the map (live mode: self-check), parse it (a lint error is a note, not a stop), usage checks, dbTarget, then the first connection.
// A refusal or a usage error therefore never opens a database client. The only write path is runLane (lib/lane-cli.mjs).
import { ExitError, usageError } from './errors.mjs';
import { git } from './git.mjs';
import { checkTable } from './map-check.mjs';
import { parseMap } from './map-parse.mjs';
import { programFacts } from './facts.mjs';
import { dbTarget, readDoc, readMap, DECISIONS_PATH } from './source.mjs';
import { depSql } from './contract.mjs';
import { hasLaneDep, openAutocommitRO, openReadOnly } from './db.mjs';
import { readBoard, readEdges, readForeign, readLaneEvents, readLaneStates, readProgramSeed } from './board.mjs';
import { laneCliPath, runLane } from './lane-cli.mjs';
import { selectReady, renderReady } from './ready.mjs';
import { planSync, renderSync } from './sync.mjs';
import { checkBoard, renderBoardCheck } from './board-check.mjs';
import { checkClaims, renderClaims } from './claims.mjs';
import { listOrphans, renderOrphans } from './orphans.mjs';
import { buildStatus, renderStatus } from './status.mjs';
import { parseDecisions } from './holds.mjs';

const DEFAULT_BOARD = 'continuous-claude';
const json = (value) => JSON.stringify(value, null, 2);
const header = (verb, map) => ({ verb, testMode: map.testMode, mapSource: map.source });
const noteLines = (facts) => facts.notes.map((n) => `NOTE ${n}`);
const sha40 = /^[0-9a-f]{40}$/;

// ---- the real reader (SQL: lib/board.mjs; the scratch-database probe runs it)

export function realIo(env = process.env) {
  return {
    env,
    async open(url) {
      const sql = await depSql();
      const client = await openReadOnly(url);
      return {
        hasLaneDep: () => hasLaneDep(client),
        board: (board, ids) => readBoard(client, { board, ids, sql }),
        foreign: (board, ids) => readForeign(client, { board, ids }),
        edges: (board, ids) => readEdges(client, { board, ids }),
        programSeed: (board) => readProgramSeed(client, board),
        events: (board, ids) => readLaneEvents(client, { board, ids, sql }),
        end: () => client.end(),
      };
    },
    async fresh(url) {
      const client = await openAutocommitRO(url);
      return { lanes: (board, ids) => readLaneStates(client, { board, ids }), end: () => client.end() };
    },
  };
}

// ---- shared steps

// Map, lint, facts, board key, caller. No database yet.
function setup(ctx, verb) {
  const { flags, scriptDir } = ctx;
  const io = ctx.io ?? realIo();
  const map = readMap(flags, scriptDir);
  const model = parseMap(map.text, map.source);
  if (model.errors.length) throw new ExitError(1, `${verb}: the map does not parse (${model.errors.length} errors); run check --table`);
  const facts = programFacts(map.text, model);
  const lint = checkTable(model);
  if (lint.errors.length) facts.notes.push(`the map has ${lint.errors.length} lint errors; run check --table`);
  const caller = flags.as || io.env.CLAUDE_CODE_SESSION_ID || null;
  return { io, flags, map, model, facts, board: flags.project ?? DEFAULT_BOARD, caller, lintErrors: lint.errors.length };
}

// The checked database URL (test mode: a scratch database only), then one snapshot reader for fn. The reader always ends.
async function withReader(s, fn) {
  const url = await dbTarget({ testMode: s.map.testMode, env: s.io.env });
  s.url = url;
  const reader = await s.io.open(url);
  try {
    if (!(await reader.hasLaneDep())) throw new ExitError(1, 'migration 0006 (lane_dep) is not applied');
    return await fn(reader);
  } finally {
    await reader.end();
  }
}

// text: lines after the banner. body: the JSON fields after the header. ok: JSON ok (the exit code is separate).
function emit(s, verb, { code, text, body, ok = code === 0 }) {
  if (s.flags.json) return { code, out: [json({ ok, ...header(verb, s.map), board: s.board, ...body })], err: [] };
  return { code, out: [s.map.banner, ...text], err: [] };
}

function refusalOut(s, verb, refusal) {
  const out = s.flags.json ? [json({ ok: false, ...header(verb, s.map), board: s.board, refusal })] : [];
  return { code: refusal.exit, out, err: [refusal.message] };
}

// ---- ready

export async function ready(ctx) {
  const s = setup(ctx, 'ready');
  if (!s.caller) throw usageError('ready needs CLAUDE_CODE_SESSION_ID or --as <session>');
  if (s.facts.slotIds === null) throw new ExitError(1, 'map fact missing: Cursor eval slot bullet');
  const rows = await withReader(s, (r) => r.board(s.board, s.facts.ids));
  const res = selectReady({ model: s.model, facts: s.facts, rows, caller: s.caller, board: s.board });
  if (res.refusal) return refusalOut(s, 'ready', res.refusal);
  const { refusal, board, ...rest } = res;
  return emit(s, 'ready', { code: 0, text: [...noteLines(s.facts), renderReady(res)], body: rest });
}

// ---- sync-board

async function readPlan(s) {
  return withReader(s, async (r) => planSync({
    model: s.model, facts: s.facts, rows: await r.board(s.board, s.facts.ids), edges: await r.edges(s.board, s.facts.ids),
    programSeedId: await r.programSeed(s.board), board: s.board,
  }));
}

const planBody = (s, plan, apply, results = new Map()) => ({
  go: s.facts.go, apply, errors: plan.errors, stays: plan.stays,
  moves: plan.moves.map((m) => ({ ...m, result: results.get(m.id) ?? 'planned' })),
});

/** The argv of the one lane.mjs call that sync-board --apply makes for each move. lane-race-probe.mjs imports it, so the probe runs the exact call. */
export const syncBoardStateArgv = (id, board) => ['state', id, 'backlog', '--if-state', 'blocked', '--reason', 'program.mjs sync-board --apply', '--project', board];

// One move: re-read the lane, then run `lane.mjs state <id> backlog --if-state blocked --reason ...`. --if-state is the compare-and-set;
// --reason is required on an unowned blocked lane. No --note: state --note replaces the stored note.
function applyOne(s, cli, id, now) {
  if (!now || now.state !== 'blocked' || now.owner) return { id, result: 'skipped', text: `SKIP ${id} changed since the plan` };
  const run = runLane(syncBoardStateArgv(id, s.board), { cli, testMode: s.map.testMode, url: s.url, sessionId: s.caller });
  return run.failure ? { id, result: 'failed', text: `FAIL ${id} ${run.failure}` } : { id, result: 'applied', text: null };
}

async function applyMoves(s, moves) {
  const cli = laneCliPath(s.flags);
  const fresh = await s.io.fresh(s.url);
  const log = [];
  try {
    for (const m of moves) {
      const now = (await fresh.lanes(s.board, [m.id])).get(m.id);
      log.push(applyOne(s, cli, m.id, now));
      if (log.at(-1).result === 'failed') break;
    }
    const applied = log.filter((x) => x.result === 'applied').map((x) => x.id);
    const states = applied.length ? await fresh.lanes(s.board, applied) : new Map();
    const verify = applied.filter((id) => states.get(id)?.state !== 'backlog').map((id) => `FAIL verify ${id} state ${states.get(id)?.state ?? 'none'}`);
    return { log, verify };
  } finally {
    await fresh.end();
  }
}

function applyText(plan, { log, verify }) {
  const count = (r) => log.filter((x) => x.result === r).length;
  const failed = count('failed') > 0 || verify.length > 0;
  const result = failed ? `RESULT failed (${count('applied')} applied, ${count('skipped')} skipped)` : `RESULT applied ${count('applied')} moves, ${count('skipped')} skipped`;
  return [renderSync(plan, { apply: true }), ...log.filter((x) => x.text).map((x) => x.text), ...verify, result];
}

export async function syncBoard(ctx) {
  const s = setup(ctx, 'sync-board');
  if (s.flags.apply && !s.caller) throw usageError('sync-board --apply needs CLAUDE_CODE_SESSION_ID or --as <session>');
  // The one verb that writes does not trust a map that fails the lint. The read verbs answer with a NOTE.
  if (s.flags.apply && s.lintErrors) throw new ExitError(1, `sync-board --apply: the map has ${s.lintErrors} lint errors; nothing written. Run check --table and fix the map first.`);
  const plan = await readPlan(s);
  if (plan.refusal) return refusalOut(s, 'sync-board', plan.refusal);
  if (plan.errors.length) return emit(s, 'sync-board', { code: 1, text: [...noteLines(s.facts), renderSync(plan), 'nothing written'], body: planBody(s, plan, false) });
  if (!s.flags.apply) return emit(s, 'sync-board', { code: 0, text: [...noteLines(s.facts), renderSync(plan)], body: planBody(s, plan, false) });
  const done = await applyMoves(s, plan.moves);
  const results = new Map(done.log.map((x) => [x.id, x.result]));
  const code = done.log.some((x) => x.result === 'failed') || done.verify.length ? 1 : 0;
  return emit(s, 'sync-board', { code, text: [...noteLines(s.facts), ...applyText(plan, done)], body: planBody(s, plan, true, results) });
}

// ---- check --board

// The first-parent file list of each landed SHA. null when git cannot read it (not in the repo, a root commit).
function diffFiles(repo, sha) {
  try {
    return git(repo, ['diff', '--name-only', '-z', `${sha}^1`, sha, '--']).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function readShaFiles(repo, rows) {
  const out = {};
  if (!repo) return out;
  for (const r of rows.filter((x) => x.met && sha40.test(x.landed_sha ?? ''))) out[r.landed_sha] ??= diffFiles(repo, r.landed_sha);
  return out;
}

export async function checkBoardVerb(ctx) {
  const s = setup(ctx, 'check --board');
  const data = await withReader(s, async (r) => ({
    rows: await r.board(s.board, s.facts.ids), foreign: await r.foreign(s.board, s.facts.ids), edges: await r.edges(s.board, s.facts.ids),
  }));
  const res = checkBoard({ model: s.model, facts: s.facts, ...data, shaFiles: readShaFiles(s.map.repo, data.rows), board: s.board });
  return emit(s, 'check --board', { code: res.errors.length ? 1 : 0, text: [renderBoardCheck(res)], body: { errors: res.errors, notes: res.notes } });
}

// ---- check --claims

export async function checkClaimsVerb(ctx) {
  const s = setup(ctx, 'check --claims');
  const data = await withReader(s, async (r) => {
    const rows = await r.board(s.board, s.facts.ids);
    const ids = [...new Set([...s.facts.ids, ...rows.filter((x) => x.id.startsWith('re-')).map((x) => x.id)])];
    return { rows, events: await r.events(s.board, ids), edges: await r.edges(s.board, s.facts.ids), programSeedId: await r.programSeed(s.board) };
  });
  const res = checkClaims({ model: s.model, facts: s.facts, ...data, since: s.flags.since ?? null });
  const body = { floor: res.floor, errors: res.errors, notes: res.notes, limit: res.limit };
  return emit(s, 'check --claims', { code: res.errors.length ? 1 : 0, text: [renderClaims(res)], body });
}

// ---- check --orphans

export async function checkOrphansVerb(ctx) {
  const s = setup(ctx, 'check --orphans');
  const rows = await withReader(s, (r) => r.board(s.board, s.facts.ids));
  const res = listOrphans({ facts: s.facts, rows });
  const { exit, ...rest } = res;
  return emit(s, 'check --orphans', { code: exit, text: [renderOrphans(res)], body: rest });
}

// ---- status

export async function statusVerb(ctx) {
  const s = setup(ctx, 'status');
  const text = readDoc(s.map, DECISIONS_PATH, s.flags);
  const rows = await withReader(s, (r) => r.board(s.board, s.facts.ids));
  const st = buildStatus({ model: s.model, facts: s.facts, rows, decisions: text === null ? null : parseDecisions(text), board: s.board });
  const { board, ...rest } = st;
  return emit(s, 'status', { code: 0, text: [...noteLines(s.facts), renderStatus(st)], body: rest });
}
