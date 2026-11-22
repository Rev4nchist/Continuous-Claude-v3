#!/usr/bin/env node
/**
 * validate-mods.mjs - Gate for a Claude Code function-hook plugin (the ccv3-mods mods).
 *
 * Runs three checks and prints one summary line:
 *   1. `claude plugin validate --json <dir>`: fails when the plugin is invalid, or when any
 *      entry of `gatingHooks` (manifest or contents) has hasCatch !== true. A gating hook is
 *      one whose answer can refuse a tool call, prompt, command or setting. Without a `.catch`
 *      a hook that throws is skipped and the refusal silently does not happen.
 *   2. `tsc -p <dir>`: needs the engine-written <dir>/.claude-plugin/types/. On 2.1.296 no command
 *      this gate runs writes it, so a folder without it gets a copy of the primary checkout's.
 *      The summary line names the date of the types in use. Types older than the engine are a
 *      risk: refresh them by loading the plugin, or point TYPES_SRC at a newer folder.
 *   3. `claude plugin test <dir>`: fails on a failing test, or on zero tests (a vacuous gate).
 *
 *      The gate also fails when the report has no `gatingHooks` key at all, or lists fewer than
 *      --min-gating hooks (default 1). Without that floor a renamed key would pass with zero hooks.
 *
 * Usage: node scripts/mods/validate-mods.mjs [plugin-dir] [--min-gating N]   (default dir .claude/plugins/ccv3-mods)
 * Env:   TSC_JS = path to typescript/bin/tsc, when none is found under .claude/hooks.
 *        TYPES_SRC = a .claude-plugin/types folder to copy when the plugin folder has none.
 * Exit code: 1 when any check fails. ASCII only, node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The plugin folder and the --min-gating floor named on the command line. The folder is the first argument that is not
 * a flag and not the value of --min-gating. With no --min-gating, minAt is -1 and `i !== minAt + 1` would skip
 * argument 0: the folder named on the command line (the bug this guards: the gate then checked the default folder).
 */
export const parseArgs = (args, defaultDir) => {
  const minAt = args.indexOf('--min-gating');
  const minGating = minAt >= 0 && Number.isInteger(Number(args[minAt + 1])) ? Number(args[minAt + 1]) : 1;
  const named = args.find((a, i) => !a.startsWith('--') && (minAt < 0 || i !== minAt + 1));
  return { pluginDir: resolve(named ?? defaultDir), minGating };
};

const { pluginDir, minGating } = parseArgs(process.argv.slice(2), join(repoRoot, '.claude/plugins/ccv3-mods'));
/** The test step runs the suite in shards (see checkTest) on one clock that main starts before validate and tsc, under the 10 minutes pre-pr gives this gate (pre-pr.mjs, id 'mod'). */
export const TEST_LIMIT_MS = 9 * 60_000;
export const SHARD_FILES = 11;
const sh = (cmd, args, timeout = 280_000) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
const firstLines = (text, n = 12) => text.trim().split(/\r?\n/).slice(0, n).join('\n');

/** Every gating hook the validate report lists, wherever it sits in the report. */
export const gatingHooksOf = report => [
  ...(report?.manifest?.gatingHooks ?? []),
  ...(report?.contents ?? []).flatMap(entry => entry.gatingHooks ?? []),
];

/** Gating hooks that lack a `.catch`. A missing flag counts as missing. */
export const withoutCatch = hooks => hooks.filter(hook => hook.hasCatch !== true);

/** Why the .catch gate cannot be trusted or has failed: a lost list, too few hooks, or a bare hook. */
export const gatingProblems = (report, min) => {
  const entries = [report?.manifest, ...(report?.contents ?? [])];
  if (!entries.some(entry => Array.isArray(entry?.gatingHooks))) {
    return ['validate: the report has no gatingHooks key; the .catch gate cannot run (found 0)'];
  }
  const hooks = gatingHooksOf(report);
  const problems = [];
  if (hooks.length < min) problems.push(`validate: found ${hooks.length} gating hooks, expected at least ${min}`);
  for (const hook of withoutCatch(hooks)) problems.push(`validate: gating hook without .catch: ${label(hook)}`);
  return problems;
};

/**
 * Command names the engine refuses. `claude plugin validate` reports one as a warning ("/x" is a name Claude Code ships: $.command.register
 * refuses it and the hook that calls it is skipped). The test kit accepts any name, so without this check such a command passes every test and
 * is dead in a live session (PR C: /checkpoint).
 */
