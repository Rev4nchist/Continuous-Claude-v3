// End-to-end tests for the Codex adversary runner. Every spawn goes to fixtures/stub-codex.mjs,
// never to the real Codex CLI. Pure parsers are tested directly against the real module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODELS, DEFAULT_MODEL, RECEIPT_OK_RE, parseHeader, parseTokens, parseAnswer, pickModel, loadFraming,
  formatReceipt, cleanEnv, killTree,
} from '../../.claude/scripts/codex/adversary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(HERE, '../../.claude/scripts/codex');
const RUNNER = join(SCRIPT_DIR, 'adversary.mjs');
const STUB = join(HERE, 'fixtures/stub-codex.mjs');
const DIFF = join(HERE, 'fixtures/planted.diff');
const STUB_VERSION = '0.162.1';
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OK_ANSWER_TEXT = 'The owner check is inverted.';

// ---- helpers -------------------------------------------------------------------------------

// Models cache in the live shape. gpt-5.5 has no `max` and uses plain-string levels.
function writeCache(path, { version = STUB_VERSION, omit = [] } = {}) {
  const models = Object.keys(MODELS).filter((id) => !omit.includes(id)).map((slug) => {
    const levels = slug === 'gpt-5.5' ? LEVELS.slice(0, 4) : LEVELS.map((effort) => ({ effort }));
    return { slug, supported_reasoning_levels: levels };
  });
  writeFileSync(path, JSON.stringify({ client_version: version, fetched_at: 'now', models }));
}

