// End-to-end tests for sink-spy.mjs. Every test spawns node with the same flags
// the /security probe run form uses, so the spy is tested the way it is used.
//   node --test .claude/scripts/security/sink-spy.test.mjs
// SINK_SPY overrides the spy path (same override as the run form).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, readFileSync, statSync, constants as FSC } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPY = resolve(process.env.SINK_SPY || join(HERE, 'sink-spy.mjs'));

// ---------- helpers ----------

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sink-spy-')));
  dirs.push(d);
  mkdirSync(join(d, 'out'));
  return d;
}

// Run node on `file` the way the probe run form does. Probes are .mjs or .cjs only.
function run(dir, file, { permission = true, spy = SPY, requireSpy = true } = {}) {
  const args = [];
  if (permission) args.push('--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${spy}`);
  if (requireSpy) args.push('--require', spy);
  args.push(file);
  const env = { PATH: process.env.PATH };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return spawnSync(process.execPath, args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runSource(source, opts = {}) {
  const dir = opts.dir ?? tmp();
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, source);
  return { dir, r: run(dir, file, opts) };
}

function parse(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  return {
    lines,
    ready: lines.filter((l) => l === 'SINK_SPY_READY').length,
    records: lines.filter((l) => l.startsWith('SINK_SPY ')).map((l) => JSON.parse(l.slice(9))),
    marks: lines.filter((l) => l.startsWith('MARK ')).map((l) => l.slice(5)),
  };
}

const MARK_FN = "import { writeSync } from 'node:fs';\nconst mark = (s) => writeSync(1, 'MARK ' + s + '\\n');\n";

// ---------- sink table (every sink in the task) ----------

// [module, name, argument template]. Words in the template are replaced per run.
const BASE_SINKS = [
  ['child_process', 'exec', 'CMD, () => {}'],
  ['child_process', 'execSync', 'CMD'],
  ['child_process', 'execFile', 'PROG, ARGS, () => {}'],
  ['child_process', 'execFileSync', 'PROG, ARGS'],
  ['child_process', 'spawn', 'PROG, ARGS'],
  ['child_process', 'spawnSync', 'PROG, ARGS'],
  ['fs', 'writeFile', 'P, DATA, () => {}'],
  ['fs', 'writeFileSync', 'P, DATA'],
  ['fs', 'appendFile', 'P, DATA, () => {}'],
  ['fs', 'appendFileSync', 'P, DATA'],
  ['fs', 'createWriteStream', 'P'],
  ['fs', 'mkdir', 'P, () => {}'],
  ['fs', 'mkdirSync', 'P'],
  ['fs', 'rm', 'P, () => {}'],
  ['fs', 'rmSync', 'P'],
  ['fs', 'rename', 'P, P2, () => {}'],
  ['fs', 'renameSync', 'P, P2'],
  ['fs/promises', 'writeFile', 'P, DATA'],
  ['fs/promises', 'appendFile', 'P, DATA'],
  ['fs/promises', 'mkdir', 'P'],
  ['fs/promises', 'rm', 'P'],
  ['fs/promises', 'rename', 'P, P2'],
];
// Sinks added later: fork, the other destructive fs calls, and open with a write flag.
// MOD and MARGS are a module path and its argument list for fork.
const NEW_SINKS = [
  // execArgv: [] keeps the real child from inheriting --require, so the control run shows a real effect
  ['child_process', 'fork', 'MOD, MARGS, { execArgv: [] }'],
  ['fs', 'unlink', 'P, () => {}'],
  ['fs', 'unlinkSync', 'P'],
  ['fs', 'rmdir', 'P, () => {}'],
  ['fs', 'rmdirSync', 'P'],
  ['fs', 'copyFile', 'P, P2, () => {}'],
  ['fs', 'copyFileSync', 'P, P2'],
  ['fs', 'cp', 'P, P2, () => {}'],
  ['fs', 'cpSync', 'P, P2'],
  ['fs', 'truncate', 'P, 0, () => {}'],
  ['fs', 'truncateSync', 'P, 0'],
  ['fs', 'symlink', 'P, P2, "junction", () => {}'],
  ['fs', 'symlinkSync', 'P, P2, "junction"'],
  ['fs', 'link', 'P, P2, () => {}'],
  ['fs', 'linkSync', 'P, P2'],
  ['fs', 'open', 'P, "w", () => {}'],
  ['fs', 'openSync', 'P, "w"'],
  ['fs/promises', 'unlink', 'P'],
  ['fs/promises', 'rmdir', 'P'],
  ['fs/promises', 'copyFile', 'P, P2'],
  ['fs/promises', 'cp', 'P, P2'],
  ['fs/promises', 'truncate', 'P, 0'],
  ['fs/promises', 'symlink', 'P, P2, "junction"'],
  ['fs/promises', 'link', 'P, P2'],
  ['fs/promises', 'open', 'P, "w"'],
];
const SINKS = [...BASE_SINKS, ...NEW_SINKS];
const CP_SINKS = SINKS.filter(([m]) => m === 'child_process');
const BASE_FS_SINKS = BASE_SINKS.filter(([m]) => m !== 'child_process');
const NEW_FS_SINKS = NEW_SINKS.filter(([m]) => m !== 'child_process');
const idOf = ([m, n]) => `${m}.${n}`;

// Ways a target can reach a module. Each returns { imports, expr } for one sink.
const STYLES = {
  'esm-named': (m, n, a) => ({ imports: `import { ${n} as ${a} } from 'node:${m}';`, expr: a }),
  'esm-namespace': (m, n, a) => ({ imports: `import * as ns_${a} from 'node:${m}';`, expr: `ns_${a}.${n}` }),
  'esm-default': (m, n, a) => ({ imports: `import def_${a} from 'node:${m}';`, expr: `def_${a}.${n}` }),
  // fs/promises reached as the `promises` named export of node:fs
  'esm-fs-promises-prop': (m, n, a) =>
    m === 'fs/promises'
      ? { imports: `import { promises as pr_${a} } from 'node:fs';`, expr: `pr_${a}.${n}` }
      : { imports: `import * as ns_${a} from 'node:${m}';`, expr: `ns_${a}.${n}` },
  'cjs-destructure': (m, n, a) => ({ imports: `const { ${n}: ${a} } = require('${m}');`, expr: a }),
  'cjs-fs-promises-prop': (m, n, a) =>
    m === 'fs/promises'
      ? { imports: `const { promises: pr_${a} } = require('fs');`, expr: `pr_${a}.${n}` }
      : { imports: `const { ${n}: ${a} } = require('node:${m}');`, expr: a },
};

// Build a target module that exposes one callable per sink, and a probe that
// calls each and marks BEGIN / END around it.
function writeTable(dir, style, sinks, ctxOf, { wait = 0 } = {}) {
  const cjs = style.startsWith('cjs');
  const imports = [];
  const entries = [];
  for (const [m, n, tpl] of sinks) {
    const id = `${m}.${n}`;
    const alias = `${m.replace('/', '_')}_${n}`;
    const { imports: imp, expr } = STYLES[style](m, n, alias);
    imports.push(imp);
    const ctx = ctxOf(id);
    const args = tpl.replace(/\b(CMD|PROG|ARGS|MOD|MARGS|P2|P|DATA)\b/g, (w) => JSON.stringify(ctx[w]));
    entries.push(`${JSON.stringify(id)}: async () => await ${expr}(${args}),`);
  }
  const body = `${[...new Set(imports)].join('\n')}\nconst calls = {\n${entries.join('\n')}\n};\n`;
  const targetFile = join(dir, cjs ? 'target.cjs' : 'target.mjs');
  writeFileSync(targetFile, body + (cjs ? 'exports.calls = calls;\n' : 'export { calls };\n'));
  const probe =
    MARK_FN +
    `const m = await import(${JSON.stringify(pathToFileURL(targetFile).href)});\n` +
    'const calls = m.calls ?? m.default.calls;\n' +
    'for (const id of Object.keys(calls)) {\n' +
    "  mark('BEGIN ' + id);\n" +
    "  try { await calls[id](); } catch (e) { mark('THROW ' + id + ' ' + ((e && e.code) || e)); }\n" +
    "  mark('END ' + id);\n" +
    '}\n' +
    (wait ? `await new Promise((r) => setTimeout(r, ${wait}));\n` : '') +
    "mark('DONE');\n";
  const probeFile = join(dir, 'probe.mjs');
  writeFileSync(probeFile, probe);
  return probeFile;
}

function bySink(lines) {
  const out = {};
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('MARK BEGIN ')) {
      cur = l.slice(11);
      out[cur] = { records: [], threw: null };
    } else if (l.startsWith('MARK THROW ') && cur) out[cur].threw = l.slice(11);
    else if (l.startsWith('MARK END ')) cur = null;
    else if (l.startsWith('SINK_SPY ') && cur) out[cur].records.push(JSON.parse(l.slice(9)));
  }
  return out;
}

