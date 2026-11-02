// Tests for scripts/github/cursor-review.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/cursor-review.test.mjs
// The parser samples in fixtures/cursor-review/ are the raw JSON outputs of the 2026-11-01 Cursor runs (PR 217, 222, 225, 238).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BAND_MODEL, EXIT, MODEL_ALLOWLIST, PER_REF_CAP, WEEKLY_CAP, WEEK_MS,
  buildPrompt, countRuns, finishRun, main, parseArgs, parseReviewOutput, prepareReview, readLedger, reserveRun,
  resolveAgent, resolveModel, runAgent, runReview,
} from './cursor-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(path.join(HERE, 'fixtures', 'cursor-review', `cursor-${n}.json`), 'utf8');
const tmp = (label) => mkdtempSync(path.join(os.tmpdir(), `cursor-review-test-${label}-`));
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const DAY = 86_400_000;

// ---------- model allowlist and band mapping ----------

test('the allowlist is exactly grok-4.7-high and grok-4.7-xhigh', () => {
  assert.deepEqual([...MODEL_ALLOWLIST].sort(), ['grok-4.7-high', 'grok-4.7-xhigh']);
});

for (const bad of [undefined, null, '', '   ', 'auto', 'Auto', 'AUTO', 'default', 'grok-4.7-high-fast', 'grok-4.7-xhigh-fast', 'composer-2.5',
  'composer-2.5-fast', 'grok-4.7-low', 'grok-4.7-medium', 'cursor-grok-4.6-high', 'Grok-4.7-High', ' grok-4.7-high', 'grok-4.7-high ',
  'grok-4.7-high[fast=true]', 'grok-4.7-high[effort=low]', 'fast', 'claude-opus-5-thinking-high-fast']) {
  test(`resolveModel refuses model ${JSON.stringify(bad)}`, () => {
    const r = resolveModel({ model: bad });
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0);
  });
}

