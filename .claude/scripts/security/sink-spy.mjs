// Sink spy: a preload for /security replay probes.
//
// Run form:  node --permission --allow-fs-read=... --require <this file> <probe>
//
// It replaces the child_process and fs write functions with recorders. The probe
// calls the real target function. The recorder prints one line to stdout and
// returns a stub, so nothing runs and nothing is written.
//
// Output contract:
//   SINK_SPY_READY                         once, after every patch succeeded
//   SINK_SPY {"sink":"<mod>.<fn>","args":[...]}   one line per recorded call
// args are in call order. Functions are omitted. Strings are verbatim.
// Buffers and typed arrays become {"buffer":"<utf8 text>"}.
// A write stream also records each chunk as sink "fs.createWriteStream.write",
// with args [path, chunk].
//
// Fail closed: any patch problem throws, so node exits non-zero before the probe runs.
// Needs read access only: no child process, no file write, no worker.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { writeSync } from 'node:fs';
import * as cpNs from 'node:child_process';
import * as fsNs from 'node:fs';
import * as fspNs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const writeFd = writeSync; // keep our own reference; a target cannot swap it out
const STUB_PID = 2147483646; // truthy, and no real process has it
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// ---------- output ----------

function writeAll(text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  let spins = 0;
  while (off < buf.length) {
    try {
      off += writeFd(1, buf, off, buf.length - off);
      spins = 0;
    } catch (e) {
      if (e.code !== 'EAGAIN' || ++spins > 5000) throw e;
      Atomics.wait(sleepCell, 0, 0, 2); // pipe full: wait 2 ms, retry
    }
  }
}

function ser(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === undefined) return null;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return String(v);
  if (ArrayBuffer.isView(v)) return { buffer: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8') };
  if (v instanceof ArrayBuffer) return { buffer: Buffer.from(v).toString('utf8') };
  if (v instanceof URL) return v.href;
  if (seen.has(v)) return '[Circular]';
  seen.add(v);
  let out;
  if (Array.isArray(v)) out = v.filter((x) => typeof x !== 'function').map((x) => ser(x, seen));
  else {
    out = {};
    for (const k of Object.keys(v)) if (typeof v[k] !== 'function') out[k] = ser(v[k], seen);
  }
  seen.delete(v);
  return out;
}

function record(sink, args) {
  const shown = args.filter((a) => typeof a !== 'function').map((a) => ser(a));
  writeAll('SINK_SPY ' + JSON.stringify({ sink, args: shown }) + '\n');
}

// ---------- stubs ----------

const lastFn = (args) => [...args].reverse().find((a) => typeof a === 'function');
const isPlain = (a) => a !== null && typeof a === 'object' && !Array.isArray(a) && !ArrayBuffer.isView(a);
function encodingOf(args) {
  const opts = [...args].reverse().find(isPlain);
  const enc = typeof opts?.encoding === 'string' ? opts.encoding : null;
  return enc && enc !== 'buffer' ? enc : null;
}
const emptyOut = (args) => (encodingOf(args) ? '' : Buffer.alloc(0));
// exec and execFile callbacks get strings unless the options ask for 'buffer'
const callbackOut = (args) => ([...args].reverse().find(isPlain)?.encoding === 'buffer' ? Buffer.alloc(0) : '');

function stubChild(afterClose) {
  const c = new EventEmitter();
  c.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  c.stdout = new Readable({ read() {} });
  c.stderr = new Readable({ read() {} });
  c.stdout.push(null);
  c.stderr.push(null);
  c.stdio = [c.stdin, c.stdout, c.stderr];
  Object.assign(c, { pid: STUB_PID, killed: false, connected: false, exitCode: null, signalCode: null });
  c.kill = () => {
    c.killed = true;
    return true;
  };
  c.ref = () => {};
  c.unref = () => {};
  setImmediate(() => {
    c.emit('spawn');
    c.exitCode = 0;
    c.emit('exit', 0, null);
    c.emit('close', 0, null);
    afterClose?.();
  });
  return c;
}

// ---------- recorders ----------

const makers = {
  // child_process
  execSync: (sink) => (...a) => (record(sink, a), emptyOut(a)),
  execFileSync: (sink) => (...a) => (record(sink, a), emptyOut(a)),
  spawnSync: (sink) => (...a) => {
    record(sink, a);
    const stdout = emptyOut(a);
    const stderr = emptyOut(a);
    return { pid: 0, status: 0, signal: null, output: [null, stdout, stderr], stdout, stderr };
  },
  spawn: (sink) => (...a) => (record(sink, a), stubChild()),
  exec: (sink) => withCallback(sink),
  execFile: (sink) => withCallback(sink),
};

function withCallback(sink) {
  const fn = (...a) => {
    record(sink, a);
    const cb = lastFn(a);
    const out = callbackOut(a);
    return stubChild(cb ? () => cb(null, out, out) : undefined);
  };
  // util.promisify(exec) must resolve {stdout, stderr}, as the real one does
  fn[promisify.custom] = (...a) => {
    let child;
    const p = new Promise((resolve) => {
      child = fn(...a, (err, stdout, stderr) => resolve({ stdout, stderr }));
    });
    p.child = child;
    return p;
  };
  return fn;
}

const fsCallbackForm = (sink) => (...a) => {
  record(sink, a);
  const cb = lastFn(a);
  if (cb) setImmediate(() => cb(null));
};
const fsSyncForm = (sink) => (...a) => {
  record(sink, a);
};
const fspForm = (sink) => async (...a) => {
  record(sink, a);
};

function createWriteStreamForm(sink) {
  return (...a) => {
    record(sink, a);
    const path = ser(a[0]);
    const ws = new Writable({
      decodeStrings: false, // keep a string chunk a string
      write(chunk, _enc, cb) {
        record(sink + '.write', [path, chunk]);
        ws.bytesWritten += Buffer.byteLength(chunk);
        cb();
      },
    });
    ws.path = path;
    ws.bytesWritten = 0;
    ws.close = (cb) => {
      if (cb) ws.once('close', cb);
      ws.end();
    };
    setImmediate(() => {
      ws.emit('open', -1);
      ws.emit('ready');
    });
    return ws;
  };
}

// ---------- patching ----------

function patch(obj, modName, name, make) {
  if (typeof obj[name] !== 'function') throw new Error(`sink-spy: ${modName}.${name} is not a function`);
  obj[name] = make(`${modName}.${name}`);
}

for (const n of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  patch(cp, 'child_process', n, makers[n]);
}
for (const n of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename']) patch(fs, 'fs', n, fsCallbackForm);
for (const n of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync']) patch(fs, 'fs', n, fsSyncForm);
patch(fs, 'fs', 'createWriteStream', createWriteStreamForm);

// fs.promises and require('fs/promises') are one object; patch whichever objects exist.
for (const target of new Set([fsp, fs.promises])) {
  for (const n of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename']) patch(target, 'fs/promises', n, fspForm);
}

syncBuiltinESMExports();

// Self-check: ESM views of the builtins must now see the recorders.
const unpatched = [
  ['child_process', cpNs, cp, ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']],
  ['fs', fsNs, fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'renameSync']],
  ['fs/promises', fspNs, fsp, ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename']],
].flatMap(([mod, ns, cjs, names]) => names.filter((n) => ns[n] !== cjs[n]).map((n) => `${mod}.${n}`));
if (unpatched.length > 0) throw new Error('sink-spy: ESM exports not synced: ' + unpatched.join(', '));
if (fsNs.promises.writeFile !== fspNs.writeFile) throw new Error('sink-spy: fs.promises is not patched');

writeAll('SINK_SPY_READY\n');
