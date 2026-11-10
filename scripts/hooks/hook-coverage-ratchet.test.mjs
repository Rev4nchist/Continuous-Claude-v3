// Tests for scripts/hooks/hook-coverage-ratchet.mjs, the ratchet for "every registered hook has a test".
//
// How it can fail, one test each:
//   a new hook is registered with no test and it is not in the baseline: the ratchet passes
//   a baseline name is now tested (or no longer registered) and the ratchet passes: the baseline never shrinks
//   zero hooks are registered (0 of 0) and the ratchet passes: a vacuous gate
//   fewer hooks are registered than the floor and the ratchet passes
//   baseline equals the current untested set and the ratchet reports a finding (false alarm)
//   a test file that only names the dist in a comment counts as evidence
//   a test file that only lists the name in a string (no import, no spawn) counts as evidence
//   a real import, a spawn of dist/<name>.mjs, or a resolveHook call is not recognised as evidence
//   the registration parser misses an entry that uses {command, args} (the live shape)
//   the test scan reads node_modules, or misses a nested test file
//   the verdict line hides the registered count
//   the real tree: the committed baseline no longer matches the real template and tests
// Critic round (tests prefixed D1..D8):
//   D1 a spawn string for another hook, or a "spawns" test title, counts as spawn evidence for every name in the file
//   D2 the baseline grows (over MAX_UNTESTED), has duplicates, or is not a list of strings, and nothing flags it
//   D3 a command hook that does not match hooks/dist/<name>.mjs is dropped, or the first .mjs wins
//   D4 a test that CI never runs (outside src/__tests__, or a script test not wired into test:scripts or the workflow) counts
//   D5 a missing or BOM baseline file is not an unreadable-baseline finding
//   D6 a '/*' inside a string deletes the code up to the next '*/'
//   D7 an import of ../shared/<name> or ../lib/<name> counts for hook <name>
//   D8 a spawn of dist/pre-<name>.mjs counts for hook <name>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mod from './hook-coverage-ratchet.mjs';
import {
  hookCoverageFindings,
  untestedHooks,
  registeredHookNames,
  loadTestFiles,
  checkRepo,
  verdictLine,
} from './hook-coverage-ratchet.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const kinds = (f) => f.map((x) => x.kind);
const HOOK_TEST = '.claude/hooks/src/__tests__/a.test.ts';
const file = (text, path = HOOK_TEST) => ({ path, text });
const names = (n) => Array.from({ length: n }, (_, i) => `hook-${i}`);
// One test file that spawns every name in the list.
const spawnsAll = (list) => file(list.map((n) => `spawnSync('node', ['dist/${n}.mjs']);`).join('\n'));

test('a new untested hook that is not in the baseline is a finding', () => {
  const reg = names(5);
  const f = hookCoverageFindings({ registered: reg, tests: [spawnsAll(reg.slice(0, 4))], baseline: [], minRegistered: 5 });
  assert.deepEqual(kinds(f), ['untested-not-in-baseline']);
  assert.match(f[0].detail, /hook-4/);
});

test('a baseline name that is now tested is a finding that says to remove it', () => {
  const reg = names(5);
  const f = hookCoverageFindings({ registered: reg, tests: [spawnsAll(reg)], baseline: ['hook-2'], minRegistered: 5 });
  assert.deepEqual(kinds(f), ['stale-baseline']);
  assert.match(f[0].detail, /remove from baseline/);
  assert.match(f[0].detail, /hook-2/);
});

test('a baseline name that is no longer registered is a stale finding', () => {
  const reg = names(5);
  const f = hookCoverageFindings({ registered: reg, tests: [spawnsAll(reg)], baseline: ['gone-hook'], minRegistered: 5 });
  assert.deepEqual(kinds(f), ['stale-baseline']);
  assert.match(f[0].detail, /gone-hook/);
  assert.match(f[0].detail, /remove from baseline/);
});

