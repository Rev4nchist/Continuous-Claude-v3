// Tests for engine-version.mjs: the reviewer-set and band-set hashes at one git commit (map.md "Freeze set (B3)").
// Every repo here is a synthetic temp git repo. No real pull request, no real review data, no model run.
// Each test names the source change that breaks it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAND_SET_FILES, BAND_SET_IMPORT_EXEMPT, EXEMPT_LOCAL_REVIEW_KEYS, REVIEWER_SET_FILES,
  bandVersion, computeVersions, engineVersion, importClosureGaps, relativeImports, reviewerVersion,
} from './engine-version.mjs';
import * as router from '../../github/review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, 'engine-version.mjs');
const WORKTREE = path.resolve(HERE, '..', '..', '..');
const ROUTER = 'scripts/github/review-router.mjs';
const CONFIG = 'review-router.config.json';
const DIR = 'scripts/github/local-review/';

// An inherited GIT_DIR (a hook, a worktree run) would send these commits into the real repo: drop every GIT_* variable.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmpDir = () => { const d = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'engine-version-')); made.push(d); return d; };

const baseConfig = () => ({
  _doc: 'synthetic',
  greptile: { tier: 'low' },
  coderabbit: { enabled: true, demoted: { critical: false } },
  matrix: { control_plane: ['a.mjs', 'b.mjs'], weights: { x: 1, y: 2 } },
  local_review: {
    enabled: true, bands: ['MID', 'HIGH'], max_concurrent: 2, per_branch_cap: 8, retry_max: 1, slot_wait_min: 60,
    timeout_min: 40, context_cap_kb: 48, skip_authors: ['bot-a'], headless_daily_cap: 30,
  },
});

function baseFiles() {
  const files = {};
  for (const f of REVIEWER_SET_FILES) files[f] = `// synthetic ${f}\n`;
  files[`${DIR}prompt.mjs`] = 'export const PROMPT_VERSION = 1;\n';
  files[`${DIR}prompt.test.mjs`] = '// synthetic test\n';
  files[ROUTER] = 'export function bandOf() { return "MID"; }\n';
  files[CONFIG] = `${JSON.stringify(baseConfig(), null, 2)}\n`;
  files['README.md'] = 'synthetic repo\n';
  return files;
}

/** A temp repo with the synthetic files committed. commit(changes): path -> content (string or Buffer) or null (delete); returns the new sha. */
function makeRepo(files = baseFiles()) {
  const dir = tmpDir();
  const run = (...a) => execFileSync('git', a, { cwd: dir, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) run('config', k, v);
  const write = (changes) => {
    for (const [p, c] of Object.entries(changes)) {
      const abs = path.join(dir, ...p.split('/'));
      if (c === null) { unlinkSync(abs); continue; }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, c);
    }
  };
  const commit = (changes = {}) => {
    write(changes);
    run('add', '-A');
    run('commit', '-q', '--allow-empty', '-m', 'c');
    return run('rev-parse', 'HEAD');
  };
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', windowsHide: true });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const sha0 = commit(files);
  return { dir, run, write, commit, git, sha0 };
}

const at = (repo, sha) => computeVersions({ sha, root: repo.dir, git: repo.git });
const configWith = (edit) => { const c = baseConfig(); edit(c); return `${JSON.stringify(c, null, 2)}\n`; };
const cli = (args) => spawnSync(process.execPath, [MODULE, ...args], { env: ENV, encoding: 'utf8', windowsHide: true });

// 1
test('one sha gives the same versions twice, and the CLI prints the same lines twice', () => {
  // Breaks when: the hash text holds a time, a random value or an unsorted list; or the CLI output format changes.
  const r = makeRepo();
  const a = at(r, r.sha0);
  const b = at(r, r.sha0);
  assert.equal(a.reviewerVersion, b.reviewerVersion);
  assert.equal(a.bandVersion, b.bandVersion);
  assert.match(a.reviewerVersion, /^[0-9a-f]{16}$/);
  assert.match(a.bandVersion, /^[0-9a-f]{16}$/);
  assert.notEqual(a.reviewerVersion, a.bandVersion);
  const one = cli(['--sha', r.sha0, '--root', r.dir]);
  const two = cli(['--sha', r.sha0, '--root', r.dir]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, two.stdout);
  assert.equal(one.stdout, `engineVersion ${a.engineVersion}\nbandVersion ${a.bandVersion}\n`);
  const j = cli(['--sha', r.sha0, '--root', r.dir, '--json']);
  assert.equal(j.status, 0, j.stderr);
  const o = JSON.parse(j.stdout);
  assert.equal(o.sha, r.sha0);
  assert.equal(o.engineVersion, a.engineVersion);
  assert.equal(o.bandVersion, a.bandVersion);
  assert.deepEqual(o.bandFiles.map((f) => f.path), [ROUTER]);
});

