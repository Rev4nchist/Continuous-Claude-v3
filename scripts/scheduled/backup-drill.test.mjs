// Tests of the restore drill of the nightly state backup (card ops-state-backup-nightly).
// The drill talks to docker, psql and scratch-db.mjs through one injected runner `sh(cmd, args)`; a fake runner records every call.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compareCounts, runDrill, sweepPendingDrills, TABLES } from './backup-drill.mjs';

// The dump of a night is gzip. Each test gets a real small .gz file from one temp folder that this file made; the folder holds only files.
const DUMP_BYTES = Buffer.from('PGDMP fake custom-format dump bytes '.repeat(50));
const DUMP_DIR = mkdtempSync(join(tmpdir(), 'bk-drill-'));
const GOOD_GZ = join(DUMP_DIR, 'ccv3-lanedb-2026-11-25.dump.gz');
const BAD_GZ = join(DUMP_DIR, 'corrupt.dump.gz');
writeFileSync(GOOD_GZ, gzipSync(DUMP_BYTES));
writeFileSync(BAD_GZ, Buffer.from('this is not a gzip file at all'));
after(() => rmSync(DUMP_DIR, { recursive: true, force: true }));

const SCRATCH = 'postgresql://claude:pw@localhost:5432/lanes_pr1_abcd1234';
const LIVE_COUNTS = { lane: 150, lane_event: 1000, lane_dep: 20, sessions: 300, file_claims: 100, archival_memory: 2000 };
const countsText = (c) => Object.entries(c).map(([k, v]) => `${k}|${v}`).join('\n');
const IDS = ['a', 'b', 'c'];

/** A fake runner. over: { scratchOut, restore, counts, ids } override one answer; `fail` makes a step throw. */
function fakeSh(over = {}) {
  const calls = [];
  const sh = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ cmd, args, line });
    if (args[0] === 'cp') { try { calls.at(-1).copied = readFileSync(args[1]); } catch { calls.at(-1).copied = null; } } // what the copied file holds at the time of the copy
    if (over.throwOn && over.throwOn(line)) throw new Error('boom');
    if (line.includes('rm -f')) return { code: over.rmCode ?? 0, stdout: '', stderr: '' };
    if (line.includes('scratch-db.mjs create')) return { code: 0, stdout: over.scratchOut ?? JSON.stringify({ url: SCRATCH, name: 'lanes_pr1_abcd1234' }), stderr: '' };
    if (line.includes('pg_restore')) return { code: over.restore ?? 0, stdout: '', stderr: over.restore ? (over.restoreErr ?? 'restore broke') : '' };
    if (line.includes('union all')) return { code: 0, stdout: countsText(over.counts ?? LIVE_COUNTS), stderr: '' };
    if (line.includes('select id from')) return { code: 0, stdout: (over.ids ?? IDS).join('\n'), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { sh, calls };
}
const live = { counts: LIVE_COUNTS, idsBefore: IDS, idsAfter: IDS };
const drill = (f, extra = {}) => runDrill({ sh: f.sh, dumpPath: GOOD_GZ, live, repo: 'C:/repo', ...extra });

test('D1 count rule: lane tables within 1 percent or 5 rows, busy tables within 5 percent or 50 rows', () => {
  assert.equal(compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, lane: 145 }).ok, true);
  assert.deepEqual(compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, lane: 160 }).bad, ['lane'], 'a restore with MORE rows than live is also wrong');
  const bad = compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, lane: 144 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.bad, ['lane']);
  assert.equal(compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, lane_event: 960 }).ok, true);
  assert.deepEqual(compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, lane_event: 940 }).bad, ['lane_event']);
  assert.deepEqual(compareCounts({ ...LIVE_COUNTS, archival_memory: 10000 }, { ...LIVE_COUNTS, archival_memory: 9899 }).bad, ['archival_memory']);
  assert.deepEqual(compareCounts(LIVE_COUNTS, { ...LIVE_COUNTS, sessions: 0 }).bad, ['sessions']);
  assert.deepEqual(compareCounts(LIVE_COUNTS, { lane: 150 }).bad.sort(), ['archival_memory', 'file_claims', 'lane_dep', 'lane_event', 'sessions']);
  assert.equal(TABLES.length, 6);
});