test('zero registrations is a vacuous finding', () => {
  const f = hookCoverageFindings({ registered: [], tests: [file('anything')], baseline: [], minRegistered: 0 });
  assert.ok(kinds(f).includes('vacuous'), JSON.stringify(f));
});

test('fewer registrations than the floor is a count-regression finding', () => {
  const reg = names(4);
  const f = hookCoverageFindings({ registered: reg, tests: [spawnsAll(reg)], baseline: [], minRegistered: 5 });
  assert.ok(kinds(f).includes('registration-count-regression'), JSON.stringify(f));
});

test('baseline equal to the current untested set passes', () => {
  const reg = names(6);
  const tests = [spawnsAll(reg.slice(0, 4))];
  assert.deepEqual(untestedHooks({ registered: reg, tests }), ['hook-4', 'hook-5']);
  assert.deepEqual(hookCoverageFindings({ registered: reg, tests, baseline: ['hook-4', 'hook-5'], minRegistered: 6 }), []);
});

test('a name only in a line comment, a block comment or a trailing comment is not evidence', () => {
  const t = file([
    "// spawnSync('node', ['dist/hook-0.mjs'])",
    "/* resolveHook('hook-1') and import x from '../hook-1' */",
    "const x = 1; // dist/hook-2.mjs",
    "/*",
    " * import y from '../hook-3';",
    " */",
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-1', 'hook-2', 'hook-3'], tests: [t] }), ['hook-0', 'hook-1', 'hook-2', 'hook-3']);
});

test('a name only in a string list, with no import and no spawn, is not evidence', () => {
  const t = file("const ALL = ['hook-0', 'hook-0.mjs', 'dist/hook-0.mjs'];");
  assert.deepEqual(untestedHooks({ registered: ['hook-0'], tests: [t] }), ['hook-0']);
});

test('an import of ../<name>, with or without an extension, is evidence', () => {
  const t = file([
    "import { a } from '../hook-0';",
    "import { b } from '../hook-1.js';",
    "import { c } from '../../src/hook-2.ts';",
    "const d = await import('../hook-3');",
    "const e = require('../hook-4');",
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: names(5), tests: [t] }), []);
});

test('an import of a longer name that ends the same is not evidence', () => {
  const t = file("import { a } from '../pre-hook-0';");
  assert.deepEqual(untestedHooks({ registered: ['hook-0'], tests: [t] }), ['hook-0']);
});

test('a spawn of dist/<name>.mjs is evidence, a spawn of a different dist is not', () => {
  const t = file("const r = spawnSync('node', [join(dir, 'dist', 'hook-0.mjs')]);");
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-00'], tests: [t] }), ['hook-00']);
});

test('a resolveHook call is evidence', () => {
  const t = file("const p = resolveHook('hook-0'); const q = resolveHook(\"hook-1\");");
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-1', 'hook-2'], tests: [t] }), ['hook-2']);
});

test('registeredHookNames reads args, command strings and every event', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['{{CLAUDE_HOME}}/hooks/dist/alpha.mjs'] }] }],
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node C:/x/hooks/dist/beta.mjs' },
        { type: 'command', command: 'node', args: ['{{CLAUDE_HOME}}/hooks/dist/alpha.mjs'] },
      ] }],
    },
  };
  assert.deepEqual(registeredHookNames(settings), ['alpha', 'beta']);
  assert.deepEqual(registeredHookNames({}), []);
});

test('the verdict line carries the registered count and the untested count', () => {
  const pass = verdictLine({ ok: true, registered: 67, untested: names(13), baseline: names(13), findings: [] });
  assert.match(pass, /^PASS/);
  assert.match(pass, /67 registered/);
  assert.match(pass, /13 untested/);
  const fail = verdictLine({ ok: false, registered: 0, untested: [], baseline: [], findings: [{ kind: 'vacuous', detail: 'x' }] });
  assert.match(fail, /^FAIL/);
  assert.match(fail, /0 registered/);
});

