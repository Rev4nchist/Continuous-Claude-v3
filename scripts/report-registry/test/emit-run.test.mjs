// emit-run.test.mjs — tests for the always-emit spine (emit-run.mjs). Verifies
// the caller contract (README/header comment in emit-run.mjs): silent stderr on
// a healthy run, one-line stdout, honest failure exit, --out overriding the
// canonical temp path, and runId pairing via a shared runDate. Transport is
// ALWAYS injected — nothing here ever touches Notion.
// Run: node --test scripts/report-registry/test/emit-run.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync, rmSync, mkdtempSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitRun, captureConsole } from '../emit-run.mjs';
import { tempRunPath } from '../make-run.mjs';
import { runScopedRefresh } from '../upsert.mjs';

const base = {
  type: 'Project Portfolio',
  period: '2026-07-05',
  status: 'OK',
  source: 'Project-Cards',
};

// Capturing mock transport: emits realistic progress chatter on BOTH streams so
// the "success path is silent" assertions are proving suppression, not just an
// absence of chatter to suppress.
function mockTransport({ upsertResult = { action: 'created', pageId: 'mock-page' } } = {}) {
  const calls = { upsert: [], refresh: [] };
  return {
    calls,
    upsert: (run) => {
      calls.upsert.push(run);
      console.error(`[report-registry] created row for Run ID "${run.runId}" (page mock-page)`);
      return upsertResult;
    },
    refresh: (type) => {
      calls.refresh.push(type);
      console.error(`[report-registry] scoped refresh ok (type "${type}": child page + hub)`);
      return { ok: true, status: 0 };
    },
  };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'emit-run-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- contract #1 + #2: success path is one stdout line, silent stderr --------

test('success path: exactly one stdout line (the path); nothing leaks to stderr', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    const mocks = mockTransport();
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logs.push(a.map(String).join(' '));
    console.error = (...a) => errs.push(a.map(String).join(' '));
    let res;
    try {
      res = emitRun({ ...base, out }, { upsert: mocks.upsert, refresh: mocks.refresh });
      // What main() does on the success path: print exactly the emitted path.
      console.log(res.path);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.deepEqual(errs, [], 'the mocked transport chatter must be captured, not leaked to real stderr');
    assert.deepEqual(logs, [res.path], 'stdout must carry exactly one line: the emitted path');
    assert.equal(res.action, 'created');
    assert.ok(existsSync(out));
  });
});

// --- contract #2 against the REAL transport -----------------------------------
// The mock above emits via in-process console.error. Until 2026-08-03 the real
// runScopedRefresh did the OPPOSITE (stdio 'inherit' — child wrote straight to
// the parent's fds), so the mock-based test asserted a contract the real
// transport violated. This test wires emitRun to the REAL runScopedRefresh,
// driving a REAL child process through its own spawn options, and proves the
// success path stays silent on the actual fds.
test('contract #2 holds against the REAL runScopedRefresh: a chattering real child leaks nothing to stderr', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    const realChild = (cmd, args, opts) => spawnSync(
      process.execPath,
      ['-e', 'console.log("refresh stdout chatter"); console.error("refresh stderr chatter")'],
      opts, // the exact options runScopedRefresh built — stdio config included
    );
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.map(String).join(' '));
    let res;
    try {
      res = emitRun({ ...base, out }, {
        upsert: () => ({ action: 'created', pageId: 'mock-page' }),
        refresh: (type) => runScopedRefresh(type, { spawn: realChild }),
      });
    } finally {
      console.error = origErr;
    }
    assert.deepEqual(errs, [], 'real child chatter must be captured by emitRun, never leaked to stderr');
    const joined = res.lines.join('\n');
    assert.match(joined, /refresh stdout chatter/, 'the chatter must land in the sink (replayable on failure)');
    assert.match(joined, /refresh stderr chatter/, 'the chatter must land in the sink (replayable on failure)');
  });
});

// --- contract #6: runDate pairs a pre-emit with its final emit ----------------

