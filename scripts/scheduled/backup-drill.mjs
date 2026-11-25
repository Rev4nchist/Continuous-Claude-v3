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
import { assertScratchUrl, dbNameOf } from '../coordination/scratch-db.mjs';
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

/**
 * live: { counts, idsBefore, idsAfter } read from the live database just before and just after the dump.
 * deadlineMs: time the drill may use (undefined = no limit). At 0 or below nothing starts: fail "no time for drill". When it passes, the running child gets an abort
 *   signal (sh(cmd, args, { signal })), the drill ends as a fail and the cleanup below still runs.
 * pendingFile: written when the scratch database exists, removed after a clean cleanup. A run killed from outside (Stop-Process) leaves it,
 *   and sweepPendingDrills of the next run cleans from it. It holds the scratch url (a local throwaway database, in the run folder of this user).
 * Returns { drill: 'pass' | 'fail', detail }. Never throws: any error is a fail with its text.
 */
export async function runDrill({ sh: shell, dumpPath, live, repo, container = 'continuous-claude-postgres', user = 'claude', node = 'node', docker = 'docker', deadlineMs, pendingFile }) {
  if (deadlineMs !== undefined && !(deadlineMs > 0)) return fail('no time for drill: the run budget is used up');
  const ac = new AbortController();
  const sh = (cmd, args) => shell(cmd, args, { signal: ac.signal }); // the steps of the body
  const scratchCli = join(repo, 'scripts', 'coordination', 'scratch-db.mjs');
  let url = null;
  let name = null;
  let copy = null;
  let plain = null; // the gunzipped dump on this machine
  const body = async () => {
    const created = await sh(node, [scratchCli, 'create', '--through', '0']);
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
    if (pendingFile) { try { writeFileSync(pendingFile, JSON.stringify({ name, url, plain })); } catch { /* the sweep has nothing to read: the finally below still cleans */ } }
    try {
      await pipeline(createReadStream(dumpPath), createGunzip(), createWriteStream(plain), { signal: ac.signal });
    } catch (e) {
      return fail(`dump gunzip failed: ${e.message}`);
    }
    copy = `/tmp/${name}.dump`;
    const cp = await sh(docker, ['cp', plain, `${container}:${copy}`]);
    if (cp.code !== 0) return fail('docker cp failed: ', cp.stderr);
    const restore = await sh(docker, ['exec', container, 'pg_restore', '-U', user, '--clean', '--if-exists', '--no-owner', '-d', name, copy]);
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
    const sh = shell; // the cleanup runs on the plain runner: an aborted signal must not stop it
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
 * assertScratchUrl, the container copy and the temp dump are derived from the name, never from the file text. A file that fails any check stays
 * for a person. A failed drop keeps the file for the next run. Never throws. Returns { cleaned: [names], skipped: [text] }.
 */
export async function sweepPendingDrills({ root, sh, repo, container = 'continuous-claude-postgres', node = 'node', docker = 'docker', skip = null }) {
  const cleaned = [];
  const skipped = [];
  const folders = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !lstatSync(join(dir, d.name)).isSymbolicLink()).map((d) => join(dir, d.name));
    } catch { return []; }
  };
  const scratchCli = join(repo, 'scripts', 'coordination', 'scratch-db.mjs');
  for (const day of folders(root)) {
    for (const run of folders(day)) {
      const file = join(run, 'drill-pending.json');
      if (skip && resolve(run) === resolve(skip)) continue;
      if (!existsSync(file)) continue;
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8'));
        const name = assertScratchUrl(rec.url);
        if (rec.name !== name) throw new Error('name does not match the url');
        let ok = true;
        const removed = await sh(docker, ['exec', container, 'rm', '-f', `/tmp/${name}.dump`]);
        if (removed.code !== 0) ok = false;
        const dropped = await sh(node, [scratchCli, 'drop', rec.url]);
        if (dropped.code !== 0) ok = false;
        rmSync(join(tmpdir(), `${name}.dump`), { force: true });
        if (ok) { rmSync(file, { force: true }); cleaned.push(name); } else skipped.push(`${name}: cleanup not complete, kept for the next run`);
      } catch (e) {
        skipped.push(`${file}: ${maskText(e.message)}`);
      }
    }
  }
  return { cleaned, skipped };
}