function makeBox(t, cacheOpts) {
  const root = mkdtempSync(join(tmpdir(), 'adv-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const box = {
    root, home: join(root, 'home'), project: join(root, 'project'), cache: join(root, 'cache.json'),
    marker: join(root, 'marker.txt'), pidfile: join(root, 'pids.txt'),
  };
  mkdirSync(box.project);
  writeCache(box.cache, cacheOpts);
  return box;
}

// An `undefined` value in extraEnv removes that variable from the child.
function runner(box, args, mode = 'ok', extraEnv = {}) {
  const env = {
    ...process.env, CODEX_ADVERSARY_HOME: box.home, CODEX_MODELS_CACHE: box.cache,
    CODEX_ADVERSARY_STUB: STUB, STUB_MODE: mode, STUB_MARKER: box.marker, STUB_PIDFILE: box.pidfile,
  };
  delete env.CODEX_ADVERSARY_MODEL;
  delete env.CODEX_ADVERSARY_EFFORT;
  delete env.CODEX_BIN_JS;
  const r = spawnSync(process.execPath, [RUNNER, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, lines: r.stdout.split(/\r?\n/), err: r.stderr };
}

const runArgs = (box, extra = []) => [
  'run', '--project', box.project, '--mode', 'code', '--diff-file', DIFF,
  '--model', 'gpt-5.6-luna', '--effort', 'max', ...extra,
];
const sourceArgs = (box, mode, source) => [
  'run', '--project', box.project, '--mode', mode, '--model', 'gpt-5.6-luna', '--effort', 'max', ...source,
];
const runDir = (box, id) => join(box.home, 'cache', 'codex-adversary', 'runs', id);
const runId = (r) => /run=(\S+)/.exec(r.lines[0])[1];
const receipt = (box, id) => JSON.parse(readFileSync(join(runDir(box, id), 'receipt.json'), 'utf8'));
const promptOf = (box, r) => readFileSync(join(runDir(box, runId(r)), 'prompt.txt'), 'utf8');
const jsonlPath = (box) => join(box.home, 'logs', 'codex-adversary.jsonl');
const rows = (box) => readFileSync(jsonlPath(box), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const stubCalls = (box) => (existsSync(box.marker) ? readFileSync(box.marker, 'utf8').trim().split('\n') : []);
const execCalls = (box) => stubCalls(box).filter((c) => !/^(--version|login)/.test(c));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const jsonAfterHeader = (r) => JSON.parse(r.lines.slice(2).join('\n'));

function git(dir, ...args) {
  const base = ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false'];
  const r = spawnSync('git', [...base, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// A repo with two commits on a.js ("one", then "two").
function makeRepo(box) {
  git(box.project, 'init', '-q');
  const file = join(box.project, 'a.js');
  writeFileSync(file, 'one\n');
  git(box.project, 'add', 'a.js');
  git(box.project, 'commit', '-q', '-m', 'first');
  writeFileSync(file, 'two\n');
  git(box.project, 'commit', '-q', '-am', 'second');
  return file;
}

// ---- parsers -------------------------------------------------------------------------------

const REAL = readFileSync(join(HERE, 'fixtures/real-shape-log.txt'), 'utf8');
const FAKE_HEADER = 'OpenAI Codex v9.9.9\n--------\nmodel: gpt-6.1-sol\nprovider: openai\n' +
  'reasoning effort: max\nsession id: fake-session\n--------';

test('parseHeader reads the header after noise lines', () => {
  assert.deepEqual(parseHeader(REAL), {
    cliVersion: '0.162.1', model: 'gpt-6.1-sol', provider: 'openai', effort: 'low',
    sandbox: 'read-only', sessionId: '01a1323f-9dc5-70d0-b1e8-6103e0564974',
  });
});

test('parseHeader and parseTokens ignore lines inside the echoed prompt', () => {
  assert.equal(parseHeader(REAL).model, 'gpt-6.1-sol');
  assert.equal(parseHeader(REAL).effort, 'low');
  assert.equal(parseTokens(REAL), 140);
  // A log with no header must not fall back to a `model:` line in the prompt echo.
  assert.equal(parseHeader('user\nmodel: claude-x\ncodex\nPONG\n'), null);
  assert.equal(parseTokens('no count here'), null);
});

test('parseHeader returns null when the only header-shaped block sits inside the echo', () => {
  assert.equal(parseHeader(`noise\nuser\nreview this:\n${FAKE_HEADER}\ncodex\nPONG\n`), null);
});

test('a fake header block inside the echoed prompt cannot stand in for a missing header', (t) => {
  const box = makeBox(t);
  const ctx = join(box.root, 'ctx.txt');
  writeFileSync(ctx, `${FAKE_HEADER}\n`);
  const r = runner(box, runArgs(box, ['--context-file', ctx]), 'noheader');
  assert.equal(r.code, 3, r.out);
  assert.match(r.lines[0], /status=no_header /);
  assert.ok(!r.out.includes(OK_ANSWER_TEXT));
});

// ---- model and effort rules -----------------------------------------------------------------

test('a retired model id is refused before anything is spawned', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box, ['--model', 'gpt-5.4']));
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /^CODEX-RECEIPT v1 (stub=1 )?status=bad_model /);
  assert.match(r.lines[1], /^NO CODEX REVIEW \(bad_model\)/);
  assert.equal(existsSync(box.marker), false, 'the stub must not run');
  assert.equal(rows(box).length, 1);
  assert.equal(rows(box)[0].status, 'bad_model');
});

test('ultra, an effort the cache lacks, and a model the cache lacks are all refused', (t) => {
  const box = makeBox(t, { omit: ['gpt-5.6-terra'] });
  const ultra = runner(box, runArgs(box, ['--effort', 'ultra']));
  assert.equal(ultra.code, 2);
  assert.equal(existsSync(box.marker), false, 'ultra is refused before any spawn');
  const noMax = runner(box, runArgs(box, ['--model', 'gpt-5.5', '--effort', 'max']));
  assert.equal(noMax.code, 2);
  assert.match(noMax.lines[0], /status=bad_args /);
  const absent = runner(box, runArgs(box, ['--model', 'gpt-5.6-terra']));
  assert.equal(absent.code, 2);
  assert.match(absent.lines[0], /status=bad_model /);
  assert.deepEqual(execCalls(box), []);
});

test('flag beats env beats default, for model and effort', () => {
  const env = { CODEX_ADVERSARY_MODEL: 'gpt-5.6-terra', CODEX_ADVERSARY_EFFORT: 'high' };
  assert.deepEqual(pickModel({}, {}), { model: DEFAULT_MODEL, effort: 'xhigh' });
  assert.deepEqual(pickModel({}, env), { model: 'gpt-5.6-terra', effort: 'high' });
  assert.deepEqual(pickModel({ model: 'gpt-5.5', effort: 'low' }, env), { model: 'gpt-5.5', effort: 'low' });
});

test('a cache from another CLI version is stale: the table ceiling decides, the run proceeds', (t) => {
  const box = makeBox(t, { version: '0.100.0', omit: ['gpt-5.6-luna'] });
  const r = runner(box, runArgs(box));
  assert.equal(r.code, 0, r.out);
  assert.equal(receipt(box, runId(r)).cache, 'stale');
  assert.equal(rows(box)[0].cache, 'stale');
});

test('a cache for the installed version still refuses an id it lacks, with no exec', (t) => {
  const box = makeBox(t, { omit: ['gpt-5.6-luna'] });
  const r = runner(box, runArgs(box));
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /status=bad_model /);
  assert.deepEqual(stubCalls(box).map((c) => c.split(' ')[0]), ['--version']);
});

test('an unreadable cache uses the table ceiling and says so', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'ok', { CODEX_MODELS_CACHE: join(box.root, 'missing.json') });
  assert.equal(r.code, 0, r.out);
  assert.equal(receipt(box, runId(r)).cache, 'unreadable');
});