const SAFE = (id) => id.replace(/[^a-z0-9]/gi, '_');
function ctxFor(dir, id) {
  const P = join(dir, 'out', SAFE(id));
  return { CMD: 'echo hello', PROG: 'prog', ARGS: ['a b', '--c'], MOD: 'mod.js', MARGS: ['a b', '--c'], P, P2: `${P}.moved`, DATA: 'data' };
}

// Run the whole table under the real run form; return problems found.
function tableProblems(style, sinks = SINKS) {
  const dir = tmp();
  const file = writeTable(dir, style, sinks, (id) => ctxFor(dir, id));
  const r = run(dir, file);
  const problems = [];
  if (r.status !== 0) problems.push(`exit ${r.status}: ${r.stderr.split('\n').slice(0, 4).join(' | ')}`);
  const per = bySink(parse(r.stdout).lines);
  for (const s of sinks) {
    const id = idOf(s);
    const ctx = ctxFor(dir, id);
    const got = per[id];
    if (!got) problems.push(`${id}: never called`);
    else if (got.threw) problems.push(`${id}: threw ${got.threw}`);
    else if (got.records.length !== 1) problems.push(`${id}: ${got.records.length} records, want 1`);
    else {
      if (got.records[0].sink !== id) problems.push(`${id}: recorded as ${got.records[0].sink}`);
      const first = ctx[s[2].split(',')[0].trim()];
      if (got.records[0].args[0] !== first) problems.push(`${id}: first arg ${JSON.stringify(got.records[0].args[0])}`);
    }
  }
  return problems;
}

// ---------- 1. every sink is replaced (table-driven) ----------

let esmNamed;
for (const s of SINKS) {
  test(`1. sink is replaced: ${idOf(s)}`, () => {
    esmNamed ??= tableProblems('esm-named');
    const mine = esmNamed.filter((p) => p.startsWith(idOf(s) + ':') || p.startsWith('exit'));
    assert.deepEqual(mine, []);
  });
}

// ---------- 2-4. every way to reach a module ----------

test('2. CJS require() path is replaced (destructured require, with and without node: prefix)', () => {
  assert.deepEqual(tableProblems('cjs-destructure'), []);
});
test('2b. CJS destructure of require("fs").promises is replaced', () => {
  assert.deepEqual(tableProblems('cjs-fs-promises-prop'), []);
});
test('3. ESM named imports are replaced (checked in test 1); ESM default imports too', () => {
  assert.deepEqual(tableProblems('esm-default'), []);
});
test('4. ESM namespace imports are replaced', () => {
  assert.deepEqual(tableProblems('esm-namespace'), []);
});
test('4b. import { promises } from "node:fs" is replaced', () => {
  assert.deepEqual(tableProblems('esm-fs-promises-prop'), []);
});

// ---------- 5 and 6. nothing real happens (run WITHOUT --permission) ----------

// What each call does to the disk when it runs for real, by base name (Sync suffix removed).
const GONE = new Set(['rm', 'rmdir', 'unlink']); // P is gone
const MOVED = new Set(['rename', 'copyFile', 'cp', 'symlink', 'link']); // P2 appears
function effectOf(id, ctx) {
  const name = id.split('.')[1].replace(/Sync$/, '');
  if (GONE.has(name)) return !existsSync(ctx.P);
  if (MOVED.has(name)) return existsSync(ctx.P2);
  if (name === 'truncate') return existsSync(ctx.P) && statSync(ctx.P).size === 0;
  return existsSync(ctx.P);
}

// Seed files that rm and rename act on, run the table, return the sinks with a real effect.
function realEffects(sinks, { requireSpy, ctxOf, seed, wait }) {
  const dir = tmp();
  const ctxD = (id) => ctxOf(dir, id);
  for (const s of sinks) seed?.(idOf(s), ctxD(idOf(s)), dir);
  const file = writeTable(dir, 'esm-named', sinks, ctxD, { wait });
  const r = run(dir, file, { permission: false, requireSpy });
  const effects = sinks.map(idOf).filter((id) => effectOf(id, ctxD(id)));
  return { r, effects };
}

