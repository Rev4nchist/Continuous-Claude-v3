// Tests of gate-coverage.mjs (card coord-test-gate-coverage). Fixtures are made up; a few tests read the real gate sources to pin the runner table.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsOfWorkflow, evaluate, expandRuns, gatedBy, globToRegExp, isDirectRun, isTestFile, parseSkipFile, RUNNERS, runnerFiles, runsOf, testMatchOf } from './gate-coverage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');

describe('isTestFile', () => {
  it('knows the test file shapes of this repo and nothing else', () => {
    for (const f of ['a/b.test.mjs', 'a/b.test.js', 'a/b.test.cjs', 'a/b.test.ts', 'a/b.test.tsx', 'a/b.test.sh', 'a/b.test.ps1', 'a/b.spec.ts', 'a/test_x.py', 'a/x_test.py']) assert.ok(isTestFile(f), f);
    for (const f of ['a/b.mjs', 'a/test.mjs', 'a/attest.mjs', 'a/b.test.json', 'a/test_x.txt', 'README.md']) assert.ok(!isTestFile(f), f);
  });
});

describe('globToRegExp', () => {
  it('* stays inside one folder, ** crosses folders, ? is one character, dots are literal', () => {
    assert.ok(globToRegExp('scripts/lib/*.test.mjs').test('scripts/lib/a.test.mjs'));
    assert.ok(!globToRegExp('scripts/lib/*.test.mjs').test('scripts/lib/sub/a.test.mjs'));
    assert.ok(globToRegExp('scripts/**/*.test.mjs').test('scripts/lib/sub/a.test.mjs'));
    assert.ok(globToRegExp('scripts/**/*.test.mjs').test('scripts/a.test.mjs'), '** may match no folder');
    assert.ok(globToRegExp('a/?.test.mjs').test('a/x.test.mjs'));
    assert.ok(!globToRegExp('a/b.test.mjs').test('a/bXtest.mjs'), 'a dot is not a wildcard');
  });
});

describe('commandsOfWorkflow', () => {
  const yml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      # node --test scripts/commented.test.mjs',
    '      - name: one',
    '        run: node --test scripts/one.test.mjs   # node --test scripts/inline.test.mjs',
    '      - name: two # node --test scripts/in-name.test.mjs',
    '        if: ${{ !cancelled() }}   # node --test scripts/in-if.test.mjs',
    '        run: >-',
    '          node --test',
    '          scripts/two-a.test.mjs',
    '          scripts/two-b.test.mjs',
    '      - name: three',
    '        run: |',
    '          echo hi',
    '          # node --test scripts/block-comment.test.mjs',
    '          node --test "scripts/three/*.test.mjs"',
    '      - name: four',
    '        working-directory: .claude/hooks',
    '        run: npx --no-install vitest run --retry=2',
    '      - run: node --test scripts/dash-run.test.mjs',
    '      - name: five',
    '        env:',
    '          X: 1',
    '        run: node --test scripts/after-env.test.mjs',
  ].join('\n');
  it('reads the run: commands of single-line, folded and literal blocks, a `- run:` item, and nothing from comments, names or if lines', () => {
    const text = commandsOfWorkflow(yml).join('\n');
    for (const want of ['scripts/one.test.mjs', 'scripts/two-a.test.mjs', 'scripts/two-b.test.mjs', 'scripts/three/*.test.mjs', 'vitest run', 'scripts/dash-run.test.mjs', 'scripts/after-env.test.mjs']) assert.ok(text.includes(want), want);
    for (const no of ['commented', 'inline', 'in-name', 'in-if', 'block-comment']) assert.ok(!text.includes(no), no);
  });
  it('an empty workflow gives no command (the caller must fail on that)', () => {
    assert.deepEqual(commandsOfWorkflow('name: x\non: push\n'), []);
  });
});

describe('runsOf', () => {
  it('returns the test paths and globs a runner command runs, quotes removed, flags and other words left out', () => {
    assert.deepEqual(runsOf('node --test "scripts/a/*.test.mjs" scripts/b.test.mjs --retry=2 echo').paths, ['scripts/a/*.test.mjs', 'scripts/b.test.mjs']);
    assert.deepEqual(runsOf('cd x && bash scripts/t.test.sh; pwsh -File scripts/u.test.ps1').paths, ['scripts/t.test.sh', 'scripts/u.test.ps1']);
    assert.deepEqual(runsOf('node scripts/not-a-test.mjs').paths, []);
  });
  it('a test path in echo, git, rm, cat or a comment is not run', () => {
    assert.deepEqual(runsOf('echo scripts/a.test.mjs').paths, []);
    assert.deepEqual(runsOf('git diff scripts/a.test.mjs && rm scripts/b.test.mjs; cat scripts/c.test.mjs').paths, []);
    assert.deepEqual(runsOf('node --test scripts/d.test.mjs # scripts/e.test.mjs').paths, ['scripts/d.test.mjs']);
  });
  it('env assignments, timeout and a path before the runner word are allowed', () => {
    assert.deepEqual(runsOf('FOO=1 timeout 60 node --test scripts/a.test.mjs').paths, ['scripts/a.test.mjs']);
    assert.deepEqual(runsOf('C:/tools/node.exe --test scripts/b.test.mjs').paths, ['scripts/b.test.mjs']);
  });
  it('npm run <script> and npm test name the script; the text of the script is not read here', () => {
    assert.deepEqual(runsOf('npm run test:scripts').npm, ['test:scripts']);
    assert.deepEqual(runsOf('npm test').npm, ['test']);
    assert.deepEqual(runsOf('npm ci --ignore-scripts').npm, []);
  });
});