test('D2 a good drill: scratch, copy, restore with the three flags, counts, then drop and cleanup', async () => {
  const f = fakeSh();
  const out = await drill(f);
  assert.equal(out.drill, 'pass');
  assert.match(out.detail, /lane 150 of 150/);
  assert.match(out.detail, /scratch lanes_pr1_abcd1234 dropped/, 'the detail names the scratch database it removed');
  const lines = f.calls.map((c) => c.line);
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at('scratch-db.mjs create --through 0') >= 0);
  assert.ok(at('docker') >= 0);
  assert.ok(at('cp ') < at('pg_restore') && at('pg_restore') < at('union all') && at('union all') < at('scratch-db.mjs drop'));
  const restore = f.calls.find((c) => c.line.includes('pg_restore'));
  for (const flag of ['--clean', '--if-exists', '--no-owner']) assert.ok(restore.args.includes(flag), flag);
  assert.equal(restore.args[restore.args.indexOf('-d') + 1], 'lanes_pr1_abcd1234');
  assert.ok(lines.some((l) => l.includes('rm -f')), 'the copy in the container is removed');
  assert.ok(lines.at(-1).includes('scratch-db.mjs drop') || lines.some((l) => l.includes('scratch-db.mjs drop')));
});

test('D3 a failed restore is a fail, and the scratch database and the copy are still removed', async () => {
  const f = fakeSh({ restore: 1 });
  const out = await drill(f);
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /pg_restore/);
  assert.ok(f.calls.some((c) => c.line.includes('scratch-db.mjs drop')));
  assert.ok(f.calls.some((c) => c.line.includes('rm -f')));
});

test('D4 a scratch url that names the live database stops the drill: no restore, no drop of it', async () => {
  const f = fakeSh({ scratchOut: JSON.stringify({ url: 'postgresql://claude:pw@localhost:5432/continuous_claude', name: 'continuous_claude' }) });
  const out = await drill(f);
  assert.equal(out.drill, 'fail');
  assert.ok(!f.calls.some((c) => c.line.includes('pg_restore')));
  assert.ok(!f.calls.some((c) => c.line.includes('scratch-db.mjs drop')));
  assert.ok(!f.calls.some((c) => c.args.includes('continuous_claude') && c.line.includes('pg_restore')));
});

test('D5 a lane that was live before the dump and is still live, but is missing from the restore, fails the drill', async () => {
  const f = fakeSh({ ids: ['a', 'b'] });
  const out = await drill(f);
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /lane id/);
  assert.match(out.detail, /1 missing/);
});

test('D6 a lane deleted after the dump may be absent; a lane made after the dump may be extra', async () => {
  const f = fakeSh({ ids: ['a', 'b', 'c'] });
  const out = await runDrill({ sh: f.sh, dumpPath: GOOD_GZ, repo: 'C:/repo', live: { counts: LIVE_COUNTS, idsBefore: ['a', 'b', 'c', 'gone'], idsAfter: ['a', 'b', 'c', 'new'] } });
  assert.equal(out.drill, 'pass');
});

test('D7 a count outside the rule fails the drill and names the table', async () => {
  const f = fakeSh({ counts: { ...LIVE_COUNTS, lane_event: 500 } });
  const out = await drill(f);
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /lane_event/);
});

test('D8 a step that throws is a fail, not a crash, and the cleanup still runs', async () => {
  const f = fakeSh({ throwOn: (l) => l.includes('union all') });
  const out = await drill(f);
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /boom/);
  assert.ok(f.calls.some((c) => c.line.includes('scratch-db.mjs drop')));
  assert.ok(f.calls.some((c) => c.line.includes('rm -f')));
});

test('D9 the password of the scratch url never reaches the detail text', async () => {
  const f = fakeSh({ restore: 1, restoreErr: 'could not connect to postgresql://claude:pw@localhost:5432/x' });
  const out = await drill(f);
  assert.match(out.detail, /could not connect/);
  assert.ok(!out.detail.includes(':pw@'), out.detail);
});

test('D10 a copy in the container that the rm step could not remove is named in the detail', async () => {
  // Breaks when the exit code of rm is ignored: sh() does not throw for a failed command.
  const f = fakeSh({ rmCode: 1 });
  const out = await drill(f);
  assert.equal(out.drill, 'pass');
  assert.match(out.detail, /copy in container not removed/);
  assert.doesNotMatch((await drill(fakeSh())).detail, /not removed/, 'a clean rm adds no note');
});

test('D11 a corrupt or non-gzip dump is a fail named "dump gunzip failed", docker cp is never called, the scratch database is dropped', async () => {
  // Breaks when the dump is copied as it is, or when the gunzip error escapes as a throw.
  for (const dumpPath of [BAD_GZ, join(DUMP_DIR, 'missing.dump.gz')]) {
    const f = fakeSh();
    const out = await drill(f, { dumpPath });
    assert.equal(out.drill, 'fail');
    assert.match(out.detail, /^dump gunzip failed: /);
    assert.ok(!f.calls.some((c) => c.args[0] === 'cp'), 'no docker cp');
    assert.ok(!f.calls.some((c) => c.line.includes('pg_restore')), 'no restore');
    assert.ok(f.calls.some((c) => c.line.includes('scratch-db.mjs drop')), 'the scratch database is dropped');
  }
});

