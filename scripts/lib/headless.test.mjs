// Failure modes (P0 spec F11-F13, main spec 13.6). One test per failure; each comment names the source change that breaks it.
//  F11 the API key reaches the child         -> remove the delete in childEnv
//  F12 day cap counted on the UTC day        -> count UTC days in chicagoDay
//  F13 damaged ledger line                   -> JSON.parse with no try (the shared readLedger)
//  13.6 the cap counts every headless run    -> filter the count by purpose
//  stdin: the prompt must arrive on stdin    -> pass the prompt as argv
//  cap: a refused run starts no process      -> spawn before reserveHeadless
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HEADLESS_DAILY_CAP, buildArgs, chicagoDay, childEnv, finishHeadless, readHeadlessLedger, reserveHeadless, runClaude, runJudge } from './headless.mjs';

const tmp = () => mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'headless-'));
const rows = (file) => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// A stub `claude`: reads stdin, reports env KEY NAMES (never values), argv and the stdin length inside a result line.
function stubClaude(dir, { sleepMs = 0 } = {}) {
  const file = path.join(dir, 'stub-claude.mjs');
  writeFileSync(file, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const report = { envKeys: Object.keys(process.env).sort(), argv: process.argv.slice(2), stdinLen: input.length, stdinHead: input.slice(0, 40), cwd: process.cwd() };
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), total_cost_usd: 0.0123, usage: { input_tokens: 5, output_tokens: 7 } }) + '\\n');
  }, ${sleepMs});
});
`);
  return file;
}

test('F11 childEnv drops the API key and the auth token, keeps the rest', () => {
  // Breaks when: the `delete env.ANTHROPIC_API_KEY` line in childEnv is removed.
  const env = childEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', PATH: 'p', KEEP: '1' });
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.equal(env.PATH, 'p');
  assert.equal(env.KEEP, '1');
});

test('buildArgs: no tools, one turn, strict MCP, subscription model, never --bare', () => {
  // Breaks when: --tools "" , --max-turns 1 or --strict-mcp-config is dropped from buildArgs.
  const a = buildArgs({ model: 'sonnet', mcpConfig: 'm.json', settings: 's.json' });
  assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
  assert.equal(a[a.indexOf('--max-turns') + 1], '1');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('--no-session-persistence'));
  assert.equal(a.includes('--bare'), false);
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
});

test('F12 the day cap counts the America/Chicago day, not the UTC day', () => {
  // Breaks when: chicagoDay uses toISOString().slice(0,10) (the UTC day).
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  // 2026-11-02T05:30Z is 23:30 on 2026-11-01 in Chicago (CST, UTC-6 after the 11-01 change). The UTC day is 11-02.
  const late = Date.parse('2026-11-02T05:30:00Z');
  assert.equal(chicagoDay(late), '2026-11-01');
  for (let i = 0; i < HEADLESS_DAILY_CAP; i += 1) assert.equal(reserveHeadless(file, { purpose: 'eval-judge', model: 'sonnet' }, { now: () => late }).ok, true);
  const r31 = reserveHeadless(file, { purpose: 'eval-judge', model: 'sonnet' }, { now: () => late });
  assert.deepEqual([r31.ok, r31.reason], [false, 'cap']);
  // One hour later it is 00:30 on 11-02 in Chicago: a new day. The UTC day has not changed, so a UTC count would refuse.
  assert.equal(reserveHeadless(file, { purpose: 'eval-judge', model: 'sonnet' }, { now: () => late + 3_600_000 }).ok, true);
});

test('13.6 the cap counts every headless run in the ledger, whatever its purpose', () => {
  // Breaks when: the day count filters on purpose === 'eval-judge'.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const now = Date.parse('2026-11-02T18:00:00Z');
  for (let i = 0; i < 3; i += 1) assert.equal(reserveHeadless(file, { purpose: 'team-bridge' }, { now: () => now, cap: 4 }).ok, true);
  assert.equal(reserveHeadless(file, { purpose: 'eval-judge' }, { now: () => now, cap: 4 }).ok, true);
  assert.equal(reserveHeadless(file, { purpose: 'team-bridge' }, { now: () => now, cap: 4 }).reason, 'cap');
});

test('F13 a damaged ledger line is skipped and the other rows still count', () => {
  // Breaks when: the ledger reader parses every line with no try/catch.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const now = Date.parse('2026-11-02T18:00:00Z');
  reserveHeadless(file, { purpose: 'a' }, { now: () => now });
  writeFileSync(file, `${readFileSync(file, 'utf8')}{this is not json\n`);
  reserveHeadless(file, { purpose: 'b' }, { now: () => now });
  const { entries, damaged } = readHeadlessLedger(file);
  assert.equal(entries.length, 2);
  assert.equal(damaged, 1);
  assert.equal(reserveHeadless(file, { purpose: 'c' }, { now: () => now, cap: 2 }).reason, 'cap');
});

test('finishHeadless appends an end row that keeps the id', () => {
  // Breaks when: finishHeadless writes no id, so countRuns would count the end row as a second run.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const r = reserveHeadless(file, { purpose: 'x' }, { now: () => 1_000 });
  finishHeadless(file, r.id, { exit: 0 }, { now: () => 2_000 });
  const [start, end] = rows(file);
  assert.equal(start.phase, 'start');
  assert.equal(end.phase, 'end');
  assert.equal(end.id, start.id);
});

test('runClaude: prompt on stdin, API key absent from the child, ledger start and end rows written', async () => {
  // Breaks when: the prompt goes in argv, childEnv is skipped, or the rows are not written.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const stub = stubClaude(dir);
  const prompt = 'PROMPT-BODY '.repeat(500);
  const res = await runClaude({ prompt, model: 'sonnet', timeoutMs: 20_000, purpose: 'eval-judge' }, {
    ledgerPath: file, command: process.execPath, prefixArgs: [stub], env: { ...process.env, ANTHROPIC_API_KEY: 'sk-secret-should-not-pass', ANTHROPIC_AUTH_TOKEN: 'tok' }, sessionId: 'sess-1', skipConfigFiles: true,
  });
  assert.equal(res.ok, true);
  const report = JSON.parse(res.result);
  assert.equal(report.envKeys.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(report.envKeys.includes('ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(report.stdinLen, prompt.length);
  assert.equal(report.argv.some((a) => a.includes('PROMPT-BODY')), false);
  assert.equal(res.costUsd, 0.0123);
  const [start, end] = rows(file);
  assert.equal(start.purpose, 'eval-judge');
  assert.equal(start.sessionId, 'sess-1');
  assert.equal(start.day, chicagoDay(Date.parse(start.ts)));
  assert.equal(end.keyStripped, true);
  assert.equal(end.costUsd, 0.0123);
  assert.equal(end.exit, 0);
});

test('runClaude at the cap starts no process and writes no end row', async () => {
  // Breaks when: runClaude spawns before reserveHeadless, or ignores the cap result.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const marker = path.join(dir, 'spawned');
  const now = () => Date.parse('2026-11-02T18:00:00Z');
  reserveHeadless(file, { purpose: 'x' }, { now });
  const res = await runClaude({ prompt: 'p', timeoutMs: 1000 }, {
    ledgerPath: file, cap: 1, now, command: process.execPath, prefixArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'1')`], skipConfigFiles: true,
  });
  assert.deepEqual([res.ok, res.reason], [false, 'cap']);
  assert.equal(existsSync(marker), false);
  assert.equal(rows(file).length, 1);
});

