// Tests of gate-coverage.mjs (card coord-test-gate-coverage). Fixtures are made up; two tests read the real gate sources to pin the runner table.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsOfWorkflow, evaluate, gatedBy, globToRegExp, isTestFile, parseSkipFile, pathTokens, RUNNERS, runnerFiles } from './gate-coverage.mjs';

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
    '        run: node --test scripts/one.test.mjs',
    '      - name: two # node --test scripts/in-name.test.mjs',
    '        if: ${{ !cancelled() }}   # node --test scripts/in-if.test.mjs',
    '        run: >-',
    '          node --test',
    '          scripts/two-a.test.mjs',
    '          scripts/two-b.test.mjs',
    '      - name: three',
    '        run: |',
    '          echo hi',
    '          node --test "scripts/three/*.test.mjs"',
    '      - name: four',
    '        working-directory: .claude/hooks',
    '        run: npx --no-install vitest run --retry=2',
  ].join('\n');
  it('reads the run: commands of single-line, folded and literal blocks, and nothing from comments, names or if lines', () => {
    const text = commandsOfWorkflow(yml).join('\n');
    for (const want of ['scripts/one.test.mjs', 'scripts/two-a.test.mjs', 'scripts/two-b.test.mjs', 'scripts/three/*.test.mjs', 'vitest run']) assert.ok(text.includes(want), want);
    for (const no of ['commented', 'in-name', 'in-if']) assert.ok(!text.includes(no), no);
  });
  it('an empty workflow gives no command (the caller must fail on that)', () => {
    assert.deepEqual(commandsOfWorkflow('name: x\non: push\n'), []);
  });
});

describe('pathTokens', () => {
  it('returns the test paths and test globs of a command, quotes removed, flags and other words left out', () => {
    assert.deepEqual(pathTokens('node --test "scripts/a/*.test.mjs" scripts/b.test.mjs --retry=2 echo'), ['scripts/a/*.test.mjs', 'scripts/b.test.mjs']);
    assert.deepEqual(pathTokens("cd x && bash scripts/t.test.sh; pwsh -File scripts/u.test.ps1"), ['scripts/t.test.sh', 'scripts/u.test.ps1']);
    assert.deepEqual(pathTokens('node scripts/not-a-test.mjs'), []);
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
  it('accepts entries with a path and a reason; a missing reason, an empty reason or a bad shape is a problem', () => {
    const ok = parseSkipFile({ skip: [{ path: 'archive/**', reason: 'archived' }], ciGaps: [{ path: 'p/**', reason: 'pre-pr only' }] });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.skip.length, 1);
    assert.equal(ok.ciGaps.length, 1);
    assert.equal(parseSkipFile({ skip: [{ path: 'a/**' }] }).problems.length, 1);
    assert.equal(parseSkipFile({ skip: [{ path: 'a/**', reason: '   ' }] }).problems.length, 1);
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
  it('runnerFiles returns the files a runner covers when its gate exists, and none when it does not', () => {
    const files = ['.claude/hooks/src/__tests__/a.test.ts', 'opc/scripts/test_x.py', 'scripts/a.test.mjs'];
    const have = runnerFiles(files, [{ id: 'hooks-vitest', cmd: 'npx', args: ['vitest', 'run'], cwd: '.claude/hooks' }, { id: 'opc-pytest', cmd: 'uv', args: ['run', 'pytest'], cwd: 'opc' }]);
    assert.deepEqual([...have].sort(), ['.claude/hooks/src/__tests__/a.test.ts', 'opc/scripts/test_x.py']);
    assert.deepEqual([...runnerFiles(files, [])], []);
  });
});