test('D12 the DECOMPRESSED temp file is copied into the container, and it is removed afterwards', async () => {
  // Breaks when the .gz is copied (pg_restore cannot read it) or when the temp file is left on disk.
  const f = fakeSh();
  const out = await drill(f);
  assert.equal(out.drill, 'pass');
  const cp = f.calls.find((c) => c.args[0] === 'cp');
  assert.notEqual(cp.args[1], GOOD_GZ);
  assert.equal(cp.args[1], join(tmpdir(), 'lanes_pr1_abcd1234.dump'));
  assert.equal(cp.args[2], 'continuous-claude-postgres:/tmp/lanes_pr1_abcd1234.dump');
  assert.ok(cp.copied && cp.copied.equals(DUMP_BYTES), 'the copied file holds the gunzipped bytes');
  assert.equal(existsSync(cp.args[1]), false, 'the temp file is removed after the drill');
});

// ---- card ops-backup-drill-deadline-cleanup, Part A: a drill that hits its deadline, and a run that was killed hard ----

/** pg_restore never ends by itself. honorSignal: it ends when the runner is aborted; else it hangs forever (a child that ignores the abort). */
function hangingSh(honorSignal) {
  const f = fakeSh();
  const inner = f.sh;
  f.aborted = false;
  f.sh = async (cmd, args, opts = {}) => {
    if ([cmd, ...args].join(' ').includes('pg_restore')) {
      f.calls.push({ cmd, args, line: [cmd, ...args].join(' ') });
      return new Promise((resolve) => {
        if (honorSignal && opts.signal) opts.signal.addEventListener('abort', () => { f.aborted = true; resolve({ code: 143, stdout: '', stderr: 'killed' }); });
      });
    }
    return inner(cmd, args, opts);
  };
  return f;
}
const cleanedUp = (f) => {
  const lines = f.calls.map((c) => c.line);
  return lines.some((l) => l.includes('rm -f /tmp/lanes_pr1_abcd1234.dump')) && lines.some((l) => l.includes('scratch-db.mjs drop'));
};

test('D13 a drill past its deadline is a fail named "deadline", the child is aborted, and copy, temp dump and scratch database are removed', async () => {
  // Breaks when runDrill has no deadline (the test would hang), or when the abort signal never reaches the runner.
  const f = hangingSh(true);
  const out = await drill(f, { deadlineMs: 60 });
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /deadline/);
  assert.equal(f.aborted, true, 'the running child got the abort signal');
  assert.ok(cleanedUp(f), 'the container copy is removed and the scratch database is dropped');
  assert.equal(existsSync(join(tmpdir(), 'lanes_pr1_abcd1234.dump')), false, 'the temp dump is removed');
});

test('D14 a child that ignores the abort still ends the drill at the deadline, with the cleanup done', async () => {
  // Breaks when the deadline only sends the signal and then waits for the child.
  const f = hangingSh(false);
  const out = await drill(f, { deadlineMs: 60 });
  assert.equal(out.drill, 'fail');
  assert.match(out.detail, /deadline/);
  assert.ok(cleanedUp(f));
});

test('D14b a drill that starts with no time left (deadlineMs 0 or below) is a fail "no time for drill" and makes no scratch database', async () => {
  // Breaks when a late start still runs the drill: it would pass the wrapper kill and leave the upload undone.
  for (const deadlineMs of [0, -5000]) {
    const f = fakeSh();
    const out = await drill(f, { deadlineMs });
    assert.equal(out.drill, 'fail');
    assert.match(out.detail, /no time for drill/);
    assert.equal(f.calls.length, 0, 'no call at all: nothing was made, so nothing needs cleanup');
  }
});

const pendingDir = () => mkdtempSync(join(tmpdir(), 'bk-pending-'));

