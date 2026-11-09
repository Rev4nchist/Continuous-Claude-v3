#!/usr/bin/env node
/**
 * export-factory-data -- write factory.json for the Fleet app Flow tab (Phase B). It reads four local files and writes one
 * JSON document. It uploads nothing and calls no database or model.
 *
 *   node scripts/coordination/export-factory-data.mjs [--out <dir>] [--gates <file>] [--reviews <file>] [--coderabbit <file>]
 *        [--handoffs <dir>] [--dash-config <file>] [--router-config <file>]
 *
 * The files (defaults in USAGE): the pre-PR gate log, the cursor review ledger, the CodeRabbit paid ledger, and the
 * handoff YAML headers. The rows are built by factory-rows.mjs (schema in that file). Design:
 * .claudedocs/2026-11-09-factory-json-design.md. The nightly CCv3-Lane-Snapshot wrapper runs this as its second command.
 *
 * Reads: JSONL files line by line (a stream, never a whole file in memory), and for a handoff only the lines between the
 * first two --- lines. Each row is cut to the allowed fields at once. A path, branch, head, session id, prompt, finding
 * or handoff body line is never read into a row. The run and head keys are renumbered (r1, h1) so the real values
 * never leave the reader.
 *
 * Failure policy: a family that cannot be read is a note row ("no data: <reason>"), never a zero. Reasons, first match wins:
 * missing, too large (over 64 MB, checked before any read), empty, corrupt (no valid row, or over half the lines bad),
 * reader error (the message goes to stderr). The script never throws past a family. Exit 0 whenever factory.json is written.
 * Exit 1 when it cannot be written (the lock is held, the folder is not writable, over 256 KB). Exit 2 for a bad argument.
 *
 * Writes: <out>/factory.json through a temp file and a rename, under <out>/.factory.lock. It never touches the 8 export
 * files, refresh.json or .export.lock. It never writes to a source file and never creates a source folder.
 *
 * Importing this file does nothing: no I/O.
 */
import { createReadStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primaryRoot } from '../lib/resolve-deps.mjs';
import { buildFactoryRows } from './factory-rows.mjs';
import { chicagoDay } from './lane-dash-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MAX_BYTES = 64 * 1024 * 1024;
export const DOC_CAP_BYTES = 256 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
const SQL = 'Computed in Node by scripts/coordination/factory-rows.mjs from four local files. No query.';
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------- paths and config

/**
 * The default paths. The handoffs and router config live in the primary checkout, never in the script's own (a worktree has
 * no thoughts/). The primary checkout is looked up (one git call) only when one of those two paths is read.
 */
export function defaultPaths({ primaryRoot: findRoot = primaryRoot, home = homedir() } = {}) {
  let root = null;
  // The repo root is two folders above HERE. primaryRoot() returns its input when git fails, so HERE itself would
  // give <repo>/scripts/coordination/thoughts and a silent "no data: missing".
  const primary = () => (root ??= findRoot(path.resolve(HERE, '..', '..')));
  const claude = path.join(home, '.claude');
  return {
    out: path.join(claude, 'state', 'lane-dash'),
    gates: path.join(claude, 'logs', 'pre-pr-gates.jsonl'),
    reviews: path.join(claude, 'state', 'cursor-review-ledger.jsonl'),
    coderabbit: path.join(claude, 'state', 'coderabbit-paid.jsonl'),
    get handoffs() { return path.join(primary(), 'thoughts', 'shared', 'handoffs'); },
    dashConfig: path.join(HERE, 'lane-dash.config.json'),
    get routerConfig() { return path.join(primary(), 'review-router.config.json'); },
  };
}

/** The target rows of the dash config (window_days is the one used). A missing or bad file gives window_days 7 and one stderr line. */
export function readDashTargets(file, err = console.error) {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(cfg?.targets)) return cfg.targets.filter((t) => typeof t?.key === 'string').map((t) => ({ key: t.key, value: t.value }));
    err('export-factory-data: dash config has no targets, window_days 7');
  } catch {
    err('export-factory-data: dash config not found or not JSON, window_days 7');
  }
  return [{ key: 'window_days', value: 7 }];
}