export const refusedCommandProblems = report =>
  [report?.manifest, ...(report?.contents ?? [])]
    .flatMap(entry => entry?.warnings ?? [])
    .map(warning => (typeof warning === 'string' ? warning : (warning?.message ?? '')))
    .filter(message => /is a name Claude Code ships/.test(message))
    .map(message => `validate: refused command name: ${message}`);

const label = hook => `${hook.module ?? '?'} ${hook.hook ?? hook.pattern ?? '?'}`;

const checkValidate = () => {
  const ran = sh('claude', ['plugin', 'validate', '--json', pluginDir]);
  let report;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    return { ok: false, note: `validate: no JSON from claude (exit ${ran.status})\n${firstLines(`${ran.stdout}${ran.stderr ?? ''}`)}` };
  }
  const hooks = gatingHooksOf(report);
  const bare = withoutCatch(hooks);
  const problems = [];
  if (report.success !== true) problems.push('validate: the plugin is not valid');
  for (const entry of [report.manifest, ...(report.contents ?? [])]) {
    for (const error of entry?.errors ?? []) problems.push(`validate: ${entry.file}: ${typeof error === 'string' ? error : JSON.stringify(error)}`);
  }
  problems.push(...gatingProblems(report, minGating));
  problems.push(...refusedCommandProblems(report));
  return { ok: problems.length === 0, note: problems.join('\n'), short: `validate ${problems.length === 0 ? 'OK' : 'FAIL'} (${hooks.length} gating hook${hooks.length === 1 ? '' : 's'}, ${bare.length} without .catch)` };
};

/** The primary checkout: the worktree's own root, or the folder that holds the shared .git. */
const primaryRoot = () => {
  const common = sh('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir']).stdout?.trim();
  return common ? resolve(repoRoot, common, '..') : repoRoot;
};

const findTsc = () => {
  const rel = '.claude/hooks/node_modules/typescript/bin/tsc';
  return [process.env.TSC_JS, join(repoRoot, rel), join(primaryRoot(), rel), join(repoRoot, 'node_modules/typescript/bin/tsc')].find(p => p && existsSync(p));
};

/**
 * The engine writes .claude-plugin/types/ (gitignored), and on 2.1.296 `claude plugin validate`, `claude plugin test`
 * and a headless `claude -p` all leave it out. A fresh worktree has none, so copy the primary checkout's.
 * TYPES_SRC names another source folder. Returns the folder's tsconfig date, `{ error }` naming the path when the copy
 * or the date read fails (a read-only folder must not stop the other two checks), or null when no copy exists.
 */
