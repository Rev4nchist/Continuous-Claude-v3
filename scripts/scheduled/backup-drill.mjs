/**
 * Restore drill of the nightly state backup (card ops-state-backup-nightly). Design note section 6.
 * Gunzips the dump (.dump.gz) to a temp file, then loads it into a SCRATCH database (never the live one), compares counts and lane ids, then drops the scratch database.
 * Every outside call goes through one runner `sh(cmd, args) -> { code, stdout, stderr }`, so a test can fake docker and psql.
 * A module only: no shebang, no argv read.
 */
import { createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { assertLocalHost, assertScratchUrl, dbNameOf, scratchUrlFor } from '../coordination/scratch-db.mjs';
import { maskText } from './backup-state-lib.mjs';

/** [key, qualified table]. */
export const TABLES = [
  ['lane', 'agentic_os.lane'],
  ['lane_event', 'agentic_os.lane_event'],
  ['lane_dep', 'agentic_os.lane_dep'],
  ['sessions', 'public.sessions'],
  ['file_claims', 'public.file_claims'],
  ['archival_memory', 'public.archival_memory'],
];
/** Tables that change slowly are held to 1 percent or 5 rows. The others change while the dump runs: 5 percent or 50 rows. */
const STEADY = new Set(['lane', 'lane_dep', 'archival_memory']);

/** live and scratch: { key: count }. Returns { ok, bad: [keys outside the rule] }. A key missing in scratch counts as 0. */
export function compareCounts(live, scratch) {
  const bad = [];
  for (const [key] of TABLES) {
    const want = live[key] ?? 0;
    const got = scratch[key] ?? 0;
    const allowed = STEADY.has(key) ? Math.max(5, want * 0.01) : Math.max(50, want * 0.05);
    if (Math.abs(want - got) > allowed) bad.push(key);
  }
  return { ok: bad.length === 0, bad };
}

const COUNT_SQL = TABLES.map(([key, table]) => `select '${key}', count(*) from ${table}`).join(' union all ');
const IDS_SQL = 'select id from agentic_os.lane order by id';

const psql = (db, sql, { container, user }) => ['exec', container, 'psql', '-U', user, '-d', db, '-At', '-c', sql];

/** Counts and lane ids of one database, read through psql in the container. Throws on a psql failure. */
export async function readState(sh, { db, container = 'continuous-claude-postgres', user = 'claude', docker = 'docker' }) {
  const counts = await sh(docker, psql(db, COUNT_SQL, { container, user }));
  if (counts.code !== 0) throw new Error(`psql counts failed: ${maskText(counts.stderr)}`);
  const ids = await sh(docker, psql(db, IDS_SQL, { container, user }));
  if (ids.code !== 0) throw new Error(`psql lane ids failed: ${maskText(ids.stderr)}`);
  const parsed = {};
  for (const line of counts.stdout.split(/\r?\n/)) {
    const [key, n] = line.trim().split('|');
    if (key && Number.isFinite(Number(n))) parsed[key] = Number(n);
  }
  return { counts: parsed, ids: ids.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
}

const fail = (detail, tail = '') => ({ drill: 'fail', detail: maskText(`${detail}${tail}`) });

/** One outside call with its own limit. At `ms` the child gets the abort, and a runner that ignores it still returns code 124 (a hung docker or node child cannot hold the run). */
async function bounded(shell, cmd, args, ms) {
  const ac = new AbortController();
  let timer;
  // done() first, abort second: Node spawn emits the AbortError inside abort(), so the real runner answers 127 at once and would win the race. `timedOut` marks a call that lost to its limit, whatever the runner answered.
  const limit = new Promise((done) => { timer = setTimeout(() => { done({ code: 124, timedOut: true, stdout: '', stderr: `no answer in ${Math.round(ms / 1000)} s` }); ac.abort(); }, ms); });
  const run = Promise.resolve(shell(cmd, args, { signal: ac.signal }));
  run.catch(() => {}); // a call that lost the race may fail later: nobody waits for it
  try { return await Promise.race([run, limit]); } finally { clearTimeout(timer); }
}

/**
 * live: { counts, idsBefore, idsAfter } read from the live database just before and just after the dump.
 * deadlineMs: time the drill may use (undefined = no limit). At 0 or below nothing starts: fail "no time for drill". When it passes, the running child gets an abort
 *   signal (sh(cmd, args, { signal })), the drill ends as a fail and the cleanup below still runs.
 * pendingFile: written when the scratch database exists, removed after a clean cleanup. A run killed from outside (Stop-Process) leaves it,
 *   and sweepPendingDrills of the next run cleans from it. It holds the scratch NAME only: no url, no password.
 * Returns { drill: 'pass' | 'fail', detail }. Never throws: any error is a fail with its text.
 */
export async function runDrill({ sh: shell, dumpPath, live, repo, container = 'continuous-claude-postgres', user = 'claude', node = 'node', docker = 'docker', deadlineMs, pendingFile, cleanupMs = 20000 }) {
  if (deadlineMs !== undefined && !(deadlineMs > 0)) return fail('no time for drill: the run budget is used up');
  const ac = new AbortController();
  const sh = (cmd, args) => shell(cmd, args, { signal: ac.signal }); // the steps of the body
  const scratchCli = join(repo, 'scripts', 'coordination', 'scratch-db.mjs');
  let url = null;
  let name = null;
  let copy = null;
  let plain = null; // the gunzipped dump on this machine
  // A create that ends after the abort made a database the cleanup never saw: drop it here, by its own url (checked first), and do nothing else.
  // A drop that fails or hangs is put in the pending file (the name only), so the next run's sweep owns it.
  const lateCreate = async (created) => {
    let late;
    let lateName;
    try {
      late = JSON.parse(created.stdout).url;
      lateName = assertScratchUrl(late);
    } catch { return fail('drill aborted'); } // nothing usable to drop: the scratch CLI removes its own failed creates
    let dropped = { code: 1 };
    try { dropped = await bounded(shell, node, [scratchCli, 'drop', late], cleanupMs); } catch { /* recorded below */ }
    if (dropped.code !== 0 && pendingFile) { try { writeFileSync(pendingFile, JSON.stringify({ name: lateName })); } catch { /* nothing more to do here */ } }
    return fail('drill aborted');
  };
  const body = async () => {
    if (ac.signal.aborted) return fail('drill aborted');
    const created = await sh(node, [scratchCli, 'create', '--through', '0']);
    if (ac.signal.aborted) return lateCreate(created); // the deadline passed while the create ran: the cleanup below already ran
    if (created.code !== 0) return fail('scratch database not made: ', created.stderr);
    url = JSON.parse(created.stdout).url;
    try {
      name = assertScratchUrl(url);
    } catch (e) {
      url = null; // nothing of ours to drop: a refused url is never dropped
      return fail(`scratch url refused: ${e.message}`);
    }
    if (dbNameOf(url) !== name) return fail('scratch name mismatch');
    plain = join(tmpdir(), `${name}.dump`);
    if (pendingFile) { try { writeFileSync(pendingFile, JSON.stringify({ name })); } catch { /* the sweep has nothing to read: the finally below still cleans */ } }
    try {
      await pipeline(createReadStream(dumpPath), createGunzip(), createWriteStream(plain), { signal: ac.signal });
    } catch (e) {
      return fail(`dump gunzip failed: ${e.message}`);
    }
    copy = `/tmp/${name}.dump`;
    if (ac.signal.aborted) return fail('drill aborted');
    const cp = await sh(docker, ['cp', plain, `${container}:${copy}`]);
    if (ac.signal.aborted) { // the cp ended after the cleanup ran: the copy it made has no owner but this line
      const late = await bounded(shell, docker, ['exec', container, 'rm', '-f', copy], cleanupMs).catch(() => ({ code: 1 }));
      if (late.code !== 0 && pendingFile) { try { writeFileSync(pendingFile, JSON.stringify({ name })); } catch { /* nothing more to do here */ } } // the cleanup at the deadline removed the record: put it back
      return fail('drill aborted');
    }
    if (cp.code !== 0) return fail('docker cp failed: ', cp.stderr);
    const restore = await sh(docker, ['exec', container, 'pg_restore', '-U', user, '--clean', '--if-exists', '--no-owner', '-d', name, copy]);
    if (ac.signal.aborted) return fail('drill aborted');
    if (restore.code !== 0) return fail(`pg_restore exit ${restore.code}: `, restore.stderr.split(/\r?\n/).find(Boolean) ?? '');
    const scratch = await readState(sh, { db: name, container, user, docker });
    const cmp = compareCounts(live.counts, scratch.counts);
    const after = new Set(live.idsAfter);
    const have = new Set(scratch.ids);
    const missing = live.idsBefore.filter((id) => after.has(id) && !have.has(id));
    const parts = TABLES.map(([key]) => `${key} ${scratch.counts[key] ?? 0} of ${live.counts[key] ?? 0}`).join(', ');
    if (!cmp.ok) return fail(`counts outside the rule: ${cmp.bad.join(', ')}. ${parts}`);
    if (missing.length) return fail(`lane id check: ${missing.length} missing (${missing.slice(0, 5).join(', ')}). ${parts}`);
    return { drill: 'pass', detail: maskText(`${parts}; ${live.idsBefore.length} lane ids checked`) };
  };
  let result;
  let timer = null;
  try {
    const racers = [body()];
    if (deadlineMs !== undefined) {
      racers.push(new Promise((done) => {
        timer = setTimeout(() => { ac.abort(); done(fail(`drill deadline of ${Math.round(deadlineMs / 1000)} s passed`)); }, deadlineMs);
      }));
    }
    result = await Promise.race(racers);
  } catch (e) {
    result = fail(`drill error: ${e.message}`);
  } finally {
    if (timer) clearTimeout(timer);
    const sh = (cmd, args) => bounded(shell, cmd, args, cleanupMs); // the cleanup gets a fresh signal and its own limit per call: an aborted signal must not stop it, a hung call must not hold it
    const notes = [];
    if (copy) {
      try {
        const removed = await sh(docker, ['exec', container, 'rm', '-f', copy]);
        if (removed.code !== 0) notes.push('copy in container not removed');
      } catch { notes.push('copy in container not removed'); }
    }
    if (plain) {
      try { rmSync(plain, { force: true }); } catch { notes.push('restore copy not removed'); }
    }
    if (url) {
      try {
        const dropped = await sh(node, [scratchCli, 'drop', url]);
        notes.push(dropped.code === 0 ? `scratch ${name} dropped` : `scratch ${name} not dropped`);
      } catch { notes.push(`scratch ${name} not dropped`); }
    }
    // Only a clean cleanup removes the pending file: a failed drop stays on record for the next run's sweep.
    if (pendingFile && !notes.some((n) => /not (dropped|removed)/.test(n))) { try { rmSync(pendingFile, { force: true }); } catch { /* the sweep finds nothing left to do */ } }
    if (notes.length) result = { ...result, detail: `${result.detail} | ${notes.join('; ')}` };
  }
  return result;
}

/**
 * Start-of-run sweep. Reads only <root>/<day>/<run>/drill-pending.json (the folder of an earlier run; `skip` is the current one) and cleans what
 * that file names: the scratch database, the copy in the container and the temp dump. Never by age or prefix. The name is checked again with
 * assertScratchUrl and assertLocalHost, the container copy and the temp dump are derived from the name, never from the file text. A file that fails any check stays
 * for a person. A failed drop keeps the file for the next run. Never throws. Returns { cleaned: [names], skipped: [text] }.
 */
export async function sweepPendingDrills({ root, sh: shell, repo, container = 'continuous-claude-postgres', node = 'node', docker = 'docker', skip = null, urlFor = scratchUrlFor, callMs = 20000 }) {
  const sh = (cmd, args) => bounded(shell, cmd, args, callMs); // each docker and node call has its own limit (a hung call is a code 124: the file stays for the next run)
  const cleaned = [];
  const skipped = [];
  const folders = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !lstatSync(join(dir, d.name)).isSymbolicLink()).map((d) => join(dir, d.name));
    } catch { return []; }
  };
  const scratchCli = join(repo, 'scripts', 'coordination', 'scratch-db.mjs');
  let stopped = false; // the first call that gets no answer (code 124) ends the sweep: the files it did not reach stay for the next run
  for (const day of folders(root)) {
    for (const run of folders(day)) {
      if (stopped) break;
      const file = join(run, 'drill-pending.json');
      if (skip && resolve(run) === resolve(skip)) continue;
      if (!existsSync(file)) continue;
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8'));
        // The file holds the name only. The url comes from this machine's own connection chain, then both guards run before any drop.
        const url = urlFor(String(rec.name));
        const name = assertScratchUrl(url);
        if (rec.name !== name) throw new Error('name does not match the url');
        assertLocalHost(url);
        let ok = true;
        const removed = await sh(docker, ['exec', container, 'rm', '-f', `/tmp/${name}.dump`]);
        if (removed.code !== 0) ok = false;
        if (removed.timedOut) stopped = true;
        const dropped = stopped ? { code: 124 } : await sh(node, [scratchCli, 'drop', url]);
        if (dropped.code !== 0) ok = false;
        if (dropped.timedOut) stopped = true;
        rmSync(join(tmpdir(), `${name}.dump`), { force: true });
        if (ok) { rmSync(file, { force: true }); cleaned.push(name); } else skipped.push(`${name}: cleanup not complete, kept for the next run`);
      } catch (e) {
        skipped.push(`${file}: ${maskText(e.message)}`);
      }
    }
  }
  if (stopped) skipped.push('sweep stopped: docker or node did not answer');
  return { cleaned, skipped };
}