// ---- run outcomes -----------------------------------------------------------------------------

test('an ok stub run prints the receipt, the answer, and stores a verifiable run folder', (t) => {
  const box = makeBox(t);
  const ctx = join(box.root, 'ctx.txt');
  writeFileSync(ctx, 'model: claude-x\ntokens used\n999999\n');
  const r = runner(box, runArgs(box, ['--context-file', ctx, '--via', 'test']));
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines[0], /^CODEX-RECEIPT v1 stub=1 status=ok run=\S+ model=gpt-5\.6-luna requested=gpt-5\.6-luna /);
  assert.match(r.lines[0], /effort=max provider=openai cli=0\.162\.1 /);
  assert.match(r.lines[0], / exit=0 final_bytes=\d+ sha256=[0-9a-f]{16} tokens=1234 duration_s=[\d.]+ json=1 via=test$/);
  assert.match(r.lines[1], /^STUB RUN \(not a Codex review\): /);
  assert.ok(!r.out.includes('Reviewed by OpenAI'));
  assert.ok(r.out.includes('## Codex answer (verbatim)'));
  assert.ok(r.out.includes(OK_ANSWER_TEXT));
  const id = runId(r);
  assert.deepEqual(readdirSync(runDir(box, id)).sort(), ['final.txt', 'log.txt', 'prompt.txt', 'receipt.json']);
  assert.match(promptOf(box, r), /# Review Target/);
  const rec = receipt(box, id);
  assert.deepEqual([rec.json, rec.framing, rec.bin, rec.effort_requested], [true, 'file', 'stub', 'max']);
  assert.equal(rows(box)[0].bin, 'stub');
  assert.equal(runner(box, ['verify', id, '--allow-stub']).code, 0);
  assert.equal(runner(box, ['verify', id]).code, 1, 'a stub run never verifies without --allow-stub');
});

test('a stub run can never match the production gate, and a path run can', () => {
  const base = {
    status: 'ok', run: '20261012T010101Z-ab12', model_observed: 'gpt-6.1-sol', model_requested: 'gpt-6.1-sol',
    effort: 'xhigh', provider: 'openai', cli: '0.162.1', session_id: 's', exit_code: 0, final_bytes: 5,
    final_sha256: 'a'.repeat(64), tokens: 9, duration_s: 1, json: true, via: 'x',
  };
  assert.match(formatReceipt({ ...base, bin: 'path' }), RECEIPT_OK_RE);
  assert.doesNotMatch(formatReceipt({ ...base, bin: 'stub' }), RECEIPT_OK_RE);
  assert.doesNotMatch(formatReceipt({ ...base, bin: 'env' }), RECEIPT_OK_RE);
  assert.match(formatReceipt({ ...base, bin: 'env' }), /^CODEX-RECEIPT v1 bin=env status=ok /);
  assert.ok(!formatReceipt({ ...base, bin: 'stub' }).endsWith('stub=1'));
});