test('resolveModel refuses a call with neither model nor band (no CLI default)', () => {
  const r = resolveModel({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /--model|--band/);
});

test('resolveModel accepts the two allowed ids', () => {
  assert.deepEqual(resolveModel({ model: 'grok-4.7-high' }), { ok: true, model: 'grok-4.7-high', band: null });
  assert.equal(resolveModel({ model: 'grok-4.7-xhigh' }).model, 'grok-4.7-xhigh');
});

test('band to model: MID, ELEVATED and HIGH use grok-4.7-high; CRITICAL uses grok-4.7-xhigh', () => {
  for (const band of ['MID', 'ELEVATED', 'HIGH']) assert.equal(resolveModel({ band }).model, 'grok-4.7-high', band);
  assert.equal(resolveModel({ band: 'CRITICAL' }).model, 'grok-4.7-xhigh');
  assert.equal(resolveModel({ band: 'critical' }).model, 'grok-4.7-xhigh', 'a band is case-insensitive');
  assert.deepEqual(Object.keys(BAND_MODEL).sort(), ['CRITICAL', 'ELEVATED', 'HIGH', 'MID']);
});

test('LOW runs no Cursor, and an unknown band is refused', () => {
  const low = resolveModel({ band: 'LOW' });
  assert.equal(low.ok, false);
  assert.match(low.reason, /LOW/);
  assert.equal(resolveModel({ band: 'SEVERE' }).ok, false);
});

test('a model that disagrees with the band is refused (CRITICAL may not drop to high)', () => {
  assert.equal(resolveModel({ band: 'CRITICAL', model: 'grok-4.7-high' }).ok, false);
  assert.equal(resolveModel({ band: 'MID', model: 'grok-4.7-xhigh' }).ok, false);
  assert.equal(resolveModel({ band: 'CRITICAL', model: 'grok-4.7-xhigh' }).ok, true);
});

// ---------- ledger: rolling 7 day cap ----------

const startLine = (ts, id, ref = 'pr-1') => JSON.stringify({ ts: new Date(ts).toISOString(), phase: 'start', id, ref, model: 'grok-4.7-high', band: 'MID', sessionId: null });

function ledgerWith(lines) {
  const dir = tmp('ledger');
  const file = path.join(dir, 'ledger.jsonl');
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return file;
}

test('the cap constants are 300 per 7 days and 8 per ref', () => {
  assert.equal(WEEKLY_CAP, 300);
  assert.equal(WEEK_MS, 7 * DAY);
  assert.equal(PER_REF_CAP, 8);
});

test('the 300th run in a window is allowed and the 301st is refused', () => {
  const lines = Array.from({ length: 299 }, (_, i) => startLine(NOW - 1000 * i, `r${i}`, `pr-${i}`));
  const file = ledgerWith(lines);
  const r300 = reserveRun(file, { ref: 'pr-300', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW });
  assert.equal(r300.ok, true, '299 used, so the 300th is allowed');
  const r301 = reserveRun(file, { ref: 'pr-301', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW });
  assert.equal(r301.ok, false);
  assert.equal(r301.reason, 'cap');
  assert.equal(r301.count, 300);
  assert.equal(readLedger(file).entries.length, 300, 'a refused run writes no line');
});

test('runs older than 7 days do not count; the edge is inclusive on the inside', () => {
  const old = Array.from({ length: 300 }, (_, i) => startLine(NOW - WEEK_MS - 1000 - i, `old${i}`, `pr-${i}`));
  assert.equal(reserveRun(ledgerWith(old), { ref: 'x', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW }).ok, true);
  const inside = Array.from({ length: 300 }, (_, i) => startLine(NOW - WEEK_MS + 1000 + i, `in${i}`, `pr-${i}`));
  assert.equal(reserveRun(ledgerWith(inside), { ref: 'x', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW }).ok, false);
});

test('the start and end lines of one run count once', () => {
  const file = ledgerWith([]);
  const a = reserveRun(file, { ref: 'pr-9', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW });
  finishRun(file, a.id, { ref: 'pr-9', model: 'grok-4.7-high', band: 'MID', durationMs: 10, exit: 0 }, { now: () => NOW + 10 });
  assert.equal(countRuns(readLedger(file).entries, { now: NOW + 20 }), 1);
});

test('a missing ledger counts as zero and a damaged line is skipped, not fatal', () => {
  const dir = tmp('missing');
  const file = path.join(dir, 'nope', 'ledger.jsonl');
  assert.equal(readLedger(file).entries.length, 0);
  const r = reserveRun(file, { ref: 'p', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW });
  assert.equal(r.ok, true, 'the state folder is created');
  writeFileSync(file, `not json\n{"half":\n${startLine(NOW, 'a')}\n`);
  const read = readLedger(file);
  assert.equal(read.entries.length, 1);
  assert.equal(read.damaged, 2);
});

test('one ref is capped at 8 runs, other refs are not affected', () => {
  const file = ledgerWith(Array.from({ length: 8 }, (_, i) => startLine(NOW - 1000 * i, `r${i}`, 'pr-42')));
  const refused = reserveRun(file, { ref: 'pr-42', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'ref-cap');
  assert.equal(reserveRun(file, { ref: 'pr-43', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW }).ok, true);
});

test('ledger line shape: start line then end line, with every field Dave asked for', () => {
  const file = ledgerWith([]);
  const a = reserveRun(file, { ref: 'pr-7', model: 'grok-4.7-high', band: 'ELEVATED', sessionId: 'sess-1' }, { now: () => NOW });
  finishRun(file, a.id, { ref: 'pr-7', model: 'grok-4.7-high', band: 'ELEVATED', sessionId: 'sess-1', durationMs: 4321, exit: 0, timedOut: false, usage: { inputTokens: 5 } }, { now: () => NOW + 4321 });
  const [start, end] = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(start).sort(), ['band', 'id', 'model', 'phase', 'ref', 'sessionId', 'ts']);
  assert.equal(start.phase, 'start');
  assert.equal(start.ts, new Date(NOW).toISOString());
  assert.equal(end.phase, 'end');
  assert.equal(end.id, start.id);
  for (const k of ['ts', 'ref', 'model', 'band', 'durationMs', 'exit', 'timedOut', 'sessionId', 'usage']) assert.ok(k in end, `end line has ${k}`);
  assert.equal(end.durationMs, 4321);
  assert.equal(end.sessionId, 'sess-1');
});

test('a fresh lock held by another session makes reserve fail, and a stale lock is taken over', () => {
  const file = ledgerWith([]);
  const lock = `${file}.lock`;
  writeFileSync(lock, 'other');
  const held = reserveRun(file, { ref: 'p', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW, lockWaitMs: 60, lockStaleMs: 30_000 });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'lock');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const taken = reserveRun(file, { ref: 'p', model: 'grok-4.7-high', band: 'MID' }, { now: () => NOW, lockWaitMs: 60, lockStaleMs: 30_000 });
  assert.equal(taken.ok, true);
  assert.equal(existsSync(lock), false, 'the lock is released');
});