const ensureTypes = () => {
  const own = join(pluginDir, '.claude-plugin/types');
  let copied = false;
  try {
    if (!existsSync(join(own, 'tsconfig.json'))) {
      const donor = process.env.TYPES_SRC ?? join(primaryRoot(), '.claude/plugins/ccv3-mods/.claude-plugin/types');
      if (!existsSync(join(donor, 'tsconfig.json'))) return null;
      cpSync(donor, own, { recursive: true, preserveTimestamps: true });
      copied = true;
    }
    return { date: statSync(join(own, 'tsconfig.json')).mtime.toISOString().slice(0, 10), copied };
  } catch (err) {
    return { error: `${own}: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const checkTsc = () => {
  const types = ensureTypes();
  if (types?.error) return { ok: false, note: `tsc: NOT RUN, the types folder could not be copied or read: ${types.error}`, short: 'tsc NOT RUN' };
  if (!types) {
    return {
      ok: false,
      note: 'tsc: NOT RUN, no .claude-plugin/types/ in the plugin folder or in the primary checkout. On 2.1.296 validate, test and a headless claude -p do not write it. Copy it from a checkout that has one (set TYPES_SRC to its folder).',
      short: 'tsc NOT RUN',
    };
  }
  const tsc = findTsc();
  if (!tsc) return { ok: false, note: 'tsc: NOT RUN, no typescript found. Set TSC_JS or run npm install in .claude/hooks.', short: 'tsc NOT RUN' };
  const ran = sh(process.execPath, [tsc, '-p', pluginDir]);
  const ok = ran.status === 0;
  const from = `types ${types.date}${types.copied ? ', copied' : ''}`;
  return { ok, note: ok ? '' : `tsc: exit ${ran.status}\n${firstLines(ran.stdout + (ran.stderr ?? ''), 20)}`, short: `tsc ${ok ? 'OK' : 'FAIL'} (${from})` };
};

const isTest = name => /\.test\.tsx?$/.test(name);
/** Every test file under the plugin folder, as a path relative to it, sorted: a fixed order, so a run can be repeated. node_modules is left out. */
export const testFilesOf = dir => {
  const walk = sub => readdirSync(join(dir, sub), { withFileTypes: true }).flatMap(e => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(`${sub}${e.name}/`) : [`${sub}${e.name}`]));
  return existsSync(dir) ? walk('').filter(isTest).sort() : [];
};
export const shardsOf = (files, size = SHARD_FILES) => Array.from({ length: Math.ceil(files.length / size) }, (_, i) => files.slice(i * size, (i + 1) * size));
/** The engine runs every test file of the folder it is given, and starts one child for each at once (a full run then misses its 5 s test limit in a different set of tests each time). So a part of the suite gets its own folder: a temp copy of the plugin without node_modules and without the test files of the other shards. */
export const makeShard = (dir, files) => {
  const keep = new Set(files);
  const root = mkdtempSync(join(tmpdir(), 'mods-shard-'));
  cpSync(dir, root, { recursive: true, filter: src => !/[\\/]node_modules$/.test(src) && (!isTest(src) || keep.has(relative(dir, src).split('\\').join('/'))) });
  return root;
};
export const leftMs = (startedAt, now, limitMs) => limitMs - (now - startedAt);
/** Removes the temp folder this run made. On Windows a child the timeout stopped can still hold a file: retry, and if it stays, print the path and go on (the verdict is not lost). */
export const removeShard = (dir, remove = rmSync) => {
  try {
    remove(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    console.log(`mods gate: could not remove the temp folder ${dir}`);
  }
};
const countsOf = (out, status) => {
  const count = word => Number((out.match(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'm')) ?? [])[1] ?? NaN);
  return { status, pass: count('pass'), fail: count('fail'), lines: out.split(/\r?\n/).filter(l => /^\(fail\)/.test(l) || /Error|Expected|Received/.test(l)) };
};
/** The verdict of all shards: counts summed, the failing lines of every shard kept, and a step the limit stopped says "stopped at N s" in place of "NaN pass NaN fail". */
export const shardsVerdict = (rows, stopped, limitMs) => {
  const sum = key => rows.reduce((n, r) => n + (Number.isNaN(r[key]) ? 0 : r[key]), 0);
  const [pass, fail, secs] = [sum('pass'), sum('fail'), Math.round(limitMs / 1000)];
  const blind = rows.some(r => Number.isNaN(r.pass) || Number.isNaN(r.fail));
  const ok = !stopped && !blind && rows.length > 0 && rows.every(r => r.status === 0) && fail === 0 && pass > 0;
  const why = stopped ? `stopped at ${secs} s` : blind ? 'a shard printed no pass/fail count' : pass === 0 ? 'zero tests ran (vacuous gate)' : `${fail} failing`;
  return { ok, why, lines: rows.flatMap(r => r.lines), short: stopped ? `test stopped at ${secs} s` : `test ${pass} pass ${fail} fail` };
};

const checkTest = started => {
  const rows = [];
  let stopped = false;
  for (const files of shardsOf(testFilesOf(pluginDir))) {
    const left = leftMs(started, Date.now(), TEST_LIMIT_MS);
    if (left <= 0) { stopped = true; break; }
    const shard = makeShard(pluginDir, files);
    try {
      const ran = sh('claude', ['plugin', 'test', shard], left);
      stopped = ran.error?.code === 'ETIMEDOUT';
      rows.push(countsOf(`${ran.stdout ?? ''}${ran.stderr ?? ''}`, ran.status));
    } finally {
      removeShard(shard);
    }
    if (stopped) break;
  }
  const verdict = shardsVerdict(rows, stopped, TEST_LIMIT_MS);
  return { ok: verdict.ok, note: verdict.ok ? '' : `test: ${verdict.why}\n${firstLines(verdict.lines.join('\n'), 20)}`, short: verdict.short };
};

const main = () => {
  const started = Date.now();
  const results = [checkValidate(), checkTsc(), checkTest(started)];
  for (const result of results.filter(r => !r.ok)) console.log(result.note);
  const failed = results.some(r => !r.ok);
  const shorts = results.map(r => r.short ?? 'FAIL');
  console.log(`mods ${failed ? 'FAIL' : 'OK'}: ${shorts.join(' | ')}`);
  process.exit(failed ? 1 : 0);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
