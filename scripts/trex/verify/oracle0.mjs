// oracle0: the control arm of TREX verify. No model. It runs tests that already exist and judges the runs with prove-check.
//
// Two uses:
//   fix-diff replay (P0 calibration): for a bench row, take the test files the fix commit added or changed, run them at the
//     pre SHA (with the fix's copy of those files laid over the pre tree) and at the fix SHA, and judge: fire at pre, no fire at fix.
//   finding mode (P1 control arm): for a finding "file:line", pick the nearest existing tests with test-map selectFlows, run them
//     at head and at base, and report a differential: fail at head and pass at base.
//
// Where the tests run: on the host, in a plain `git archive` tree under <repo>/.claude/cache/proof/ (the prove-check way: no
// checkout, no reset, no worktree, never the primary checkout). The TREX container is not used. Why: `claude plugin test` needs the
// claude binary and the image has none; the Windows-only tests need Windows; a container costs a minute per side and holds the global
// TREX lock. The one thing the host cannot do is a Playwright spec that needs the Next server and a database: those specs run in the TREX
// container (oracle0-container.mjs), the same env.mjs environment the bench uses.
//
// classifyRun, judge, proveRow and acquireRowLock come from prove-check.mjs. Nothing of them is copied here.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyRun, judge, proveRow, realDeps } from '../../checks/prove-check.mjs';
import { selectFlows } from '../../checks/test-map.mjs';
import { archiveArgs } from '../base.mjs';

export const NODE_FIRE = '^not ok ';
export const PLUGIN_FIRE = '^\\(fail\\)';
export const PLAYWRIGHT_FIRE = '^(\\d+\\)|[\\u2716\\u2718\\u2717\\u00d7]|x\\s+\\d+)\\s';
const PLUGIN_RE = /^(\.claude\/plugins\/[^/]+)\/tests\/(.+\.test\.tsx?)$/;
const NODE_TEST_RE = /\.test\.(mjs|cjs|js)$/;
const SPEC_RE = /^apps\/agentic-os\/e2e\/.+\.spec\.ts$/;
const TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\.test\.ps1$)|(^|\/)(tests?|__tests__|fixtures|e2e)\//;
const PROOF_ROOT = ['.claude', 'cache', 'proof'];

// ---------- which files are tests ----------

/** True for a test, spec, fixture or e2e helper path. A README or a source file is not one. */
export const isTestPath = (p) => TEST_PATH.test(String(p).replace(/\\/g, '/'));

/** The fix-diff test files: changed or added test paths, minus the files that hold the seeded defect. */
export function overlayFiles(changed, defectFiles = []) {
  const defects = new Set(defectFiles.map((f) => f.replace(/\\/g, '/')));
  return changed.map((f) => f.replace(/\\/g, '/')).filter((f) => isTestPath(f) && !defects.has(f));
}

// ---------- which command runs them ----------