test('D15 the drill writes drill-pending.json (name, url, temp dump) when the scratch database exists, and removes it after the cleanup', async () => {
  // Breaks when no file is written (a hard kill leaves no trace to sweep), or when the file stays after a clean drill.
  const dir = pendingDir();
  try {
    const pendingFile = join(dir, 'drill-pending.json');
    let seen = null;
    const f = fakeSh();
    const inner = f.sh;
    f.sh = async (cmd, args, opts) => {
      if ([cmd, ...args].join(' ').includes('pg_restore') && existsSync(pendingFile)) seen = JSON.parse(readFileSync(pendingFile, 'utf8'));
      return inner(cmd, args, opts);
    };
    const out = await drill(f, { pendingFile });
    assert.equal(out.drill, 'pass');
    assert.equal(seen.name, 'lanes_pr1_abcd1234');
    assert.equal(seen.url, SCRATCH);
    assert.equal(seen.plain, join(tmpdir(), 'lanes_pr1_abcd1234.dump'));
    assert.equal(existsSync(pendingFile), false, 'removed after the cleanup');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A run folder of a killed run: <root>/<date>/run-<time>-<pid>/drill-pending.json. */
function crashedRun(root, rec, run = 'run-030000-111') {
  const folder = join(root, '2026-11-24', run);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'drill-pending.json'), JSON.stringify(rec));
  return folder;
}

test('D16 the sweep cleans only what a killed run wrote in its own folder: drop, container copy, temp dump, then the file', async () => {
  // Breaks when the sweep reads nothing, or leaves one of the three leftovers.
  const root = pendingDir();
  try {
    const plain = join(tmpdir(), 'lanes_pr1_deadbeef.dump');
    writeFileSync(plain, 'x');
    const folder = crashedRun(root, { name: 'lanes_pr1_deadbeef', url: 'postgresql://claude:pw@localhost:5432/lanes_pr1_deadbeef', plain });
    const f = fakeSh();
    const out = await sweepPendingDrills({ root, sh: f.sh, repo: 'C:/repo' });
    const lines = f.calls.map((c) => c.line);
    assert.ok(lines.some((l) => l.includes('scratch-db.mjs drop postgresql://claude:pw@localhost:5432/lanes_pr1_deadbeef')));
    assert.ok(lines.some((l) => l.includes('rm -f /tmp/lanes_pr1_deadbeef.dump')));
    assert.equal(existsSync(plain), false);
    assert.equal(existsSync(join(folder, 'drill-pending.json')), false);
    assert.deepEqual(out.cleaned, ['lanes_pr1_deadbeef']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D17 the sweep never acts on a name outside the scratch rule, or on a temp path that is not tmpdir/<name>.dump', async () => {
  // Breaks when the file text is trusted: a hand-edited file naming the live database or an unrelated path must do nothing.
  const root = pendingDir();
  const victim = join(root, 'precious.txt');
  writeFileSync(victim, 'keep');
  try {
    const live = crashedRun(root, { name: 'continuous_claude', url: 'postgresql://claude:pw@localhost:5432/continuous_claude', plain: victim }, 'run-030000-1');
    const badPath = crashedRun(root, { name: 'lanes_pr1_cafe0001', url: 'postgresql://claude:pw@localhost:5432/lanes_pr1_cafe0001', plain: victim }, 'run-030000-2');
    const f = fakeSh();
    const out = await sweepPendingDrills({ root, sh: f.sh, repo: 'C:/repo' });
    assert.equal(f.calls.some((c) => c.line.includes('continuous_claude')), false, 'the live database is never touched');
    assert.equal(existsSync(victim), true, 'a path outside tmpdir/<name>.dump is never deleted');
    assert.equal(existsSync(join(live, 'drill-pending.json')), true, 'a refused file stays for a person to read');
    assert.ok(out.skipped.length >= 1);
    assert.equal(existsSync(join(badPath, 'drill-pending.json')), false, 'the valid name is cleaned; only its bad path is skipped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D17b the sweep skips the folder of the current run', async () => {
  // Breaks when the sweep reads its own run: it would drop the scratch database of a drill that is about to start.
  const root = pendingDir();
  try {
    const own = crashedRun(root, { name: 'lanes_pr1_deadbeef', url: 'postgresql://claude:pw@localhost:5432/lanes_pr1_deadbeef', plain: join(tmpdir(), 'lanes_pr1_deadbeef.dump') }, 'run-030000-own');
    const f = fakeSh();
    const out = await sweepPendingDrills({ root, sh: f.sh, repo: 'C:/repo', skip: own });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(out.cleaned, []);
    assert.equal(existsSync(join(own, 'drill-pending.json')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D18 a sweep with no pending file, or a failed drop, changes nothing else and never throws', async () => {
  // Breaks when a failed drop deletes the file (the next run could not retry) or an empty root throws.
  const root = pendingDir();
  try {
    const f0 = fakeSh();
    assert.deepEqual((await sweepPendingDrills({ root, sh: f0.sh, repo: 'C:/repo' })).cleaned, []);
    assert.equal(f0.calls.length, 0);
    const folder = crashedRun(root, { name: 'lanes_pr1_deadbeef', url: 'postgresql://claude:pw@localhost:5432/lanes_pr1_deadbeef', plain: join(tmpdir(), 'lanes_pr1_deadbeef.dump') });
    const f = fakeSh();
    const base = f.sh;
    f.sh = async (cmd, args, opts) => (args.includes('drop') ? { code: 1, stdout: '', stderr: 'no' } : base(cmd, args, opts));
    const out = await sweepPendingDrills({ root, sh: f.sh, repo: 'C:/repo' });
    assert.deepEqual(out.cleaned, []);
    assert.equal(existsSync(join(folder, 'drill-pending.json')), true, 'kept for the next run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