// ---- the loader and checkRepo, on a temp tree ----
// wired: script tests named in package.json test:scripts (default: every scripts/ test in `tests`).
// workflow: text of .github/workflows/ccv3-checks.yml (default: no file). commands: extra raw command hooks.
function tree({ hooks, tests = {}, baseline = [], settingsFile = '.claude/settings.json.template', wired, workflow, commands = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'hcr-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const entries = hooks.map((n) => ({ type: 'command', command: 'node', args: [`{{CLAUDE_HOME}}/hooks/dist/${n}.mjs`] }));
  for (const c of commands) entries.push({ type: 'command', command: c });
  put(settingsFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: entries }] } }));
  for (const [rel, text] of Object.entries(tests)) put(rel, text);
  put('scripts/hooks/hook-coverage-baseline.json', JSON.stringify({ untested: baseline }));
  const list = wired ?? Object.keys(tests).filter((k) => k.startsWith('scripts/'));
  put('package.json', JSON.stringify({ scripts: { 'test:scripts': `node --test ${list.join(' ')}` } }));
  if (workflow !== undefined) put('.github/workflows/ccv3-checks.yml', workflow);
  return root;
}
const posixPaths = (root) => loadTestFiles(root).map((t) => t.path.replaceAll('\\', '/')).sort();

test('loadTestFiles finds nested hook tests and wired script tests and skips node_modules', () => {
  const root = tree({
    hooks: ['h'],
    tests: {
      '.claude/hooks/src/__tests__/deep/a.test.ts': 'x',
      'scripts/sub/b.test.mjs': 'x',
      '.claude/hooks/node_modules/pkg/c.test.ts': 'x',
      '.claude/hooks/src/not-a-test.ts': 'x',
    },
  });
  assert.deepEqual(posixPaths(root), ['.claude/hooks/src/__tests__/deep/a.test.ts', 'scripts/sub/b.test.mjs']);
});

test('D4: a hook test outside src/__tests__, or not a .test.ts, is not a test file (vitest does not run it)', () => {
  const root = tree({
    hooks: ['h'],
    tests: {
      '.claude/hooks/src/__tests__/ok.test.ts': 'x',
      '.claude/hooks/src/loose.test.ts': 'x',
      '.claude/hooks/src/__tests__/wrong-ext.test.mjs': 'x',
      '.claude/hooks/src/__tests__/helper.ts': 'x',
    },
  });
  assert.deepEqual(posixPaths(root), ['.claude/hooks/src/__tests__/ok.test.ts']);
});

test('D4: a script test that package.json and the workflow do not name is not a test file', () => {
  const root = tree({
    hooks: ['h'],
    tests: { 'scripts/never-run.test.mjs': 'x', 'scripts/in-pkg.test.mjs': 'x' },
    wired: ['scripts/in-pkg.test.mjs'],
  });
  assert.deepEqual(posixPaths(root), ['scripts/in-pkg.test.mjs']);
});

test('D4: a script test named in the workflow counts, as a path, as a glob and in a multi-line block; a commented line does not', () => {
  const workflow = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: node --test scripts/one/a.test.mjs',
    '      - run: node --test scripts/glob/*.test.mjs',
    '      - run: |',
    '          node --test',
    '          scripts/multi/m1.test.mjs',
    '          scripts/multi/m2.test.mjs',
    '      # - run: node --test scripts/off/commented.test.mjs',
  ].join('\n');
  const tests = Object.fromEntries([
    'scripts/one/a.test.mjs', 'scripts/one/other.test.mjs', 'scripts/glob/g1.test.mjs', 'scripts/glob/deep/g2.test.mjs',
    'scripts/multi/m1.test.mjs', 'scripts/multi/m2.test.mjs', 'scripts/off/commented.test.mjs',
  ].map((k) => [k, 'x']));
  const root = tree({ hooks: ['h'], tests, wired: [], workflow });
  assert.deepEqual(posixPaths(root), [
    'scripts/glob/g1.test.mjs', 'scripts/multi/m1.test.mjs', 'scripts/multi/m2.test.mjs', 'scripts/one/a.test.mjs',
  ]);
});