/** A spec that takes the `page` or `request` fixture needs the Next server and a database. A spec of pure functions does not. */
export const specNeedsServer = (text) => /async\s*\(\s*\{[^}]*\b(page|request|context|browser)\b/.test(text);

/**
 * Splits test files into runnable groups and skipped files.
 * readFile(path) -> text of the file at the fix SHA (used only to tell a pure spec from a server spec).
 * @returns {{ groups: Array<{kind, files, cmd, fireMatch, keep?}>, skipped: Array<{file, reason}> }}
 */
export function planRunners(files, readFile = () => '') {
  const node = [];
  const plugins = new Map();
  const pure = [];
  const server = [];
  const skipped = [];
  for (const f of files) {
    const plugin = PLUGIN_RE.exec(f);
    if (plugin) plugins.set(plugin[1], [...(plugins.get(plugin[1]) ?? []), f]);
    else if (NODE_TEST_RE.test(f)) node.push(f);
    else if (SPEC_RE.test(f)) (specNeedsServer(readFile(f)) ? server.push(f) : pure.push(f));
    else if (/\.test\.ps1$/.test(f)) skipped.push({ file: f, reason: 'PowerShell test prints "FAIL  <name>", a line shape prove-check classifyRun does not read: a run would be BROKEN whatever it did' });
    else skipped.push({ file: f, reason: 'not a test file (fixture or helper only): it rides along as an overlay, it is not run' });
  }
  const groups = [];
  if (node.length) groups.push({ kind: 'node', files: node, cmd: ['{node}', '--test', '--test-reporter=tap', ...node], fireMatch: NODE_FIRE });
  for (const [dir, list] of plugins) groups.push({ kind: `plugin:${dir.split('/').pop()}`, files: list, cmd: ['claude', 'plugin', 'test', dir], fireMatch: PLUGIN_FIRE, keep: { dir: `${dir}/tests`, files: list } });
  if (pure.length) groups.push({ kind: 'playwright-pure', files: pure, cmd: ['{node}', '{repo}/node_modules/@playwright/test/cli.js', 'test', '--config', PURE_CONFIG, '--reporter=list', ...pure.map((p) => p.replace(/^apps\/agentic-os\//, ''))], fireMatch: PLAYWRIGHT_FIRE, writeFiles: { [PURE_CONFIG]: pureConfig(pure) } });
  if (server.length) groups.push({ kind: 'playwright-server', files: server, container: true, cmd: ['npx', 'playwright', 'test', ...server], fireMatch: PLAYWRIGHT_FIRE });
  return { groups, skipped };
}

const PURE_CONFIG = 'apps/agentic-os/playwright.oracle0.config.ts';
function pureConfig(specs) {
  const names = specs.map((s) => s.replace(/^apps\/agentic-os\/e2e\//, ''));
  return `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './e2e', testMatch: ${JSON.stringify(names)}, timeout: 30000, retries: 0, workers: 1, forbidOnly: true, reporter: [['list']] });\n`;
}

// ---------- fix-diff plan ----------

const gitOut = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
};

/**
 * The plan for one bench row: which test files the fix adds or changes, how to run them, what is skipped.
 * row: { major, pre, fix, bench: { defectFiles } }. A row with no test file in its fix diff gives { attempted: false }.
 */
export function planFixDiff(repo, row) {
  const changed = gitOut(repo, ['diff', '--name-only', '--diff-filter=AMR', row.pre, row.fix]).split('\n').map((s) => s.trim()).filter(Boolean);
  const overlay = overlayFiles(changed, row.bench?.defectFiles ?? []);
  // A range of more than one commit means a fire at pre may come from a sibling change, not from the seeded defect. The report shows the count.
  const commits = Number.parseInt(gitOut(repo, ['rev-list', '--count', `${row.pre}..${row.fix}`]).trim(), 10);
  const base = { major: row.major, pre: row.pre, fix: row.fix, commits, changed, overlay };
  if (overlay.length === 0) return { ...base, groups: [], skipped: [], attempted: false, why: 'no test file in the fix diff' };
  const readFile = (f) => { try { return gitOut(repo, ['show', `${row.fix}:${f}`]); } catch { return ''; } };
  const { groups, skipped } = planRunners(overlay, readFile);
  const attempted = groups.length > 0;
  return { ...base, groups, skipped, attempted, why: attempted ? undefined : skipped.map((s) => `${s.file}: ${s.reason}`).join('; ') };
}

/** A prove-check row for one runner group of a plan. `oracle` carries what buildTree needs: the overlay and the pruning. */
export function groupRow(plan, group, { check = 'oracle0', timeoutMs } = {}) {
  return {
    major: `${plan.major}.${group.kind.replace(/[^A-Za-z0-9]+/g, '-')}`,
    check,
    pre: plan.pre,
    fix: plan.fix,
    paths: group.kind.startsWith('plugin:') ? [group.keep.dir.replace(/\/tests$/, '')] : ['.'],
    cmd: group.cmd,
    fireMatch: group.fireMatch,
    timeoutMs: timeoutMs ?? 280_000,
    note: `fix-diff replay ${plan.major} ${group.kind}: ${group.files.join(', ')}`,
    oracle: { overlay: plan.overlay, keep: group.keep, writeFiles: group.writeFiles ?? {}, container: group.container === true, specs: group.container ? group.files : undefined },
  };
}

// ---------- trees ----------

function resetTree(repo, tree) {
  const root = path.join(path.resolve(repo), ...PROOF_ROOT);
  const rel = path.relative(root, path.resolve(tree));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to clear ${tree}: not inside ${root}`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
}

function extract(repo, sha, paths, tree) {
  const a = spawnSync('git', ['-C', repo, ...archiveArgs(sha, paths)], { maxBuffer: 1 << 29 });
  if (a.status !== 0) throw new Error(`git archive ${sha} ${paths.join(' ')}: ${String(a.stderr).trim()}`);
  const winTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const tar = process.env.TAR_BIN ?? (existsSync(winTar) ? winTar : 'tar');
  const x = spawnSync(tar, ['-xf', '-'], { cwd: tree, input: a.stdout, maxBuffer: 1 << 26 });
  if (x.status !== 0) throw new Error(`tar -x in ${tree}: ${String(x.stderr).trim() || x.error?.message}`);
}

/** Delete the *.test.ts(x) files of `dir` that are not in `keepFiles`, so `claude plugin test` runs only the fix-diff tests. */
export function pruneTests(tree, dir, keepFiles) {
  const keep = new Set(keepFiles.map((f) => path.normalize(path.join(tree, f))));
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name) && !keep.has(path.normalize(p))) rmSync(p);
    }
  };
  if (existsSync(path.join(tree, dir))) walk(path.join(tree, dir));
}

const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Deps for proveRow. The tree for the pre side gets the fix's copy of the overlay files laid over it: at pre those tests do not
 * exist yet. The tree for the fix side is the fix SHA alone. Everything else (acquire, runCmd) is prove-check's own.
 */
export function oracleDeps({ repo, env = process.env, treeRoot = repo }) {
  const real = realDeps({ repo, env });
  return {
    acquire: real.acquire,
    runCmd: real.runCmd,
    buildTree(row, ref) {
      const sha = gitOut(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
      const tree = path.join(treeRoot, ...PROOF_ROOT, sha.slice(0, 8), `${slug(row.check)}-${slug(row.major)}`);
      resetTree(treeRoot, tree);
      extract(repo, sha, row.paths, tree);
      const o = row.oracle ?? {};
      const copied = [];
      if (ref === row.pre && o.overlay?.length) {
        extract(repo, row.fix, o.overlay, tree);
        copied.push(...o.overlay.map((f) => ({ from: `${row.fix}:${f}`, to: f })));
      }
      for (const [file, text] of Object.entries(o.writeFiles ?? {})) {
        mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
        writeFileSync(path.join(tree, file), text);
      }
      if (o.keep) pruneTests(tree, o.keep.dir, o.keep.files);
      return { ref, sha, tree, copied };
    },
  };
}

// ---------- fix-diff verdict per bench row ----------

/**
 * One bench row from its sub-row results. Proven when at least one runner group fires at pre and is clean at fix,
 * and no group fires or breaks at the fix side. A group that is BROKEN at pre is reported, it does not prove anything.
 */
export function rowVerdict(results) {
  if (results.length === 0) return { proven: false, why: 'no runner group ran' };
  const okOnes = results.filter((r) => r.ok);
  const fixBad = results.filter((r) => r.fix && r.fix.verdict !== 'no-fire');
  if (fixBad.length) return { proven: false, why: `fix side not clean: ${fixBad.map((r) => `${r.major} ${r.fix.verdict}`).join(', ')}` };
  if (okOnes.length === 0) return { proven: false, why: results.map((r) => `${r.major}: ${r.reasons.join('; ')}`).join(' | ') };
  return { proven: true, why: `${okOnes.map((r) => r.major).join(', ')}` };
}

/**
 * Run every group of a plan. Host groups go through proveRow with deps = oracleDeps(...). Container groups go through
 * containerRun(row) -> Promise<proveRow-shaped result>. A container group with no containerRun is a setup error, not a skip.
 * Never throws: a setup error is a result.
 */
export async function runPlan(plan, deps, containerRun, opts = {}) {
  const out = [];
  for (const g of plan.groups) {
    const row = groupRow(plan, g, opts);
    if (!g.container) { out.push(proveRow(row, deps)); continue; }
    if (!containerRun) { out.push({ major: row.major, check: row.check, ok: false, reasons: ['setup error: no container runner given'], setupError: true }); continue; }
    try { out.push(await containerRun(row)); } catch (e) { out.push({ major: row.major, check: row.check, ok: false, reasons: [`setup error: ${e.message}`], setupError: true }); }
  }
  return out;
}

// ---------- finding mode ----------

const stripExt = (p) => p.replace(/\.[cm]?[jt]sx?$/, '');
const stripTestExt = (p) => stripExt(p.replace(/\.(test|spec)(?=\.[cm]?[jt]sx?$)/, ''));

/** Resolve a relative import of a test file to the repo paths it may name (extension tried, index too). */
export function importTargets(testPath, text, listed) {
  const out = [];
  const dir = path.posix.dirname(testPath);
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.posix.normalize(path.posix.join(dir, m[1]));
    out.push(...listed.filter((f) => f === base || stripExt(f) === stripExt(base) || stripExt(f) === `${stripExt(base)}/index`));
  }
  return [...new Set(out)];
}

/**
 * One test-map flow per test file. A flow covers the files its test imports, and the file it is named after
 * (`foo.test.mjs` covers `foo.mjs`, `tests/foo.test.ts` covers `foo.*` anywhere under the same plugin).
 * listed: every tracked path. read(path) -> text.
 */
export function testFlows(listed, read) {
  return listed.filter((f) => isTestPath(f) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)).map((t) => {
    const paths = importTargets(t, read(t) ?? '', listed);
    const name = path.posix.basename(stripTestExt(t));
    const dir = path.posix.dirname(t);
    paths.push(...listed.filter((f) => !isTestPath(f) && path.posix.basename(stripExt(f)) === name && (path.posix.dirname(f) === dir || PLUGIN_RE.test(t) && f.startsWith(`${t.split('/tests/')[0]}/`))));
    return { id: t, paths: [...new Set(paths)] };
  });
}

/** The nearest existing tests for a finding file: test-map selectFlows over the test flows. */
export function nearestTests(flows, findingFile, opts = {}) {
  return selectFlows(flows, { paths: [findingFile.replace(/\\/g, '/')] }, opts).selected.map((s) => s.id);
}

/**
 * The differential for one finding: a test run at head and one at base, classified one by one with prove-check's classifyRun.
 *   differential-fail  fires at head, clean at base: free evidence of a regression
 *   preexisting-fail   fires at both: the test says nothing about this head
 *   no-signal          clean at head
 *   broken             either run could not run the test (an import error is never a fire)
 */
export function differential(row, headRun, baseRun) {
  const head = classifyRun(row, headRun);
  const base = classifyRun(row, baseRun);
  const detail = { head, base };
  if (head.verdict === 'broken' || base.verdict === 'broken') return { verdict: 'broken', ...detail };
  if (head.verdict === 'fire' && base.verdict === 'no-fire') return { verdict: 'differential-fail', ...detail };
  if (head.verdict === 'fire') return { verdict: 'preexisting-fail', ...detail };
  return { verdict: 'no-signal', ...detail };
}

export { classifyRun, judge };