// rmdir and symlink act on a directory (a junction needs no privilege on Windows); the rest on a file.
const seedFs = (id, ctx) => {
  const name = id.split('.')[1].replace(/Sync$/, '');
  if (name === 'rmdir' || name === 'symlink') mkdirSync(ctx.P);
  else if (['rm', 'rename', 'unlink', 'copyFile', 'cp', 'truncate', 'link'].includes(name)) writeFileSync(ctx.P, 'seed');
};

// Run one group of fs sinks without --permission: a control run (no spy) must change the
// disk for every sink, or the test proves nothing; the spied run must change nothing.
function assertNoDiskEffect(sinks) {
  const opts = { ctxOf: ctxFor, seed: seedFs, wait: 300 };
  const control = realEffects(sinks, { ...opts, requireSpy: false });
  assert.deepEqual(control.effects, sinks.map(idOf), `control run: ${control.r.stderr}`);
  const spied = realEffects(sinks, { ...opts, requireSpy: true });
  assert.equal(spied.r.status, 0, spied.r.stderr);
  assert.deepEqual(spied.effects, []);
}

test('5. no real file write, mkdir, rm or rename happens (fs and fs/promises)', () => {
  assertNoDiskEffect(BASE_FS_SINKS);
});

test('5b. unlink, rmdir, copyFile, cp, truncate, symlink, link and a write-flag open leave the disk unchanged', () => {
  assertNoDiskEffect(NEW_FS_SINKS);
});

function cpCtx(dir, id) {
  const marker = join(dir, `marker-${SAFE(id)}`);
  const script = join(dir, 'marker.cjs');
  writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'x');\n");
  return {
    CMD: `"${process.execPath}" "${script}" "${marker}"`,
    PROG: process.execPath,
    ARGS: [script, marker],
    MOD: script, // fork runs a module, not a program
    MARGS: [marker],
    P: marker,
  };
}

test('6. no real child process runs (exec, execSync, execFile, execFileSync, spawn, spawnSync, fork)', () => {
  const opts = { ctxOf: cpCtx, wait: 2500 };
  const control = realEffects(CP_SINKS, { ...opts, requireSpy: false });
  assert.deepEqual(control.effects, CP_SINKS.map(idOf), `control run: ${control.r.stderr}`);
  const spied = realEffects(CP_SINKS, { ...opts, requireSpy: true });
  assert.equal(spied.r.status, 0, spied.r.stderr);
  assert.deepEqual(spied.effects, []);
});

// ---------- 7. the payload is recorded byte for byte ----------

const PAYLOADS = [
  'a"b\'c',
  'x; touch PWNED',
  '$(id)',
  '`id`',
  'line1\nline2\r\nline3',
  'ünï ✓ 日本語 😀',
  'lone \ud800 surrogate',
  'tab\there \\ back \u0000 nul',
  '',
  '   ',
];
const BUFTEXT = 'h\u00e9llo "q" $(id) `x` \n end';

test('7. payloads are recorded unchanged: quotes, $(), ;, backticks, newline, unicode, Buffers, nested options', () => {
  const src =
    "import { execSync, execFileSync } from 'node:child_process';\n" +
    "import { writeFileSync } from 'node:fs';\n" +
    `const P = ${JSON.stringify(PAYLOADS)};\n` +
    `const B = ${JSON.stringify(BUFTEXT)};\n` +
    'for (const p of P) execSync(p);\n' +
    'for (const p of P) writeFileSync(p, p);\n' +
    "writeFileSync('f1', Buffer.from(B));\n" +
    "writeFileSync('f2', new Uint8Array(Buffer.from(B)));\n" +
    "execFileSync('prog', P, { input: Buffer.from(B), encoding: 'utf8', env: { A: '$(id)' }, mode: 420 });\n";
  const { r } = runSource(src);
  assert.equal(r.status, 0, r.stderr);
  const { records } = parse(r.stdout);
  const n = PAYLOADS.length;
  assert.equal(records.length, 2 * n + 3);
  PAYLOADS.forEach((p, i) => {
    assert.deepEqual(records[i], { sink: 'child_process.execSync', args: [p] });
    assert.deepEqual(records[n + i], { sink: 'fs.writeFileSync', args: [p, p] });
  });
  assert.deepEqual(records[2 * n], { sink: 'fs.writeFileSync', args: ['f1', { buffer: BUFTEXT }] });
  assert.deepEqual(records[2 * n + 1], { sink: 'fs.writeFileSync', args: ['f2', { buffer: BUFTEXT }] });
  assert.deepEqual(records[2 * n + 2], {
    sink: 'child_process.execFileSync',
    args: ['prog', PAYLOADS, { input: { buffer: BUFTEXT }, encoding: 'utf8', env: { A: '$(id)' }, mode: 420 }],
  });
});

test('7b. a record is complete when the probe exits right after the sink (large payload, process.exit)', () => {
  const src =
    "import { execSync } from 'node:child_process';\n" +
    "execSync('x'.repeat(300000));\n" +
    'process.exit(0);\n';
  const { r } = runSource(src);
  assert.equal(r.status, 0, r.stderr);
  const { records } = parse(r.stdout);
  assert.equal(records.length, 1);
  assert.equal(records[0].args[0].length, 300000);
});

// ---------- 8. stubs have the shape target code expects ----------

const SHAPE_OK = [
  'execSync.buffer', 'execSync.encoding', 'execSync.bufferEncoding', 'execFileSync.buffer', 'execFileSync.encoding',
  'spawn.shape', 'spawn.exit-then-close', 'spawn.kill', 'spawn.stdout-iterates', 'spawn.unref',
  'spawnSync', 'exec.callback', 'execFile.callback', 'promisify.exec', 'promisify.execFile',
  'createWriteStream.finish', 'createWriteStream.close', 'createWriteStream.pipeline',
  'fs.writeFile.callback-async', 'fs.mkdir.callback', 'fs.rm.callback', 'fs.rename.callback', 'promisify.writeFile',
  'promisify.write', 'promisify.write.real', 'promisify.writev',
  'fsp.writeFile', 'fsp.appendFile', 'fsp.mkdir', 'fsp.rm', 'fsp.rename',
];