/** coderabbit.monthly_file_cap from the router config: a whole number of 0 or more, else null. Never throws. */
export function readRouterCap(file) {
  try {
    const cap = JSON.parse(readFileSync(file, 'utf8'))?.coderabbit?.monthly_file_cap;
    return Number.isInteger(cap) && cap >= 0 ? cap : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- reading

/** Lines of a stream. A chunk can end inside a line or inside a multi-byte character. */
async function* linesOf(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = buf.indexOf('\n', start); i >= 0; i = buf.indexOf('\n', start)) {
      yield buf.slice(start, i);
      start = i + 1;
    }
    buf = buf.slice(start);
  }
  if (buf) yield buf;
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const opaque = (map, prefix, value) => {
  if (!map.has(value)) map.set(value, `${prefix}${map.size + 1}`);
  return map.get(value);
};

/** The row reducers. Each keeps only the allowed fields and returns null for a bad line. `ok(ts)` is a ts that parses and is not after the run. */
function reducers(exportedMs) {
  const runs = new Map();
  const heads = new Map();
  const ok = (ts) => typeof ts === 'string' && Number.isFinite(Date.parse(ts)) && Date.parse(ts) <= exportedMs;
  return {
    prpr: (o) => (ok(o.ts) && typeof o.status === 'string' && typeof o.run_id === 'string' && o.run_id !== ''
      ? { ts: o.ts, run: opaque(runs, 'r', o.run_id), head: typeof o.head === 'string' && o.head !== '' ? opaque(heads, 'h', o.head) : '', status: o.status }
      : null),
    rev: (o) => (ok(o.ts) && typeof o.phase === 'string'
      ? { ts: o.ts, phase: o.phase, purpose: typeof o.purpose === 'string' ? o.purpose : null, timedOut: o.timedOut === true }
      : null),
    coderabbit: (o) => (ok(o.ts) && isNumber(o.files) && isNumber(o.cost)
      ? { ts: o.ts, kind: typeof o.kind === 'string' ? o.kind : null, files: o.files, cost: o.cost }
      : null),
  };
}

/** missing, a read error or a size: the stat step, shared by every reader. Returns the size or a dark result. */
function sizeOf(file, stat) {
  try {
    return { size: stat(file).size };
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { dark: { ok: false, reason: 'missing' } };
    throw e;
  }
}

/** Decide ok / corrupt from the line counts. */
function verdict(rows, lines, bad) {
  if (lines === 0) return { ok: false, reason: 'empty' };
  if (rows.length === 0 || bad * 2 > lines) return { ok: false, reason: 'corrupt' };
  return { ok: true, rows, bad };
}

/**
 * Read one JSONL family: family is 'prpr', 'rev' or 'coderabbit'. Returns {ok: true, rows, bad} or {ok: false, reason}.
 * deps = {stat, open, err} (tests inject them). The size is checked before the file is opened.
 */
export async function readJsonlFamily(file, family, exportedAt, deps = {}) {
  const stat = deps.stat ?? statSync;
  const open = deps.open ?? createReadStream;
  const err = deps.err ?? console.error;
  try {
    const s = sizeOf(file, stat);
    if (s.dark) return s.dark;
    if (s.size > MAX_BYTES) return { ok: false, reason: 'too large' };
    if (s.size === 0) return { ok: false, reason: 'empty' };
    const reduce = reducers(Date.parse(exportedAt))[family];
    const rows = [];
    let lines = 0;
    let bad = 0;
    for await (const raw of linesOf(open(file))) {
      const line = raw.trim();
      if (!line) continue;
      lines++;
      let row = null;
      try {
        const o = JSON.parse(line);
        row = isObject(o) ? reduce(o) : null;
      } catch { /* a line that does not parse is a bad line */ }
      if (row) rows.push(row); else bad++;
    }
    return verdict(rows, lines, bad);
  } catch (e) {
    err(`export-factory-data: ${family}: ${e?.message ?? e}`);
    return { ok: false, reason: 'reader error' };
  }
}

const isCalendarDay = (s) => {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim();

/** {date, outcome} from the header (the lines between the first two --- lines) of one handoff file, or null. The body is never read. */
async function readHeader(file, open) {
  const found = {};
  let inside = false;
  for await (const raw of linesOf(open(file))) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '---') {
      if (inside) {
        return isCalendarDay(found.date ?? '') && found.outcome ? { date: found.date, outcome: found.outcome } : null;
      }
      inside = true;
      continue;
    }
    if (!inside || line.startsWith('#')) continue;
    const m = /^(date|outcome)\s*:\s*(.*)$/.exec(line);
    if (m) found[m[1]] = unquote(m[2]);
  }
  return null; // no header, or no second ---
}

/** The *.yaml files in the folder and in each folder one level down. */
function yamlFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && /\.yaml$/i.test(e.name)) out.push(path.join(d, e.name));
      else if (e.isDirectory() && depth < 1) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

/** Read the handoff headers. Returns {ok: true, rows: [{date, outcome}], bad} or {ok: false, reason}. A bad file is one with no usable header. */
export async function readHandoffs(dir, deps = {}) {
  const stat = deps.stat ?? statSync;
  const open = deps.open ?? createReadStream;
  const err = deps.err ?? console.error;
  try {
    const s = sizeOf(dir, stat);
    if (s.dark) return s.dark;
    const files = yamlFiles(dir);
    const rows = [];
    let bad = 0;
    for (const f of files) {
      const row = await readHeader(f, open);
      if (row) rows.push(row); else bad++;
    }
    return verdict(rows, files.length, bad);
  } catch (e) {
    err(`export-factory-data: hand: ${e?.message ?? e}`);
    return { ok: false, reason: 'reader error' };
  }
}

