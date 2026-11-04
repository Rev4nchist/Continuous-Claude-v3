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
// fs.open / openSync / fs/promises.open with a write flag (w, a, x, + or a numeric flag with
// O_WRONLY, O_RDWR, O_CREAT, O_APPEND or O_TRUNC) is recorded, args [path, flags, mode?]. It returns
// a fake fd (above 2**30) or a stub FileHandle. A write, writev or FileHandle method on it records
// [path, data] (sinks fs.write, fs.writeSync, fs.writev, fs/promises.FileHandle.write ...), one record
// per buffer for writev. ftruncate records [path, length]. writeFile and appendFile record the path
// in place of a fake fd or a stub FileHandle. close and fsync on a fake fd are no-ops. read and fstat
// on it give an empty file (0 bytes), so a w+ target can read back. Read-only opens and real fds go
// to the real functions.
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
  fork: (sink) => (...a) => {
    record(sink, a);
    const c = stubChild(); // connected stays false: there is no channel
    c.send = (_msg, ...rest) => {
      const cb = lastFn(rest);
      if (cb) setImmediate(() => cb(null));
      return true;
    };
    c.disconnect = () => {};
    return c;
  },
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

const same = (a) => a;
const fsCallbackForm = (sink, view = same) => (...a) => {
  record(sink, view(a));
  const cb = lastFn(a);
  if (cb) setImmediate(() => cb(null));
};
const fsSyncForm = (sink, view = same) => (...a) => {
  record(sink, view(a));
};
const fspForm = (sink, view = same) => async (...a) => {
  record(sink, view(a));
};

// ---------- file descriptors and open ----------

// Fake fds sit far above any real one but are still valid int32 values.
let nextFd = 0x40000000;
const fakeFds = new Map(); // fd -> path as recorded
const isFake = (fd) => typeof fd === 'number' && fakeFds.has(fd);
const newFd = (path) => {
  fakeFds.set(++nextFd, ser(path));
  return nextFd;
};

const C = fs.constants;
const WRITE_BITS = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_APPEND | C.O_TRUNC;
function isWriteFlag(flags) {
  if (typeof flags === 'string') return /[wax+]/.test(flags);
  return typeof flags === 'number' && (flags & WRITE_BITS) !== 0;
}
const flagsOf = (a) => (typeof a[1] === 'function' ? undefined : a[1]);

// The bytes a write really sends: a Buffer is cut by offset and length (or an options object).
function written(data, rest) {
  if (!ArrayBuffer.isView(data)) return data;
  const o = isPlain(rest[0]) ? rest[0] : { offset: rest[0], length: rest[1] };
  const off = Number.isInteger(o.offset) && o.offset > 0 ? Math.min(o.offset, data.byteLength) : 0;
  const len = Number.isInteger(o.length) && o.length >= 0 ? Math.min(o.length, data.byteLength - off) : data.byteLength - off;
  return new Uint8Array(data.buffer, data.byteOffset + off, len);
}
const sizeOf = (d) => (typeof d === 'string' ? Buffer.byteLength(d) : (d?.byteLength ?? 0));
const bufList = (v) => (Array.isArray(v) ? v : []);
const sumLen = (bufs) => bufs.reduce((n, b) => n + sizeOf(b), 0);

// writeFile and appendFile take a path, an fd or a FileHandle: record the path for a fake one.
const fhPath = new WeakMap(); // stub FileHandle -> path
function pathFirst(a) {
  const p = isFake(a[0]) ? fakeFds.get(a[0]) : fhPath.get(a[0]);
  return p === undefined ? a : [p, ...a.slice(1)];
}

// What a read or a stat on a fake fd gives: an empty file.
const readTarget = (x) => (ArrayBuffer.isView(x) ? x : isPlain(x) && ArrayBuffer.isView(x.buffer) ? x.buffer : Buffer.alloc(0));
const readOut = (o) => emptyOut([typeof o === 'string' ? { encoding: o } : o]);
const fakeStats = () => ({
  size: 0,
  mode: 0o100644,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
});

