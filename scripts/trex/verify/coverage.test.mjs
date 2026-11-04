// Tests for coverage.mjs: the V8 and bash-trace reader, the argv wrapper and the container loader.
// Sample data in fixtures/coverage/ was captured in the real TREX image (trex:49d167ec9ca1) on 2026-11-03.
// V8 offsets count UTF-16 units of the source string, not bytes (u.mjs holds a non-ASCII comment to prove it).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFlow } from '../flow-run.mjs';
import {
  covDir, coverageWanted, loadContainerCoverage, makeCoverage, parseTrace, targetKind, traceFile, wrapAction,
} from './coverage.mjs';

const FIX = new URL('./fixtures/coverage/', import.meta.url);
// A Windows checkout may turn LF into CRLF; the captured offsets are for the LF text.
const read = (name) => readFileSync(new URL(name, FIX), 'utf8').replace(/\r\n/g, '\n');
const v8 = JSON.parse(read('lib.v8.json'));
const sources = { 'lib.mjs': read('lib.mjs'), 'u.mjs': read('u.mjs'), 'm.mjs': 'x\n' };
const cov = (extra = {}) => makeCoverage({ v8: [v8], sources, trace: read('t.trace'), ...extra });

// ---------- V8 reader ----------

// lib.mjs: line 1 export function f, 2 if, 3 return 'big' (never ran), 5 return 'small', 7 export function never, 8 return 1.
test('V8: a line in the called function body is executed', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 5, 5), true);
});

// Breaks if: the reader takes the outer function range (count 1) instead of the innermost one (count 0).
test('V8: a line inside a nested count-0 block is not executed', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 3, 3), false);
});

test('V8: a function that never ran is not executed', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 8, 8), false);
});

// Breaks if: the range test needs all lines to have run instead of any line.
test('V8: a range with one executed line counts, a range with none does not', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 2, 3), true);
  assert.equal(cov().citedLinesExecuted('lib.mjs', 3, 3), false);
});

// Breaks if: the file is looked up by suffix only, or a missing file reads as covered.
test('V8: a file the run never loaded is false, not null and not true', () => {
  assert.equal(cov().citedLinesExecuted('other.mjs', 1, 1), false);
  assert.equal(cov().citedLinesExecuted('ib.mjs', 1, 1), false);
});

test('V8: no coverage files at all gives null', () => {
  assert.equal(makeCoverage({ v8: [], sources }).citedLinesExecuted('lib.mjs', 1, 1), null);
  assert.equal(makeCoverage({}).citedLinesExecuted('lib.mjs', 1, 1), null);
});

// Breaks if: offsets are read as bytes. u.mjs line 1 is the unicode comment; a() is line 2, b() spans lines 3-5 and never ran.
test('V8: offsets are UTF-16 units: a non-ASCII comment above the cited line does not shift it', () => {
  assert.equal(cov().citedLinesExecuted('u.mjs', 2, 2), true);
  assert.equal(cov().citedLinesExecuted('u.mjs', 4, 4), false);
});

test('V8: a loaded file with no source text gives null (the lines cannot be placed)', () => {
  assert.equal(cov({ sources: {} }).citedLinesExecuted('lib.mjs', 5, 5), null);
});

test('V8: node: internals and non-/app urls never match', () => {
  assert.equal(cov().citedLinesExecuted('internal/per_context/primordials', 1, 1), false);
});

// Breaks if: two processes that load the same file overwrite each other instead of merging.
test('V8: a line counts when any process executed it', () => {
  const cold = { result: [{ url: 'file:///app/lib.mjs', functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: 120, count: 0 }] }] }] };
  assert.equal(makeCoverage({ v8: [cold, v8], sources }).citedLinesExecuted('lib.mjs', 5, 5), true);
  assert.equal(makeCoverage({ v8: [cold], sources }).citedLinesExecuted('lib.mjs', 5, 5), false);
});

test('V8: blank and comment-only lines do not count as code', () => {
  const src = '// c\n\nlet a = 1;\n';
  const entry = { result: [{ url: 'file:///app/s.mjs', functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }] }] };
  const c = makeCoverage({ v8: [entry], sources: { 's.mjs': src } });
  assert.equal(c.citedLinesExecuted('s.mjs', 1, 2), false);
  assert.equal(c.citedLinesExecuted('s.mjs', 1, 3), true);
});

