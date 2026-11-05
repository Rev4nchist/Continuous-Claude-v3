// Tests for scripts/github/local-review/trace.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/trace.test.mjs
// The stream is a real cursor-agent stream-json run (fixtures/cursor-review/stream-json-read-glob.jsonl, 2026-11-04 precheck, grok-4.7-high):
// one glob call, two read calls, then the answer. Grep, error and cap cases use small events built to the same shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTrace, condense, contextSha, cursorAgentVersion, relPath } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(HERE, '..', 'fixtures', 'cursor-review', 'stream-json-read-glob.jsonl'), 'utf8');
// The folder the precheck ran in (the cwd of its system/init event). The reads name files under it with backslashes.
const TREE = 'C:\\Users\\dkhay\\AppData\\Local\\Temp\\claude\\C--Users-dkhay-continuous-claude\\5cbfb659-13cd-42b8-a19c-17cbaefdd9f0\\scratchpad\\stream-precheck';
const META = {
  runId: 'run-1', pr: 7, headSha: 'a'.repeat(40), engineSha: 'b'.repeat(40), promptSha256: 'c'.repeat(64), contextSha: 'd'.repeat(64), model: 'grok-4.7-high',
  cursorAgentVersion: '2026.10.22-27dcf5f', durationMs: 15256, funnel: { raw: 1, withdrawn: 0, dropped: { byReason: {} }, posted: 1 },
  findings: [{ id: 'f1', severity: 'major', file: 'main.mjs', startLine: 3, confidence: 4, title: 'x', body: 'must not leak into the trace' }], diffFiles: ['main.mjs', 'math.mjs'],
};

const call = (subtype, id, kind, body, extra = {}) => JSON.stringify({ type: 'tool_call', subtype, call_id: id, tool_call: { [kind]: body, startedAtMs: '1000', ...(subtype === 'completed' ? { completedAtMs: '1500' } : {}), ...extra } });

test('filesRead lists each file the reviewer read, repo-relative with forward slashes, with the line range (breaks if the tree prefix or backslashes stay)', () => {
  const t = buildTrace({ raw: RAW, treeDir: TREE, ...META });
  assert.deepEqual(t.filesRead.map((f) => f.path).sort(), ['main.mjs', 'math.mjs']);
  const math = t.filesRead.find((f) => f.path === 'math.mjs');
  assert.deepEqual(math.ranges, [[1, 4]]);
  assert.ok(!JSON.stringify(t).includes('AppData'), 'no temp-tree path may stay in the trace');
});

test('the glob call is kept apart from reads, the answer text is not in the trace, and the contract keys are all present (breaks if a key is renamed or the findings body is copied)', () => {
  const t = buildTrace({ raw: RAW, treeDir: TREE, ...META });
  for (const key of ['runId', 'pr', 'headSha', 'engineSha', 'promptSha256', 'contextSha', 'model', 'cursorAgentVersion', 'filesRead', 'greps', 'toolErrors', 'toolStats', 'durationMs', 'funnel', 'findings', 'diffFiles']) {
    assert.ok(key in t, `missing ${key}`);
  }
  assert.deepEqual(t.findings, [{ id: 'f1', sev: 'major', path: 'main.mjs', line: 3, confidence: 4 }]);
  assert.deepEqual(t.globs, [{ glob: '**/{main,math}.mjs' }]);
  assert.equal(t.greps.length, 0);
  assert.equal(t.toolStats.toolCalls, 3);
  assert.equal(t.streamModel, 'Grok 4.7 256K High');
});

test('a grep call gives {pattern, glob}; a failed call is a toolError; a read with offset and limit gets that range (breaks if grep args are read from the wrong key or errors are dropped)', () => {
  const raw = [
    call('started', 'g1', 'grepToolCall', { args: { pattern: 'foo\\(', glob: '*.mjs', path: 'C:\\t\\tree' } }),
    call('completed', 'g1', 'grepToolCall', { args: { pattern: 'foo\\(', glob: '*.mjs', path: 'C:\\t\\tree' }, result: { success: { matches: 2 } } }),
    call('completed', 'r1', 'readToolCall', { args: { path: 'C:\\t\\tree\\src\\a.mjs', offset: 10, limit: 5 }, result: { success: { content: 'x', totalLines: 90 } } }),
    call('completed', 'r2', 'readToolCall', { args: { path: 'C:\\t\\tree\\src\\gone.mjs' }, result: { error: { message: 'file not found' } } }),
  ].join('\n');
  const t = buildTrace({ raw, treeDir: 'C:\\t\\tree', ...META });
  assert.deepEqual(t.greps, [{ pattern: 'foo\\(', glob: '*.mjs' }]);
  assert.deepEqual(t.filesRead.find((f) => f.path === 'src/a.mjs').ranges, [[10, 14]]);
  assert.equal(t.toolErrors.length, 1);
  assert.match(t.toolErrors[0].message, /file not found/);
  assert.equal(t.toolErrors[0].path, 'src/gone.mjs');
});

