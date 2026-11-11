#!/usr/bin/env node
/**
 * program.mjs: the review-engine program script.
 *   Table verbs (no database): check --table, check --diff, seed-file.
 *   Board verbs (database, read-only; lib/db-verbs.mjs): ready, sync-board, check --board, check --claims, check --orphans, status.
 *   sync-board --apply is the only write. It runs lane.mjs through the shim, one child per move.
 * Grammar, exit codes and test mode: scripts/review-engine/README.md.
 *
 * Live mode runs only from the primary checkout, only when every script file equals main, and reads the map from main.
 * Test mode (--test-mode) skips that and says so on line 1 of the output. A board verb in test mode reads only a
 * scratch database (lanes_pr1_*) named in CONTINUOUS_CLAUDE_DB_URL.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { ExitError, usageError } from './lib/errors.mjs';
import { revParse } from './lib/git.mjs';
import { changedFiles, outsideOwnsOf, packGroup } from './lib/diff.mjs';
import { checkTable } from './lib/map-check.mjs';
import { parseMap } from './lib/map-parse.mjs';
import { branchOf } from './lib/pack.mjs';
import { rankOf } from './lib/rank.mjs';
import { buildEdges, renderSeed, seedItems } from './lib/seed.mjs';
import { blockedStateErrors, SEED_FILE_NOTE, seedParser, validateSeed } from './lib/contract.mjs';
import { scrubUrls } from './lib/db.mjs';
import { readMap } from './lib/source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (value) => JSON.stringify(value, null, 2);
const withLine = (f) => (f.line ? ` [map.md:${f.line}]` : '');
const findingText = (f) => `${f.message.startsWith(f.rule) ? f.message : `${f.rule} ${f.message}`}${withLine(f)}`;

function countsOf(model) {
  return {
    lanes: model.lanes.length, externals: model.externals.length, dropped: model.dropped.length,
    edges: buildEdges(model).length, held: model.lanes.filter((l) => l.held.length > 0).length,
  };
}

const header = (verb, map) => ({ verb, testMode: map.testMode, mapSource: map.source });

// check --table

function tableText(map, res, c) {
  return [
    map.banner,
    `check --table: ${c.lanes} lanes, ${c.externals} external, ${c.dropped} dropped, ${c.edges} edges, ${c.held} held`,
    `examined: ${Object.entries(res.examined).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    ...res.errors.map((f) => `FAIL ${findingText(f)}`),
    ...res.notes.map((f) => `NOTE ${findingText(f)}`),
    `RESULT ${res.errors.length ? 'fail' : 'pass'} (${res.errors.length} errors)`,
  ];
}

function checkTableVerb({ flags, scriptDir }) {
  const map = readMap(flags, scriptDir);
  const model = parseMap(map.text, map.source);
  const res = checkTable(model);
  const counts = countsOf(model);
  const ok = res.errors.length === 0;
  const body = flags.json
    ? [json({ ok, ...header('check --table', map), counts, examined: res.examined, errors: res.errors, notes: res.notes })]
    : tableText(map, res, counts);
  return { code: ok ? 0 : 1, out: body, err: [] };
}

// seed-file

function writeAtomic(file, text) {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
  return target;
}

function seedSummary(model, lanes, edges, file, map, ranked) {
  const dropped = model.dropped.length ? `; dropped, close by hand: ${model.dropped.map((d) => d.id).join(', ')}` : '';
  return `seed-file: ${lanes} lanes, ${edges} edges -> ${file} (map ${map.shortLabel})${dropped}${ranked > 0 ? `; ranked ${ranked}` : ''}`;
}

// A lint failure writes no file. With --out the report is on stdout, otherwise on stderr (stdout stays empty).
// An older file at --out stays as it is and is stale: the report says so.
function seedFailure(map, res, flags) {
  const toStdout = flags.out !== undefined;
  const stale = toStdout && existsSync(resolve(flags.out));
  const staleLine = stale ? [`FAIL seed-file: '${flags.out}' exists from an earlier run and was left unchanged; it is stale`] : [];
  const lines = flags.json
    ? [json({ ok: false, ...header('seed-file', map), errors: res.errors, notes: res.notes, out: flags.out ?? null, staleOut: stale })]
    : [map.banner, ...res.errors.map((f) => `FAIL ${findingText(f)}`), ...staleLine, `RESULT fail (${res.errors.length} errors)`];
  return toStdout ? { code: 1, out: lines, err: [] } : { code: 1, out: [], err: lines };
}

function seedJson(map, model, res, s, file) {
  return json({
    ok: true, ...header('seed-file', map), counts: countsOf(model), out: file, items: s.items.length,
    dropped: model.dropped.map((d) => d.id), edges: s.edges.length, ranked: Object.keys(s.rank).length, notes: res.notes, seedNotes: s.notes,
  });
}

// --rank <file>: a flat id-to-number object or a packages.json. An unreadable file or a bad entry is a usage error (exit 2).
function readRank(flags, model) {
  if (flags.rank === undefined) return { rank: undefined, notes: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(flags.rank, 'utf8'));
  } catch (e) {
    throw usageError(`cannot read --rank file '${flags.rank}': ${e.message}`);
  }
  const res = rankOf(data, model);
  if (res.errors.length) throw usageError(res.errors.join('\n'));
  return res;
}

// The parser of the gate-2 contract (lane-seed-file.mjs) validates the exact payload, in test mode and live mode alike.
// Absent in test mode: a note, and the file is still written. Absent in live mode: ExitError 5 from seedParser, nothing written.
// io.seedUrl points the seam at another module file. Only an in-process test passes io, and only test mode honours it.
async function validatedSeed(map, items, edges, io) {
  const parser = await seedParser({ testMode: map.testMode, ...(map.testMode && io?.seedUrl ? { url: io.seedUrl } : {}) });
  const state = blockedStateErrors(items);
  const parsed = parser ? validateSeed(parser, items, edges).errors : [];
  return { errors: [...state, ...parsed].map((message) => ({ rule: 'seed-file', message })), notes: parser ? [] : [SEED_FILE_NOTE] };
}

async function seedFileVerb({ flags, scriptDir, io }) {
  const map = readMap(flags, scriptDir);
  const model = parseMap(map.text, map.source);
  const res = checkTable(model);
  if (res.errors.length) return seedFailure(map, res, flags);
  const ranked = readRank(flags, model);
  const ctx = { sha: map.source.sha, ref: map.source.ref, project: flags.project, testMode: map.testMode, rank: ranked.rank };
  const items = seedItems(model, ctx);
  const edges = buildEdges(model);
  const check = await validatedSeed(map, items, edges, io);
  if (check.errors.length) return seedFailure(map, { errors: check.errors, notes: res.notes }, flags);
  const text = renderSeed(items, edges, 'object');
  const notes = [...ranked.notes, ...check.notes];
  const lines = notes.map((n) => `NOTE ${n}`);
  // No --out: stdout carries only the object, so the banner and the notes go to stderr.
  if (flags.out === undefined) return { code: 0, out: [text.trimEnd()], err: [map.banner, ...lines] };
  const file = writeAtomic(flags.out, text);
  if (flags.json) return { code: 0, out: [seedJson(map, model, res, { items, edges, rank: ranked.rank ?? {}, notes }, file)], err: [] };
  const summary = seedSummary(model, items.length, edges.length, flags.out, map, Object.keys(ranked.rank ?? {}).length);
  return { code: 0, out: [map.banner, summary, ...lines], err: [] };
}

// check --diff

function resolveRef(repo, ref, flag) {
  const sha = revParse(repo, ref);
  if (!sha) throw usageError(`${flag === '--branch' ? 'branch' : 'base'} '${ref}' not found; pass ${flag}`);
  return sha;
}

// Both refs are resolved to commit ids once. git diff gets the ids, so a branch that moves later changes nothing.
// The default branch is the branch of the lane's group: re/<id>, or the shared branch of its pack.
function diffTarget(flags, map, model, id) {
  if (!map.repo) throw usageError('no git repo for check --diff; pass --repo <dir>');
  const branch = flags.branch ?? branchOf(id, model.packs ?? []);
  const branchSha = resolveRef(map.repo, branch, '--branch');
  const base = flags.base ?? map.mainSha ?? 'main';
  return { branch, base, branchSha, baseSha: resolveRef(map.repo, base, '--base') };
}

// An empty diff is not a pass: nothing was checked.
function diffOutcome(files, outside) {
  if (files.length === 0) return { code: 1, result: 'diff-empty' };
  return outside.length ? { code: 1, result: 'diff-outside-owns' } : { code: 0, result: 'diff-clean' };
}

function diffText(map, lane, d) {
  const prose = lane.section?.ownsProse
    ? [`NOTE owns-prose lane '${lane.id}': Owns has text outside backticks: '${lane.section.ownsProse}'`] : [];
  if (d.group.length > 1) prose.push(`NOTE pack: ${d.group.map((l) => l.id).join(', ')} (union of Owns)`);
  const count = `files: ${d.files.length} base ${d.baseSha.slice(0, 12)} branch ${d.branchSha.slice(0, 12)}`;
  const result = d.result === 'diff-outside-owns' ? `RESULT diff-outside-owns ${d.outside.length}` : `RESULT ${d.result}`;
  return [map.banner, count, ...d.outside.map((f) => `OUTSIDE ${f}`), ...prose, result];
}

function checkDiffVerb({ flags, scriptDir }) {
  const map = readMap(flags, scriptDir);
  const model = parseMap(map.text, map.source);
  const id = flags.diff;
  const lane = model.lanes.find((l) => l.id === id) ?? model.externals.find((e) => e.id === id);
  if (!lane) throw usageError(`unknown lane '${id}': it is not in the Waves table or the external lanes`);
  const target = diffTarget(flags, map, model, id);
  const files = changedFiles(map.repo, target.baseSha, target.branchSha);
  const group = packGroup(model, id);
  const outside = outsideOwnsOf(group, files);
  const { code, result } = diffOutcome(files, outside);
  const d = { ...target, files, outside, result, group };
  if (!flags.json) return { code, out: diffText(map, lane, d), err: [] };
  const { branch, base, baseSha, branchSha } = target;
  const body = json({ ok: code === 0, ...header('check --diff', map), lane: id, lanes: group.map((l) => l.id), branch, base, baseSha, branchSha, files, outside, result });
  return { code, out: [body], err: [] };
}

// Dispatch table. The board verbs load lib/db-verbs.mjs on first use, so a table verb never loads pg.
const board = (name) => async (ctx) => (await import('./lib/db-verbs.mjs'))[name](ctx);
export const HANDLERS = {
  'check --table': checkTableVerb,
  'check --diff': checkDiffVerb,
  'seed-file': seedFileVerb,
  'check --board': board('checkBoardVerb'),
  'check --claims': board('checkClaimsVerb'),
  'check --orphans': board('checkOrphansVerb'),
  ready: board('ready'),
  'sync-board': board('syncBoard'),
  status: board('statusVerb'),
};

// Returns { code, out: [lines], err: [lines] }. Never throws. io: the reader and env of the board verbs (tests inject a fake).
export async function main(argv, scriptDir = HERE, io = null) {
  try {
    const { key, flags } = parseArgs(argv);
    return await HANDLERS[key]({ flags, scriptDir, io });
  } catch (e) {
    const message = scrubUrls(e.message);
    if (e instanceof ExitError) return { code: e.exitCode, out: [], err: [message] };
    return { code: 1, out: [], err: [`program.mjs: ${message}`] };
  }
}

const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const res = await main(process.argv.slice(2));
  if (res.out.length) process.stdout.write(`${res.out.join('\n')}\n`);
  if (res.err.length) process.stderr.write(`${res.err.join('\n')}\n`);
  process.exitCode = res.code;
}