// 2
test('a change to each reviewer-set file changes reviewerVersion and not bandVersion', () => {
  // Breaks when: a file is dropped from REVIEWER_SET_FILES or its blob id is left out of the hash text.
  // The paths are written out, not taken from the constant: a path dropped from REVIEWER_SET_FILES then fails here.
  const LISTED = [
    'scripts/github/local-review.mjs', 'scripts/github/cursor-review.mjs', 'scripts/github/review-filter.mjs', 'scripts/github/lib/file-lock.mjs',
    'scripts/github/lib/grok-slots.mjs', 'scripts/github/lib/findings-repair.mjs', 'scripts/github/lib/proc.mjs', 'scripts/ratchets/review-skip-sync.mjs',
  ];
  assert.deepEqual([...REVIEWER_SET_FILES], LISTED);
  const r = makeRepo();
  const base = at(r, r.sha0);
  for (const f of [...LISTED, `${DIR}prompt.mjs`]) {
    const sha = r.commit({ [f]: `// changed ${f}\n` });
    const v = at(r, sha);
    assert.notEqual(v.reviewerVersion, base.reviewerVersion, f);
    assert.equal(v.bandVersion, base.bandVersion, f);
    r.commit({ [f]: baseFiles()[f] });
  }
});

// 3
test('a change to review-router.mjs changes bandVersion and not reviewerVersion', () => {
  // Breaks when: the router blob is left out of the band text, or is also put into the reviewer text.
  const r = makeRepo();
  const base = at(r, r.sha0);
  const v = at(r, r.commit({ [ROUTER]: 'export function bandOf() { return "HIGH"; }\n' }));
  assert.notEqual(v.bandVersion, base.bandVersion);
  assert.equal(v.reviewerVersion, base.reviewerVersion);
});

// 4
test('the five exempt local_review keys change neither version, also from absent to present', () => {
  // Breaks when: an exempt key is hashed, or the filter misses one of the five.
  const r = makeRepo();
  const base = at(r, r.sha0);
  const edits = {
    weekly_live_cap: (lr) => { lr.weekly_live_cap = 100; }, // absent today: absent -> present
    max_concurrent: (lr) => { lr.max_concurrent = 5; },
    per_branch_cap: (lr) => { lr.per_branch_cap = 99; },
    slot_wait_min: (lr) => { lr.slot_wait_min = 1; },
    headless_daily_cap: (lr) => { delete lr.headless_daily_cap; }, // present -> absent
  };
  for (const [k, edit] of Object.entries(edits)) {
    const v = at(r, r.commit({ [CONFIG]: configWith((c) => edit(c.local_review)) }));
    assert.equal(v.reviewerVersion, base.reviewerVersion, k);
    assert.equal(v.bandVersion, base.bandVersion, k);
  }
  const v = at(r, r.commit({ [CONFIG]: configWith((c) => { c.local_review.weekly_live_cap = 300; c.local_review.max_concurrent = 9; c.local_review.headless_daily_cap = 1; }) }));
  assert.equal(v.reviewerVersion, base.reviewerVersion, 'all caps at once');
});

test('the exempt list is exactly the five cap and slot keys of the map', () => {
  // Breaks when: a key is added to or removed from EXEMPT_LOCAL_REVIEW_KEYS without a map change.
  assert.deepEqual([...EXEMPT_LOCAL_REVIEW_KEYS].sort(), ['headless_daily_cap', 'max_concurrent', 'per_branch_cap', 'slot_wait_min', 'weekly_live_cap']);
});

