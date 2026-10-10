// Tests for bash-output-bands.mjs. Each test names the source change that would make it fail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, commandHead, persistInfo, bandOf } from './bash-output-bands.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bash-output-bands.mjs');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
let tmp, seq = 0;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-bands-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function mkRoot() { const r = path.join(tmp, `root${++seq}`); fs.mkdirSync(r, { recursive: true }); return r; }
function put(root, rel, lines) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(NOW); fs.utimesSync(f, t, t);
}
const use = (id, name, input, ts = iso(0)) => ({ type: 'assistant', timestamp: ts,
  message: { id: `m-${id}`, model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, { ts = iso(0), isError = false, toolUseResult } = {}) => ({ type: 'user', timestamp: ts,
  ...(toolUseResult ? { toolUseResult } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
const shell = (id, n, opts = {}) => [use(id, 'Bash', { command: opts.cmd || 'cat big.txt' }), result(id, 'x'.repeat(n), opts)];
const report = (root, days = 7) => buildReport({ root, days, nowMs: NOW });
const PREVIEW = '<persisted-output>\nOutput too large (39.1KB). Full output saved to: /h/.claude/projects/p/s/tool-results/b1n90p1b4.txt\n\nPreview (first 2KB):\nxxx\n...\n</persisted-output>';

test('persisted result counts as persisted with its original size, not as a small band', async () => {
  // Fails if: persistInfo ignores toolUseResult.persistedOutputPath, so the 2 KB preview lands in "small".
  const root = mkRoot();
  put(root, 'p/s.jsonl', [use('t1', 'Bash', { command: 'find /' }),
    result('t1', PREVIEW, { toolUseResult: { persistedOutputPath: '/x/tool-results/abc.txt', persistedOutputSize: 40000 } })]);
  const r = await report(root);
  assert.equal(r.threads.main.persisted.n, 1);
  assert.equal(r.threads.main.persisted.originalChars, 40000);
  assert.equal(r.threads.main.bands.small.n, 0);
});

test('text marker alone is enough when toolUseResult is missing (older transcripts)', () => {
  // Fails if: the PERSIST_RE fallback or the KB multiplier is removed.
  const p = persistInfo(PREVIEW, undefined);
  assert.equal(p.path, '/h/.claude/projects/p/s/tool-results/b1n90p1b4.txt');
  assert.equal(p.originalChars, Math.round(39.1 * 1024));
  assert.equal(persistInfo('plain output', undefined), null);
});

test('band edges: 4999 small, 5000 mid, 29999 mid, 30000 large', () => {
  // Fails if: a comparison flips from < to <= or the constants change.
  assert.deepEqual([4999, 5000, 29999, 30000].map(bandOf), ['small', 'mid', 'mid', 'large']);
});

test('a resumed file repeating a tool result counts it once', async () => {
  // Fails if: the tool_use_id de-dup is removed (results would be 2).
  const root = mkRoot();
  put(root, 'p/a.jsonl', shell('t1', 6000));
  put(root, 'p/b.jsonl', shell('t1', 6000));
  const r = await report(root);
  assert.equal(r.threads.main.results, 1);
  assert.equal(r.dataQuality.dupResults, 1);
});

test('a file under subagents/ counts as subagent', async () => {
  // Fails if: thread comes from anything but the path.
  const root = mkRoot();
  put(root, 'p/s/subagents/agent-1.jsonl', shell('t1', 100));
  const r = await report(root);
  assert.equal(r.threads.sub.results, 1);
  assert.equal(r.threads.main.results, 0);
});

test('a failed command counts as an error, not in a band', async () => {
  // Fails if: is_error is ignored, so a 7K stack trace lands in "mid".
  const root = mkRoot();
  put(root, 'p/s.jsonl', shell('t1', 7000, { isError: true }));
  const r = await report(root);
  assert.equal(r.threads.main.errors, 1);
  assert.equal(r.threads.main.bands.mid.n, 0);
});

test('PowerShell counts; Grep and other tools do not', async () => {
  // Fails if: SHELLS loses PowerShell, or the tool-name filter is removed.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [use('t1', 'PowerShell', { command: 'Get-Content big.txt' }), result('t1', 'y'.repeat(8000)),
    use('t2', 'Grep', { pattern: 'x' }), result('t2', 'z'.repeat(8000))]);
  const r = await report(root);
  assert.equal(r.threads.main.results, 1);
  assert.equal(r.topHeads[0].head, 'Get-Content');
});

test('a Read of a saved file in another file counts as a re-read; other Reads do not', async () => {
  // Fails if: re-reads are matched per file at ingest time, or by full path instead of basename.
  const root = mkRoot();
  put(root, 'p/s/subagents/agent-1.jsonl', [use('r1', 'Read', { file_path: 'C:\\h\\tool-results\\abc.txt' }), result('r1', 'q'.repeat(900)),
    use('r2', 'Read', { file_path: '/repo/other.ts' }), result('r2', 'q'.repeat(500))]);
  put(root, 'p/s.jsonl', [use('t1', 'Bash', { command: 'find /' }),
    result('t1', PREVIEW, { toolUseResult: { persistedOutputPath: '/h/tool-results/abc.txt', persistedOutputSize: 50000 } })]);
  const r = await report(root);
  assert.equal(r.threads.sub.rereads.n, 1);
  assert.equal(r.threads.sub.rereads.chars, 900);
  assert.equal(r.threads.main.persistNetSavedChars, 50000 - PREVIEW.length);
});

test('the window uses the line timestamp, not the file mtime', async () => {
  // Fails if: the line timestamp check is dropped (a fresh file holding old lines would count).
  const root = mkRoot();
  put(root, 'p/s.jsonl', [use('t1', 'Bash', { command: 'ls' }, iso(30)), result('t1', 'a', { ts: iso(30) })]);
  const r = await report(root, 7);
  assert.equal(r.threads.main.results, 0);
  assert.equal(r.dataQuality.outsideWindow, 1);
});

test('a result with no matching tool_use is counted, not thrown', async () => {
  // Fails if: a missing tool_use crashes ingest or is silently dropped.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [result('ghost', 'a')]);
  const r = await report(root);
  assert.equal(r.dataQuality.unknownTool, 1);
});

test('commandHead strips setup statements and keeps subcommands', () => {
  // Fails if: SETUP_RE stops looping, or TWO_WORD / trailing-separator handling is removed.
  assert.equal(commandHead('E=/tmp/x; cd "$E" && git log -5'), 'git log');
  assert.equal(commandHead('FOO=1 npm test'), 'npm test');
  assert.equal(commandHead('cd /repo && mkdir -p out && ls; echo hi'), 'ls');
  assert.equal(commandHead('timeout 30 /usr/bin/python3 x.py'), 'python3');
  assert.equal(commandHead(''), '?');
});

test('CLI rejects a bad --days with exit code 2', () => {
  // Fails if: parseCli stops validating days.
  const r = spawnSync(process.execPath, [CLI, '--days', 'abc', '--root', mkRoot()], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('a file read through the shell is read-equivalent and kept out of the steal-A pool', async () => {
  // Fails if: isReadEquivalent is dropped, or a pipe (a derived answer) stops disqualifying a command.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [...shell('t1', 9000, { cmd: 'cd /r && sed -n 1,200p a.ts; echo ---; cat b.md' }),
    ...shell('t2', 7000, { cmd: 'grep -rn foo .' }), ...shell('t3', 6000, { cmd: 'cat big.log | grep ERROR' })]);
  const r = await report(root);
  assert.equal(r.threads.main.readEquivalentBig.chars, 9000);
  assert.equal(r.threads.main.stealAPoolChars, 13000);
});
