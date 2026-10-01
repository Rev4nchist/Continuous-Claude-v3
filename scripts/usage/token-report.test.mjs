// Tests for token-report.mjs. Each test names the source change that would make it fail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, parseLine, extractUsage, renderMarkdown } from './token-report.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'token-report.mjs');
const NOW = Date.parse('2026-09-30T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
let tmp, seq = 0;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-report-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// A fresh root per test. Files get an mtime of NOW unless told otherwise.
function mkRoot() { const r = path.join(tmp, `root${++seq}`); fs.mkdirSync(r, { recursive: true }); return r; }
function put(root, rel, lines, { mtimeDaysAgo = 0, meta } = {}) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const t = new Date(NOW - mtimeDaysAgo * 86400000); fs.utimesSync(f, t, t);
  if (meta) fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
  return f;
}
const usage = (o = {}) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...o });
function asst({ id = 'm1', model = 'claude-x', u, ts = iso(0), sid = 's1', effort, content = [], uuid, noMsgId, requestId } = {}) {
  const message = { model, content, ...(id && !noMsgId ? { id } : {}), ...(u === undefined ? {} : { usage: u }) };
  return { type: 'assistant', timestamp: ts, sessionId: sid, uuid: uuid || `u-${++seq}`, ...(effort ? { effort } : {}),
    ...(requestId ? { requestId } : {}), message };
}
const report = (root, days = 7) => buildReport({ root, days, nowMs: NOW });

test('duplicate lines of one message.id keep MAX per field, counted once', async () => {
  // Fails if: dedup is removed (sum = 3 msgs) or MAX is replaced by first/last/sum.
  const root = mkRoot();
  put(root, 'p/s1.jsonl', [
    asst({ id: 'dup', u: usage({ input_tokens: 5, output_tokens: 10 }) }),
    asst({ id: 'dup', u: usage({ input_tokens: 5, output_tokens: 90, cache_read_input_tokens: 7 }) }),
    asst({ id: 'dup', u: usage({ input_tokens: 2, output_tokens: 40 }) }),
  ]);
  const r = await report(root);
  assert.equal(r.totals.all.msgs, 1);
  assert.deepEqual([r.totals.all.input, r.totals.all.out, r.totals.all.cr], [5, 90, 7]);
  assert.equal(r.dataQuality.dupLines, 2);
});

test('resumed session repeating lines in a second file is de-duplicated globally', async () => {
  // Fails if: the de-dup map is reset per file.
  const root = mkRoot();
  const line = asst({ id: 'resumed', u: usage({ output_tokens: 100 }) });
  put(root, 'p/a.jsonl', [line]);
  put(root, 'p/b.jsonl', [line, asst({ id: 'new', u: usage({ output_tokens: 1 }) })]);
  const r = await report(root);
  assert.equal(r.totals.all.out, 101);
  assert.equal(r.totals.all.msgs, 2);
});

test('synthetic model is skipped and counted', async () => {
  // Fails if: the "<synthetic>" check is removed.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [asst({ id: 'syn', model: '<synthetic>', u: usage({ output_tokens: 50 }) })]);
  const r = await report(root);
  assert.equal(r.totals.all.total, 0);
  assert.equal(r.dataQuality.synthetic, 1);
});

test('all-zero usage is skipped and counted, not a message', async () => {
  // Fails if: the zero-sum check is removed (msgs would be 1).
  const root = mkRoot();
  put(root, 'p/s.jsonl', [asst({ id: 'z', u: usage() })]);
  const r = await report(root);
  assert.equal(r.totals.all.msgs, 0);
  assert.equal(r.dataQuality.zeroUsage, 1);
});

test('assistant line with no usage is skipped and counted without throwing', async () => {
  // Fails if: extractUsage dereferences message.usage without a guard (throws) or counts it.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [asst({ id: 'nu' }), asst({ id: 'ok', u: usage({ input_tokens: 3 }) })]);
  const r = await report(root);
  assert.equal(r.dataQuality.noUsage, 1);
  assert.equal(r.totals.all.input, 3);
});

test('missing message.id falls back to requestId so copies still de-dup, and is counted', async () => {
  // Fails if: the fallback is removed (id undefined: all copies merge into one key or all count).
  const root = mkRoot();
  put(root, 'p/s.jsonl', [
    asst({ noMsgId: true, requestId: 'req-A', u: usage({ output_tokens: 10 }) }),
    asst({ noMsgId: true, requestId: 'req-A', u: usage({ output_tokens: 20 }) }),
    asst({ noMsgId: true, requestId: 'req-B', u: usage({ output_tokens: 5 }) }),
  ]);
  const r = await report(root);
  assert.equal(r.totals.all.msgs, 2);
  assert.equal(r.totals.all.out, 25);
  assert.equal(r.dataQuality.idFallback, 2);
});