test('every other local_review key changes reviewerVersion only', () => {
  // Breaks when: the filter removes more than the five keys (timeout_min, skip_authors, ...), or the block is not hashed.
  const r = makeRepo();
  const base = at(r, r.sha0);
  const edits = {
    timeout_min: (lr) => { lr.timeout_min = 41; },
    skip_authors: (lr) => { lr.skip_authors.push('bot-b'); },
    enabled: (lr) => { lr.enabled = false; },
    bands: (lr) => { lr.bands = ['HIGH']; },
    retry_max: (lr) => { lr.retry_max = 2; },
    new_key: (lr) => { lr.union_runs = false; },
  };
  for (const [k, edit] of Object.entries(edits)) {
    const v = at(r, r.commit({ [CONFIG]: configWith((c) => edit(c.local_review)) }));
    assert.notEqual(v.reviewerVersion, base.reviewerVersion, k);
    assert.equal(v.bandVersion, base.bandVersion, k);
  }
});

test('a matrix change changes bandVersion only; a coderabbit or other block change changes neither', () => {
  // Breaks when: the matrix block is not in the band text, or the whole config blob (or another block) is hashed.
  const r = makeRepo();
  const base = at(r, r.sha0);
  const m = at(r, r.commit({ [CONFIG]: configWith((c) => { c.matrix.control_plane.push('c.mjs'); }) }));
  assert.notEqual(m.bandVersion, base.bandVersion);
  assert.equal(m.reviewerVersion, base.reviewerVersion);
  for (const [k, edit] of Object.entries({
    coderabbit: (c) => { c.coderabbit.demoted.critical = true; c.coderabbit.blind_sample_rate = 0; },
    greptile: (c) => { c.greptile.tier = 'high'; },
    newBlock: (c) => { c.capacity = { x: 1 }; },
    doc: (c) => { c._doc = 'another text'; },
  })) {
    const v = at(r, r.commit({ [CONFIG]: configWith(edit) }));
    assert.equal(v.reviewerVersion, base.reviewerVersion, k);
    assert.equal(v.bandVersion, base.bandVersion, k);
  }
  const ws = at(r, r.commit({ [CONFIG]: `${JSON.stringify(baseConfig())}\n` })); // same JSON, other whitespace: another blob
  assert.equal(ws.reviewerVersion, base.reviewerVersion, 'whitespace');
  assert.equal(ws.bandVersion, base.bandVersion, 'whitespace');
});

// 5
test('a new non-test file under local-review/ changes reviewerVersion, also nested or json', () => {
  // Breaks when: the directory rule is dropped, is not recursive, or takes only *.mjs files.
  const r = makeRepo();
  let prev = at(r, r.sha0);
  for (const f of [`${DIR}refs.mjs`, `${DIR}backends/cursor.mjs`, `${DIR}checklist.json`]) {
    const v = at(r, r.commit({ [f]: '// new\n' }));
    assert.notEqual(v.reviewerVersion, prev.reviewerVersion, f);
    assert.equal(v.bandVersion, prev.bandVersion, f);
    assert.ok(v.reviewerFiles.some((x) => x.path === f), f);
    prev = v;
  }
});

test('a new or changed *.test.mjs under local-review/, or a file outside the sets, changes nothing', () => {
  // Breaks when: the test-file filter is dropped, or the whole scripts/github tree is hashed.
  const r = makeRepo();
  const base = at(r, r.sha0);
  for (const change of [
    { [`${DIR}refs.test.mjs`]: '// new test\n' },
    { [`${DIR}prompt.test.mjs`]: '// changed test\n' },
    { [`${DIR}backends/cursor.test.mjs`]: '// nested test\n' },
    { 'scripts/github/review-status.mjs': '// outside\n' },
    { 'README.md': 'other\n' },
  ]) {
    const v = at(r, r.commit(change));
    assert.equal(v.reviewerVersion, base.reviewerVersion, Object.keys(change)[0]);
    assert.equal(v.bandVersion, base.bandVersion, Object.keys(change)[0]);
    assert.ok(!v.reviewerFiles.some((x) => x.path.endsWith('.test.mjs')));
  }
});