test('a bad line range throws RangeError', () => {
  for (const [s, e] of [[0, 1], [3, 2], [1.5, 2], ['1', 2]]) assert.throws(() => cov().citedLinesExecuted('lib.mjs', s, e), RangeError, `${s}-${e}`);
});

test('./ and /app/ prefixes on the cited file are ignored', () => {
  assert.equal(cov().citedLinesExecuted('./lib.mjs', 5, 5), true);
  assert.equal(cov().citedLinesExecuted('/app/lib.mjs', 5, 5), true);
});

// ---------- bash trace ----------

test('trace: executed lines come from the file:line prefix, relative and absolute', () => {
  const c = cov();
  assert.equal(c.citedLinesExecuted('t.sh', 9, 9), true);
  assert.equal(c.citedLinesExecuted('t.sh', 4, 4), true);
  assert.equal(c.citedLinesExecuted('sub.sh', 2, 2), true); // traced as /app/sub.sh
  assert.equal(c.citedLinesExecuted('/app/sub.sh', 1, 1), true);
});

// Breaks if: the trace marks the whole file as covered once it saw one line.
test('trace: a line that never ran is false', () => {
  assert.equal(cov().citedLinesExecuted('t.sh', 7, 7), false); // echo never
  assert.equal(cov().citedLinesExecuted('t.sh', 7, 8), false);
  assert.equal(cov().citedLinesExecuted('t.sh', 6, 8), true); // the if line ran
});

test('trace: a script that was never traced is false', () => {
  assert.equal(cov().citedLinesExecuted('scripts/other.sh', 1, 1), false);
});

test('trace: no trace gives null, an empty trace gives null', () => {
  assert.equal(makeCoverage({ v8: [v8], sources, trace: null }).citedLinesExecuted('t.sh', 2, 2), null);
  assert.equal(makeCoverage({ v8: [v8], sources, trace: '' }).citedLinesExecuted('t.sh', 2, 2), null);
});

// Breaks if: a .sh file is answered from V8 data, or a .mjs file from the trace.
test('kind follows the file extension', () => {
  assert.equal(makeCoverage({ trace: read('t.trace') }).citedLinesExecuted('lib.mjs', 5, 5), null);
  assert.equal(makeCoverage({ v8: [v8], sources }).citedLinesExecuted('t.sh', 2, 2), null);
});

test('parseTrace: nested levels, empty BASH_SOURCE and noise lines', () => {
  const m = parseTrace("++scripts/a.sh:12 echo hi\n+++scripts/a.sh:13 'x'\n+:1 true\n+ x=1\nplain output\n");
  assert.deepEqual([...m.get('scripts/a.sh')].sort(), [12, 13]);
  assert.equal(m.size, 1);
});

test('trace: a relative trace path from a sub folder matches by path suffix, not by base name alone', () => {
  const c = makeCoverage({ trace: '+lib/x.sh:4 echo\n' });
  assert.equal(c.citedLinesExecuted('scripts/lib/x.sh', 4, 4), true);
  assert.equal(c.citedLinesExecuted('scripts/other/x.sh', 4, 4), false);
});

// ---------- wrapper ----------

test('targetKind: node, bash, a .sh path, and everything else', () => {
  assert.equal(targetKind(['node', 'a.mjs']), 'node');
  assert.equal(targetKind(['/usr/local/bin/node', 'a.mjs']), 'node');
  assert.equal(targetKind(['bash', 'a.sh']), 'bash');
  assert.equal(targetKind(['scripts/a.sh']), 'bash');
  for (const cmd of [['sh', 'a.sh'], ['npx', 'vitest'], ['git', 'status'], ['nodejs', 'x'], ['cat', 'a.sh']]) assert.equal(targetKind(cmd), null, cmd.join(' '));
});

test('wrapAction: a node target gets NODE_V8_COVERAGE and keeps its argv and env', () => {
  const action = { cmd: ['node', 'scripts/a.mjs', '--x'], cwd: 'sub', env: { K: 'v' }, stdin: 'in' };
  const out = wrapAction(action, 'my-flow');
  assert.deepEqual(out.cmd, action.cmd);
  assert.deepEqual(out.env, { K: 'v', NODE_V8_COVERAGE: '/app/.verify/my-flow/cov' });
  assert.equal(out.cwd, 'sub');
  assert.equal(out.stdin, 'in');
  assert.equal(covDir('my-flow'), '/app/.verify/my-flow/cov');
  assert.equal(action.env.NODE_V8_COVERAGE, undefined, 'the input action is not changed');
});