// util.promisify(fs.write) resolves { bytesWritten, buffer }; read and writev do the same with their own names.
// A fake fd resolves here. A real fd keeps the real semantics through promisify(orig).
function withResult(fn, orig, names) {
  fn[promisify.custom] = (...a) =>
    isFake(a[0])
      ? new Promise((resolve, reject) =>
          fn(...a, (err, ...vals) => (err ? reject(err) : resolve(Object.fromEntries(names.map((k, i) => [k, vals[i]]))))),
        )
      : promisify(orig)(...a);
  return fn;
}

// open and openSync: a read-only open is real, a write open returns a fake fd.
const openForm = (sink, orig) => (...a) => {
  if (!isWriteFlag(flagsOf(a))) return orig(...a);
  record(sink, a);
  const fd = newFd(a[0]);
  const cb = lastFn(a);
  if (!cb) return fd;
  setImmediate(() => cb(null, fd));
};

// write and writeSync
const fdWriteForm = (sink, orig) =>
  withResult(
    (...a) => {
      if (!isFake(a[0])) return orig(...a);
      const d = written(a[1], a.slice(2));
      record(sink, [fakeFds.get(a[0]), d]);
      const cb = lastFn(a);
      if (cb) setImmediate(() => cb(null, sizeOf(d), a[1]));
      return sizeOf(d);
    },
    orig,
    ['bytesWritten', 'buffer'],
  );

// writev and writevSync: one record per buffer
const fdWritevForm = (sink, orig) =>
  withResult(
    (...a) => {
      if (!isFake(a[0])) return orig(...a);
      const bufs = bufList(a[1]);
      for (const b of bufs) record(sink, [fakeFds.get(a[0]), b]);
      const cb = lastFn(a);
      if (cb) setImmediate(() => cb(null, sumLen(bufs), a[1]));
      return sumLen(bufs);
    },
    orig,
    ['bytesWritten', 'buffers'],
  );

// read and readSync: 0 bytes
const fdReadForm = (_sink, orig) =>
  withResult(
    (...a) => {
      if (!isFake(a[0])) return orig(...a);
      const cb = lastFn(a);
      if (!cb) return 0;
      setImmediate(() => cb(null, 0, readTarget(a[1])));
    },
    orig,
    ['bytesRead', 'buffer'],
  );

// fstat and fstatSync: empty stats
const fdStatForm = (_sink, orig) => (...a) => {
  if (!isFake(a[0])) return orig(...a);
  const cb = lastFn(a);
  if (!cb) return fakeStats();
  setImmediate(() => cb(null, fakeStats()));
};

// close, ftruncate, fsync, fdatasync (and the Sync forms): act runs for a fake fd only.
const fdForm = (act) => (sink, orig) => (...a) => {
  if (!isFake(a[0])) return orig(...a);
  act?.(sink, a);
  const cb = lastFn(a);
  if (cb) setImmediate(() => cb(null));
};
const onClose = (_sink, a) => fakeFds.delete(a[0]);
const onTruncate = (sink, a) => record(sink, [fakeFds.get(a[0]), Number.isInteger(a[1]) ? a[1] : 0]);

function stubFileHandle(path, fd) {
  const base = 'fs/promises.FileHandle.';
  const fh = {
    fd,
    async write(data, ...rest) {
      const d = written(data, rest);
      record(base + 'write', [path, d]);
      return { bytesWritten: sizeOf(d), buffer: data };
    },
    async writeFile(data) {
      record(base + 'writeFile', [path, data]);
    },
    async appendFile(data) {
      record(base + 'appendFile', [path, data]);
    },
    async writev(bufs) {
      for (const b of bufList(bufs)) record(base + 'writev', [path, b]);
      return { bytesWritten: sumLen(bufList(bufs)), buffers: bufs };
    },
    async read(buf) {
      return { bytesRead: 0, buffer: readTarget(buf) };
    },
    async readFile(opts) {
      return readOut(opts);
    },
    async stat() {
      return fakeStats();
    },
    async truncate(len = 0) {
      record(base + 'truncate', [path, len]);
    },
    async sync() {},
    async datasync() {},
    async close() {
      fakeFds.delete(fd);
    },
  };
  fh[Symbol.asyncDispose] = fh.close;
  fhPath.set(fh, path);
  return fh;
}