test('a binary named by CODEX_BIN_JS is marked bin=env and fails the production gate', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'ok', { CODEX_ADVERSARY_STUB: undefined, CODEX_BIN_JS: STUB });
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines[0], /^CODEX-RECEIPT v1 bin=env status=ok /);
  assert.doesNotMatch(r.lines[0], RECEIPT_OK_RE);
  assert.match(r.lines[1], /^STUB RUN \(not a Codex review\): /);
  const id = runId(r);
  assert.equal(receipt(box, id).bin, 'env');
  assert.equal(runner(box, ['verify', id]).code, 1);
  assert.equal(runner(box, ['verify', id, '--allow-stub']).code, 0);
});

test('the API keys never reach the child, in any letter case', (t) => {
  const box = makeBox(t);
  const keys = { OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'sk-y', openai_api_key: 'sk-z', Codex_Api_Key: 'sk-w' };
  const r = runner(box, runArgs(box), 'ok', keys);
  assert.equal(r.code, 0, r.out);
  const calls = stubCalls(box);
  assert.ok(calls.length >= 3, 'version, login and exec all ran');
  assert.ok(calls.every((c) => c.endsWith('key=no')), calls.join(' | '));
});

test('cleanEnv drops API keys whatever their case and keeps the rest', () => {
  const kept = cleanEnv({ Path: 'p', openai_api_key: 'a', CODEX_API_KEY: 'b', OPENAI_API_KEY_X: 'c' });
  assert.deepEqual(kept, { Path: 'p', OPENAI_API_KEY_X: 'c' });
});

test('a model mismatch in the header yields no answer on stdout', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'mismatch');
  assert.equal(r.code, 3);
  assert.match(r.lines[0], /status=model_mismatch /);
  assert.ok(!r.out.includes(OK_ANSWER_TEXT));
  assert.equal(RECEIPT_OK_RE.test(r.lines[0]), false);
});

test('a provider other than openai is refused and the answer is not printed', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'provider');
  assert.equal(r.code, 3);
  assert.match(r.lines[0], /status=provider_mismatch /);
  assert.ok(!r.out.includes(OK_ANSWER_TEXT));
});

test('no answer file and exit 127 is an empty review', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'empty127');
  assert.equal(r.code, 3);
  assert.match(r.lines[0], /status=empty /);
  assert.match(r.lines[1], /^NO CODEX REVIEW \(empty\)/);
  assert.ok(r.lines[1].includes('Do not substitute a Claude review.'));
});

test('a hung run times out, its process tree stops, and an unrelated process survives', (t) => {
  const box = makeBox(t);
  const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => sibling.kill());
  const t0 = Date.now();
  const r = runner(box, runArgs(box, ['--timeout-s', '2']), 'hang');
  assert.ok(Date.now() - t0 < 15000, 'returned in time');
  assert.equal(r.code, 4);
  assert.match(r.lines[0], /status=timeout /);
  assert.equal(receipt(box, runId(r)).cleanup, 'ok');
  const pids = readFileSync(box.pidfile, 'utf8').trim().split('\n').map(Number);
  assert.equal(pids.length, 2);
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
  assert.deepEqual(pids.map(alive), [false, false]);
  assert.equal(alive(sibling.pid), true, 'a process that is not a descendant must not be stopped');
});

