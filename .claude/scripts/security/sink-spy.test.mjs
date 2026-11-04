// End-to-end tests for sink-spy.mjs. Every test spawns node with the same flags
// the /security probe run form uses, so the spy is tested the way it is used.
//   node --test .claude/scripts/security/sink-spy.test.mjs
// SINK_SPY overrides the spy path (same override as the run form).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, readFileSync } from 'node:fs';
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
const SINKS = [
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
const CP_SINKS = SINKS.filter(([m]) => m === 'child_process');
const FS_SINKS = SINKS.filter(([m]) => m !== 'child_process');
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
    const args = tpl.replace(/\b(CMD|PROG|ARGS|P2|P|DATA)\b/g, (w) => JSON.stringify(ctx[w]));
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
  return { CMD: 'echo hello', PROG: 'prog', ARGS: ['a b', '--c'], P, P2: `${P}.moved`, DATA: 'data' };
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

function effectOf(id, ctx) {
  const name = id.split('.')[1];
  if (name.startsWith('rm')) return !existsSync(ctx.P);
  if (name.startsWith('rename')) return existsSync(ctx.P2);
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

const seedFs = (id, ctx) => {
  if (/\.(rm|rename)/.test(id)) writeFileSync(ctx.P, 'seed');
};

test('5. no real file write, mkdir, rm or rename happens (fs and fs/promises)', () => {
  const opts = { ctxOf: ctxFor, seed: seedFs, wait: 300 };
  // control: without the spy, every sink must have a real effect, or the test proves nothing
  const control = realEffects(FS_SINKS, { ...opts, requireSpy: false });
  assert.deepEqual(control.effects, FS_SINKS.map(idOf), `control run: ${control.r.stderr}`);
  const spied = realEffects(FS_SINKS, { ...opts, requireSpy: true });
  assert.equal(spied.r.status, 0, spied.r.stderr);
  assert.deepEqual(spied.effects, []);
});

function cpCtx(dir, id) {
  const marker = join(dir, `marker-${SAFE(id)}`);
  const script = join(dir, 'marker.cjs');
  writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'x');\n");
  return {
    CMD: `"${process.execPath}" "${script}" "${marker}"`,
    PROG: process.execPath,
    ARGS: [script, marker],
    P: marker,
  };
}

test('6. no real child process runs (exec, execSync, execFile, execFileSync, spawn, spawnSync)', () => {
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
  'fsp.writeFile', 'fsp.appendFile', 'fsp.mkdir', 'fsp.rm', 'fsp.rename',
];

test('8. target keeps running after each recorded sink (stub return shapes)', () => {
  const dir = tmp();
  const out = JSON.stringify(join(dir, 'out'));
  const src = `${MARK_FN}
import { execSync, execFileSync, spawn, spawnSync, exec, execFile } from 'node:child_process';
import { createWriteStream, writeFile, mkdir, rm, rename, promises as fsp } from 'node:fs';
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