test('8. target keeps running after each recorded sink (stub return shapes)', () => {
  const dir = tmp();
  const out = JSON.stringify(join(dir, 'out'));
  const src = `${MARK_FN}
import { execSync, execFileSync, spawn, spawnSync, exec, execFile } from 'node:child_process';
import { createWriteStream, writeFile, mkdir, rm, rename, openSync, write, writev, promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const OUT = ${out};
const ok = (name, cond) => mark((cond ? 'OK ' : 'BAD ') + name);
const once = (em, ev) => new Promise((r) => em.once(ev, (...a) => r(a)));

ok('execSync.buffer', Buffer.isBuffer(execSync('echo x')) && execSync('echo x').toString() === '');
ok('execSync.encoding', execSync('echo x', { encoding: 'utf8' }).trim() === '');
ok('execSync.bufferEncoding', Buffer.isBuffer(execSync('echo x', { encoding: 'buffer' })));
ok('execFileSync.buffer', execFileSync('prog', ['a']).toString() === '');
ok('execFileSync.encoding', execFileSync('prog', ['a'], { encoding: 'utf8' }) === '');

const c = spawn('prog', ['a']);
c.stdout.on('data', () => {});
c.stderr.on('data', () => {});
c.stdin.write('x');
c.stdin.end();
const order = [];
c.on('exit', (code, sig) => order.push('exit:' + code + ':' + sig));
const closed = once(c, 'close');
ok('spawn.shape', typeof c.pid === 'number' && c.pid > 0 && typeof c.kill === 'function');
ok('spawn.unref', (c.unref(), c.ref(), true));
const [code] = await closed;
ok('spawn.exit-then-close', code === 0 && order.join() === 'exit:0:null');
ok('spawn.kill', c.kill() === true);
const c2 = spawn('prog');
let chunks = 0;
for await (const _ of c2.stdout) chunks++;
ok('spawn.stdout-iterates', chunks === 0);

const s = spawnSync('prog', ['a']);
ok('spawnSync', s.status === 0 && s.signal === null && s.error === undefined && s.pid === 0 &&
  s.stdout.toString() === '' && s.stderr.toString() === '' && s.output.length === 3 && s.output[0] === null);

for (const [name, call] of [['exec', (cb) => exec('echo x', cb)], ['execFile', (cb) => execFile('prog', ['a'], cb)]]) {
  let sync = true;
  let calledSync = false;
  const res = await new Promise((resolve) => {
    const ch = call((err, so, se) => { if (sync) calledSync = true; resolve([err, so, se, ch]); });
    sync = false;
  });
  ok(name + '.callback', res[0] === null && res[1] === '' && res[2] === '' && typeof res[3].on === 'function' && !calledSync);
}
const pe = await promisify(exec)('echo x');
ok('promisify.exec', pe.stdout === '' && pe.stderr === '');
const pf = await promisify(execFile)('prog', ['a']);
ok('promisify.execFile', pf.stdout === '' && pf.stderr === '');

const ws = createWriteStream(OUT + '/w.txt');
const fin = once(ws, 'finish');
const cl = once(ws, 'close');
ws.write('a');
ws.write(Buffer.from('b'));
ws.end('c');
await fin;
ok('createWriteStream.finish', true);
await cl;
ok('createWriteStream.close', true);
await pipeline(Readable.from(['p1', 'p2']), createWriteStream(OUT + '/w2.txt'));
ok('createWriteStream.pipeline', true);

let sync2 = true;
let sc = false;
const e1 = await new Promise((res) => { writeFile(OUT + '/c.txt', 'd', (e) => { if (sync2) sc = true; res(e); }); sync2 = false; });
ok('fs.writeFile.callback-async', e1 === null && !sc);
ok('fs.mkdir.callback', (await new Promise((res) => mkdir(OUT + '/d', { recursive: true }, (e) => res(e)))) === null);
ok('fs.rm.callback', (await new Promise((res) => rm(OUT + '/d', { recursive: true, force: true }, (e) => res(e)))) === null);
ok('fs.rename.callback', (await new Promise((res) => rename(OUT + '/a', OUT + '/b', (e) => res(e)))) === null);
ok('promisify.writeFile', (await promisify(writeFile)(OUT + '/pw.txt', 'd')) === undefined);
// util.promisify(fs.write) resolves { bytesWritten, buffer } on a fake fd and on a real one
const wfd = openSync(OUT + '/pw.bin', 'w');
const pw = await promisify(write)(wfd, 'abc');
ok('promisify.write', pw.bytesWritten === 3 && pw.buffer === 'abc');
const prw = await promisify(write)(1, 'REAL_PW\\n');
ok('promisify.write.real', prw.bytesWritten === 8 && prw.buffer === 'REAL_PW\\n');
const pv = await promisify(writev)(wfd, [Buffer.from('v1'), Buffer.from('v2')]);
ok('promisify.writev', pv.bytesWritten === 4 && pv.buffers.length === 2);

ok('fsp.writeFile', (await fsp.writeFile(OUT + '/p.txt', 'd')) === undefined);
ok('fsp.appendFile', (await fsp.appendFile(OUT + '/p.txt', 'd')) === undefined);
ok('fsp.mkdir', (await fsp.mkdir(OUT + '/pd', { recursive: true })) === undefined);
ok('fsp.rm', (await fsp.rm(OUT + '/pd', { recursive: true, force: true })) === undefined);
ok('fsp.rename', (await fsp.rename(OUT + '/p.txt', OUT + '/q.txt')) === undefined);
mark('DONE');
`;
  const { r } = runSource(src, { dir });
  const { marks, records } = parse(r.stdout);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(marks.filter((m) => m.startsWith('BAD ')), []);
  const oks = marks.filter((m) => m.startsWith('OK ')).map((m) => m.slice(3));
  assert.deepEqual(SHAPE_OK.filter((n) => !oks.includes(n)), []);
  assert.ok(marks.includes('DONE'));
  // the stream writes are recorded one chunk per record: a, b, c
  const chunks = records.filter((x) => x.sink === 'fs.createWriteStream.write' && x.args[0].endsWith('w.txt'));
  assert.deepEqual(chunks.map((x) => x.args[1]), ['a', { buffer: 'b' }, 'c']);
  assert.ok(records.some((x) => x.sink === 'fs.createWriteStream' && x.args[0].endsWith('w.txt')));
});

// ---------- 9. loading the spy needs read access only ----------

test('9. spy loads under --permission with read access only (no child process, write or worker)', () => {
  const { r } = runSource("console.log('PROBE_RAN');\n");
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.equal(p.ready, 1);
  assert.ok(p.lines.includes('PROBE_RAN'));
});

// ---------- 10. a missing spy fails closed ----------