test('killTree skips a process created before the cutoff, so a reused PID is safe', { skip: process.platform !== 'win32' }, async (t) => {
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  await new Promise((resolve) => setTimeout(resolve, 500));
  killTree(sleeper.pid, process.env, Date.now() + 3600000);   // cutoff in the future: the sleeper is older
  assert.equal(alive(sleeper.pid), true, 'a process older than the cutoff must survive');
  killTree(sleeper.pid, process.env, Date.now() - 3600000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(alive(sleeper.pid), false);
});

test('usage limit, rejected model, missing login and missing header each get their own status', (t) => {
  const box = makeBox(t);
  const status = (mode) => runner(box, runArgs(box), mode);
  const usage = status('usage');
  assert.match(usage.lines[0], /status=usage_limited /);
  assert.ok(usage.lines[1].includes('try again at 3:42 PM'));
  assert.match(status('reject400').lines[0], /status=model_rejected /);
  const login = status('nologin');
  assert.equal(login.code, 2);
  assert.match(login.lines[0], /status=auth /);
  assert.ok(login.lines[1].includes('run: codex login'));
  assert.match(status('noheader').lines[0], /status=no_header /);
});

test('an answer that quotes the usage-limit sentence is still an ok review', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box), 'quote');
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines[0], /^CODEX-RECEIPT v1 stub=1 status=ok /);
});

test('prompt text that quotes the usage-limit sentence does not fake a usage limit on a failed run', (t) => {
  const box = makeBox(t);
  const diff = join(box.root, 'quotes.diff');
  writeFileSync(diff, 'diff --git a/x b/x\n+// You\'ve hit your usage limit; "status":400 model is not supported\n');
  const r = runner(box, runArgs(box, ['--diff-file', diff]), 'empty127');
  assert.match(r.lines[0], /status=empty /);
});

test('prose from Codex is ok but not json: answer null, text in answer_raw', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box, ['--format', 'json']), 'prose');
  assert.equal(r.code, 0, r.out);
  assert.equal(receipt(box, runId(r)).json, false);
  assert.match(r.lines[0], / json=0 via=manual$/);
  const obj = jsonAfterHeader(r);
  assert.equal(obj.answer, null);
  assert.equal(obj.answer_raw, 'Looks fine to me, no real issues found.');
  assert.equal(obj.codex_receipt, r.lines[0]);
});

test('parseAnswer strips ``` fences and returns null for prose', () => {
  assert.deepEqual(parseAnswer('```json\n{"verdict":"approve","findings":[]}\n```'), { verdict: 'approve', findings: [] });
  assert.deepEqual(parseAnswer('[{"file":"a:1"}]'), [{ file: 'a:1' }]);
  assert.equal(parseAnswer('Looks fine.'), null);
  assert.equal(parseAnswer('42'), null);
});

test('json format parses the answer for ok runs and prints answer null for failed runs', (t) => {
  const box = makeBox(t);
  const bad = runner(box, runArgs(box, ['--format', 'json']), 'empty127');
  const obj = jsonAfterHeader(bad);
  assert.deepEqual([obj.status, obj.answer, obj.answer_raw], ['empty', null, '']);
  const ok = runner(box, runArgs(box, ['--format', 'json']));
  assert.equal(jsonAfterHeader(ok).answer.verdict, 'needs-attention');
});

test('with --format json a refusal carries the valid choices inside the object', (t) => {
  const box = makeBox(t);
  const r = runner(box, runArgs(box, ['--model', 'gpt-5.4', '--format', 'json']));
  assert.equal(r.code, 2);
  const obj = jsonAfterHeader(r);
  assert.equal(obj.status, 'bad_model');
  assert.ok(obj.choices.includes('Valid models'));
});

test('an empty diff and an oversize diff are refused before any exec', (t) => {
  const box = makeBox(t);
  const empty = join(box.root, 'empty.diff');
  const big = join(box.root, 'big.diff');
  writeFileSync(empty, '');
  writeFileSync(big, 'x'.repeat(401 * 1024));
  for (const file of [empty, big]) {
    const r = runner(box, runArgs(box, ['--diff-file', file]));
    assert.equal(r.code, 2);
    assert.match(r.lines[0], /status=bad_args /);
  }
  assert.deepEqual(execCalls(box), []);
});

