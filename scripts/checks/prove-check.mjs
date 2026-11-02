#!/usr/bin/env node
/**
 * prove-check.mjs - prove a pre-PR check with a fire at the pre-fix SHA and no fire at the fix SHA.
 *
 * For each row of proofs.json: build a tree for <pre> and one for <fix> with `git archive` (no checkout, no
 * reset, no worktree change), copy the check files onto each tree, run the row command in each tree, and judge:
 *   - at <pre> the row must FIRE: a failing line (or a Semgrep result) that matches `fireMatch`
 *   - at <fix> the row must NOT fire
 *   - a run that dies on an import, compile, load or spawn error is BROKEN. It is never a fire, and it is
 *     never a clean fix either. The proof fails.
 * A passing test with the same title as `fireMatch` is not a fire: only failing lines are matched.
 *
 * Usage:
 *   node scripts/checks/prove-check.mjs --check <name> [--major "#44"]... [--proofs file] [--repo dir]
 *                                       [--date YYYY-MM-DD] [--out dir]
 * Writes <out>/<date>-prove-<check>.json and .txt (default out: <repo>/.claude/cache/e2e).
 * Trees: <repo>/.claude/cache/proof/<sha8>/<check>-<major>/ (gitignored). Each run clears its tree first, so a stale
 * file from an earlier copy list cannot change a verdict. The tree stays after the run, for inspection.
 *
 * Row shape (see proofs.json):
 *   { major, check, pre, fix, paths: [archive paths], copy: [{ from, to, root?: "primary" }],
 *     cmd: [exe, ...args], fireMatch: "<regex over failing lines>", expect: { pre: "fire", fix: "no-fire" },
 *     fireText?: "<Semgrep rows only: regex the hit's source line must match>",
 *     note?: "<era adapter or other record>", timeoutMs? }
 * A run that exits non-zero with no failing line (docker exit 125, a crash before output) is BROKEN.
 * cmd placeholders: {tree} {repo} {rules} {node} {docker} {image}. {rules} is <repo>/scripts/ratchets/semgrep-ccv3. The command runs with cwd = the tree, with no shell.
 *
 * Exit: 0 every row proven, 1 a row failed (no fire at pre, fire at fix, broken run, setup error),
 *       2 bad input or NO rows (a vacuous run is not a pass).
 * Node builtins and git/tar only.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class InputError extends Error {}

export const DEFAULT_IMAGE = 'semgrep/semgrep@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b';
const DOCKER_WIN = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const LOG_LIMIT = 60_000;

/** Output that shows the command could not run the check, whatever the exit code says. */
const BROKEN_MARKERS = [
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /is not exported/,
  /does not provide an export named/,
  /the file did not load/,
  /\bcannot import\b/,
  /\bSyntaxError\b/,
  /Traceback \(most recent call last\)/,
  /\berror TS\d+/,
  /\bRan 0 tests\b/,
  /\bNo tests found\b/,
];

/** The line shapes of a failing test: claude plugin test, node --test (tap and spec), Playwright (list and summary). */
const FAIL_LINE = [
  /^\(fail\)/,
  /^not ok\b/,
  /^[\u2716\u2718\u2717\u00d7]\s/,
  /^x\s+\d+\s/,
  /^\d+\)\s/,
];

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

function parseSemgrep(stdout) {
  const t = stdout.trim();
  if (!t.startsWith('{')) return null;
  try {
    const j = JSON.parse(t);
    return Array.isArray(j.results) ? j : null;
  } catch {
    return null;
  }
}

/** Lines that count as "this check failed here". Semgrep: one line per result, `<check_id> <path>:<line>`. */
function failingLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => FAIL_LINE.some((re) => re.test(l)));
}

const semgrepLines = (j) => j.results.map((r) => `${r.check_id} ${r.path}:${r.start?.line ?? '?'}`);

