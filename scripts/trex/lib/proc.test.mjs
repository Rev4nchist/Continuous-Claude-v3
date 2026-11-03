import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerBin, makePidRecorder, pipeChildren, processStartMs, runChild } from './proc.mjs';

const NODE = 'node'; // resolveSpawn maps "node" to the running binary
const killChild = (child) => child.kill(); // the real killTree runs a 5 s PowerShell query on Windows, so tests inject this

// ---------- dockerBin ----------

test('dockerBin: DOCKER_BIN wins over the Program Files path', () => {
  assert.equal(dockerBin({ DOCKER_BIN: 'D:\\x\\docker.exe' }, { exists: () => true }), 'D:\\x\\docker.exe');
});

test('dockerBin: uses the Program Files path when it exists', () => {
  const got = dockerBin({}, { exists: () => true });
  assert.equal(got, 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe');
});

test('dockerBin: falls back to docker on the PATH', () => {
  assert.equal(dockerBin({}, { exists: () => false }), 'docker');
});

// ---------- runChild ----------

test('runChild: returns code, stdout and stderr', async () => {
  const r = await runChild(NODE, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], {}, { killer: killChild });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
});

test('runChild: feeds opts.stdin to the child', async () => {
  const code = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.toUpperCase()))';
  const r = await runChild(NODE, ['-e', code], { stdin: 'hello' }, { killer: killChild });
  assert.equal(r.stdout.trim(), 'HELLO');
});

test('runChild: a time-out calls the injected killer and sets timedOut', async () => {
  const killed = [];
  const killer = (child) => { killed.push(child.pid); child.kill(); };
  const r = await runChild(NODE, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 }, { killer });
  assert.equal(r.timedOut, true);
  assert.equal(killed.length, 1);
});

test('runChild: onSpawn gets the pid before the child ends', async () => {
  const seen = [];
  const r = await runChild(NODE, ['-e', '0'], { onSpawn: (pid) => seen.push(pid) }, { killer: killChild });
  assert.equal(r.code, 0);
  assert.equal(seen.length, 1);
  assert.ok(Number.isInteger(seen[0]) && seen[0] > 0);
});

test('runChild: the child env has no Anthropic key by default', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
  try {
    const r = await runChild(NODE, ['-e', 'console.log("[" + (process.env.ANTHROPIC_API_KEY ?? "") + "]")'], {}, { killer: killChild });
    assert.equal(r.stdout.trim(), '[]');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('runChild: a missing command is a result, never a throw', async () => {
  const r = await runChild('trex-no-such-command-xyz', [], {}, { killer: killChild });
  assert.equal(r.code, null);
  assert.match(r.error, /ENOENT|spawn/);
});

test('runChild: spawn options are non-detached, hidden, shell-free and piped', async () => {
  let seen;
  const spawnFn = (cmd, args, options) => {
    seen = options;
    const child = new EventEmitter();
    Object.assign(child, { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  await runChild('x', [], {}, { spawnFn, resolve: (s) => s, killer: killChild });
  assert.equal(seen.windowsHide, true);
  assert.equal(seen.shell, false);
  assert.ok(!seen.detached);
  assert.deepEqual(seen.stdio, ['pipe', 'pipe', 'pipe']);
});

test('runChild: logPath receives the child output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-proc-'));
  const logPath = path.join(dir, 'step.log');
  await runChild(NODE, ['-e', 'console.log("logged line")'], { logPath }, { killer: killChild });
  assert.match(readFileSync(logPath, 'utf8'), /logged line/);
});

// ---------- pipeChildren ----------

test('pipeChildren: a stdout reaches b stdin', async () => {
  const a = { cmd: NODE, args: ['-e', 'process.stdout.write("pipe data")'] };
  const b = { cmd: NODE, args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.toUpperCase()))'] };
  const r = await pipeChildren(a, b, {}, { killer: killChild });
  assert.equal(r.codeA, 0);
  assert.equal(r.codeB, 0);
  assert.equal(r.stdoutB.trim(), 'PIPE DATA');
});

test('pipeChildren: one time-out kills both children', async () => {
  const killed = [];
  const killer = (child) => { killed.push(child.pid); child.kill(); };
  const sleeper = { cmd: NODE, args: ['-e', 'setTimeout(()=>{}, 60000)'] };
  const r = await pipeChildren(sleeper, sleeper, { timeoutMs: 300 }, { killer });
  assert.equal(r.timedOut, true);
  assert.equal(killed.length, 2);
});

test('pipeChildren: onSpawn sees both pids', async () => {
  const seen = [];
  const quick = { cmd: NODE, args: ['-e', '0'] };
  await pipeChildren(quick, quick, { onSpawn: (pid) => seen.push(pid) }, { killer: killChild });
  assert.equal(seen.length, 2);
});

// ---------- pid sidecar ----------

test('makePidRecorder: records pids and live() keeps only the running ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-pids-'));
  const file = path.join(dir, 'pids.json');
  const rec = makePidRecorder(file, { alive: (pid) => pid === 22 });
  rec.onSpawn(11);
  rec.onSpawn(22);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pids.map((e) => e.pid), [11, 22]);
  assert.deepEqual(rec.live(), [22]);
});