test('a whole prompt above 600 KB is refused before any exec', (t) => {
  const box = makeBox(t);
  const diff = join(box.root, 'near-limit.diff');
  const ctx = join(box.root, 'ctx.txt');
  writeFileSync(diff, 'x'.repeat(390 * 1024));
  writeFileSync(ctx, 'y'.repeat(250 * 1024));
  const r = runner(box, runArgs(box, ['--diff-file', diff, '--context-file', ctx]));
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /status=bad_args /);
  assert.deepEqual(execCalls(box), []);
});

test('a directory or a missing file given as an input path is bad_args, not a crash', (t) => {
  const box = makeBox(t);
  const dirAsPlan = runner(box, sourceArgs(box, 'plan', ['--plan', box.root]));
  const dirAsDiff = runner(box, runArgs(box, ['--diff-file', box.root]));
  const noContext = runner(box, runArgs(box, ['--context-file', join(box.root, 'nope.txt')]));
  const noFocus = runner(box, runArgs(box, ['--focus-file', join(box.root, 'nope.txt')]));
  for (const r of [dirAsPlan, dirAsDiff, noContext, noFocus]) {
    assert.equal(r.code, 2, r.out);
    assert.match(r.lines[0], /status=bad_args /);
  }
});

test('--focus-file puts the file text in the prompt', (t) => {
  const box = makeBox(t);
  const focus = join(box.root, 'focus.txt');
  writeFileSync(focus, 'FOCUS-FROM-FILE-MARKER');
  const r = runner(box, runArgs(box, ['--focus-file', focus]));
  assert.equal(r.code, 0, r.out);
  assert.ok(promptOf(box, r).includes('FOCUS-FROM-FILE-MARKER'));
});

test('--room feeds the prompt, writes findings and a thread line, never status.json', (t) => {
  const box = makeBox(t);
  const room = join(box.root, 'room');
  mkdirSync(join(room, 'inbox', 'codex'), { recursive: true });
  writeFileSync(join(room, 'CONTRACT.md'), 'CONTRACT-MARKER-TEXT');
  writeFileSync(join(room, 'status.json'), '{"phase":"build"}');
  writeFileSync(join(room, 'inbox', 'codex', 'note.md'), 'INBOX-MARKER-TEXT');
  const r = runner(box, runArgs(box, ['--room', room]));
  assert.equal(r.code, 0, r.out);
  const id = runId(r);
  assert.ok(promptOf(box, r).includes('CONTRACT-MARKER-TEXT') && promptOf(box, r).includes('INBOX-MARKER-TEXT'));
  assert.deepEqual(readdirSync(join(room, 'findings')), [`booth-codex-${id}.md`]);
  assert.match(readFileSync(join(room, 'findings', `booth-codex-${id}.md`), 'utf8'), /^CODEX-RECEIPT v1 stub=1 status=ok /);
  assert.match(readFileSync(join(room, 'THREAD.md'), 'utf8'),
    / codex \[reviewer\] needs-attention run=\S+ model=gpt-5\.6-luna\n$/);
  assert.equal(readFileSync(join(room, 'status.json'), 'utf8'), '{"phase":"build"}');
});

test('--room without CONTRACT.md is bad_args', (t) => {
  const box = makeBox(t);
  const room = join(box.root, 'room');
  mkdirSync(room);
  const r = runner(box, runArgs(box, ['--room', room]));
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /status=bad_args /);
  assert.deepEqual(execCalls(box), []);
});

test('a storage error is reported on line 2 and does not change an ok status', (t) => {
  const box = makeBox(t);
  mkdirSync(jsonlPath(box), { recursive: true });   // a directory where the log file should be
  const r = runner(box, runArgs(box));
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines[0], /^CODEX-RECEIPT v1 stub=1 status=ok /);
  assert.match(r.lines[1], / storage_error=\S/);
  assert.ok(r.out.includes(OK_ANSWER_TEXT));
});