test('runJudge is runClaude with purpose eval-judge and the judge model, Opus at effort high', async () => {
  // Breaks when: runJudge uses another purpose (the ledger would no longer show judge runs), goes back to Sonnet,
  // or drops effort high (Dave 2026-11-13: the judge is Opus 5.5 at effort high).
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const stub = stubClaude(dir);
  const res = await runJudge('hello', { ledgerPath: file, command: process.execPath, prefixArgs: [stub], timeoutMs: 20_000, skipConfigFiles: true });
  const [start] = rows(file);
  assert.equal(start.purpose, 'eval-judge');
  assert.equal(start.model, 'opus');
  const { argv } = JSON.parse(res.result);
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
});

test('a time-out ends the run with timedOut in the end row', async () => {
  // Breaks when: runClaude ignores run.timedOut, or the timer is never set.
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const stub = stubClaude(dir, { sleepMs: 30_000 });
  const res = await runClaude({ prompt: 'p', timeoutMs: 400 }, {
    ledgerPath: file, command: process.execPath, prefixArgs: [stub], skipConfigFiles: true,
    agentDeps: { killer: async (pid) => { try { process.kill(pid); } catch { /* gone */ } }, killGraceMs: 500 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(rows(file)[1].timedOut, true);
  mkdirSync(dir, { recursive: true });
});