// ---------- output parser ----------

test('parser reads the bold-line shape (PR 217 sample)', () => {
  const p = parseReviewOutput(fixture(217));
  assert.equal(p.ok, true);
  assert.equal(p.format, 'markdown');
  assert.equal(p.findings.length, 3);
  const [a, b, c] = p.findings;
  assert.equal(a.severity, 'major');
  assert.equal(a.file, '.claude/plugins/ccv3-mods/hooks/pr-checkpoint/index.tsx');
  assert.equal(a.line, 701);
  assert.equal(a.lineEnd, 709);
  assert.match(a.body, /shellLock/);
  assert.equal(b.severity, 'minor');
  assert.equal(b.line, 688);
  assert.equal(c.file, '.claude/plugins/ccv3-mods/tests/pr-checkpoint.test.ts');
  assert.equal(c.line, 754);
  assert.doesNotMatch(c.body, /No new issues stood out/, 'the closing remark is not part of the last finding');
});

test('parser reads the heading shape (PR 222 sample): 3 Major, 2 Minor', () => {
  const p = parseReviewOutput(fixture(222));
  assert.equal(p.ok, true);
  assert.deepEqual(p.findings.map((f) => f.severity), ['major', 'major', 'major', 'minor', 'minor']);
  assert.equal(p.findings[0].file, 'brief.ts');
  assert.equal(p.findings[0].line, 421);
  assert.match(p.findings[0].title, /waiting on\/for/);
  assert.match(p.findings[0].body, /Waiting for confirmation from Dave/);
  assert.equal(p.findings[4].line, 423);
  assert.doesNotMatch(p.findings[4].body, /Skipped \(nothing new/, 'the horizontal rule ends the last finding');
});

test('parser takes the first path of a heading with two locations (PR 225 sample)', () => {
  const p = parseReviewOutput(fixture(225));
  assert.equal(p.findings.length, 6);
  assert.deepEqual(p.findings.map((f) => f.severity), ['major', 'major', 'major', 'minor', 'minor', 'minor']);
  const first = p.findings[0];
  assert.equal(first.file, 'scripts/github/review-status.mjs');
  assert.equal(first.line, 886);
  assert.equal(first.lineEnd, 888);
  assert.match(first.title, /bugs \/ fail-open/);
});

test('parser keeps category headings out of findings and reads the whole PR 238 sample', () => {
  const p = parseReviewOutput(fixture(238));
  assert.equal(p.findings.length, 9);
  assert.equal(p.findings.filter((f) => f.severity === 'major').length, 4);
  const modelTs = p.findings.find((f) => f.file.endsWith('pr-checkpoint/model.ts'));
  assert.equal(modelTs.line, 87);
  assert.equal(modelTs.lineEnd, 96);
  assert.doesNotMatch(p.findings[0].body, /Missed events/, 'a category heading ends a finding body');
});

test('parser returns usage, duration and session id from the result JSON', () => {
  const p = parseReviewOutput(fixture(217));
  assert.equal(p.sessionId, '8c30d30b-13c6-418c-aa97-c209d2f5d940');
  assert.equal(p.durationMs, 242912);
  assert.deepEqual(p.usage, { inputTokens: 76837, outputTokens: 12489, cacheReadTokens: 798720, cacheWriteTokens: 0 });
});

const resultLine = (text, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: text, session_id: 's', usage: {}, ...extra });
const block = (obj) => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;