describe('expandRuns', () => {
  const scripts = { 'test:scripts': ['node --test a/x.test.mjs a/y.test.mjs'], 'test:all': ['npm run test:scripts'] };
  it('a script counts only when a command calls it (a script that nothing calls is not a gate)', () => {
    assert.deepEqual(expandRuns(['node --test z.test.mjs'], scripts).paths, ['z.test.mjs']);
    assert.deepEqual(expandRuns(['npm run test:scripts'], scripts).paths, ['a/x.test.mjs', 'a/y.test.mjs']);
  });
  it('follows a script that calls another script, and stops on a loop', () => {
    assert.deepEqual(expandRuns(['npm run test:all'], scripts).paths, ['a/x.test.mjs', 'a/y.test.mjs']);
    assert.doesNotThrow(() => expandRuns(['npm run a'], { a: ['npm run b'], b: ['npm run a'] }));
  });
});

describe('gatedBy', () => {
  it('a file is gated by a path token or a glob token, and by nothing else', () => {
    const files = ['a/x.test.mjs', 'a/y.test.mjs', 'b/z.test.mjs'];
    assert.deepEqual([...gatedBy(files, ['a/*.test.mjs'])].sort(), ['a/x.test.mjs', 'a/y.test.mjs']);
    assert.deepEqual([...gatedBy(files, ['b/z.test.mjs'])], ['b/z.test.mjs']);
    assert.deepEqual([...gatedBy(files, ['b/none.test.mjs'])], []);
  });
});

describe('parseSkipFile', () => {
  it('accepts entries with a path and a reason; a missing reason, an empty reason, a duplicate path or a bad shape is a problem', () => {
    const ok = parseSkipFile({ skip: [{ path: 'archive/**', reason: 'archived' }], ciGaps: [{ path: 'p/**', reason: 'pre-pr only' }], deadGates: [{ path: 'g/**/*.test.mjs', reason: 'gone' }] });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.skip.length, 1);
    assert.equal(ok.ciGaps.length, 1);
    assert.equal(ok.deadGates.length, 1);
    assert.equal(parseSkipFile({ skip: [{ path: 'a/**' }] }).problems.length, 1);
    assert.equal(parseSkipFile({ skip: [{ path: 'a/**', reason: '   ' }] }).problems.length, 1);
    assert.deepEqual(parseSkipFile({ skip: [{ path: 'a', reason: 'x' }, { path: './a', reason: 'y' }] }).problems.map((p) => p.kind), ['duplicate-entry']);
    assert.ok(parseSkipFile({ skip: 'no' }).problems.length >= 1);
    assert.ok(parseSkipFile(null).problems.length >= 1);
  });
});