/** @returns {{ verdict: 'fire'|'no-fire'|'broken', fireLine?: string, why?: string }} */
export function classifyRun(row, run) {
  if (run.error || run.code === null || run.code === undefined) {
    return { verdict: 'broken', why: run.error || 'no exit code (killed or timed out)' };
  }
  const sg = parseSemgrep(run.stdout ?? '');
  if (!sg && isSemgrepRow(row)) return { verdict: 'broken', why: `Semgrep row printed no Semgrep JSON (exit ${run.code})` };
  if (sg) {
    const fatal = (sg.errors ?? []).filter((e) => e.level === 'error');
    if (fatal.length) return { verdict: 'broken', why: `semgrep reported ${fatal.length} error(s): ${fatal[0].type ?? fatal[0].message}` };
  }
  const text = sg ? (run.stderr ?? '') : `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const marker = BROKEN_MARKERS.find((re) => re.test(text));
  if (marker) return { verdict: 'broken', why: `output matches ${marker}` };
  const lines = sg ? semgrepLines(sg) : failingLines(text);
  if (run.code !== 0 && lines.length === 0) {
    return { verdict: 'broken', why: `exit ${run.code} with no failing line: the check did not run` };
  }
  const re = new RegExp(row.fireMatch);
  const hits = sg ? sg.results.filter((r, i) => re.test(lines[i])) : lines.filter((l) => re.test(l));
  if (!sg || !row.fireText) {
    if (!hits.length) return { verdict: 'no-fire' };
    return { verdict: 'fire', fireLine: sg ? semgrepLines({ results: [hits[0]] })[0] : hits[0] };
  }
  return fireTextVerdict(row, run, hits);
}

/** A Semgrep hit counts only when the source line it names matches row.fireText. Line numbers move; text does not. */
function fireTextVerdict(row, run, hits) {
  const re = new RegExp(row.fireText);
  for (const h of hits) {
    const file = path.join(run.tree ?? '', h.path);
    if (!run.tree || !existsSync(file)) return { verdict: 'broken', why: `fireText: cannot read ${h.path} in the tree` };
    const text = readFileSync(file, 'utf8').split(/\r?\n/)[(h.start?.line ?? 0) - 1] ?? '';
    if (re.test(text)) return { verdict: 'fire', fireLine: `${h.check_id} ${h.path}:${h.start?.line} ${text.trim().slice(0, 80)}` };
  }
  return { verdict: 'no-fire' };
}

const isSemgrepRow = (row) => Array.isArray(row.cmd) && row.cmd.includes('semgrep') && row.cmd.includes('--json');

/** Throws InputError for a row that cannot prove anything. Returns the row with defaults filled in. */
export function validateRow(row) {
  const bad = (m) => new InputError(`row ${row?.major ?? '?'}: ${m}`);
  const str = (k) => typeof row?.[k] === 'string' && row[k].trim() !== '';
  for (const k of ['major', 'check', 'pre', 'fix']) if (!str(k)) throw bad(`"${k}" must be a non-empty string`);
  const strList = (k) => Array.isArray(row[k]) && row[k].length > 0 && row[k].every((x) => typeof x === 'string' && x !== '');
  if (!strList('paths')) throw bad('"paths" must be a non-empty list of strings');
  if (!strList('cmd')) throw bad('"cmd" must be a non-empty list of strings');
  if (!str('fireMatch')) throw bad('"fireMatch" must be a non-empty string');
  let re;
  try {
    re = new RegExp(row.fireMatch);
  } catch (e) {
    throw bad(`"fireMatch" is not a valid regex: ${e.message}`);
  }
  if (re.test('')) throw bad('"fireMatch" matches an empty line, so it would fire on every run');
  if (row.fireText !== undefined) {
    if (!isSemgrepRow(row)) throw bad('"fireText" works only on a Semgrep row (cmd has semgrep and --json)');
    if (!str('fireText')) throw bad('"fireText" must be a non-empty string');
    let t;
    try {
      t = new RegExp(row.fireText);
    } catch (e) {
      throw bad(`"fireText" is not a valid regex: ${e.message}`);
    }
    if (t.test('')) throw bad('"fireText" matches an empty line, so it would fire on every hit');
  }
  const copy = row.copy ?? [];
  if (!Array.isArray(copy) || copy.some((c) => !c || typeof c.from !== 'string' || typeof c.to !== 'string')) {
    throw bad('"copy" must be a list of { from, to }');
  }
  const ex = row.expect ?? { pre: 'fire', fix: 'no-fire' };
  if (ex.pre !== 'fire' || ex.fix !== 'no-fire') throw bad('"expect" must be { pre: "fire", fix: "no-fire" }');
  return { ...row, copy, expect: ex };
}

/** Pure verdict over two finished runs. */
export function judge(row, preRun, fixRun) {
  const pre = classifyRun(row, preRun);
  const fix = classifyRun(row, fixRun);
  const reasons = [];
  if (pre.verdict === 'broken') reasons.push(`pre-fix run is broken, not a fire: ${pre.why}`);
  else if (pre.verdict !== 'fire') reasons.push('pre-fix run did not fire');
  if (fix.verdict === 'broken') reasons.push(`fix run is broken, not a clean fix: ${fix.why}`);
  else if (fix.verdict === 'fire') reasons.push(`fix run still fires: ${fix.fireLine}`);
  return { ok: reasons.length === 0, reasons, pre, fix };
}

/** Run one row. deps = { buildTree(row, ref) -> { ref, sha, tree, copied }, runCmd(row, tree) -> run }. */
export function proveRow(row, deps) {
  let pre;
  let fix;
  let preRun;
  let fixRun;
  let release = null;
  try {
    // One run at a time per row: buildTree clears the tree, so a second run could delete files under a running command.
    release = deps.acquire ? deps.acquire(row) : null;
    pre = deps.buildTree(row, row.pre);
    preRun = deps.runCmd(row, pre.tree);
    fix = deps.buildTree(row, row.fix);
    fixRun = deps.runCmd(row, fix.tree);
  } catch (e) {
    return { major: row.major, check: row.check, ok: false, reasons: [`setup error: ${e.message}`], setupError: true };
  } finally {
    if (typeof release === 'function') release();
  }
  const j = judge(row, preRun, fixRun);
  const phase = (b, v, r) => ({ ref: b.ref, sha: b.sha, tree: b.tree, copied: b.copied ?? [], code: r.code, cmd: r.cmd, ...v });
  return {
    major: row.major,
    check: row.check,
    ok: j.ok,
    reasons: j.reasons,
    note: row.note,
    pre: phase(pre, j.pre, preRun),
    fix: phase(fix, j.fix, fixRun),
    raw: { pre: preRun, fix: fixRun },
  };
}

// ---- real dependencies: git archive, copy, spawn -----------------------------------------------------------------

const git = (repo, args, opts = {}) => spawnSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 29, ...opts });
const gitText = (repo, args) => {
  const r = git(repo, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
};

/** The checkout that owns .git. A worktree has no gitignored engine types; the primary checkout has them. */
export function primaryRoot(repo) {
  const common = path.resolve(repo, gitText(repo, ['rev-parse', '--git-common-dir']));
  return path.basename(common) === '.git' ? path.dirname(common) : repo;
}

const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

function extractArchive(repo, sha, paths, tree) {
  const a = git(repo, ['archive', '--format=tar', sha, '--', ...paths]);
  if (a.status !== 0) throw new Error(`git archive ${sha} ${paths.join(' ')}: ${String(a.stderr).trim()}`);
  const winTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const tar = process.env.TAR_BIN ?? (existsSync(winTar) ? winTar : 'tar');
  // cwd + stdin, no -C: GNU tar reads a Windows drive path in an argument as a remote host.
  const x = spawnSync(tar, ['-xf', '-'], { cwd: tree, input: a.stdout, maxBuffer: 1 << 26 });
  if (x.status !== 0) throw new Error(`tar -x in ${tree}: ${String(x.stderr).trim() || x.error?.message}`);
}

function copyOne(repo, primary, tree, c) {
  const src = path.join(c.root === 'primary' ? primary : repo, c.from);
  if (!existsSync(src)) throw new Error(`copy source missing: ${src}`);
  const dest = path.join(tree, c.to);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  const isFile = statSync(src).isFile();
  const rec = { from: c.from, to: c.to, root: c.root ?? 'repo' };
  if (isFile) rec.sha256 = createHash('sha256').update(readFileSync(src)).digest('hex');
  if (c.root !== 'primary') rec.dirty = gitText(repo, ['status', '--porcelain', '--', c.from]) !== '';
  return rec;
}

export const rowLockPath = (repo, row) =>
  path.join(path.resolve(repo), '.claude', 'cache', 'proof', 'locks', `${slug(row.check)}-${slug(row.major)}.lock`);

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Hold the row's lock from tree creation to the end of its runs. The lock file holds the owner pid. A live owner
 * (this process too) is a refusal; a lock left by a dead process is taken over. Returns the release function.
 */
export function acquireRowLock(repo, row) {
  const file = rowLockPath(repo, row);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number.parseInt(readFileSync(file, 'utf8'), 10);
      if (Number.isInteger(owner) && pidAlive(owner)) throw new Error(`tree of ${row.check} ${row.major} is in use by pid ${owner} (${file})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take the lock ${file}`);
}

/** Empty and recreate a proof tree. Refuses any path outside <repo>/.claude/cache/proof/. */
function resetTree(repo, tree) {
  const root = path.join(path.resolve(repo), '.claude', 'cache', 'proof');
  const rel = path.relative(root, path.resolve(tree));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to clear ${tree}: not inside ${root}`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
}