test('makePidRecorder: live() is empty when the file is missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-pids-'));
  const rec = makePidRecorder(path.join(dir, 'none.json'), { alive: () => true });
  assert.deepEqual(rec.live(), []);
});

test('makePidRecorder: a child that exits is removed from the file (M-pids; break: never remove on close)', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'trex-pids-')), 'pids.json');
  const rec = makePidRecorder(file, { alive: () => true });
  const seen = [];
  const onSpawn = (pid) => { rec.onSpawn(pid); seen.push(readFileSync(file, 'utf8')); };
  await runChild(NODE, ['-e', 'process.exit(0)'], { onSpawn, onExit: rec.onExit }, { killer: killChild });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pids, []);
  assert.equal(JSON.parse(seen[0]).pids.length, 1, 'the pid was recorded while the child ran');
});

test('makePidRecorder: liveOwned drops a live pid whose start time does not match the record (pid reuse)', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'trex-pids-')), 'pids.json');
  const starts = { 11: 1_000_000, 22: 9_000_000 };
  const rec = makePidRecorder(file, { alive: () => true, processStart: (pid) => starts[pid], now: () => 1_000_500 });
  rec.onSpawn(11);
  rec.onSpawn(22);
  assert.deepEqual(rec.liveOwned(), [11]);
  assert.deepEqual(rec.live(), [11, 22], 'live() only checks that the pid runs');
});

test('makePidRecorder: liveOwned drops a pid whose start time is unknown, and one that is dead', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'trex-pids-')), 'pids.json');
  const rec = makePidRecorder(file, { alive: (pid) => pid !== 33, processStart: (pid) => (pid === 44 ? null : 1_000_000), now: () => 1_000_000 });
  rec.onSpawn(33);
  rec.onSpawn(44);
  rec.onSpawn(55);
  assert.deepEqual(rec.liveOwned(), [55]);
});

test('processStartMs reads the PowerShell ISO time on win32 and the ps time elsewhere, and gives null on failure', () => {
  const ok = (stdout) => () => ({ status: 0, stdout });
  assert.equal(processStartMs(7, { platform: 'win32', run: ok('2026-11-02T12:00:00.0000000Z') }), Date.UTC(2026, 10, 2, 12));
  assert.equal(processStartMs(7, { platform: 'linux', run: ok('Mon Nov  2 12:00:00 2026') }), new Date(2026, 10, 2, 12).getTime());
  assert.equal(processStartMs(7, { platform: 'win32', run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(processStartMs(0, { run: ok('x') }), null);
});