test('10. missing spy file: node exits non-zero and the probe never runs', () => {
  const dir = tmp();
  const missing = join(dir, 'no-such-spy.mjs');
  const { r } = runSource("console.log('PROBE_RAN');\n", { dir, spy: missing });
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes('PROBE_RAN'), r.stdout);
  assert.equal(parse(r.stdout).ready, 0);
});

// ---------- 11 and 12. output contract ----------

test('11. SINK_SPY_READY prints exactly once, before any record', () => {
  const src =
    "import { execSync } from 'node:child_process';\n" +
    "import { writeFileSync } from 'node:fs';\n" +
    "execSync('echo a');\nwriteFileSync('f', 'b');\nexecSync('echo c');\n";
  const { r } = runSource(src);
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.equal(p.ready, 1);
  assert.equal(p.lines[0], 'SINK_SPY_READY');
  assert.equal(p.records.length, 3);
});

test('12. records and READY go to stdout, never stderr', () => {
  const src = "import { execSync } from 'node:child_process';\nexecSync('echo a');\n";
  const { r } = runSource(src);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parse(r.stdout).records.length, 1);
  assert.ok(!/SINK_SPY/.test(r.stderr), r.stderr);
});

// ---------- 13. the fixture shape ----------

test('13. path traversal and injected command are recorded unchanged (reports-style target)', () => {
  const dir = tmp();
  writeFileSync(
    join(dir, 'reports.mjs'),
    [
      "import { join, resolve } from 'node:path';",
      "import { writeFileSync } from 'node:fs';",
      "import { execSync } from 'node:child_process';",
      "const BASE = resolve('out-reports');",
      'export function reportPath(name) { return join(BASE, name); }',
      'export function saveReport(name, text) { writeFileSync(reportPath(name), text); }',
      'export function archiveCommand(folder) { return `tar -czf archive.tgz ${folder}`; }',
      'export function archive(folder) { return execSync(archiveCommand(folder)); }',
      '',
    ].join('\n'),
  );
  const src =
    MARK_FN +
    "import { saveReport, archive } from './reports.mjs';\n" +
    "mark('CWD ' + process.cwd());\n" +
    "saveReport('../../escaped.txt', 'x');\n" +
    "const a = archive('r; touch PWNED');\n" +
    "const b = archive('$(id)');\n" +
    "mark('RETURNED ' + (a.toString() === '' && b.toString() === ''));\n";
  const { r } = runSource(src, { dir });
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  const cwd = p.marks.find((m) => m.startsWith('CWD ')).slice(4);
  const traversal = join(resolve(cwd, 'out-reports'), '../../escaped.txt');
  assert.ok(!traversal.startsWith(resolve(cwd, 'out-reports') + sep), 'fixture must escape its base');
  assert.deepEqual(p.records, [
    { sink: 'fs.writeFileSync', args: [traversal, 'x'] },
    { sink: 'child_process.execSync', args: ['tar -czf archive.tgz r; touch PWNED'] },
    { sink: 'child_process.execSync', args: ['tar -czf archive.tgz $(id)'] },
  ]);
  assert.ok(p.marks.includes('RETURNED true'));
  assert.ok(!existsSync(join(dir, 'PWNED')));
  assert.ok(!existsSync(resolve(cwd, 'out-reports', '../../escaped.txt')));
});

test('14. aegis and the refuter use the same probe run form, and it loads the spy', () => {
  const root = resolve(HERE, '..', '..', '..');
  const formOf = (f) => {
    const text = readFileSync(join(root, f), 'utf8');
    const m = text.match(/timeout 15 env -i [^\n]*?--require "[^"]+"/);
    assert.ok(m, `${f}: no probe run form with --require`);
    return m[0];
  };
  const aegis = formOf('.claude/agents/aegis.md');
  assert.equal(formOf('.claude/agents/security-refuter.md'), aegis, 'run forms differ');
  assert.equal((aegis.match(/--allow-fs-read=/g) || []).length, 2, 'spy path needs its own --allow-fs-read');
  assert.match(aegis, /--require "\$\{SINK_SPY:-\$HOME\/\.claude\/scripts\/security\/sink-spy\.mjs\}"/);
});

// ---------- 15-22. fork, file descriptors and open ----------

// A fake descriptor is above 2**30 (the header of sink-spy.mjs says so); a real one is small.
const FAKE_FD_MIN = 2 ** 30;

// A probe in a fresh temp dir. `body` gets MARK_FN, P (a path in out/) and the dir as D.
function fdProbe(body, name = 'f') {
  const dir = tmp();
  const P = join(dir, 'out', name);
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, `${MARK_FN}const P = ${JSON.stringify(P)};\nconst D = ${JSON.stringify(dir)};\n${body}`);
  return { dir, P, file };
}
const marksOf = (r) => parse(r.stdout).marks;

test('15. read-only open (r, rs, no flag, O_RDONLY) is not recorded: real fd, real bytes (fs, callback and fs/promises)', () => {
  const dir = tmp();
  const input = join(dir, 'in.txt');
  writeFileSync(input, 'real-bytes');
  const src =
    `${MARK_FN}import { openSync, open, readSync, closeSync, constants } from 'node:fs';
import { open as fspOpen } from 'node:fs/promises';
import { promisify } from 'node:util';
const F = ${JSON.stringify(input)};
const slurp = (fd) => { const b = Buffer.alloc(32); return b.toString('utf8', 0, readSync(fd, b, 0, 32, 0)); };
const popen = promisify(open);
const fds = [
  ['openSync.r', openSync(F, 'r')], ['openSync.default', openSync(F)], ['openSync.rs', openSync(F, 'rs')],
  ['openSync.O_RDONLY', openSync(F, constants.O_RDONLY)], ['open.r', await popen(F, 'r')], ['open.noflags', await popen(F)],
];
const afterClose = [];
for (const [name, fd] of fds) {
  mark(name + ' real=' + (fd < ${FAKE_FD_MIN}) + ' ' + slurp(fd));
  closeSync(fd);
  try { slurp(fd); afterClose.push('read-ok'); } catch (e) { afterClose.push(e.code); } // a real close really closed it
}
mark('AFTER_CLOSE ' + afterClose.join());
for (const flags of [undefined, 'r', constants.O_RDONLY]) {
  const fh = await fspOpen(F, flags);
  mark('fsp.open real=' + (fh.fd < ${FAKE_FD_MIN}) + ' ' + (await fh.readFile('utf8')));
  await fh.close();
}
`;
  const { r } = runSource(src, { dir });
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.records, []);
  assert.deepEqual(p.marks, [
    'openSync.r real=true real-bytes', 'openSync.default real=true real-bytes', 'openSync.rs real=true real-bytes',
    'openSync.O_RDONLY real=true real-bytes', 'open.r real=true real-bytes', 'open.noflags real=true real-bytes',
    'AFTER_CLOSE ' + Array(6).fill('EBADF').join(),
    ...Array(3).fill('fsp.open real=true real-bytes'),
  ]);
});