/**
 * Fill the cmd placeholders. {rules} is the Semgrep rule folder, built with path.join so the separator fits the host.
 * A row must not spell that path with backslashes: on Linux they stay literal and Docker mounts the wrong folder.
 */
export function substitute(cmd, { tree, repo, node, docker, image }) {
  const rules = path.join(repo, 'scripts', 'ratchets', 'semgrep-ccv3');
  return cmd.map((s) => s.replaceAll('{tree}', tree).replaceAll('{repo}', repo).replaceAll('{rules}', rules).replaceAll('{node}', node).replaceAll('{docker}', docker).replaceAll('{image}', image));
}

export function realDeps({ repo, env = process.env }) {
  const primary = primaryRoot(repo);
  const docker = env.DOCKER_BIN ?? (existsSync(DOCKER_WIN) ? DOCKER_WIN : 'docker');
  const image = env.SEMGREP_IMAGE ?? DEFAULT_IMAGE;
  return {
    acquire: (row) => acquireRowLock(repo, row),
    buildTree(row, ref) {
      const sha = gitText(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
      const tree = path.join(repo, '.claude', 'cache', 'proof', sha.slice(0, 8), `${slug(row.check)}-${slug(row.major)}`);
      resetTree(repo, tree);
      extractArchive(repo, sha, row.paths, tree);
      const copied = row.copy.map((c) => copyOne(repo, primary, tree, c));
      return { ref, sha, tree, copied };
    },
    runCmd(row, tree) {
      const cmd = substitute(row.cmd, { tree, repo, node: process.execPath, docker, image });
      const r = spawnSync(cmd[0], cmd.slice(1), {
        cwd: tree,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        timeout: row.timeoutMs ?? 280_000,
        windowsHide: true,
        env: { ...env, MSYS_NO_PATHCONV: '1' },
      });
      return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message, cmd, tree };
    },
  };
}