const fspOpenForm = (sink, orig) => async (...a) => {
  if (!isWriteFlag(flagsOf(a))) return orig(...a);
  record(sink, a);
  const fd = newFd(a[0]);
  return stubFileHandle(fakeFds.get(fd), fd);
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

// make(sink, original) returns the replacement. Most recorders ignore the original.
function patch(obj, modName, name, make) {
  if (typeof obj[name] !== 'function') throw new Error(`sink-spy: ${modName}.${name} is not a function`);
  obj[name] = make(`${modName}.${name}`, obj[name]);
}

const CP_NAMES = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
// Calls that only record. The Sync and fs/promises forms share these names.
const SIMPLE = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink', 'rmdir', 'copyFile', 'cp', 'truncate', 'symlink', 'link'];
const FS_SPECIAL = {
  createWriteStream: createWriteStreamForm,
  open: openForm,
  openSync: openForm,
  write: fdWriteForm,
  writeSync: fdWriteForm,
  writev: fdWritevForm,
  writevSync: fdWritevForm,
  read: fdReadForm,
  readSync: fdReadForm,
  fstat: fdStatForm,
  fstatSync: fdStatForm,
  close: fdForm(onClose),
  closeSync: fdForm(onClose),
  ftruncate: fdForm(onTruncate),
  ftruncateSync: fdForm(onTruncate),
  fsync: fdForm(),
  fsyncSync: fdForm(),
  fdatasync: fdForm(),
  fdatasyncSync: fdForm(),
};

for (const n of CP_NAMES) patch(cp, 'child_process', n, makers[n]);
const FD_FIRST = new Set(['writeFile', 'appendFile']); // the first argument may be a fake fd or FileHandle
const viewOf = (n) => (FD_FIRST.has(n) ? pathFirst : same);
for (const n of SIMPLE) {
  patch(fs, 'fs', n, (sink) => fsCallbackForm(sink, viewOf(n)));
  patch(fs, 'fs', n + 'Sync', (sink) => fsSyncForm(sink, viewOf(n)));
}
for (const [n, make] of Object.entries(FS_SPECIAL)) patch(fs, 'fs', n, make);

// fs.promises and require('fs/promises') are one object; patch whichever objects exist.
for (const target of new Set([fsp, fs.promises])) {
  for (const n of SIMPLE) patch(target, 'fs/promises', n, (sink) => fspForm(sink, viewOf(n)));
  patch(target, 'fs/promises', 'open', fspOpenForm);
}

syncBuiltinESMExports();

// Self-check: ESM views of the builtins must now see the recorders.
const unpatched = [
  ['child_process', cpNs, cp, CP_NAMES],
  ['fs', fsNs, fs, [...SIMPLE, ...SIMPLE.map((n) => n + 'Sync'), ...Object.keys(FS_SPECIAL)]],
  ['fs/promises', fspNs, fsp, [...SIMPLE, 'open']],
].flatMap(([mod, ns, cjs, names]) => names.filter((n) => ns[n] !== cjs[n]).map((n) => `${mod}.${n}`));
if (unpatched.length > 0) throw new Error('sink-spy: ESM exports not synced: ' + unpatched.join(', '));
if (fsNs.promises.writeFile !== fspNs.writeFile) throw new Error('sink-spy: fs.promises is not patched');

writeAll('SINK_SPY_READY\n');