// 6
test('the value comes from the commit, never from the working tree or the index', () => {
  // Breaks when: a file is read from disk (readFileSync) or from the index in place of the commit's tree.
  const r = makeRepo();
  const base = at(r, r.sha0);
  r.write({ 'scripts/github/local-review.mjs': '// dirty\r\n', [ROUTER]: '// dirty\n', [CONFIG]: configWith((c) => { c.local_review.timeout_min = 1; c.matrix.x = 2; }), [`${DIR}new.mjs`]: 'x\n' });
  const dirty = at(r, r.sha0);
  assert.equal(dirty.reviewerVersion, base.reviewerVersion);
  assert.equal(dirty.bandVersion, base.bandVersion);
  r.run('add', '-A'); // staged, not committed
  const staged = at(r, r.sha0);
  assert.equal(staged.reviewerVersion, base.reviewerVersion);
  assert.equal(staged.bandVersion, base.bandVersion);
});

test('CRLF bytes committed in place of LF are another blob, so another reviewerVersion', () => {
  // Documents the rule: the value is a function of the blob ids, not of a normalized text. Breaks when: content is normalized before hashing.
  const r = makeRepo();
  const lf = at(r, r.commit({ 'scripts/github/review-filter.mjs': 'a\nb\n' }));
  const crlf = at(r, r.commit({ 'scripts/github/review-filter.mjs': Buffer.from('a\r\nb\r\n') }));
  assert.notEqual(crlf.reviewerVersion, lf.reviewerVersion);
  assert.equal(crlf.bandVersion, lf.bandVersion);
});

// 7
test('key order in the config JSON changes no version; array order does', () => {
  // Breaks when: the canonical JSON does not sort keys recursively (plain JSON.stringify of the parsed block).
  const r = makeRepo();
  const base = at(r, r.sha0);
  const reverse = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reverse(v)])) : o);
  const v = at(r, r.commit({ [CONFIG]: `${JSON.stringify(reverse(baseConfig()), null, 2)}\n` }));
  assert.equal(v.reviewerVersion, base.reviewerVersion);
  assert.equal(v.bandVersion, base.bandVersion);
  const arr = at(r, r.commit({ [CONFIG]: configWith((c) => { c.local_review.bands.reverse(); }) }));
  assert.notEqual(arr.reviewerVersion, base.reviewerVersion, 'array order is data');
});

// 8
test('errors: a bad sha, a sha not in the repo, or a tree or blob id', () => {
  // Breaks when: the sha check is dropped or only rev-parse is used (a tree id would pass).
  const r = makeRepo();
  assert.throws(() => at(r, 'abc'), /40 hex/);
  assert.throws(() => at(r, `${r.sha0}0`), /40 hex/);
  assert.throws(() => at(r, 'HEAD'), /40 hex/);
  assert.throws(() => at(r, 'deadbeef'.repeat(5)), /not a commit/);
  assert.throws(() => at(r, r.run('rev-parse', `${r.sha0}^{tree}`)), /not a commit/);
  assert.throws(() => at(r, r.run('rev-parse', `${r.sha0}:README.md`)), /not a commit/);
});

test('errors: a listed file missing at the commit names every missing path', () => {
  // Breaks when: a missing listed file is skipped in silence (the version of a smaller set).
  const r = makeRepo();
  const sha = r.commit({ 'scripts/github/lib/proc.mjs': null, [ROUTER]: null });
  assert.throws(() => at(r, sha), (e) => /missing/.test(e.message)
    && e.message.includes('scripts/github/lib/proc.mjs') && e.message.includes(ROUTER)
    && JSON.stringify(e.missing) === JSON.stringify(['scripts/github/lib/proc.mjs', ROUTER].sort()));
});