// ---- CLI ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { majors: [] };
  const val = (i) => {
    if (i + 1 >= argv.length) throw new InputError(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = val(i++);
    else if (a === '--major') o.majors.push(val(i++));
    else if (a === '--proofs') o.proofs = val(i++);
    else if (a === '--repo') o.repo = val(i++);
    else if (a === '--date') o.date = val(i++);
    else if (a === '--out') o.out = val(i++);
    else throw new InputError(`unknown argument ${a}`);
  }
  if (!o.check) throw new InputError('--check <name> is required');
  return o;
}

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function loadRows(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new InputError(`cannot read ${file}: ${e.message}`);
  }
  if (!Array.isArray(j.rows)) throw new InputError(`${file}: "rows" must be an array`);
  return j.rows;
}

const clip = (s) => (s.length > LOG_LIMIT ? `${s.slice(0, LOG_LIMIT)}\n[... ${s.length - LOG_LIMIT} more characters cut]` : s);

function logText(results) {
  const out = [];
  for (const r of results) {
    out.push(`==== ${r.ok ? 'PASS' : 'FAIL'} ${r.major} (${r.check})${r.note ? `  note: ${r.note}` : ''}`);
    if (r.setupError) out.push(...r.reasons);
    for (const k of ['pre', 'fix']) {
      if (!r[k]) continue;
      const raw = r.raw[k];
      out.push(`---- ${k} ${r[k].sha.slice(0, 8)} (${r[k].ref}) verdict=${r[k].verdict}${r[k].fireLine ? ` line=${r[k].fireLine}` : ''}${r[k].why ? ` why=${r[k].why}` : ''}`);
      out.push(`$ ${(raw.cmd ?? []).join(' ')}`, `exit ${raw.code}${raw.error ? ` error ${raw.error}` : ''}`, clip(raw.stdout ?? ''), clip(raw.stderr ?? ''));
    }
  }
  return `${out.join('\n')}\n`;
}