test('parser prefers the last fenced json block over any markdown headings', () => {
  const text = `Notes\n### Major — \`old.ts:1\` — ignore me\nbody\n\n${block({ findings: [{ file: 'a.ts', line: 12, severity: 'Major', title: 'T', body: 'B' }] })}`;
  const p = parseReviewOutput(resultLine(text));
  assert.equal(p.format, 'json');
  assert.deepEqual(p.findings, [{ file: 'a.ts', line: 12, lineEnd: null, severity: 'major', title: 'T', body: 'B' }]);
});

test('an explicit empty findings array is a clean pass, not a parse failure', () => {
  const p = parseReviewOutput(resultLine(`No problems.\n${block({ findings: [] })}`));
  assert.equal(p.ok, true);
  assert.equal(p.clean, true);
  assert.equal(p.findings.length, 0);
});

test('prose that says "no major bugs" with no json block and no headings is NOT a pass', () => {
  const p = parseReviewOutput(resultLine('No Major bugs found. Looks fine to me.'));
  assert.equal(p.ok, false);
  assert.match(p.problems.join(' '), /no findings block/i);
});

test('json items with a missing file or title are dropped and reported; the rest is kept', () => {
  const p = parseReviewOutput(resultLine(block({ findings: [{ line: 1, severity: 'major', title: 'x', body: '' }, { file: 'b.ts', line: '40-44', severity: 'MINOR', title: 'ok', body: 'b' }] })));
  assert.equal(p.ok, true);
  assert.equal(p.findings.length, 1);
  assert.equal(p.findings[0].line, 40);
  assert.equal(p.findings[0].lineEnd, 44);
  assert.equal(p.findings[0].severity, 'minor');
  assert.match(p.problems.join(' '), /dropped 1/);
});

test('a json block that holds only unusable items is a failure', () => {
  const p = parseReviewOutput(resultLine(block({ findings: [{ severity: 'major' }] })));
  assert.equal(p.ok, false);
});

test('an unknown severity word becomes info, never an unlabelled finding', () => {
  const p = parseReviewOutput(resultLine(block({ findings: [{ file: 'a', line: 1, severity: 'blocker-ish', title: 't', body: '' }] })));
  assert.equal(p.findings[0].severity, 'info');
});

test('a "clean" answer that says every read was blocked is void, not a pass (real output of the 2026-11-01 smoke run)', () => {
  const p = parseReviewOutput(fixture('blocked'), { expectModel: 'grok-4.7-high' });
  assert.equal(p.ok, false);
  assert.equal(p.clean, false);
  assert.equal(p.notRun, true);
  assert.match(p.problems.join(' '), /did not run/);
});

test('a truly clean answer is still a pass, and findings next to a "blocked" remark are kept', () => {
  assert.equal(parseReviewOutput(resultLine(`Read PR.diff and the spec. Nothing wrong.
${block({ findings: [] })}`)).ok, true);
  const p = parseReviewOutput(resultLine(`One tool call was blocked, I used another.
${block({ findings: [{ file: 'a.ts', line: 1, severity: 'minor', title: 't', body: '' }] })}`));
  assert.equal(p.ok, true);
  assert.equal(p.findings.length, 1);
});

test('is_error true, non-JSON output and empty output are failures', () => {
  assert.equal(parseReviewOutput(resultLine('boom', { is_error: true })).ok, false);
  assert.equal(parseReviewOutput('garbage').ok, false);
  assert.equal(parseReviewOutput('').ok, false);
});

test('the last result line wins when stdout holds earlier events', () => {
  const out = `${JSON.stringify({ type: 'system', note: 'start' })}\n${resultLine(block({ findings: [] }))}\n`;
  assert.equal(parseReviewOutput(out).ok, true);
});