test('D4: checkRepo does not count an unwired script test as evidence', () => {
  const root = tree({
    hooks: ['h1'],
    tests: { 'scripts/never-run.test.mjs': "spawnSync('node', ['dist/h1.mjs']);" },
    wired: [],
  });
  const r = checkRepo({ repoRoot: root, minRegistered: 1 });
  assert.deepEqual(r.untested, ['h1']);
  assert.deepEqual(kinds(r.findings), ['untested-not-in-baseline']);
});

test('checkRepo fails on a temp tree where a registered hook has no test', () => {
  const root = tree({ hooks: ['h1', 'h2'], tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs'])" } });
  const r = checkRepo({ repoRoot: root, minRegistered: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.registered, 2);
  assert.deepEqual(r.untested, ['h2']);
  assert.deepEqual(kinds(r.findings), ['untested-not-in-baseline']);
});

test('checkRepo passes when the baseline lists the untested hook', () => {
  const root = tree({ hooks: ['h1', 'h2'], baseline: ['h2'], tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs'])" } });
  const r = checkRepo({ repoRoot: root, minRegistered: 2 });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test('checkRepo fails when the settings file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'hcr-'));
  const r = checkRepo({ repoRoot: root, minRegistered: 1 });
  assert.equal(r.ok, false);
  assert.ok(kinds(r.findings).includes('unreadable-settings'), JSON.stringify(r.findings));
});

// ---- D1 + D8: spawn evidence is per call ----
test('D1: a loose dist string for one hook, plus a spawn of another hook, leaves the loose one untested', () => {
  const t = file("const A = 'dist/hook-1.mjs';\nspawnSync('node', ['dist/hook-0.mjs']);");
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-1'], tests: [t] }), ['hook-1']);
});

test('D1: a test title with spawns or fork, and a plain string list, is not evidence', () => {
  const t = file([
    "test('spawns every hook', () => {",
    "  const ALL = ['dist/hook-0.mjs'];",
    '});',
    "it('fork check', () => {",
    "  const MORE = ['dist/hook-1.mjs'];",
    '});',
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-1'], tests: [t] }), ['hook-0', 'hook-1']);
});

test('D1: a multi-line spawn call, a spawn through a constant and execFileSync are evidence', () => {
  const t = file([
    'const r = spawnSync(',
    "  'node',",
    "  [join(dir, 'dist', 'hook-0.mjs')],",
    '  { input },',
    ');',
    "const HOOK = join(dir, 'dist', 'hook-1.mjs');",
    "execFileSync(process.execPath, [HOOK]);",
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'hook-1', 'hook-2'], tests: [t] }), ['hook-2']);
});

test('D1: a constant that holds a dist path but is never passed to a spawn is not evidence', () => {
  const t = file("const HOOK = join(dir, 'dist', 'hook-0.mjs');\nspawnSync('node', ['other.mjs']);\nconsole.log(HOOK);");
  assert.deepEqual(untestedHooks({ registered: ['hook-0'], tests: [t] }), ['hook-0']);
});

test('D8: a spawn of dist/pre-<name>.mjs is not evidence for <name>', () => {
  const t = file("spawnSync('node', ['dist/pre-hook-0.mjs']);");
  assert.deepEqual(untestedHooks({ registered: ['hook-0', 'pre-hook-0'], tests: [t] }), ['hook-0']);
});

// ---- D2: the baseline may only shrink ----
test('D2: MAX_UNTESTED is exported, and a baseline longer than it is a finding that names the cap', () => {
  assert.equal(typeof mod.MAX_UNTESTED, 'number');
  const cap = mod.MAX_UNTESTED;
  const reg = names(cap + 2);
  const over = hookCoverageFindings({ registered: reg, tests: [], baseline: names(cap + 1), minRegistered: 1 });
  const hit = over.find((x) => x.kind === 'baseline-over-cap');
  assert.ok(hit, JSON.stringify(over));
  assert.match(hit.detail, /lowering MAX_UNTESTED/);
  const atCap = hookCoverageFindings({ registered: names(cap), tests: [], baseline: names(cap), minRegistered: 1 });
  assert.deepEqual(atCap, []);
});

test('D2: a stale-baseline finding says that lowering MAX_UNTESTED is part of every shrink', () => {
  const reg = names(5);
  const f = hookCoverageFindings({ registered: reg, tests: [spawnsAll(reg)], baseline: ['hook-2'], minRegistered: 5 });
  assert.match(f[0].detail, /lowering MAX_UNTESTED/);
});

test('D2: a duplicate baseline name is a finding', () => {
  const f = hookCoverageFindings({ registered: names(5), tests: [spawnsAll(names(4))], baseline: ['hook-4', 'hook-4'], minRegistered: 5 });
  const hit = f.find((x) => x.kind === 'baseline-duplicate');
  assert.ok(hit, JSON.stringify(f));
  assert.match(hit.detail, /hook-4/);
});

test('D2: a non-array baseline is a finding, not a TypeError', () => {
  const f = hookCoverageFindings({ registered: names(5), tests: [spawnsAll(names(5))], baseline: {}, minRegistered: 5 });
  assert.ok(kinds(f).includes('baseline-malformed'), JSON.stringify(f));
});

test('D2: a non-string baseline entry is a finding', () => {
  const f = hookCoverageFindings({ registered: names(5), tests: [spawnsAll(names(4))], baseline: [42, null, 'hook-4'], minRegistered: 5 });
  assert.ok(kinds(f).includes('baseline-malformed'), JSON.stringify(f));
});

test('D2: checkRepo with {"untested":{}} gives a finding and a verdict line, not a TypeError', () => {
  const root = tree({ hooks: ['h1'], tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs']);" } });
  const bad = join(root, 'bad-baseline.json');
  writeFileSync(bad, '{"untested":{}}');
  const r = checkRepo({ repoRoot: root, baselinePath: bad, minRegistered: 1 });
  assert.equal(r.ok, false);
  assert.ok(kinds(r.findings).includes('baseline-malformed'), JSON.stringify(r.findings));
  assert.match(verdictLine(r), /^FAIL/);
});

// ---- D3 + D5: the registration parser ----
test('D3: parseRegistrations reads backslash paths, ./dist paths and the dist path after --import, in command and args', () => {
  assert.equal(typeof mod.parseRegistrations, 'function');
  const settings = { hooks: { Stop: [{ hooks: [
    { type: 'command', command: 'node C:\\x\\hooks\\dist\\beta.mjs' },
    { type: 'command', command: 'node ./dist/gamma.mjs --flag' },
    { type: 'command', command: 'node --import x.mjs dist/h.mjs' },
    { type: 'command', command: 'node', args: ['--import', 'loader.mjs', '{{CLAUDE_HOME}}/hooks/dist/delta.mjs'] },
  ] }] } };
  const r = mod.parseRegistrations(settings);
  assert.deepEqual(r.names, ['beta', 'delta', 'gamma', 'h']);
  assert.deepEqual(r.unparsed, []);
});

test('D3: a command hook with no dist match is unparsed, and its first .mjs is not taken as a hook name', () => {
  const settings = { hooks: { Stop: [{ hooks: [
    { type: 'command', command: 'python C:/x/hooks/legacy.py' },
    { type: 'command', command: 'node C:/x/tools/helper.mjs' },
    { type: 'command', command: 'node C:/x/hooks/dist/ok.mjs' },
  ] }] } };
  const r = mod.parseRegistrations(settings);
  assert.deepEqual(r.names, ['ok']);
  assert.equal(r.unparsed.length, 2);
  assert.deepEqual(registeredHookNames(settings), ['ok']);
});

test('D3: checkRepo reports an unparsed-registration finding for a .py hook', () => {
  const root = tree({
    hooks: ['h1'],
    commands: ['python C:/x/hooks/legacy.py'],
    tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs']);" },
  });
  const r = checkRepo({ repoRoot: root, minRegistered: 1 });
  const hit = r.findings.find((x) => x.kind === 'unparsed-registration');
  assert.ok(hit, JSON.stringify(r.findings));
  assert.match(hit.detail, /legacy\.py/);
  assert.equal(r.ok, false);
});

test('D3: a settings file with a statusLine outside hooks has no unparsed finding', () => {
  const f = hookCoverageFindings({ registered: names(5), tests: [spawnsAll(names(5))], baseline: [], minRegistered: 5, unparsed: [] });
  assert.deepEqual(f, []);
  const r = mod.parseRegistrations({ statusLine: { type: 'command', command: 'node status.mjs' }, hooks: {} });
  assert.deepEqual(r.unparsed, []);
});

test('D5: a missing baseline file is an unreadable-baseline finding', () => {
  const root = tree({ hooks: ['h1'], tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs']);" } });
  const r = checkRepo({ repoRoot: root, baselinePath: join(root, 'no-such-baseline.json'), minRegistered: 1 });
  assert.ok(kinds(r.findings).includes('unreadable-baseline'), JSON.stringify(r.findings));
  assert.equal(r.ok, false);
});

test('D5: a baseline file with a BOM is an unreadable-baseline finding', () => {
  const root = tree({ hooks: ['h1'], tests: { 'scripts/a.test.mjs': "spawnSync('node', ['dist/h1.mjs']);" } });
  const bom = join(root, 'bom-baseline.json');
  writeFileSync(bom, '\uFEFF{"untested":[]}');
  const r = checkRepo({ repoRoot: root, baselinePath: bom, minRegistered: 1 });
  assert.ok(kinds(r.findings).includes('unreadable-baseline'), JSON.stringify(r.findings));
  assert.equal(r.ok, false);
});

// ---- D6: comment stripping ----
test('D6: a /* inside a string, with a */ later, does not delete the code between', () => {
  const t = file([
    "const a = '/*';",
    "spawnSync('node', ['dist/hook-0.mjs']);",
    "const b = '*/';",
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: ['hook-0'], tests: [t] }), []);
});

// ---- D7: imports resolve to the hook source file ----
test('D7: an import from shared/ or lib/ does not count for a hook of the same name; a top-level src import does', () => {
  const t = file([
    "import { a } from '../shared/hook-0';",
    "import { b } from '../lib/hook-1.js';",
    "import { c } from '../hook-2';",
    "const d = await import('../hook-3.js');",
  ].join('\n'));
  assert.deepEqual(untestedHooks({ registered: names(4), tests: [t] }), ['hook-0', 'hook-1']);
});

test('D7: the import path resolves from the test file, so a nested test and a script test work', () => {
  const nested = file("import { a } from '../../hook-0';", '.claude/hooks/src/__tests__/deep/a.test.ts');
  const script = file("import { b } from '../.claude/hooks/src/hook-1.ts';", 'scripts/x.test.mjs');
  const wrong = file("import { c } from '../other/hook-2';", 'scripts/x.test.mjs');
  assert.deepEqual(untestedHooks({ registered: names(3), tests: [nested, script, wrong] }), ['hook-2']);
});

// ---- the real tree ----
test('the real template, real tests and committed baseline give no finding', () => {
  const r = checkRepo({ repoRoot: REPO });
  assert.deepEqual(r.findings, []);
  assert.ok(r.registered >= 60, `registered ${r.registered}`);
});

test('D2: the committed baseline is no longer than MAX_UNTESTED', () => {
  const r = checkRepo({ repoRoot: REPO });
  assert.ok(r.baseline.length <= mod.MAX_UNTESTED, `${r.baseline.length} > ${mod.MAX_UNTESTED}`);
});
