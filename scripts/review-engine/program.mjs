#!/usr/bin/env node
/**
 * program.mjs: the review-engine program script (part 1: map lint, seed file, diff check).
 * Grammar, exit codes and test mode: scripts/review-engine/README.md. Part 2 verbs are stubs (exit 5).
 *
 * Live mode runs only from the primary checkout, only when every script file equals main, and reads the map from main.
 * Test mode (--test-mode) skips that and says so on line 1 of the output.
 */
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { ExitError, usageError } from './lib/errors.mjs';
import { revParse } from './lib/git.mjs';
import { changedFiles, outsideOwns } from './lib/diff.mjs';
import { checkTable } from './lib/map-check.mjs';
import { parseMap } from './lib/map-parse.mjs';
import { notBuilt } from './lib/part2.mjs';
import { buildEdges, renderSeed, seedItems } from './lib/seed.mjs';
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

function seedSummary(model, items, edges, file, map) {
  const dropped = model.dropped.length ? `; dropped, close by hand: ${model.dropped.map((d) => d.id).join(', ')}` : '';
  return `seed-file: ${items.length} items -> ${file} (map ${map.shortLabel})${dropped}; edges: ${edges.length} computed, not written (part 2)`;
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

function seedJson(map, model, res, items, edges, file) {
  return json({
    ok: true, ...header('seed-file', map), counts: countsOf(model), out: file, items: items.length,
    dropped: model.dropped.map((d) => d.id), edges: edges.length, notes: res.notes,
  });
}

function seedFileVerb({ flags, scriptDir }) {
  const map = readMap(flags, scriptDir);
  const model = parseMap(map.text, map.source);
  const res = checkTable(model);
  if (res.errors.length) return seedFailure(map, res, flags);
  const ctx = { sha: map.source.sha, ref: map.source.ref, project: flags.project, testMode: map.testMode };
  const items = seedItems(model, ctx);
  const edges = buildEdges(model);
  const text = renderSeed(items, edges, 'array');
  // No --out: stdout carries only the array, so the banner goes to stderr.
  if (flags.out === undefined) return { code: 0, out: [text.trimEnd()], err: [map.banner] };
  const file = writeAtomic(flags.out, text);
  if (flags.json) return { code: 0, out: [seedJson(map, model, res, items, edges, file)], err: [] };
  return { code: 0, out: [map.banner, seedSummary(model, items, edges, flags.out, map)], err: [] };
}

// check --diff

function resolveRef(repo, ref, flag) {
  const sha = revParse(repo, ref);
  if (!sha) throw usageError(`${flag === '--branch' ? 'branch' : 'base'} '${ref}' not found; pass ${flag}`);
  return sha;
}

// Both refs are resolved to commit ids once. git diff gets the ids, so a branch that moves later changes nothing.
function diffTarget(flags, map, id) {
  if (!map.repo) throw usageError('no git repo for check --diff; pass --repo <dir>');
  const branch = flags.branch ?? `re/${id}`;
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
  const target = diffTarget(flags, map, id);
  const files = changedFiles(map.repo, target.baseSha, target.branchSha);
  const outside = outsideOwns(lane, files);
  const { code, result } = diffOutcome(files, outside);
  const d = { ...target, files, outside, result };
  if (!flags.json) return { code, out: diffText(map, lane, d), err: [] };
  const { branch, base, baseSha, branchSha } = target;
  const body = json({ ok: code === 0, ...header('check --diff', map), lane: id, branch, base, baseSha, branchSha, files, outside, result });
  return { code, out: [body], err: [] };
}

// Dispatch table. Part 2 replaces the notBuilt entries.
const stub = (name) => () => notBuilt(name);
export const HANDLERS = {
  'check --table': checkTableVerb,
  'check --diff': checkDiffVerb,
  'seed-file': seedFileVerb,
  'seed-file --edges-out': stub('seed-file --edges-out'),
  'check --board': stub('check --board'),
  'check --claims': stub('check --claims'),
  'check --orphans': stub('check --orphans'),
  ready: stub('ready'),
  'sync-board': stub('sync-board'),
  status: stub('status'),
};

// Returns { code, out: [lines], err: [lines] }. Never throws.
export async function main(argv, scriptDir = HERE) {
  try {
    const { key, flags } = parseArgs(argv);
    return await HANDLERS[key]({ flags, scriptDir });
  } catch (e) {
    if (e instanceof ExitError) return { code: e.exitCode, out: [], err: [e.message] };
    return { code: 1, out: [], err: [`program.mjs: ${e.message}`] };
  }
}

const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const res = await main(process.argv.slice(2));
  if (res.out.length) process.stdout.write(`${res.out.join('\n')}\n`);
  if (res.err.length) process.stderr.write(`${res.err.join('\n')}\n`);
  process.exitCode = res.code;
}