test('a model named in the output is compared with the requested model', () => {
  const same = parseReviewOutput(resultLine(block({ findings: [] }), { model: 'grok-4.7-high' }), { expectModel: 'grok-4.7-high' });
  assert.equal(same.modelVerified, true);
  const other = parseReviewOutput(resultLine(block({ findings: [] }), { model: 'auto' }), { expectModel: 'grok-4.7-high' });
  assert.equal(other.modelVerified, false);
  assert.equal(other.modelMismatch, true);
  const none = parseReviewOutput(fixture(217), { expectModel: 'grok-4.7-high' });
  assert.equal(none.modelVerified, false, 'the Cursor result JSON names no model');
  assert.equal(none.modelMismatch, false);
});

// ---------- prompt ----------

test('the prompt names PR.diff, the report format, and forbids reading outside the workspace', () => {
  const prompt = buildPrompt({ ref: 'pr-9', files: ['a.ts', 'b.ts'] });
  assert.match(prompt, /PR\.diff/);
  assert.match(prompt, /"findings"/);
  assert.match(prompt, /only inside the workspace/i);
  assert.match(prompt, /a\.ts/);
  assert.doesNotMatch(prompt, /\bcomment(s)? (by|from) (CodeRabbit|Greptile)/i);
});

// ---------- agent resolver ----------

test('resolveAgent on Windows picks the newest version dir and runs node.exe on index.js directly (no cmd wrapper)', () => {
  const root = 'C:\\L\\cursor-agent';
  const dirs = ['2026.9.30-aaaaaaa', '2026.10.22-27dcf5f', '2026.10.4-bbbbbbb', 'promote-staged.cmd'];
  const files = new Set(dirs.slice(0, 3).flatMap((d) => [`${root}\\versions\\${d}\\node.exe`, `${root}\\versions\\${d}\\index.js`]));
  const r = resolveAgent({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, readdir: () => dirs, exists: (p) => files.has(p) });
  assert.equal(r.cmd, `${root}\\versions\\2026.10.22-27dcf5f\\node.exe`);
  assert.deepEqual(r.prefixArgs, [`${root}\\versions\\2026.10.22-27dcf5f\\index.js`]);
});

test('resolveAgent reports a missing install, honours CURSOR_AGENT_DIR, and uses PATH on POSIX', () => {
  assert.equal(resolveAgent({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, readdir: () => [], exists: () => false }).error.length > 0, true);
  assert.deepEqual(resolveAgent({ platform: 'linux', env: {} }), { cmd: 'cursor-agent', prefixArgs: [] });
  const d = 'D:\\x';
  const r = resolveAgent({ platform: 'win32', env: { CURSOR_AGENT_DIR: d }, readdir: () => ['2026.10.22-27dcf5f'], exists: () => true });
  assert.ok(r.cmd.startsWith(d));
});

// ---------- runReview with injected pieces ----------

const GOOD = resultLine(block({ findings: [{ file: 'a.ts', line: 3, severity: 'major', title: 'Bug', body: 'why' }] }));

function harness(over = {}) {
  const dir = tmp('run');
  const calls = [];
  const cleaned = [];
  const prepared = [];
  const deps = {
    now: () => NOW,
    env: { CLAUDE_CODE_SESSION_ID: 'sess-xyz' },
    agent: { cmd: 'AGENT', prefixArgs: ['index.js'] },
    prepare: async () => { prepared.push(1); return ({ ref: 'pr-5', base: 'b'.repeat(40), head: 'h'.repeat(40), dir: path.join(dir, 'tree'), files: ['a.ts'], cleanup: () => cleaned.push(1) }); },
    runner: async (spec) => { calls.push(spec); return { status: 0, stdout: GOOD, stderr: '', timedOut: false, durationMs: 1234 }; },
    ...over,
  };
  const opts = { input: { pr: 5 }, band: 'MID', ledgerPath: path.join(dir, 'ledger.jsonl'), outDir: path.join(dir, 'out'), timeoutMs: 1500_000, ...(over.opts ?? {}) };
  return { dir, calls, cleaned, prepared, deps, opts };
}