test('missing id, requestId and uuid: each line counts once, no collisions', async () => {
  // Fails if: the last-resort key ignores file and line number (all lines would merge to one).
  const root = mkRoot();
  const bare = (out) => { const l = asst({ noMsgId: true, u: usage({ output_tokens: out }) }); delete l.uuid; return l; };
  put(root, 'p/s.jsonl', [bare(4), bare(6)]);
  const r = await report(root);
  assert.equal(r.totals.all.msgs, 2);
  assert.equal(r.totals.all.out, 10);
});

test('main vs subagent is decided by path, and agentType comes from the meta file', async () => {
  // Fails if: classification trusts isSidechain, or isSubagentPath misses the "subagents" segment.
  const root = mkRoot();
  const main = asst({ id: 'main1', u: usage({ output_tokens: 10 }) }); main.isSidechain = true; // flag lies
  const sub = asst({ id: 'sub1', u: usage({ output_tokens: 30 }) }); sub.isSidechain = false;    // flag lies
  put(root, 'proj/sess1.jsonl', [main]);
  put(root, 'proj/sess1/subagents/agent-a1.jsonl', [sub], { meta: { agentType: 'kraken' } });
  const r = await report(root);
  assert.equal(r.totals.main.out, 10);
  assert.equal(r.totals.sub.out, 30);
  assert.equal(r.topAgentTypes[0].agentType, 'kraken');
  assert.equal(r.dataQuality.sidechainFlagMismatch, 2);
  assert.equal(r.dataQuality.filesSub, 1);
});

test('line-timestamp window excludes old lines in a recently modified file', async () => {
  // Fails if: the window uses file mtime instead of the line timestamp.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [
    asst({ id: 'old', ts: iso(20), u: usage({ output_tokens: 1000 }) }),
    asst({ id: 'new', ts: iso(1), u: usage({ output_tokens: 7 }) }),
  ], { mtimeDaysAgo: 0 });
  const r = await report(root, 7);
  assert.equal(r.totals.all.out, 7);
  assert.equal(r.dataQuality.outsideWindow, 1);
});

test('window uses the earliest copy: an old message re-written recently stays out', async () => {
  // Fails if: a duplicate copy with a newer timestamp overwrites the first timestamp.
  const root = mkRoot();
  put(root, 'p/a.jsonl', [asst({ id: 'rw', ts: iso(30), u: usage({ output_tokens: 500 }) })], { mtimeDaysAgo: 0 });
  put(root, 'p/b.jsonl', [asst({ id: 'rw', ts: iso(1), u: usage({ output_tokens: 500 }) })], { mtimeDaysAgo: 0 });
  const r = await report(root, 7);
  assert.equal(r.totals.all.out, 0);
});

test('file mtime older than the window is a prefilter and is counted', async () => {
  // Fails if: the mtime prefilter is removed (filesOlderThanWindow stays 0).
  const root = mkRoot();
  put(root, 'p/stale.jsonl', [asst({ id: 'st', ts: iso(1), u: usage({ output_tokens: 9 }) })], { mtimeDaysAgo: 40 });
  const r = await report(root, 7);
  assert.equal(r.dataQuality.filesOlderThanWindow, 1);
  assert.equal(r.totals.all.out, 0);
});

test('truncated last line is counted as a parse error and does not throw', async () => {
  // Fails if: JSON.parse is not guarded in parseLine.
  const root = mkRoot();
  const good = JSON.stringify(asst({ id: 'g', u: usage({ output_tokens: 4 }) }));
  const cut = JSON.stringify(asst({ id: 'cut', u: usage({ output_tokens: 99 }) })).slice(0, 60);
  put(root, 'p/live.jsonl', [good, cut]);
  const r = await report(root);
  assert.equal(r.dataQuality.parseErrors, 1);
  assert.equal(r.totals.all.out, 4);
  assert.equal(parseLine(cut).kind, 'parseError');
});

test('tool_result blocks are not counted as user commands; real command lines are', async () => {
  // Fails if: commandOf scans tool_result text (the quoted /clear in tool output would count).
  const root = mkRoot();
  const quoted = '<command-name>/clear</command-name>';
  const user = (content, uuid) => ({ type: 'user', timestamp: iso(0), sessionId: 's1', uuid, message: { role: 'user', content } });
  put(root, 'p/s.jsonl', [
    user([{ type: 'tool_result', tool_use_id: 't1', content: quoted }], 'u1'),
    user([{ type: 'text', text: quoted }, { type: 'tool_result', tool_use_id: 't2', content: quoted }], 'u2'),
    user(`${quoted}\n<command-message>clear</command-message>`, 'u3'),
    user('<command-name>/compact</command-name>', 'u4'),
  ]);
  const r = await report(root);
  assert.equal(r.commands.clear, 1);
  assert.equal(r.commands.compact, 1);
});