test('15b. close, ftruncate, fsync and fdatasync on a real fd go to the real function (same outcome as a run without the spy)', () => {
  const body = `import { ftruncateSync, fsyncSync, fdatasyncSync, closeSync } from 'node:fs';
const t = (name, f) => { try { f(); mark(name + ' ok'); } catch (e) { mark(name + ' ' + e.code); } };
t('ftruncate', () => ftruncateSync(1, 0)); // fd 1 is a pipe: the real call fails
t('fsync', () => fsyncSync(1));
t('fdatasync', () => fdatasyncSync(1));
t('close', () => closeSync(999)); // no such fd: the real call fails with EBADF
`;
  const c = fdProbe(body);
  const control = run(c.dir, c.file, { permission: false, requireSpy: false });
  const s = fdProbe(body);
  const spied = run(s.dir, s.file, { permission: false });
  assert.equal(spied.status, 0, spied.stderr);
  const want = marksOf(control);
  assert.ok(want.some((m) => m.startsWith('ftruncate ') && !m.endsWith(' ok')), `control: ${want}`);
  assert.ok(want.includes('close EBADF'), `control: ${want}`);
  assert.deepEqual(marksOf(spied), want);
  assert.deepEqual(parse(spied.stdout).records, []);
});

const STR_FLAGS = ['w', 'wx', 'w+', 'wx+', 'a', 'ax', 'a+', 'ax+', 'as', 'r+', 'rs+'];

test('16. open with a string write flag (w, a, x, +) is recorded with path, flags and mode; no file appears; control run creates it', () => {
  const make = () => {
    const dir = tmp();
    const paths = STR_FLAGS.map((_f, i) => join(dir, 'out', `s${i}`));
    const file = join(dir, 'probe.mjs');
    writeFileSync(
      file,
      `${MARK_FN}import { openSync } from 'node:fs';
const P = ${JSON.stringify(paths)};
${JSON.stringify(STR_FLAGS)}.forEach((f, i) => { try { openSync(P[i], f, 0o600); } catch (e) { mark('THROW ' + f + ' ' + e.code); } });
`,
    );
    return { dir, paths, file };
  };
  const c = make();
  run(c.dir, c.file, { permission: false, requireSpy: false });
  // r+ and rs+ need an existing file, so only the other flags create one
  assert.deepEqual(STR_FLAGS.filter((_f, i) => existsSync(c.paths[i])), STR_FLAGS.filter((f) => !f.startsWith('r')));
  const s = make();
  const r = run(s.dir, s.file, { permission: false });
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks, []);
  assert.deepEqual(p.records, STR_FLAGS.map((f, i) => ({ sink: 'fs.openSync', args: [s.paths[i], f, 0o600] })));
  assert.deepEqual(s.paths.filter(existsSync), []);
});

const NUM_FLAGS = ['O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_APPEND', 'O_TRUNC', 'O_WRONLY|O_CREAT', 'O_RDWR|O_CREAT|O_EXCL'];

test('17. open with a numeric write flag (O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC) is recorded; no file appears', () => {
  const make = () => {
    const dir = tmp();
    const paths = NUM_FLAGS.map((_f, i) => join(dir, 'out', `n${i}`));
    const file = join(dir, 'probe.mjs');
    writeFileSync(
      file,
      `${MARK_FN}import { openSync, constants } from 'node:fs';
const P = ${JSON.stringify(paths)};
${JSON.stringify(NUM_FLAGS)}.forEach((expr, i) => {
  const flags = expr.split('|').reduce((a, n) => a | constants[n], 0);
  mark('FLAGS ' + flags);
  try { openSync(P[i], flags); } catch (e) { mark('THROW ' + expr + ' ' + e.code); }
});
`,
    );
    return { dir, paths, file };
  };
  const c = make();
  run(c.dir, c.file, { permission: false, requireSpy: false });
  assert.deepEqual(NUM_FLAGS.filter((_f, i) => existsSync(c.paths[i])), NUM_FLAGS.filter((f) => f.includes('O_CREAT')));
  const s = make();
  const r = run(s.dir, s.file, { permission: false });
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks.filter((m) => m.startsWith('THROW')), []);
  const flags = p.marks.filter((m) => m.startsWith('FLAGS ')).map((m) => Number(m.slice(6)));
  assert.equal(flags.length, NUM_FLAGS.length);
  assert.ok(flags.every((f) => f > 0), 'the probe built nonzero numeric flags');
  assert.deepEqual(p.records, s.paths.map((path, i) => ({ sink: 'fs.openSync', args: [path, flags[i]] })));
  assert.deepEqual(s.paths.filter(existsSync), []);
});

test('18. writeSync and writevSync on a fake fd record path and data; the same calls on a real fd print and are not recorded', () => {
  const { P, dir, file } = fdProbe(`import { openSync, closeSync, fsyncSync, ftruncateSync, writevSync } from 'node:fs'; // writeSync comes from MARK_FN
const fd = openSync(P, 'w');
mark('FAKE ' + (fd >= ${FAKE_FD_MIN}));
mark('BYTES ' + writeSync(fd, 'abc'));
writeSync(fd, Buffer.from('xyz'));
writeSync(fd, Buffer.from('0123456789'), 2, 3);
writeSync(fd, new Uint8Array(Buffer.from('uvwxyz')), { offset: 1, length: 2 });
mark('WRITEV ' + writevSync(fd, [Buffer.from('v1'), new Uint8Array(Buffer.from('v2'))]));
ftruncateSync(fd, 1);
fsyncSync(fd);
closeSync(fd);
writeSync(1, 'REAL_FD_LINE\\n');
mark('REAL_WRITEV ' + writevSync(1, [Buffer.from('REAL_WRITEV_'), Buffer.from('LINE\\n')]));
try { writeSync(fd, 'late'); mark('LATE no-throw'); } catch (e) { mark('LATE throw'); }
`);
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks, ['FAKE true', 'BYTES 3', 'WRITEV 4', 'REAL_WRITEV 17', 'LATE throw']); // after close the fd is dead, so the write is not recorded
  assert.ok(p.lines.includes('REAL_FD_LINE'), 'writeSync(1) must reach the real stdout');
  assert.ok(p.lines.includes('REAL_WRITEV_LINE'), 'writevSync(1) must reach the real stdout');
  // exact list: a real-fd write, or the spy's own output, must not add a record
  assert.deepEqual(p.records, [
    { sink: 'fs.openSync', args: [P, 'w'] },
    { sink: 'fs.writeSync', args: [P, 'abc'] },
    { sink: 'fs.writeSync', args: [P, { buffer: 'xyz' }] },
    { sink: 'fs.writeSync', args: [P, { buffer: '234' }] },
    { sink: 'fs.writeSync', args: [P, { buffer: 'vw' }] },
    { sink: 'fs.writevSync', args: [P, { buffer: 'v1' }] },
    { sink: 'fs.writevSync', args: [P, { buffer: 'v2' }] },
    { sink: 'fs.ftruncateSync', args: [P, 1] },
  ]);
  assert.ok(!existsSync(P));
});