test('a good run exits 0, writes findings JSON and a summary, and logs start and end lines', async () => {
  const h = harness();
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.OK);
  const findings = JSON.parse(readFileSync(r.findingsPath, 'utf8'));
  assert.equal(findings.model, 'grok-4.7-high');
  assert.equal(findings.band, 'MID');
  assert.equal(findings.ref, 'pr-5');
  assert.equal(findings.findings[0].file, 'a.ts');
  assert.match(readFileSync(r.summaryPath, 'utf8'), /1 finding/);
  const lines = readFileSync(h.opts.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.phase), ['start', 'end']);
  assert.equal(lines[1].exit, 0);
  assert.equal(lines[1].sessionId, 'sess-xyz');
  assert.equal(lines[1].durationMs, 1234);
  assert.equal(h.cleaned.length, 1, 'the temp tree is removed');
});

test('the agent gets --mode ask, --trust, json output and an explicit allowed model, never force or a key', async () => {
  const h = harness({ opts: { band: 'CRITICAL' } });
  await runReview(h.opts, h.deps);
  const { args, cwd, command } = h.calls[0];
  assert.equal(command, 'AGENT');
  assert.equal(args[0], 'index.js');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('-p'));
  assert.equal(at('--mode'), 'ask');
  assert.equal(at('--output-format'), 'json');
  assert.equal(at('--model'), 'grok-4.7-xhigh');
  assert.ok(args.includes('--trust'));
  for (const bad of ['--force', '--yolo', '-f', '--api-key', '--sandbox', '--auto-review', '--resume', '--continue']) assert.ok(!args.includes(bad), bad);
  assert.equal(cwd, path.join(h.dir, 'tree'));
  assert.match(args.at(-1), /PR\.diff/, 'the prompt is the last argument');
});

test('a refused model exits 2, runs nothing and writes no ledger line', async () => {
  const h = harness({ opts: { band: undefined, model: 'grok-4.7-high-fast' } });
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.REFUSED);
  assert.equal(h.calls.length, 0);
  assert.equal(existsSync(h.opts.ledgerPath), false);
});

test('a missing model and band exits 2; the CLI default is never used', async () => {
  const h = harness({ opts: { band: undefined, model: undefined } });
  assert.equal((await runReview(h.opts, h.deps)).exit, EXIT.REFUSED);
  assert.equal(h.calls.length, 0);
});

test('the cap exits 3 and runs nothing', async () => {
  const h = harness();
  mkdirSync(path.dirname(h.opts.ledgerPath), { recursive: true });
  writeFileSync(h.opts.ledgerPath, `${Array.from({ length: 300 }, (_, i) => startLine(NOW - 1000 * i, `r${i}`, `pr-${i}`)).join('\n')}\n`);
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.CAP);
  assert.equal(h.calls.length, 0);
  assert.equal(h.prepared.length, 0, 'the cap is read before the tree is built');
});

test('a bad model is refused before the cap is read (exit 2, not 3)', async () => {
  const h = harness({ opts: { band: undefined, model: 'auto' } });
  mkdirSync(path.dirname(h.opts.ledgerPath), { recursive: true });
  writeFileSync(h.opts.ledgerPath, `${Array.from({ length: 300 }, (_, i) => startLine(NOW - 1000 * i, `r${i}`, `pr-${i}`)).join('\n')}\n`);
  assert.equal((await runReview(h.opts, h.deps)).exit, EXIT.REFUSED);
});

test('a time-out marks the run failed (exit 1), logs it with timedOut, and keeps the partial output out of the findings', async () => {
  const h = harness({ runner: async () => ({ status: null, stdout: '', stderr: '', timedOut: true, durationMs: 1_500_000 }) });
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.FAILED);
  const end = readFileSync(h.opts.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(end.phase, 'end');
  assert.equal(end.timedOut, true);
  assert.equal(end.exit, 1);
  assert.match(readFileSync(r.summaryPath, 'utf8'), /TIMED OUT/);
  assert.equal(JSON.parse(readFileSync(r.findingsPath, 'utf8')).status, 'failed');
  assert.equal(h.cleaned.length, 1);
});

