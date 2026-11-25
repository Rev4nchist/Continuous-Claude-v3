// Tests of the restore drill of the nightly state backup (card ops-state-backup-nightly).
// The drill talks to docker, psql and scratch-db.mjs through one injected runner `sh(cmd, args)`; a fake runner records every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCounts, runDrill, TABLES } from './backup-drill.mjs';

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
    if (over.throwOn && over.throwOn(line)) throw new Error('boom');
    if (line.includes('scratch-db.mjs create')) return { code: 0, stdout: over.scratchOut ?? JSON.stringify({ url: SCRATCH, name: 'lanes_pr1_abcd1234' }), stderr: '' };
    if (line.includes('pg_restore')) return { code: over.restore ?? 0, stdout: '', stderr: over.restore ? (over.restoreErr ?? 'restore broke') : '' };
    if (line.includes('union all')) return { code: 0, stdout: countsText(over.counts ?? LIVE_COUNTS), stderr: '' };
    if (line.includes('select id from')) return { code: 0, stdout: (over.ids ?? IDS).join('\n'), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { sh, calls };
}
const live = { counts: LIVE_COUNTS, idsBefore: IDS, idsAfter: IDS };
const drill = (f, extra = {}) => runDrill({ sh: f.sh, dumpPath: 'C:/x/ccv3-lanedb-2026-11-25.dump', live, repo: 'C:/repo', ...extra });

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
  const out = await runDrill({ sh: f.sh, dumpPath: 'C:/x/d.dump', repo: 'C:/repo', live: { counts: LIVE_COUNTS, idsBefore: ['a', 'b', 'c', 'gone'], idsAfter: ['a', 'b', 'c', 'new'] } });
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