test('19. callback fs.write, ftruncate, fsync and close on a fake fd record and call back; fs.write on a real fd prints', () => {
  const { P, dir, file } = fdProbe(`import { open, write, writev, close, fsync, ftruncate, constants } from 'node:fs';
const cb = (fn, ...a) => new Promise((res) => fn(...a, (...r) => res(r)));
const [oe, fd] = await cb(open, P, 'a');
const [we, n, data] = await cb(write, fd, 'hello');
const [be] = await cb(write, fd, Buffer.from('buf'), 0, 3, null);
const [ve, vn, vbufs] = await cb(writev, fd, [Buffer.from('w1'), Buffer.from('w2')]);
const [te] = await cb(ftruncate, fd, 2);
const [se] = await cb(fsync, fd);
const [ce] = await cb(close, fd);
const [re] = await cb(write, 1, 'REAL_ASYNC_LINE\\n');
mark([oe, we, n, data, be, te, se, ce, re].join(','));
mark('WRITEV ' + [ve, vn, vbufs.length].join(','));
const [oe2, fd2] = await cb(open, P, constants.O_APPEND); // numeric write flag, callback form
mark('OPEN_NUM ' + oe2 + ' ' + (fd2 >= ${FAKE_FD_MIN}));
await cb(close, fd2);
`);
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  // every err is null, bytes written is 5, writev wrote 4 bytes in 2 buffers
  assert.deepEqual(p.marks, [',,5,hello,,,,,', 'WRITEV ,4,2', 'OPEN_NUM null true']);
  assert.ok(p.lines.includes('REAL_ASYNC_LINE'));
  assert.deepEqual(p.records, [
    { sink: 'fs.open', args: [P, 'a'] },
    { sink: 'fs.write', args: [P, 'hello'] },
    { sink: 'fs.write', args: [P, { buffer: 'buf' }] },
    { sink: 'fs.writev', args: [P, { buffer: 'w1' }] },
    { sink: 'fs.writev', args: [P, { buffer: 'w2' }] },
    { sink: 'fs.ftruncate', args: [P, 2] },
    { sink: 'fs.open', args: [P, FSC.O_APPEND] },
  ]);
  assert.ok(!existsSync(P));
});

test('20. fs/promises.open with a write flag gives a FileHandle whose write methods record; no file appears; control run creates it', () => {
  const body = `import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
const fh = await open(P, 'w');
mark('FAKE ' + (fh.fd >= ${FAKE_FD_MIN}));
const w = await fh.write('abc');
mark('WRITE ' + w.bytesWritten + ' ' + w.buffer);
await fh.write(Buffer.from('0123456789'), 2, 3);
await fh.writeFile('whole');
await fh.appendFile(Buffer.from('app'));
await fh.truncate(1);
await fh.sync();
await fh.close();
// a read-write flag and a numeric write flag are write opens too
const fh2 = await open(P, 'rs+');
mark('FAKE_RS ' + (fh2.fd >= ${FAKE_FD_MIN}));
await fh2.close();
const fh3 = await open(P, constants.O_WRONLY | constants.O_CREAT);
mark('FAKE_NUM ' + (fh3.fd >= ${FAKE_FD_MIN}));
await fh3.close();
`;
  const c = fdProbe(body);
  run(c.dir, c.file, { permission: false, requireSpy: false });
  assert.ok(existsSync(c.P), 'control run must create the file');
  const { P, dir, file } = fdProbe(body);
  const r = run(dir, file, { permission: false });
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks, ['FAKE true', 'WRITE 3 abc', 'FAKE_RS true', 'FAKE_NUM true']);
  assert.deepEqual(p.records, [
    { sink: 'fs/promises.open', args: [P, 'w'] },
    { sink: 'fs/promises.FileHandle.write', args: [P, 'abc'] },
    { sink: 'fs/promises.FileHandle.write', args: [P, { buffer: '234' }] },
    { sink: 'fs/promises.FileHandle.writeFile', args: [P, 'whole'] },
    { sink: 'fs/promises.FileHandle.appendFile', args: [P, { buffer: 'app' }] },
    { sink: 'fs/promises.FileHandle.truncate', args: [P, 1] },
    { sink: 'fs/promises.open', args: [P, 'rs+'] },
    { sink: 'fs/promises.open', args: [P, FSC.O_WRONLY | FSC.O_CREAT] },
  ]);
  assert.ok(!existsSync(P));
});

test('21. fork records module and args; the stub has exit, close, send, disconnect and connected=false', () => {
  const { dir, file } = fdProbe(`import { fork } from 'node:child_process';
const c = fork('child.js', ['--x'], { silent: true });
const exited = new Promise((res) => c.on('exit', (code, sig) => res(code + ':' + sig)));
mark('STATE connected=' + c.connected + ' pid=' + (c.pid > 0));
mark('SEND ' + c.send({ a: 1 }));
mark('SENDCB ' + (await new Promise((res) => c.send({ b: 1 }, (e) => res(e)))));
c.disconnect();
mark('EXIT ' + (await exited));
`);
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks, ['STATE connected=false pid=true', 'SEND true', 'SENDCB null', 'EXIT 0:null']);
  assert.deepEqual(p.records, [{ sink: 'child_process.fork', args: ['child.js', ['--x'], { silent: true }] }]);
});