test('a non-zero agent exit, an is_error result and unparseable output each exit 1 and are logged', async () => {
  for (const out of [
    { status: 3, stdout: GOOD, stderr: 'x', timedOut: false, durationMs: 5 },
    { status: 0, stdout: resultLine('bad', { is_error: true }), stderr: '', timedOut: false, durationMs: 5 },
    { status: 0, stdout: 'Looks fine, no major bugs.', stderr: '', timedOut: false, durationMs: 5 },
    { status: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, error: 'spawn ENOENT' },
  ]) {
    const h = harness({ runner: async () => out });
    const r = await runReview(h.opts, h.deps);
    assert.equal(r.exit, EXIT.FAILED, JSON.stringify(out).slice(0, 60));
    const end = readFileSync(h.opts.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(end.exit, 1);
  }
});

test('a model named in the output that differs from --model voids the run (exit 1)', async () => {
  const h = harness({ runner: async () => ({ status: 0, stdout: resultLine(block({ findings: [] }), { model: 'auto' }), stderr: '', timedOut: false, durationMs: 5 }) });
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.FAILED);
  assert.match(readFileSync(r.summaryPath, 'utf8'), /model/i);
});

test('a missing cursor-agent install exits 1 before a run is reserved', async () => {
  const h = harness({ agent: { error: 'cursor-agent is not installed' } });
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.FAILED);
  assert.equal(existsSync(h.opts.ledgerPath), false, 'no run, no ledger line');
});

test('--dry-run builds the tree and prompt, runs nothing and writes no ledger line', async () => {
  const h = harness({ opts: { dryRun: true } });
  const r = await runReview(h.opts, h.deps);
  assert.equal(r.exit, EXIT.OK);
  assert.equal(h.calls.length, 0);
  assert.equal(existsSync(h.opts.ledgerPath), false);
});

// ---------- argument parsing and main ----------

test('parseArgs reads --pr, --range, --band, --model and refuses both or neither input', () => {
  assert.deepEqual(parseArgs(['--pr', '12', '--band', 'MID']).input, { pr: 12 });
  assert.deepEqual(parseArgs(['--range', 'aaa..bbb', '--model', 'grok-4.7-high']).input, { range: 'aaa..bbb' });
  assert.ok(parseArgs(['--band', 'MID']).error);
  assert.ok(parseArgs(['--pr', '1', '--range', 'a..b', '--band', 'MID']).error);
  assert.ok(parseArgs(['--pr', 'abc', '--band', 'MID']).error);
  assert.ok(parseArgs(['--range', 'nodots', '--band', 'MID']).error);
  assert.ok(parseArgs(['--pr', '1', '--band', 'MID', '--bogus']).error);
});

test('main maps a bad argument to exit 2 without touching the ledger or the agent', async () => {
  const h = harness();
  const code = await main(['--band', 'MID'], { ...h.deps, ledgerPath: h.opts.ledgerPath, stderr: () => {}, stdout: () => {} });
  assert.equal(code, EXIT.REFUSED);
  assert.equal(h.calls.length, 0);
});

// ---------- the real process: the time-out kills the whole tree ----------

test('runAgent time-out stops the agent AND the process it started', { timeout: 90_000 }, async () => {
  const dir = tmp('kill');
  const pidFile = path.join(dir, 'grandchild.pid');
  const grand = path.join(dir, 'grand.mjs');
  const fake = path.join(dir, 'fake-agent.mjs');
  writeFileSync(grand, 'setInterval(() => {}, 1000);\n');
  writeFileSync(fake, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const g = spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: 'ignore', windowsHide: true, detached: true });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const started = Date.now();
  const r = await runAgent({ command: process.execPath, args: [fake], cwd: dir, timeoutMs: 2500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 60_000, 'the run returns after the time-out');
  assert.ok(existsSync(pidFile), 'the fake agent started its child');
  const gpid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 500));
  let alive = true;
  try { process.kill(gpid, 0); } catch { alive = false; }
  if (alive) { try { process.kill(gpid, 'SIGKILL'); } catch { /* cleanup */ } }
  assert.equal(alive, false, 'the grandchild is dead');
});