test('the same file read twice is one entry with both ranges, and a tool call with no completion still counts as read (breaks if a repeat makes a second entry or started-only calls are lost)', () => {
  const raw = [
    call('completed', 'r1', 'readToolCall', { args: { path: '/t/a.mjs' }, result: { success: { totalLines: 10, readRange: { startLine: 1, endLine: 10 } } } }),
    call('completed', 'r2', 'readToolCall', { args: { path: '/t/a.mjs', offset: 3, limit: 2 }, result: { success: { readRange: { startLine: 3, endLine: 4 } } } }),
    call('started', 'r3', 'readToolCall', { args: { path: '/t/b.mjs' } }),
  ].join('\n');
  const t = buildTrace({ raw, treeDir: '/t', ...META });
  assert.deepEqual(t.filesRead.map((f) => f.path), ['a.mjs', 'b.mjs']);
  assert.deepEqual(t.filesRead[0].ranges, [[1, 10], [3, 4]]);
});

test('relPath strips the tree prefix with either slash, folds case on Windows drive paths, and leaves outside paths absolute (breaks if one prefix form is missed)', () => {
  assert.equal(relPath('C:\\Tree\\src\\a.mjs', ['c:/tree']), 'src/a.mjs');
  assert.equal(relPath('/private/tmp/t/src/a.mjs', ['/tmp/t', '/private/tmp/t']), 'src/a.mjs');
  assert.equal(relPath('./src/a.mjs', []), 'src/a.mjs');
  assert.equal(relPath('C:\\other\\x.mjs', ['C:\\tree']), 'C:/other/x.mjs');
  assert.equal(relPath('C:\\treehouse\\x.mjs', ['C:\\tree']), 'C:/treehouse/x.mjs', 'a prefix must end at a folder boundary');
});

test('a stream with no tool calls and a junk line gives empty lists, not an error (breaks if one bad line throws)', () => {
  const t = buildTrace({ raw: 'not json\n{"type":"result","result":"x"}\n', treeDir: TREE, ...META });
  assert.deepEqual([t.filesRead, t.greps, t.toolErrors], [[], [], []]);
  assert.equal(t.toolStats.toolCalls, 0);
});

test('condense caps a message at 1500 characters, a tool call at 500, the list at 160 entries, and flags errors (breaks if a cap is removed)', () => {
  const long = 'z'.repeat(5000);
  const lines = [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } })];
  lines.push(call('completed', 'e1', 'readToolCall', { args: { path: `/t/${'p'.repeat(900)}.mjs` }, result: { error: { message: 'boom' } } }));
  for (let i = 0; i < 200; i += 1) lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `m${i}` }] } }));
  const md = condense(lines.join('\n'), { treeDir: '/t' });
  const entries = md.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(entries.length, 161, '160 entries and one cut note');
  assert.match(entries.at(-1), /cut/);
  assert.ok(entries[0].length <= 1500 + 40, 'the long message is cut');
  assert.match(entries[0], /\[cut/);
  const tool = entries.find((l) => l.includes('read'));
  assert.ok(tool.length <= 500 + 40);
  assert.match(tool, /ERROR/);
});

test('condense on the real stream names the tools and the answer, with no temp path (breaks if tool calls are left out)', () => {
  const md = condense(RAW, { treeDir: TREE });
  assert.match(md, /glob/);
  assert.match(md, /read .*math\.mjs/);
  assert.match(md, /subtracts/);
  assert.ok(!md.includes('AppData'));
});

test('contextSha is the sha256 of the CONTEXT.md text (breaks if another hash or an empty text is used)', () => {
  assert.equal(contextSha('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('cursorAgentVersion reads the version folder from the agent path, else runs --version once, else null (breaks if the path form or the fallback is lost)', () => {
  const win = { cmd: 'C:\\x\\versions\\2026.10.22-27dcf5f\\node.exe', prefixArgs: ['C:\\x\\versions\\2026.10.22-27dcf5f\\index.js'] };
  assert.equal(cursorAgentVersion(win, { run: () => { throw new Error('must not spawn'); } }), '2026.10.22-27dcf5f');
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: '2026.11.01-abc\n' }; };
  assert.equal(cursorAgentVersion({ cmd: 'cursor-agent', prefixArgs: [] }, { run }), '2026.11.01-abc');
  assert.deepEqual(calls, [['cursor-agent', ['--version']]]);
  assert.equal(cursorAgentVersion({ cmd: 'cursor-agent', prefixArgs: [] }, { run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(cursorAgentVersion({ cmd: 'cursor-agent', prefixArgs: [] }, { run: () => { throw new Error('ENOENT'); } }), null);
});

test('condense keeps the temp tree path out of a result: a grep result is keyed by the tree folder (breaks if scrub only reads string values, not object keys)', () => {
  const tree = 'C:\\Users\\x\\AppData\\Local\\Temp\\cursor-review-AbC123\\tree';
  const grep = { pattern: 'foo', glob: '*.ts', path: '.claude\\plugins' };
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: tree }),
    call('completed', 'g1', 'grepToolCall', { args: grep, result: { success: { pattern: 'foo', workspaceResults: { [tree]: { content: { matches: [{ file: `${tree}\\src\\a.ts`, line: 3 }] } } } } } }),
  ].join('\n');
  const md = condense(raw, { treeDir: tree });
  assert.ok(!md.includes('AppData') && !md.includes('cursor-review-'), md);
  assert.match(md, /TOOL grep foo in \*\.ts => ok/);
  assert.match(md, /"file":"src\\\\a\.ts"/, 'the file name under the tree stays, with no separator left in front of it');
});