describe('evaluate', () => {
  const files = ['a/gated.test.mjs', 'a/skipped.test.mjs', 'a/prepr-only.test.mjs', 'a/ungated.test.mjs'];
  const base = {
    files,
    ci: new Set(['a/gated.test.mjs']),
    prepr: new Set(['a/gated.test.mjs', 'a/prepr-only.test.mjs']),
    skip: [{ path: 'a/skipped.test.mjs', reason: 'archived' }],
    ciGaps: [{ path: 'a/prepr-only.test.mjs', reason: 'no CI runner' }],
    tokens: ['a/gated.test.mjs', 'a/prepr-only.test.mjs'],
  };
  const names = (r) => r.problems.map((p) => p.kind).sort();
  it('a clean state: gated, skipped and a named pre-pr-only file, and one ungated file is the only problem', () => {
    const r = evaluate(base);
    assert.deepEqual(names(r), ['ungated']);
    assert.deepEqual(r.problems[0].files, ['a/ungated.test.mjs']);
    assert.deepEqual(r.counts, { files: 4, gated: 2, skipped: 1, ciGaps: 1, ungated: 1 });
  });
  it('no problem when the ungated file joins a gate', () => {
    const r = evaluate({ ...base, ci: new Set([...base.ci, 'a/ungated.test.mjs']), prepr: new Set([...base.prepr, 'a/ungated.test.mjs']) });
    assert.deepEqual(r.problems, []);
  });
  it('a skip entry that matches no test file is a stale-skip problem', () => {
    assert.deepEqual(names(evaluate({ ...base, skip: [...base.skip, { path: 'gone/**', reason: 'x' }] })), ['stale-skip', 'ungated']);
  });
  it('a file that is gated and also skipped is a problem (the skip entry must go)', () => {
    assert.deepEqual(names(evaluate({ ...base, skip: [...base.skip, { path: 'a/gated.test.mjs', reason: 'x' }] })), ['gated-and-skipped', 'ungated']);
  });
  it('a file gated at pre-pr only and not named in ciGaps is a problem; a stale ciGaps entry is a problem', () => {
    assert.deepEqual(names(evaluate({ ...base, ciGaps: [] })), ['pre-pr-only', 'ungated']);
    assert.deepEqual(names(evaluate({ ...base, ciGaps: [...base.ciGaps, { path: 'gone/**', reason: 'x' }] })), ['stale-ci-gap', 'ungated']);
  });
  it('a gate glob that matches no file is a problem unless deadGates names it; a deadGates entry that is not dead any more is a problem', () => {
    const dead = { ...base, tokens: [...base.tokens, 'gone/**/*.test.mjs'] };
    assert.deepEqual(names(evaluate(dead)), ['dead-gate-glob', 'ungated']);
    assert.deepEqual(names(evaluate({ ...dead, deadGates: [{ path: 'gone/**/*.test.mjs', reason: 'gone' }] })), ['ungated']);
    assert.deepEqual(names(evaluate({ ...base, deadGates: [{ path: 'a/*.test.mjs', reason: 'x' }] })), ['stale-dead-gate', 'ungated']);
  });
  it('a gate that names a test file that is not tracked is a problem', () => {
    assert.deepEqual(names(evaluate({ ...base, tokens: [...base.tokens, 'a/deleted.test.mjs'] })), ['missing-gate-file', 'ungated']);
  });
  it('fails closed: no test file, or no gated file at all, is a problem (a reader that found nothing must not pass)', () => {
    assert.deepEqual(names(evaluate({ ...base, files: [] })), ['no-test-files']);
    assert.ok(names(evaluate({ ...base, ci: new Set(), prepr: new Set() })).includes('no-gated-files'));
  });
});

describe('the runner table is pinned to the real gate sources', () => {
  it('every runner names the gate that runs it, and that gate exists in pre-pr (a rename must fail here, not drop coverage silently)', async () => {
    const pre = await import('./pre-pr.mjs');
    const gates = [...pre.ALWAYS_GATES, ...pre.SURFACES.flatMap((s) => s.gates ?? [])];
    for (const r of RUNNERS) assert.ok(gates.some((g) => r.gate(g)), `no pre-pr gate for runner ${r.id}`);
  });
  it('the vitest runner pattern equals the include of .claude/hooks/vitest.config.ts', () => {
    const cfg = fs.readFileSync(path.join(REPO, '.claude', 'hooks', 'vitest.config.ts'), 'utf8');
    assert.match(cfg, /include:\s*\['src\/__tests__\/\*\*\/\*\.test\.ts'\]/);
    const r = RUNNERS.find((x) => x.id === 'hooks-vitest');
    assert.ok(r.files('.claude/hooks/src/__tests__/a/b.test.ts'));
    assert.ok(!r.files('.claude/hooks/archive/x.test.ts'));
  });
  it('the playwright runner covers exactly the testMatch of the pure config, read from the config', () => {
    const cfg = fs.readFileSync(path.join(REPO, 'apps', 'agentic-os', 'playwright.pure.config.ts'), 'utf8');
    const match = testMatchOf(cfg);
    assert.ok(match.length >= 1, 'no testMatch read from the config');
    const r = RUNNERS.find((x) => x.id === 'playwright-pure');
    const ctx = { playwrightPure: match };
    for (const g of match) assert.ok(r.files(`apps/agentic-os/e2e/${g.replace(/\*/g, 'x')}`, ctx), g);
    assert.ok(!r.files('apps/agentic-os/e2e/not-in-the-config.spec.ts', ctx));
    assert.ok(!r.files('apps/agentic-os/e2e/safe-message-x.spec.ts', {}), 'no config read: it covers nothing');
  });
  it('runnerFiles returns the files a runner covers when its gate exists, and none when it does not', () => {
    const files = ['.claude/hooks/src/__tests__/a.test.ts', 'opc/scripts/test_x.py', 'scripts/a.test.mjs'];
    const have = runnerFiles(files, [{ id: 'hooks-vitest', cmd: 'npx', args: ['vitest', 'run'], cwd: '.claude/hooks' }]);
    assert.deepEqual([...have], ['.claude/hooks/src/__tests__/a.test.ts']);
    assert.deepEqual([...runnerFiles(files, [])], []);
  });
});

describe('isDirectRun', () => {
  it('is true for the real path of the module, also through a different spelling of it, and false for another file', () => {
    const here = path.join(HERE, 'gate-coverage.mjs');
    assert.equal(isDirectRun(here, here), true);
    assert.equal(isDirectRun(path.join(HERE, '..', 'github', 'gate-coverage.mjs'), here), true, 'a path with ..');
    assert.equal(isDirectRun(path.join(HERE, 'pre-pr.mjs'), here), false);
    assert.equal(isDirectRun(undefined, here), false);
  });
});