test('runAgent returns stdout and the exit status of a normal child, and does not hang on a spawn error', async () => {
  const dir = tmp('ok');
  const ok = await runAgent({ command: process.execPath, args: ['-e', "process.stdout.write('hi'); process.exit(4)"], cwd: dir, timeoutMs: 20_000 });
  assert.equal(ok.stdout, 'hi');
  assert.equal(ok.status, 4);
  assert.equal(ok.timedOut, false);
  assert.ok(ok.durationMs >= 0);
  const missing = await runAgent({ command: path.join(dir, 'no-such-binary'), args: [], cwd: dir, timeoutMs: 20_000 });
  assert.equal(missing.status, null);
  assert.ok(missing.error);
});

// ---------- clean tree from real git ----------

function gitRepo() {
  const root = tmp('git');
  const git = (...a) => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'a.txt'), 'one\n');
  mkdirSync(path.join(root, '.claudedocs'));
  writeFileSync(path.join(root, '.claudedocs', 'answers.md'), 'SECRET ANSWER Major in a.txt\n');
  mkdirSync(path.join(root, 'artifacts'));
  writeFileSync(path.join(root, 'artifacts', 'old-review.txt'), 'old review comment\n');
  mkdirSync(path.join(root, '.claude', 'reviews'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'reviews', 'old-report.md'), 'old review report\n');
  writeFileSync(path.join(root, '.claude', 'keep.md'), 'kept\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'topic');
  writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(root, 'b.txt'), 'new\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nUNCOMMITTED\n');
  return { root, base, head };
}

test('prepareReview builds a clean tree: head content, PR.diff, no .git, no answers, no uncommitted edits', async () => {
  const { root, base, head } = gitRepo();
  const prep = await prepareReview({ root, input: { range: `${base}..${head}` }, tmpRoot: tmp('trees') });
  try {
    assert.equal(prep.head, head);
    assert.equal(prep.base, base);
    assert.equal(prep.ref, `range-${base.slice(0, 8)}..${head.slice(0, 8)}`);
    assert.equal(existsSync(path.join(prep.dir, '.git')), false);
    assert.equal(readFileSync(path.join(prep.dir, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the committed head, not the working tree');
    assert.equal(existsSync(path.join(prep.dir, 'b.txt')), true);
    assert.equal(existsSync(path.join(prep.dir, '.claudedocs')), false, 'review docs are left out');
    assert.equal(existsSync(path.join(prep.dir, 'artifacts')), false, 'old review artifacts are left out');
    assert.equal(existsSync(path.join(prep.dir, '.claude', 'reviews')), false, 'old review reports are left out');
    assert.equal(existsSync(path.join(prep.dir, '.claude', 'keep.md')), true, 'the rest of .claude stays');
    const diff = readFileSync(path.join(prep.dir, 'PR.diff'), 'utf8');
    assert.match(diff, /^\+two$/m);
    assert.match(diff, /b\.txt/);
    assert.doesNotMatch(diff, /UNCOMMITTED|SECRET ANSWER/);
    assert.deepEqual([...prep.files].sort(), ['a.txt', 'b.txt']);
  } finally {
    prep.cleanup();
  }
  assert.equal(existsSync(prep.dir), false, 'cleanup removes the tree');
});

test('prepareReview for a PR number reads head and base from gh and diffs against the merge base', async () => {
  const { root, base, head } = gitRepo();
  const calls = [];
  const gh = (args) => { calls.push(args); return { head: { sha: head }, base: { ref: 'main' } }; };
  const prep = await prepareReview({ root, input: { pr: 77 }, tmpRoot: tmp('trees'), gh, repo: 'o/r' });
  try {
    assert.equal(prep.ref, 'pr-77');
    assert.equal(prep.head, head);
    assert.equal(prep.base, base);
    assert.ok(calls[0].join(' ').includes('repos/o/r/pulls/77'));
  } finally {
    prep.cleanup();
  }
});

test('prepareReview rejects an unknown revision with a clear error (exit 2 at the CLI)', async () => {
  const { root } = gitRepo();
  await assert.rejects(() => prepareReview({ root, input: { range: 'nope1..nope2' }, tmpRoot: tmp('trees') }), /nope1|revision|resolve/i);
});