// ---------------------------------------------------------------- build and write

/** Read the four families and build the envelope. `deps.now` is the run clock (ISO UTC). */
export async function collectFactory(opts, deps = {}) {
  const exportedAt = (deps.now ?? (() => new Date().toISOString()))();
  const err = deps.err ?? console.error;
  const d = { ...deps, err };
  const prpr = await readJsonlFamily(opts.gates, 'prpr', exportedAt, d);
  const rev = await readJsonlFamily(opts.reviews, 'rev', exportedAt, d);
  const coderabbit = await readJsonlFamily(opts.coderabbit, 'coderabbit', exportedAt, d);
  const hand = await readHandoffs(opts.handoffs, d);
  const rows = buildFactoryRows({
    today: chicagoDay(exportedAt), exportedAt, targets: readDashTargets(opts.dashConfig, err), cap: readRouterCap(opts.routerConfig),
    prpr, rev, coderabbit, hand,
  });
  return { envelope: { sql: SQL, exportedAt, rows } };
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) throw new Error(`factory lock is held: ${lock} (another run is writing; delete the file if it is older than 10 minutes)`);
      try { unlinkSync(lock); } catch { /* another process took it; the retry reports it */ }
    }
  }
  throw new Error(`factory lock is held: ${lock}`);
}

/** Write <outDir>/factory.json: a size check, then a temp file renamed into place under .factory.lock. Throws when it cannot. */
export function writeFactory(outDir, envelope, deps = {}) {
  const rename = deps.rename ?? renameSync;
  const text = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(text);
  if (bytes > DOC_CAP_BYTES) throw new Error(`factory.json is ${bytes} bytes, over the ${DOC_CAP_BYTES} byte (256 KB) cap`);
  mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, '.factory.lock');
  acquireLock(lock);
  const tmp = path.join(outDir, 'factory.json.tmp');
  try {
    writeFileSync(tmp, text);
    rename(tmp, path.join(outDir, 'factory.json'));
    return { bytes };
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never written */ }
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- command line

const USAGE = `usage: export-factory-data.mjs [--out <dir>] [--gates <file>] [--reviews <file>] [--coderabbit <file>]
                               [--handoffs <dir>] [--dash-config <file>] [--router-config <file>]
  --out            output folder (default ~/.claude/state/lane-dash)
  --gates          pre-PR gate log (default ~/.claude/logs/pre-pr-gates.jsonl)
  --reviews        review ledger (default ~/.claude/state/cursor-review-ledger.jsonl)
  --coderabbit     CodeRabbit paid ledger (default ~/.claude/state/coderabbit-paid.jsonl)
  --handoffs       handoff YAML folder (default <primary checkout>/thoughts/shared/handoffs)
  --dash-config    window_days (default scripts/coordination/lane-dash.config.json)
  --router-config  coderabbit.monthly_file_cap (default <primary checkout>/review-router.config.json)`;

const FLAGS = { '--out': 'out', '--gates': 'gates', '--reviews': 'reviews', '--coderabbit': 'coderabbit', '--handoffs': 'handoffs', '--dash-config': 'dashConfig', '--router-config': 'routerConfig' };

function parseArgs(argv) {
  const opts = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (!Object.hasOwn(FLAGS, a)) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
    opts[FLAGS[a]] = v;
  }
  return opts;
}

/** One counts-only line for a family, from the finished rows. */
function familyLine(rows, id, unit) {
  const get = (suffix) => rows.find((r) => r.id === `${id}.${suffix}`);
  const asOf = get('as_of');
  if (!asOf) return `${id}: ${get('note')?.text ?? 'no data'}`;
  return `${id}: ${get('rows').value} ${unit}, ${get('bad_lines').value} bad lines, as of ${asOf.text}`;
}

/** Run. Returns the exit code. `deps` = {now, log, err, stat, open, rename, primaryRoot, home} (tests inject them). */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`export-factory-data: ${e.message}`);
    return 2;
  }
  if (opts.help) { log(USAGE); return 0; }
  const defaults = defaultPaths({ primaryRoot: deps.primaryRoot, home: deps.home });
  const o = Object.fromEntries(Object.values(FLAGS).map((k) => [k, opts[k] ?? defaults[k]]));
  const { envelope } = await collectFactory(o, { ...deps, err });
  const rows = envelope.rows;
  for (const [id, unit] of [['prpr', 'rows'], ['rev', 'rows'], ['rev.coderabbit', 'rows'], ['hand', 'files']]) log(familyLine(rows, id, unit));
  const out = path.resolve(o.out);
  try {
    const { bytes } = writeFactory(out, envelope, deps);
    log(`factory.json: ${rows.length} rows, ${bytes} bytes`);
    return 0;
  } catch (e) {
    err(`export-factory-data: ${e.message}`);
    return 1;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`export-factory-data: ${e.message}`);
    process.exit(1);
  });
}