test('wrapAction: a bash target runs under a prelude that opens the trace and sets BASH_ENV', () => {
  const out = wrapAction({ cmd: ['bash', 'scripts/a.sh', 'arg one'] }, 'my-flow');
  assert.equal(out.cmd[0], 'sh');
  assert.equal(out.cmd[1], '-c');
  assert.match(out.cmd[2], /BASH_XTRACEFD=9/);
  assert.match(out.cmd[2], /exec "\$@"/);
  assert.deepEqual(out.cmd.slice(3, 5), ['sh', '/app/.verify/my-flow']);
  assert.equal(out.cmd[5], "PS4='+${BASH_SOURCE}:${LINENO} '; set -x");
  assert.deepEqual(out.cmd.slice(6), ['bash', 'scripts/a.sh', 'arg one']);
  assert.equal(traceFile('my-flow'), '/app/.verify/my-flow/trace');
});

test('wrapAction: a bare .sh path is run through bash, so a #!/bin/sh shebang cannot drop the trace', () => {
  const out = wrapAction({ cmd: ['scripts/a.sh', '-v'] }, 'my-flow');
  assert.deepEqual(out.cmd.slice(6), ['bash', 'scripts/a.sh', '-v']);
});

test('wrapAction: any other target comes back as the same object', () => {
  const action = { cmd: ['git', 'status'] };
  assert.equal(wrapAction(action, 'my-flow'), action);
});

test('coverageWanted: off by default, true for all flows, or a list of flow ids', () => {
  const flow = { id: 'a-flow', driver: 'cli', profile: 'container' };
  assert.equal(coverageWanted(undefined, flow), false);
  assert.equal(coverageWanted(false, flow), false);
  assert.equal(coverageWanted(true, flow), true);
  assert.equal(coverageWanted(['a-flow'], flow), true);
  assert.equal(coverageWanted(['b-flow'], flow), false);
  assert.equal(coverageWanted(true, { ...flow, profile: 'host' }), false);
  assert.equal(coverageWanted(true, { ...flow, driver: 'hook' }), false);
});

// ---------- plumbing through the real runFlow ----------

const flowOf = (cmd, extra = {}) => ({
  id: 'cov-demo', profile: 'container', driver: 'cli', severity: 'P1', limits: { timeoutMs: 60_000, retries: 0 },
  steps: [{ action: { cmd }, checks: [{ exit: 0 }] }], ...extra,
});
const gitSetup = (argv) => argv[0] === 'rm' || argv[0] === 'git';

function ctxOf(extra = {}) {
  const calls = [];
  const ctx = {
    now: () => new Date('2026-11-03T12:00:00Z'), readFixture: () => null, writeStep: () => [], defaultRemote: 'https://example.invalid/r.git',
    exec: async (argv, opts) => {
      if (!gitSetup(argv)) calls.push({ argv, opts });
      return { code: 0, stdout: argv[0] === 'git' && argv[1] === 'rev-parse' ? 'abc\n' : '', stderr: '', timedOut: false };
    },
    ...extra,
  };
  return { ctx, calls };
}

// Breaks if: the wrapper is always on, which would change the argv of every existing flow.
test('runFlow: with coverage off the exec call is exactly what it was before', async () => {
  const { ctx, calls } = ctxOf();
  await runFlow(flowOf(['node', 'a.mjs']), ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['node', 'a.mjs']);
  assert.equal(calls[0].opts.env, undefined);
});

test('runFlow: with coverage on a node step gets NODE_V8_COVERAGE for the flow id', async () => {
  const { ctx, calls } = ctxOf({ coverage: true });
  await runFlow(flowOf(['node', 'a.mjs']), ctx);
  assert.deepEqual(calls[0].argv, ['node', 'a.mjs']);
  assert.equal(calls[0].opts.env.NODE_V8_COVERAGE, '/app/.verify/cov-demo/cov');
});

test('runFlow: a coverage list that does not name the flow leaves it alone', async () => {
  const { ctx, calls } = ctxOf({ coverage: ['other-flow'] });
  await runFlow(flowOf(['node', 'a.mjs']), ctx);
  assert.equal(calls[0].opts.env, undefined);
});

test('runFlow: with coverage on a bash step runs through the trace prelude', async () => {
  const { ctx, calls } = ctxOf({ coverage: ['cov-demo'] });
  await runFlow(flowOf(['bash', 'a.sh']), ctx);
  assert.equal(calls[0].argv[0], 'sh');
  assert.deepEqual(calls[0].argv.slice(-2), ['bash', 'a.sh']);
});