test('errors: config missing, not JSON, or without a local_review or matrix object', () => {
  // Breaks when: a missing block hashes as undefined/null in place of an error, or a parse error is swallowed.
  const r = makeRepo();
  assert.throws(() => at(r, r.commit({ [CONFIG]: '{ "local_review": ' })), /not valid JSON/);
  assert.throws(() => at(r, r.commit({ [CONFIG]: configWith((c) => { delete c.local_review; }) })), /local_review/);
  assert.throws(() => at(r, r.commit({ [CONFIG]: configWith((c) => { c.local_review = [1]; }) })), /local_review/);
  assert.throws(() => at(r, r.commit({ [CONFIG]: configWith((c) => { delete c.matrix; }) })), /matrix/);
  assert.throws(() => at(r, r.commit({ [CONFIG]: configWith((c) => { c.matrix = null; }) })), /matrix/);
  assert.throws(() => at(r, r.commit({ [CONFIG]: null })), /review-router\.config\.json.*missing|missing.*review-router\.config\.json/);
});

test('CLI: an error is exit 1 with one stderr line; bad usage is exit 2 with one line', () => {
  // Breaks when: main lets the throw escape (a stack trace), git stderr leaks through, or the usage code changes.
  const r = makeRepo();
  const broken = r.commit({ [CONFIG]: 'not json' });
  for (const args of [['--sha', 'abc', '--root', r.dir], ['--sha', 'deadbeef'.repeat(5), '--root', r.dir], ['--sha', broken, '--root', r.dir]]) {
    const p = cli(args);
    assert.equal(p.status, 1, args.join(' '));
    assert.equal(p.stdout, '');
    assert.equal(p.stderr.trim().split('\n').length, 1, p.stderr);
  }
  for (const args of [[], ['--root', r.dir], ['--sha'], ['--sha', r.sha0, '--bogus'], ['--sha', r.sha0, 'extra']]) {
    const p = cli(args);
    assert.equal(p.status, 2, args.join(' '));
    assert.equal(p.stdout, '');
    assert.equal(p.stderr.trim().split('\n').length, 1, p.stderr);
  }
});

// 9
test('relativeImports finds static, multi-line, bare, export-from and dynamic import() specifiers, and skips packages', () => {
  // Breaks when: the matcher misses a multi-line "} from", a bare import, an export-from or a literal dynamic import().
  const text = [
    "import { a } from './a.mjs';",
    'import {',
    '  b,',
    '  c as d,',
    "} from '../b.mjs';",
    "import './side.mjs';",
    "import def, * as ns from \"./e.mjs\";",
    "export { x } from './x.mjs';",
    "export * from '../y/z.mjs';",
    'import {',
    '  k, // a comment inside the list',
    '  /* another */ l,',
    "} from './commented.mjs';",
    "import fs from 'node:fs';",
    "const m = await import('./dyn.mjs');",
    "try { ({ p } = await import( \"../../ratchets/r.mjs\" )); } catch { /* optional */ }",
    "const pkg = await import('node:path');",
    "export const q = 1;",
  ].join('\n');
  assert.deepEqual(relativeImports(text), [
    './a.mjs', '../b.mjs', './side.mjs', './e.mjs', './x.mjs', '../y/z.mjs', './commented.mjs', './dyn.mjs', '../../ratchets/r.mjs',
  ]);
});

test('import closure fails when a set file imports a relative file outside both sets', () => {
  // Breaks when: importClosureGaps returns [] without reading the files, or resolves the import against the wrong folder.
  const dir = tmpDir();
  const files = baseFiles();
  files['scripts/github/cursor-review.mjs'] = "import { x } from './lib/outside.mjs';\nimport { y } from './lib/proc.mjs';\n";
  files[`${DIR}context.mjs`] = "export { z } from '../review-status.mjs';\nimport { b } from '../review-router.mjs';\n";
  files[`${DIR}context.test.mjs`] = "import { t } from '../../far/away.mjs';\n";
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
  const gaps = importClosureGaps({ root: dir }).map((g) => `${g.file} -> ${g.target}`);
  assert.deepEqual(gaps.sort(), [
    'scripts/github/cursor-review.mjs -> scripts/github/lib/outside.mjs',
    `${DIR}context.mjs -> scripts/github/review-status.mjs`,
  ]);
});

test('import closure holds on the real reviewer-set files of this checkout', () => {
  // Breaks when (mutant): scripts/github/lib/proc.mjs is removed from REVIEWER_SET_FILES (cursor-review.mjs imports it),
  // or a set file gains a relative static import of a file outside the reviewer set and review-router.mjs.
  assert.deepEqual(importClosureGaps({ root: WORKTREE }), []);
});