test('a codex.cmd shim without the JS entry is cli_missing: no shell fallback runs it', { skip: process.platform !== 'win32' }, (t) => {
  const box = makeBox(t);
  const shimDir = join(box.root, 'shim');
  const shimMarker = join(box.root, 'shim-ran.txt');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'codex.cmd'), `@echo off\r\necho ran> "${shimMarker}"\r\n`);
  const r = runner(box, runArgs(box), 'ok', { CODEX_ADVERSARY_STUB: undefined, Path: undefined, PATH: shimDir });
  assert.equal(r.code, 2, r.out);
  assert.match(r.lines[0], /status=cli_missing /);
  assert.equal(existsSync(shimMarker), false, 'the shim must never run');
});

// ---- caller paths with a real git repo ------------------------------------------------------

test('--base, --staged, --unstaged, --working-tree and --plan each reach Codex and return ok', (t) => {
  const box = makeBox(t);
  const file = makeRepo(box);
  const ok = (source, mode = 'code') => {
    const r = runner(box, sourceArgs(box, mode, source));
    assert.equal(r.code, 0, r.out);
    return r;
  };
  const base = ok(['--base', 'HEAD~1']);
  assert.ok(promptOf(box, base).includes('+two') && promptOf(box, base).includes('-one'));
  writeFileSync(file, 'three\n');
  git(box.project, 'add', 'a.js');
  assert.ok(promptOf(box, ok(['--staged'])).includes('+three'));
  writeFileSync(file, 'four\n');
  writeFileSync(join(box.project, 'untracked.txt'), 'new\n');
  assert.ok(promptOf(box, ok(['--unstaged'])).includes('+four'));
  const wt = ok(['--working-tree']);
  assert.ok(promptOf(box, wt).includes('+four') && promptOf(box, wt).includes('-two'));
  assert.ok(wt.lines[1].includes(' Scope: working-tree.'), wt.lines[1]);
  assert.ok(wt.lines[1].includes(' Untracked files not reviewed: 1.'), wt.lines[1]);
  assert.equal(receipt(box, runId(wt)).untracked_not_reviewed, 1);
  assert.equal(receipt(box, runId(wt)).scope, 'working-tree');
  const plan = join(box.root, 'plan.md');
  writeFileSync(plan, '# Plan\nPLAN-MARKER\n');
  assert.ok(promptOf(box, ok(['--plan', plan], 'plan')).includes('PLAN-MARKER'));
});

test('a clean working tree reports no untracked line', (t) => {
  const box = makeBox(t);
  const file = makeRepo(box);
  writeFileSync(file, 'changed\n');
  const r = runner(box, sourceArgs(box, 'code', ['--working-tree']));
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.lines[1].includes('Untracked'));
});

test('an option-shaped --base, an unknown flag and a zero timeout are refused before any exec', (t) => {
  const box = makeBox(t);
  makeRepo(box);
  const attempts = [
    sourceArgs(box, 'code', ['--base', '-x']),
    runArgs(box, ['--bogus', '1']),
    runArgs(box, ['--timeout-s', '0']),
  ];
  for (const args of attempts) {
    const r = runner(box, args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.lines[0], /status=bad_args /);
  }
  assert.deepEqual(execCalls(box), []);
});

// ---- verify, receipts, lift -------------------------------------------------------------------

test('verify fails after one byte of final.txt changes, and for an unknown run', (t) => {
  const box = makeBox(t);
  const id = runId(runner(box, runArgs(box)));
  const good = runner(box, ['verify', id, '--allow-stub']);
  assert.equal(good.code, 0);
  assert.ok(good.out.includes(`root=${box.home}`), good.out);
  const finalPath = join(runDir(box, id), 'final.txt');
  writeFileSync(finalPath, readFileSync(finalPath, 'utf8') + ' ');
  const bad = runner(box, ['verify', id, '--allow-stub']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^VERIFY FAIL run=\S+ reason=/);
  assert.equal(runner(box, ['verify', '20260101T000000Z-dead', '--allow-stub']).code, 1);
});