test('same runDate on two emits -> identical runId; differing/absent runDate -> different runId', () => {
  withTempDir((dir) => {
    const runDate = '2026-08-01T12:00:00.000Z';
    const mocks = mockTransport();
    const r1 = emitRun(
      { ...base, runDate, out: join(dir, 'a.json') },
      { upsert: mocks.upsert, refresh: mocks.refresh },
    );
    const r2 = emitRun(
      { ...base, runDate, out: join(dir, 'b.json') },
      { upsert: mocks.upsert, refresh: mocks.refresh },
    );
    assert.equal(r1.run.runId, r2.run.runId, 'the same runDate must pair pre-emit and final-emit onto one row');

    const r3 = emitRun(
      { ...base, runDate: '2026-08-01T13:00:00.000Z', out: join(dir, 'c.json') },
      { upsert: mocks.upsert, refresh: mocks.refresh },
    );
    assert.notEqual(r3.run.runId, r1.run.runId, 'a differing runDate must mint a distinct runId');

    const r4 = emitRun(
      { ...base, out: join(dir, 'd.json') }, // no runDate -> defaults to now
      { upsert: mocks.upsert, refresh: mocks.refresh },
    );
    assert.notEqual(r4.run.runId, r1.run.runId, 'an absent runDate must not accidentally collide with an explicit one');
  });
});

// --- contract #5 (make-run.mjs "--out is MANDATORY") --------------------------

test('--out overrides the target path; the canonical tempRunPath(source) is left untouched', () => {
  withTempDir((dir) => {
    const prevTemp = process.env.TEMP;
    process.env.TEMP = dir; // so the canonical path (if ever written) would land inside dir too
    try {
      const outPath = join(dir, 'override.json');
      const mocks = mockTransport();
      const res = emitRun({ ...base, out: outPath }, { upsert: mocks.upsert, refresh: mocks.refresh });
      assert.equal(res.path, outPath);
      assert.ok(existsSync(outPath), '--out path must be written');
      const canonical = tempRunPath(base.source);
      assert.equal(existsSync(canonical), false, 'the canonical tempRunPath must NOT be written when --out is given');
    } finally {
      if (prevTemp === undefined) delete process.env.TEMP; else process.env.TEMP = prevTemp;
    }
  });
});

// --- doUpsert:false -> emit-only, upsert never invoked ------------------------

test('doUpsert:false writes the JSON and NEVER calls the injected upsert; action is emit-only', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    let called = false;
    const upsert = () => { called = true; return { action: 'created', pageId: 'x' }; };
    const res = emitRun({ ...base, out }, { upsert, doUpsert: false });
    assert.equal(res.action, 'emit-only');
    assert.equal(called, false, 'upsert must never be invoked when doUpsert is false');
    assert.ok(existsSync(out));
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(parsed.runId, res.run.runId);
  });
});

// --- contract #3: honest failure — sink retains chatter captured before throw -

test('a throwing injected upsert propagates; the sink still holds chatter captured before the throw', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    const sink = [];
    const upsert = () => {
      console.error('[mock] about to fail');
      throw new Error('mock transport failure');
    };
    assert.throws(
      () => emitRun({ ...base, out }, { upsert, sink }),
      /mock transport failure/,
    );
    assert.deepEqual(sink, ['[mock] about to fail'], 'chatter captured before the throw must survive it (honest-failure contract)');
  });
});

// --- captureConsole always restores real console, even on throw --------------

test('captureConsole restores the real console.log/console.error even when the wrapped fn throws', () => {
  const origLog = console.log;
  const origErr = console.error;
  const sink = [];
  assert.throws(() => {
    captureConsole(() => {
      console.log('captured log');
      console.error('captured err');
      throw new Error('boom');
    }, sink);
  }, /boom/);
  assert.equal(console.log, origLog, 'console.log must be restored after a throw');
  assert.equal(console.error, origErr, 'console.error must be restored after a throw');
  assert.deepEqual(sink, ['captured log', 'captured err']);
});

test('captureConsole restores the real console on the success path too', () => {
  const origLog = console.log;
  const origErr = console.error;
  const { value, lines } = captureConsole(() => {
    console.log('hello');
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(lines, ['hello']);
  assert.equal(console.log, origLog);
  assert.equal(console.error, origErr);
});

// --- contract #7: buildRun validation flows through emitRun -------------------

test('an invalid status thrown by buildRun propagates through emitRun', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    assert.throws(
      () => emitRun({ ...base, status: 'Green', out }),
      /invalid status/,
    );
  });
});

test('a non-http(s) artifactUrl thrown by buildRun propagates through emitRun', () => {
  withTempDir((dir) => {
    const out = join(dir, 'run.json');
    assert.throws(
      () => emitRun({ ...base, artifactUrl: 'C:/local/path/report.pdf', out }),
      /must be an http\(s\) URL/,
    );
  });
});