test('import closure reads the band set too: review-status.mjs is the one exempt import of review-router.mjs; a dynamic import outside is a gap', () => {
  // Breaks when: the band set is not scanned, BAND_SET_IMPORT_EXEMPT widens or applies to the reviewer set, or import() is not read.
  const dir = tmpDir();
  const files = baseFiles();
  files[ROUTER] = "import { a } from './review-status.mjs';\nimport { b } from './outside-band.mjs';\n";
  files[`${DIR}context.mjs`] = "const x = await import('../../ratchets/review-skip-sync.mjs');\nconst y = await import('./dyn-outside.mjs');\n";
  files['scripts/github/review-filter.mjs'] = "import { s } from './review-status.mjs';\n";
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
  const gaps = importClosureGaps({ root: dir }).map((g) => `${g.file} -> ${g.target}`);
  assert.deepEqual(gaps.sort(), [
    `${DIR}context.mjs -> ${DIR}dyn-outside.mjs`,
    'scripts/github/review-filter.mjs -> scripts/github/review-status.mjs',
    `${ROUTER} -> scripts/github/outside-band.mjs`,
  ]);
});

test('BAND_SET_IMPORT_EXEMPT is exactly review-status.mjs and frozen; without it the real checkout has exactly that one gap', () => {
  // Breaks when: the exemption list changes, is not frozen, or is not what keeps the real closure clean.
  assert.deepEqual([...BAND_SET_IMPORT_EXEMPT], ['scripts/github/review-status.mjs']);
  assert.ok(Object.isFrozen(BAND_SET_IMPORT_EXEMPT));
  const gaps = importClosureGaps({ root: WORKTREE, bandExempt: [] }).map((g) => `${g.file} -> ${g.target}`);
  assert.deepEqual(gaps, [`${ROUTER} -> scripts/github/review-status.mjs`]);
});

test('guard: review-router.mjs imports only the five status helpers, and classify, bandOf and globToRegExp use none of them', () => {
  // Breaks when: the exempt import names a sixth helper, or a band function starts to call a status helper (the exemption would then hide band code).
  // The function sources come from Function.prototype.toString of the imported functions: the exact source text, no brace counting of regex or
  // string braces. Each source must start with its own "function <name>(" and be long, so an empty or wrong source cannot pass.
  const FIVE = ['codeRabbitNotice', 'commitsNamed', 'latestCodeRabbitSummary', 'pullLabelNames', 'shaIsHead'];
  const text = readFileSync(path.join(WORKTREE, ...ROUTER.split('/')), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => /from\s*['"]\.\/review-status\.mjs['"]/.test(l));
  assert.equal(lines.length, 1, 'one import line of review-status.mjs');
  const names = /import\s*\{([^}]*)\}/.exec(lines[0])[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  assert.deepEqual(names.sort(), FIVE);
  const fns = { classify: router.classify, bandOf: router.bandOf, globToRegExp: router.globToRegExp };
  for (const [name, fn] of Object.entries(fns)) {
    const src = fn.toString();
    assert.ok(src.startsWith(`function ${name}(`) && src.length > 100, `${name} source: ${src.slice(0, 40)}`);
    for (const helper of FIVE) assert.ok(!new RegExp(`\\b${helper}\\b`).test(src), `${name} uses ${helper}`);
  }
});

// 10
test('the exported lists are frozen and engineVersion is the reviewerVersion alias', () => {
  // Breaks when: a list is exported unfrozen, or engineVersion becomes another function (for example the freeze.mjs one).
  for (const list of [REVIEWER_SET_FILES, BAND_SET_FILES, EXEMPT_LOCAL_REVIEW_KEYS]) {
    assert.ok(Object.isFrozen(list));
    assert.throws(() => { list.push('x'); }, TypeError);
  }
  assert.equal(engineVersion, reviewerVersion);
  assert.equal(typeof bandVersion, 'function');
  const r = makeRepo();
  const v = at(r, r.sha0);
  assert.equal(v.engineVersion, v.reviewerVersion);
  assert.deepEqual(v.missing, []);
});
