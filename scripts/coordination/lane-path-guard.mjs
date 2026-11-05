#!/usr/bin/env node
/**
 * lane-path-guard -- a ratchet against a bare relative lane.mjs path in model-run text.
 *
 * `node scripts/coordination/lane.mjs ...` works only when the cwd is the CCv3 checkout. In every other project it
 * fails; inside a worktree it runs a stale copy. Text that a model runs must use the shim path
 * (<home>/.claude/scripts/lane.mjs, built by laneCliCmd() in lane-board.mjs / shared/lane-board.ts).
 *
 * The guard counts a bare `scripts/coordination/lane.mjs` per file (one preceded by no path character, so a drive
 * path, a home path and `/continuous-claude/...` do not count) in:
 *   .claude/hooks/src (not __tests__), .claude/skills/*\/SKILL.md, .claude/rules-src, .claude/rules-ondemand,
 *   CONTEXT.md, CLAUDE.md, COORDINATION.md, AGENTS.md
 * and compares each count with scripts/coordination/lane-path-guard.baseline.json. A count that RISES fails. An equal or
 * lower count passes. Old text under docs/ and thoughts/ is out of scope on purpose.
 *
 * Usage: node scripts/coordination/lane-path-guard.mjs [--update] [--repo <dir>] [--baseline <file>]
 *   --update  rewrite the baseline DOWNWARD only (a lower count is recorded, a zero is dropped). Refuses when any count rose.
 *             It creates the baseline when the file is absent.
 * Exit 0 at or under baseline, 1 over it (or a missing baseline), 2 for a bad argument.
 * Exports checkLanePaths() for harness-doctor.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, '..', '..');
export const BASELINE_REL = 'scripts/coordination/lane-path-guard.baseline.json';

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|md|json|sh|ps1|yaml|yml|txt)$/i;
const ROOT_FILES = ['CONTEXT.md', 'CLAUDE.md', 'COORDINATION.md', 'AGENTS.md'];
const TREES = ['.claude/hooks/src', '.claude/rules-src', '.claude/rules-ondemand'];
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

/**
 * `scripts/coordination/lane.mjs` with no path character before it. A `/`, `\`, `:`, `~`, word character, `.` or `-` in front
 * means the text names a full path (C:/..., /c/..., ~/..., $HOME/..., <primary>/..., /continuous-claude/...). `./scripts/...` is
 * relative, so a run of `./` and `../` in front is allowed when the first dot stands alone.
 */
const BARE_RE = /(?<![\w.~\-/\\:])(?:\.{1,2}[\\/])*scripts[\\/]coordination[\\/]lane\.mjs(?![\w-])/g;

/** The number of bare relative lane.mjs paths in `text`. */
export function countBare(text) {
  return (String(text).match(BARE_RE) ?? []).length;
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); } else if (TEXT_EXT.test(e.name)) yield full;
  }
}

function* scopedFiles(repo) {
  for (const f of ROOT_FILES) { const p = join(repo, f); if (existsSync(p)) yield p; }
  for (const t of TREES) yield* walk(join(repo, t));
  const skills = join(repo, '.claude', 'skills');
  let names = [];
  try { names = readdirSync(skills, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* no skills dir */ }
  for (const n of names) { const p = join(skills, n, 'SKILL.md'); if (existsSync(p)) yield p; }
}

/** { counts: Map<relative path, n> (only files with n > 0), scanned: files read, total } */
export function scanRepo(repo) {
  const counts = new Map();
  let scanned = 0;
  let total = 0;
  for (const file of scopedFiles(repo)) {
    scanned++;
    let text;
    try { if (statSync(file).size > 4 * 1024 * 1024) continue; text = readFileSync(file, 'utf8'); } catch { continue; }
    const n = countBare(text);
    if (n > 0) { counts.set(relative(repo, file).replace(/\\/g, '/'), n); total += n; }
  }
  return { counts, scanned, total };
}

function readBaseline(file) {
  if (!existsSync(file)) return null;
  try {
    const files = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).files;
    return files && typeof files === 'object' && !Array.isArray(files) ? files : null;
  } catch { return null; }
}

/** Compares the repo with the baseline. { ok, total, scanned, over: [{file,count,baseline}], baselineMissing? } */
export function checkLanePaths({ repo = DEFAULT_REPO, baselinePath = join(repo, ...BASELINE_REL.split('/')) } = {}) {
  const scan = scanRepo(repo);
  const base = readBaseline(baselinePath);
  if (!base) return { ok: false, baselineMissing: true, baselinePath, total: scan.total, scanned: scan.scanned, over: [] };
  const over = [...scan.counts].filter(([f, n]) => n > (Number(base[f]) || 0)).map(([file, count]) => ({ file, count, baseline: Number(base[file]) || 0 }));
  return { ok: over.length === 0, total: scan.total, scanned: scan.scanned, baselineTotal: Object.values(base).reduce((a, n) => a + (Number(n) || 0), 0), over, baselinePath };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Records lower counts. Never raises one, never adds a file. Creates the baseline when it is absent. */
export function updateBaseline({ repo = DEFAULT_REPO, baselinePath = join(repo, ...BASELINE_REL.split('/')) } = {}) {
  const scan = scanRepo(repo);
  const base = readBaseline(baselinePath);
  let next;
  if (!base) next = Object.fromEntries(scan.counts);
  else {
    const check = checkLanePaths({ repo, baselinePath });
    if (!check.ok) return { ...check, ok: false };
    next = Object.fromEntries([...scan.counts].filter(([f, n]) => n > 0 && f in base).map(([f, n]) => [f, Math.min(n, Number(base[f]))]));
  }
  const files = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(files).reduce((a, n) => a + n, 0);
  writeAtomic(baselinePath, `${JSON.stringify({ note: 'Bare relative scripts/coordination/lane.mjs paths per file. A count may fall, never rise. Rewrite with: node scripts/coordination/lane-path-guard.mjs --update', total, files }, null, 2)}\n`);
  return { ok: true, total, scanned: scan.scanned, files, baselinePath };
}

function parse(argv) {
  const o = { update: false, repo: DEFAULT_REPO, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--update') o.update = true;
    else if (argv[i] === '--repo' || argv[i] === '--baseline') {
      if (!argv[i + 1]) throw new Error(`${argv[i]} needs a value`);
      o[argv[i].slice(2)] = resolve(argv[++i]);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function main() {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\nusage: lane-path-guard.mjs [--update] [--repo <dir>] [--baseline <file>]`);
    process.exit(2);
  }
  const opts = { repo: o.repo, ...(o.baseline ? { baselinePath: o.baseline } : {}) };
  const r = o.update ? updateBaseline(opts) : checkLanePaths(opts);
  if (r.baselineMissing) {
    console.log(`lane-path-guard: FAIL no baseline at ${r.baselinePath} (create it with --update); ${r.total} bare path(s) in ${r.scanned} file(s)`);
    process.exit(1);
  }
  if (!r.ok) {
    console.log(`lane-path-guard: FAIL ${r.over.length} file(s) over baseline${o.update ? ' (--update never raises a count)' : ''}`);
    for (const f of r.over) console.log(`  ${f.file}: ${f.count} bare lane.mjs path(s), baseline ${f.baseline}; use the shim path (laneCliCmd) instead`);
    process.exit(1);
  }
  console.log(`lane-path-guard: ${r.total} bare relative lane.mjs path(s) in ${r.scanned} file(s)${o.update ? `; baseline written to ${r.baselinePath}` : ', none over baseline'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