test('verify fails when the log row for the run is missing', (t) => {
  const box = makeBox(t);
  const id = runId(runner(box, runArgs(box)));
  writeFileSync(jsonlPath(box), '');
  assert.equal(runner(box, ['verify', id, '--allow-stub']).code, 1);
});

test('verify fails when receipt.json is edited to ok on a run that was not ok', (t) => {
  const box = makeBox(t);
  const id = runId(runner(box, runArgs(box), 'mismatch'));
  assert.equal(runner(box, ['verify', id, '--allow-stub']).code, 1);
  const path = join(runDir(box, id), 'receipt.json');
  writeFileSync(path, JSON.stringify({ ...receipt(box, id), status: 'ok' }));
  const r = runner(box, ['verify', id, '--allow-stub']);
  assert.equal(r.code, 1, r.out);
});

test('verify fails when the model in the log header is edited', (t) => {
  const box = makeBox(t);
  const id = runId(runner(box, runArgs(box)));
  const path = join(runDir(box, id), 'log.txt');
  writeFileSync(path, readFileSync(path, 'utf8').replace('model: gpt-5.6-luna', 'model: gpt-5.5'));
  const r = runner(box, ['verify', id, '--allow-stub']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /reason=.*log/);
});

test('RECEIPT_OK_RE accepts only an ok receipt that names a GPT model', () => {
  const ok = 'CODEX-RECEIPT v1 status=ok run=20261012T010101Z-ab12 model=gpt-6.1-sol requested=gpt-6.1-sol';
  assert.equal(RECEIPT_OK_RE.test(ok), true);
  assert.equal(RECEIPT_OK_RE.test('[{"file":"a.js:1","issue":"x"}]'), false);
  assert.equal(RECEIPT_OK_RE.test(ok.replace('status=ok', 'status=empty')), false);
  assert.equal(RECEIPT_OK_RE.test(ok.replace('model=gpt-6.1-sol', 'model=claude-sonnet-5-5')), false);
});

test('the synced framing copy is byte-identical to the vendored file', () => {
  const vendor = readFileSync(join(HERE, '../../vendor/codex-plugin-cc/prompts/adversarial-review.md'));
  assert.ok(vendor.equals(readFileSync(join(SCRIPT_DIR, 'adversarial-review.md'))));
});

test('a missing framing file falls back to the embedded framing', () => {
  assert.equal(loadFraming(SCRIPT_DIR).source, 'file');
  const fallback = loadFraming(join(tmpdir(), 'no-such-dir-adv'));
  assert.equal(fallback.source, 'embedded');
  assert.ok(fallback.text.includes('BREAK CONFIDENCE'));
});

test('lift refuses a run that fails verify and logs a row for one that passes', (t) => {
  const box = makeBox(t);
  const lift = (id, extra = []) => runner(box, ['lift', '--run', id, '--skill', 'review', '--scope', 'pr-1',
    '--claude-only', '1', '--codex-only', '2', '--both', '3', '--project', box.project, ...extra]);
  const liftLog = join(box.project, '.claude', 'logs', 'codex-lift.jsonl');
  const failed = runId(runner(box, runArgs(box), 'empty127'));
  assert.equal(lift(failed, ['--allow-stub']).code, 1);
  const good = runId(runner(box, runArgs(box)));
  assert.equal(lift(good).code, 1, 'a stub run is refused without --allow-stub');
  assert.equal(existsSync(liftLog), false);
  assert.equal(lift(good, ['--allow-stub']).code, 0);
  const row = JSON.parse(readFileSync(liftLog, 'utf8').trim());
  assert.deepEqual([row.reviewer_model, row.reviewer_effort, row.codex_run, row.codex_status],
    ['gpt-5.6-luna', 'max', good, 'ok']);
  assert.deepEqual([row.claude_only, row.codex_only, row.both, row.model, row.via], [1, 2, 3, 'codex', 'runner']);
});