test('22. the new fs stubs keep the target running: callbacks fire async with null, promises resolve undefined, sync calls return undefined', () => {
  const { dir, file } = fdProbe(`import * as fs from 'node:fs';
const A = D + '/out/a';
const B = D + '/out/b';
const ok = (name, cond) => mark((cond ? 'OK ' : 'BAD ') + name);
const calls = {
  unlink: (cb) => fs.unlink(A, cb), rmdir: (cb) => fs.rmdir(A, cb), copyFile: (cb) => fs.copyFile(A, B, cb),
  cp: (cb) => fs.cp(A, B, cb), truncate: (cb) => fs.truncate(A, 0, cb), symlink: (cb) => fs.symlink(A, B, 'junction', cb),
  link: (cb) => fs.link(A, B, cb),
};
for (const [name, call] of Object.entries(calls)) {
  let sync = true;
  let early = false;
  const err = await new Promise((res) => { call((e) => { if (sync) early = true; res(e); }); sync = false; });
  ok('cb.' + name, err === null && !early);
}
const sync = {
  unlinkSync: () => fs.unlinkSync(A), rmdirSync: () => fs.rmdirSync(A), copyFileSync: () => fs.copyFileSync(A, B), cpSync: () => fs.cpSync(A, B),
  truncateSync: () => fs.truncateSync(A, 0), symlinkSync: () => fs.symlinkSync(A, B, 'junction'), linkSync: () => fs.linkSync(A, B),
  closeSync: () => fs.closeSync(fs.openSync(A, 'w')),
};
for (const [name, call] of Object.entries(sync)) ok(name, call() === undefined);
const prom = {
  unlink: () => fs.promises.unlink(A), rmdir: () => fs.promises.rmdir(A), copyFile: () => fs.promises.copyFile(A, B),
  cp: () => fs.promises.cp(A, B), truncate: () => fs.promises.truncate(A, 0), symlink: () => fs.promises.symlink(A, B, 'junction'),
  link: () => fs.promises.link(A, B),
};
for (const [name, call] of Object.entries(prom)) ok('fsp.' + name, (await call()) === undefined);
const fd = await new Promise((res) => fs.open(A, 'w', (e, f) => res(e === null ? f : e)));
ok('open.cb', typeof fd === 'number' && fd >= ${FAKE_FD_MIN});
`);
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  const m = marksOf(r);
  assert.equal(m.length, 7 + 8 + 7 + 1);
  assert.deepEqual(m.filter((x) => !x.startsWith('OK ')), []);
});

test('23. writeFile and appendFile on a fake fd or a stub FileHandle record the path, not the fd number', () => {
  const { P, dir, file } = fdProbe(`import { openSync, writeFileSync, appendFileSync, writeFile, appendFile, promises as fsp } from 'node:fs';
const cb = (fn, ...a) => new Promise((res) => fn(...a, (...r) => res(r)));
const fd = openSync(P, 'w');
writeFileSync(fd, 'a');
appendFileSync(fd, Buffer.from('b'));
await cb(writeFile, fd, 'c');
await cb(appendFile, fd, 'd');
const fh = await fsp.open(P, 'w');
await fsp.writeFile(fh, 'e');
await fsp.appendFile(fh, 'f');
`);
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.stdout).records, [
    { sink: 'fs.openSync', args: [P, 'w'] },
    { sink: 'fs.writeFileSync', args: [P, 'a'] },
    { sink: 'fs.appendFileSync', args: [P, { buffer: 'b' }] },
    { sink: 'fs.writeFile', args: [P, 'c'] },
    { sink: 'fs.appendFile', args: [P, 'd'] },
    { sink: 'fs/promises.open', args: [P, 'w'] },
    { sink: 'fs/promises.writeFile', args: [P, 'e'] },
    { sink: 'fs/promises.appendFile', args: [P, 'f'] },
  ]);
});

test('24. a w+ / r+ target can read back from its fake fd (read, readSync, fstat, FileHandle read, readFile, stat, writev); a real fd still reads for real', () => {
  const { P, dir, file } = fdProbe(`import { openSync, readSync, read, fstatSync, fstat, promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
const F = D + '/in.txt';
const cb = (fn, ...a) => new Promise((res) => fn(...a, (...r) => res(r)));
const fd = openSync(P, 'w+');
const b = Buffer.alloc(8);
mark('READSYNC ' + readSync(fd, b, 0, 8, 0));
const [re, rn, rb] = await cb(read, fd, b, 0, 8, 0);
mark('READ ' + [re, rn, rb === b].join());
const pr = await promisify(read)(fd, b, 0, 8, 0);
mark('PROMISIFY_READ ' + pr.bytesRead + ' ' + (pr.buffer === b));
mark('FSTATSYNC ' + fstatSync(fd).size + ' ' + fstatSync(fd).isFile());
const [se, st] = await cb(fstat, fd);
mark('FSTAT ' + [se, st.size].join());
const fh = await fsp.open(P, 'w+');
const hr = await fh.read(b, 0, 8, 0);
mark('FH_READ ' + hr.bytesRead + ' ' + (hr.buffer === b));
mark('FH_READFILE ' + JSON.stringify(await fh.readFile('utf8')) + ' ' + Buffer.isBuffer(await fh.readFile()));
mark('FH_STAT ' + (await fh.stat()).size);
const wv = await fh.writev([Buffer.from('v1'), Buffer.from('v2')]);
mark('FH_WRITEV ' + wv.bytesWritten + ' ' + wv.buffers.length);
const real = openSync(F, 'r');
mark('REAL ' + fstatSync(real).size + ' ' + readSync(real, b, 0, 8, 0) + ' ' + b.toString('utf8', 0, 8));
`);
  writeFileSync(join(dir, 'in.txt'), 'real-bytes');
  const r = run(dir, file);
  assert.equal(r.status, 0, r.stderr);
  const p = parse(r.stdout);
  assert.deepEqual(p.marks, [
    'READSYNC 0', 'READ ,0,true', 'PROMISIFY_READ 0 true', 'FSTATSYNC 0 true', 'FSTAT ,0',
    'FH_READ 0 true', 'FH_READFILE "" true', 'FH_STAT 0', 'FH_WRITEV 4 2', 'REAL 10 8 real-byt',
  ]);
  assert.deepEqual(p.records, [
    { sink: 'fs.openSync', args: [P, 'w+'] },
    { sink: 'fs/promises.open', args: [P, 'w+'] },
    { sink: 'fs/promises.FileHandle.writev', args: [P, { buffer: 'v1' }] },
    { sink: 'fs/promises.FileHandle.writev', args: [P, { buffer: 'v2' }] },
  ]);
});