const stripRaw = ({ raw, ...rest }) => rest;

export function main(argv, io = { log: (s) => process.stdout.write(`${s}\n`) }, depsFor = realDeps) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.log(`prove-check: ${e.message}`);
    return 2;
  }
  const repo = path.resolve(o.repo ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const proofs = path.resolve(o.proofs ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'proofs.json'));
  let rows;
  try {
    rows = loadRows(proofs).filter((r) => r?.check === o.check && (o.majors.length === 0 || o.majors.includes(r.major))).map(validateRow);
  } catch (e) {
    io.log(`prove-check: ${e.message}`);
    return 2;
  }
  if (rows.length === 0) {
    io.log(`prove-check: check "${o.check}": no rows in ${proofs}${o.majors.length ? ` for ${o.majors.join(', ')}` : ''}. A run with no rows proves nothing.`);
    return 2;
  }
  const deps = depsFor({ repo });
  const results = rows.map((row) => proveRow(row, deps));
  for (const r of results) {
    io.log(r.ok
      ? `PASS ${r.major}  pre fire "${r.pre.fireLine}"  fix no-fire  (${r.pre.sha.slice(0, 8)} -> ${r.fix.sha.slice(0, 8)})`
      : `FAIL ${r.major}  ${r.reasons.join('; ')}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  const date = o.date ?? localDate();
  const out = path.resolve(o.out ?? path.join(repo, '.claude', 'cache', 'e2e'));
  mkdirSync(out, { recursive: true });
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  const summary = { rows: results.length, proven: results.length - failed, failed };
  writeFileSync(path.join(out, `${date}-prove-${o.check}.json`), `${JSON.stringify({ check: o.check, date, head, proofs, filter: o.majors, summary, rows: results.map(stripRaw) }, null, 2)}\n`);
  writeFileSync(path.join(out, `${date}-prove-${o.check}.txt`), logText(results));
  io.log(`prove-check ${o.check}: ${summary.rows} rows, ${summary.proven} proven, ${summary.failed} failed -> ${path.join(out, `${date}-prove-${o.check}.json`)}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