// ---------- container loader ----------

function fakeExec(files) {
  const exec = async (argv) => {
    if (argv[0] === 'sh') {
      const dir = argv[argv.length - 1];
      const names = Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1));
      return { code: names.length ? 0 : 1, stdout: names.join('\n'), stderr: '', timedOut: false };
    }
    const f = argv[argv.length - 1];
    return f in files ? { code: 0, stdout: files[f], stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: 'no such file', timedOut: false };
  };
  return exec;
}

test('loadContainerCoverage: reads the cov json files, the trace and the cited sources', async () => {
  const exec = fakeExec({
    '/app/.verify/f1/cov/coverage-1.json': read('lib.v8.json'),
    '/app/.verify/f1/cov/coverage-2.json': '{not json',
    '/app/.verify/f1/trace': read('t.trace'),
    '/app/lib.mjs': read('lib.mjs'),
  });
  const data = await loadContainerCoverage(exec, 'f1', ['lib.mjs', 'gone.mjs']);
  assert.equal(data.v8.length, 1);
  assert.deepEqual(data.v8[0].result.map((r) => r.url), ['file:///app/m.mjs', 'file:///app/lib.mjs', 'file:///app/u.mjs']);
  assert.equal(data.trace, read('t.trace'));
  assert.deepEqual(Object.keys(data.sources), ['lib.mjs']);
  assert.equal(makeCoverage(data).citedLinesExecuted('lib.mjs', 5, 5), true);
});

test('loadContainerCoverage: nothing written gives empty v8 and a null trace, so the answer is null', async () => {
  const data = await loadContainerCoverage(fakeExec({}), 'f1', ['lib.mjs']);
  assert.deepEqual(data, { v8: [], trace: null, sources: {} });
  assert.equal(makeCoverage(data).citedLinesExecuted('lib.mjs', 1, 1), null);
});

test('loadContainerCoverage: an exec that throws gives no data and no throw', async () => {
  const data = await loadContainerCoverage(async () => { throw new Error('docker gone'); }, 'f1', ['lib.mjs']);
  assert.deepEqual(data, { v8: [], trace: null, sources: {} });
});

// ---------- declaration lines ----------

// Breaks if: a declaration line reads executed because the module range (count 1) holds the word "export".
// lib.mjs line 7 is `export function never() {` and u.mjs line 3 is `export function b() {`; neither function was ever called.
test('V8: the declaration line of a function that never ran is not executed', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 7, 7), false);
  assert.equal(cov().citedLinesExecuted('u.mjs', 3, 3), false);
});

// Breaks if: the declaration rule is applied so widely that a called function's header or an `if (...) {` line reads false.
test('V8: the declaration line of a function that ran, and an if line inside it, are executed', () => {
  assert.equal(cov().citedLinesExecuted('lib.mjs', 1, 1), true);
  assert.equal(cov().citedLinesExecuted('lib.mjs', 2, 2), true);
  assert.equal(cov().citedLinesExecuted('u.mjs', 2, 2), true);
});

// Breaks if: a callback that never ran makes the line that passes it read false (the line itself ran).
test('V8: a line that passes a never-called callback is executed', () => {
  const src = '[1].map((x) => x + 1);\n';
  const entry = { result: [{ url: 'file:///app/cb.mjs', functions: [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
    { functionName: '', ranges: [{ startOffset: 8, endOffset: 20, count: 0 }] },
  ] }] };
  assert.equal(makeCoverage({ v8: [entry], sources: { 'cb.mjs': src } }).citedLinesExecuted('cb.mjs', 1, 1), true);
});

// Breaks if: only the first of several scripts/processes is read for the declaration rule.
test('V8: a declaration line counts when any process called the function', () => {
  const src = 'export function g() {\n  return 1;\n}\n';
  const mk = (count) => ({ result: [{ url: 'file:///app/g.mjs', functions: [
    { functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
    { functionName: 'g', ranges: [{ startOffset: 7, endOffset: src.length - 1, count }] },
  ] }] });
  assert.equal(makeCoverage({ v8: [mk(0)], sources: { 'g.mjs': src } }).citedLinesExecuted('g.mjs', 1, 1), false);
  assert.equal(makeCoverage({ v8: [mk(0), mk(2)], sources: { 'g.mjs': src } }).citedLinesExecuted('g.mjs', 1, 1), true);
});