test('repeated command lines (same uuid, resumed file) count once', async () => {
  // Fails if: events are not de-duplicated by uuid.
  const root = mkRoot();
  const l = { type: 'user', timestamp: iso(0), sessionId: 's1', uuid: 'same', message: { role: 'user', content: '<command-name>/clear</command-name>' } };
  put(root, 'p/a.jsonl', [l]); put(root, 'p/b.jsonl', [l]);
  assert.equal((await report(root)).commands.clear, 1);
});

test('compact_boundary counts by trigger, main files only', async () => {
  // Fails if: the trigger is ignored, or subagent boundaries are counted.
  const root = mkRoot();
  const b = (trigger, uuid) => ({ type: 'system', subtype: 'compact_boundary', timestamp: iso(0), uuid, compactMetadata: { trigger } });
  put(root, 'p/s.jsonl', [b('auto', 'b1'), b('auto', 'b2'), b('manual', 'b3')]);
  put(root, 'p/s/subagents/agent-x.jsonl', [b('auto', 'b4')]);
  const r = await report(root);
  assert.equal(r.commands.boundaryAuto, 2);
  assert.equal(r.commands.boundaryManual, 1);
});

test('big Read/Grep results are split main vs subagent, de-duplicated by tool_use_id, images ignored', async () => {
  // Fails if: the 20 KB threshold, the thread split, or the tool_use_id dedup is removed.
  const root = mkRoot();
  const call = (id, name) => asst({ id: `a-${id}`, u: usage({ output_tokens: 1 }), content: [{ type: 'tool_use', id, name }] });
  const res = (id, text, uuid) => ({ type: 'user', timestamp: iso(0), uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  const big = 'x'.repeat(21 * 1024), small = 'y'.repeat(100);
  put(root, 'p/s.jsonl', [call('r1', 'Read'), res('r1', big, 'x1'), res('r1', big, 'x2'), call('g1', 'Grep'), res('g1', small, 'x3')]);
  put(root, 'p/s/subagents/agent-a.jsonl', [call('r2', 'Read'), res('r2', big, 'x4'), res('nope', big, 'x5')]);
  const r = await report(root);
  assert.deepEqual([r.bigResults.main.read, r.bigResults.main.readBig, r.bigResults.main.grep, r.bigResults.main.grepBig], [1, 1, 1, 0]);
  assert.deepEqual([r.bigResults.sub.read, r.bigResults.sub.readBig], [1, 1]);
  assert.equal(r.dataQuality.unknownTool, 1);
});

test('top sessions rank by total tokens across main and subagent threads', async () => {
  // Fails if: sessions are keyed by thread, or the sort is by message count.
  const root = mkRoot();
  put(root, 'projA/sA.jsonl', [asst({ id: 'a1', sid: 'sA', u: usage({ output_tokens: 100 }) })]);
  put(root, 'projB/sB.jsonl', [asst({ id: 'b1', sid: 'sB', u: usage({ output_tokens: 60 }) })]);
  put(root, 'projB/sB/subagents/agent-1.jsonl', [asst({ id: 'b2', sid: 'sB', u: usage({ output_tokens: 70 }) })]);
  const r = await report(root);
  assert.deepEqual(r.topSessions.map((s) => [s.sessionId, s.project, s.total]), [['sB', 'projB', 130], ['sA', 'projA', 100]]);
});

test('extractUsage reports each skip status', () => {
  // Fails if: any status branch in extractUsage is removed.
  const m = (message) => ({ message });
  assert.equal(extractUsage(m({ model: '<synthetic>', usage: usage({ output_tokens: 1 }) })).status, 'synthetic');
  assert.equal(extractUsage(m({ model: 'x' })).status, 'noUsage');
  assert.equal(extractUsage(m({ model: 'x', usage: usage() })).status, 'zero');
  assert.equal(extractUsage(m({ model: 'x', usage: usage({ input_tokens: 1 }) })).status, 'ok');
});

test('CLI: --root, --format json and --out write a report; bad --days exits 2', () => {
  // Fails if: the entry-point guard, --root, --out or --days validation is removed.
  const root = mkRoot();
  put(root, 'p/s.jsonl', [asst({ id: 'c1', ts: new Date().toISOString(), u: usage({ output_tokens: 12 }) })], { mtimeDaysAgo: 0 });
  fs.utimesSync(path.join(root, 'p/s.jsonl'), new Date(), new Date());
  const out = path.join(tmp, 'cli', 'out.json');
  const ok = spawnSync(process.execPath, [CLI, '--root', root, '--days', '7', '--format', 'json', '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).totals.all.out, 12);
  const md = spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });
  assert.match(md.stdout, /^# Token report: last 7 days/);
  assert.ok(md.stdout.split('\n').length < 60, 'markdown stays under 60 lines');
  const bad = spawnSync(process.execPath, [CLI, '--root', root, '--days', 'abc'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('markdown renders an empty root without NaN', async () => {
  // Fails if: ratios divide by zero without a guard.
  const md = renderMarkdown(await report(mkRoot()));
  assert.ok(!/NaN|undefined/.test(md), md);
});
