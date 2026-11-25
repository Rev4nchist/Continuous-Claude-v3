#!/usr/bin/env node
/**
 * Nightly state backup (card ops-state-backup-nightly). Design: .claudedocs/e2e-ops-state-backup-nightly/00-design-note.md.
 *
 *   node scripts/scheduled/backup-state.mjs --dry-run --out <dir>   make the four files, the manifest, the row and the drill result in <dir>;
 *                                                                   no Notion call. The drill runs on a scratch database.
 *   node scripts/scheduled/backup-state.mjs                         the real night: files in ~/.claude/state/backups/<date>/run-<time>-<pid>, upload, one row.
 *                                                                   Needs the credential and the database id (Dave's yes, not set up yet).
 *   --repo <dir>                                                    the checkout that holds .claudedocs (the primary checkout; default: this one)
 *   --allow-trash                                                let the retention step move old rows to the Notion trash (Dave's yes).
 *
 * The dump file is gzip (ccv3-lanedb-<date>.dump.gz): gunzip it before pg_restore.
 * Order of a night: read the live lane ids, dump, read the live counts, zip the three sets, manifest, restore drill, upload,
 * one row (a failed night gets a row too, with a named Status), retention, local prune. Exit 0 only when Status is ok.
 * The task runs with llm=false: no model reads the dump. A module too: the exports below are what the tests call.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { createGzip } from 'node:zlib';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeZip } from './zip-lite.mjs';
import { MiB, maskText } from './backup-state-lib.mjs';
import { listRows, makeNotion, rowProperties, runRetention, uploadFile } from './backup-notion.mjs';
import { readState, runDrill } from './backup-drill.mjs';

const TEXT = /\.(md|json|mjs|jsonl|txt)$/i;
const KEEP_LOCAL_DAYS = 14;
const DOCKER_EXE = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const CONTAINER = 'continuous-claude-postgres';

/** readdir that treats a missing folder (ENOENT) as empty. Any other error (no right, not a folder) is thrown: a partial backup must not look whole. */
function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
}

/** Text files below dir, as { name: 'a/b.md', data }. A link (symlink or junction) is never followed: only plain files and folders count. */
function walk(dir, prefix = '') {
  const out = [];
  const entries = listDir(dir);
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else if (e.isFile() && TEXT.test(e.name)) out.push({ name: rel, data: readFileSync(join(dir, e.name)) });
  }
  return out;
}

/** The three zip sets of a night: state (decisions and the decision log), coordination (the seat notes), seat (re-execution). */
export async function collectSets({ home, repo }) {
  const mods = join(home, '.claude', 'state', 'ccv3-mods');
  const top = listDir(mods).filter((e) => e.isFile()).map((e) => e.name); // no folder yet: empty
  const state = top
    .filter((n) => n === 'decisions.json' || n === 'ask-dialogs.jsonl' || /^decision-log.*\.jsonl$/.test(n))
    .map((n) => ({ name: n, data: readFileSync(join(mods, n)) }));
  return {
    state,
    coordination: walk(join(repo, '.claudedocs', 'coordination')),
    seat: walk(join(repo, '.claudedocs', 're-execution')),
  };
}

/**
 * Run a command and write its stdout, gzipped, to outPath (gunzip gives the stdout back byte for byte). Resolves { bytes }: the raw stdout bytes.
 * Any failure rejects ONCE with a masked message, kills the child, destroys the streams and removes the partial file after the file stream is closed:
 *   dump could not start / dump exit N: <stderr> / dump write failed / dump compress failed / dump read failed.
 * A failed sink never waits for the child to exit: a child that fills a pipe nobody reads would block for ever.
 */
export function dumpToFile({ cmd, args, outPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const gzip = createGzip();
    const sink = createWriteStream(outPath);
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let exitedOk = false;
    let sinkDone = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      child.kill();
      child.stdout.destroy();
      gzip.destroy();
      sink.destroy();
      const remove = () => { try { unlinkSync(outPath); } catch { /* none */ } reject(new Error(maskText(message))); };
      if (sink.closed) remove(); else sink.once('close', remove); // a file that is still open cannot be removed on Windows
    };
    const finish = () => { if (!settled && exitedOk && sinkDone) { settled = true; resolve({ bytes }); } };
    child.stdout.on('data', (c) => { bytes += c.length; });
    child.stdout.on('error', (e) => fail(`dump read failed: ${e.message}`));
    child.stdout.pipe(gzip).pipe(sink);
    child.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c.toString('utf8'); });
    gzip.on('error', (e) => fail(`dump compress failed: ${e.message}`));
    sink.on('error', (e) => fail(`dump write failed: ${e.message}`));
    sink.on('finish', () => { sinkDone = true; finish(); });
    child.on('error', (e) => fail(`dump could not start: ${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) return fail(`dump exit ${code}: ${stderr}`);
      exitedOk = true;
      return finish();
    });
  });
}

/** The folder of ONE real run: <home>/.claude/state/backups/<date>/run-<HHmmss local>-<pid>. Two runs on one date never share files. */
export function runOutDir({ home, date, now = new Date(), pid = process.pid }) {
  const two = (n) => String(n).padStart(2, '0');
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return join(home, '.claude', 'state', 'backups', date, `run-${time}-${pid}`);
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const days = (s) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const holds = (folder, inner) => { const rel = relative(resolve(folder), resolve(inner)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/** Remove a folder tree. A link (symlink or junction) is removed itself and never followed. */
function removeTree(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) { try { unlinkSync(full); } catch { rmdirSync(full); } } else if (e.isDirectory()) removeTree(full); else unlinkSync(full);
  }
  rmdirSync(dir);
}

/**
 * Remove dated folders (YYYY-MM-DD, plain folders only) older than 14 days from `dir`, the backups root. Returns the removed names.
 * Nothing outside `dir` is touched. Refused with an error (nothing removed): a root that is not a string, not absolute, not an existing folder,
 * the home folder, a drive root, or opts.repo; a now that is not a real date. A dated folder that holds opts.keep (the current run) stays.
 */
export function pruneLocal(dir, { now, keep = null, repo = null } = {}) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) throw new Error('prune root must be an absolute folder path');
  if (!isDate(now)) throw new Error('prune needs a real date as now');
  if (samePath(dir, parse(resolve(dir)).root)) throw new Error('prune root is a drive root: refused');
  if (samePath(dir, homedir())) throw new Error('prune root is the home folder: refused');
  if (repo && samePath(dir, repo)) throw new Error('prune root is the repo root: refused');
  if (!lstatSync(dir).isDirectory()) throw new Error('prune root is not a plain folder');
  const gone = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !isDate(e.name) || days(now) - days(e.name) <= KEEP_LOCAL_DAYS) continue;
    const full = join(dir, e.name);
    if (lstatSync(full).isSymbolicLink() || (keep && holds(full, keep))) continue;
    removeTree(full);
    gone.push(e.name);
  }
  return gone;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function sliceReader(path) {
  const fd = openSync(path, 'r');
  return { readSlice: (s, e) => { const b = Buffer.alloc(e - s); readSync(fd, b, 0, e - s, s); return b; }, close: () => closeSync(fd) };
}

/**
 * opts: { date, home, repo, outDir, dryRun, notion, minDumpBytes, allowTrash, secrets, pruneRoot }
 * pruneRoot: the backups root to prune after a real night; unset means no prune. A bad value is logged as "local prune skipped", never acted on.
 * deps: { dump(outPath), readLive() -> { counts, ids }, drill({ dumpPath, live }), log(line) }
 * Returns { status, exitCode, manifest, drill, row, trashed }.
 */
export async function runBackup(opts, deps) {
  const { date, home, repo, outDir, dryRun = false, notion = null, minDumpBytes = MiB, allowTrash = false, secrets = [], pruneRoot } = opts;
  const log = (m) => deps.log(String(m)); // every message passed in is already masked by say()
  const say = (e) => maskText(e?.message ?? String(e), { secrets });
  mkdirSync(outDir, { recursive: true });
  const manifest = { date, kind: new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? 'weekly' : 'nightly', host: hostname(), files: [] };
  let status = 'ok';
  let detail = '';
  let drill = { drill: 'not-run', detail: '' };
  const dumpName = `ccv3-lanedb-${date}.dump.gz`;
  const dumpPath = join(outDir, dumpName);

  let before = null;
  let after = null;
  try { before = await deps.readLive(); } catch (e) { detail = `live state not read: ${say(e)}`; }
  try {
    await deps.dump(dumpPath);
    const size = statSync(dumpPath).size;
    if (size < minDumpBytes) throw new Error(`dump too small: ${size} bytes`);
    after = await deps.readLive().catch(() => null);
  } catch (e) {
    status = 'dump-failed';
    detail = say(e);
    log(`dump failed: ${detail}`);
  }

  if (status === 'ok') {
    try {
      const sets = await collectSets({ home, repo });
      const zips = [['state', sets.state], ['coordination', sets.coordination], ['seat', sets.seat]];
      const files = [{ name: dumpName, path: dumpPath, type: 'application/gzip' }];
      for (const [label, entries] of zips) {
        const name = `ccv3-${label}-${date}.zip`;
        try { writeFileSync(join(outDir, name), makeZip(entries)); } catch (e) { status = `collect-failed:${name}`; detail = say(e); break; }
        files.push({ name, path: join(outDir, name), type: 'application/zip' });
      }
      if (status === 'ok') {
        for (const f of files) {
          const bytes = readFileSync(f.path);
          manifest.files.push({ name: f.name, bytes: bytes.length, sha256: sha256(bytes), type: f.type });
        }
      }
    } catch (e) { status = 'collect-failed'; detail = say(e); }
  }
  if (status === 'ok') writeJson(join(outDir, 'manifest.json'), manifest);

  if (status === 'ok') {
    if (!before || !after) {
      drill = { drill: 'fail', detail: detail || 'live state not read, no comparison possible' };
    } else {
      try { drill = await deps.drill({ dumpPath, live: { counts: after.counts, idsBefore: before.ids, idsAfter: after.ids } }); } catch (e) { drill = { drill: 'fail', detail: say(e) }; }
    }
    if (drill.drill !== 'pass') status = 'drill-failed';
    writeJson(join(outDir, 'drill.json'), drill);
  }

  if (!dryRun && notion) {
    for (const f of manifest.files) {
      const reader = sliceReader(join(outDir, f.name));
      try {
        const up = await uploadFile(notion, { filename: f.name, contentType: f.type, size: f.bytes, readSlice: reader.readSlice });
        f.uploadId = up.id;
      } catch (e) {
        if (status === 'ok' || status === 'drill-failed') status = e.code === 'over-limit' ? `over-limit:${f.name}` : `upload-failed:${f.name}`;
        detail = say(e);
        log(`upload failed: ${detail}`);
        break;
      } finally { reader.close(); }
    }
  }

  const row = rowProperties(manifest, { status, drill: drill.drill, drillDetail: [detail, drill.detail].filter(Boolean).join(' | ') });
  writeJson(join(outDir, 'row.json'), row);
  const result = { status, exitCode: status === 'ok' ? 0 : 1, manifest, drill, row, trashed: [] };
  if (dryRun) return result;

  try {
    await notion.createRow(row);
  } catch (e) {
    writeJson(join(outDir, `FAILED-${date}.json`), { date, status, error: say(e) });
    log(`row not made: ${say(e)}`);
    return { ...result, exitCode: 1 };
  }
  try {
    const rows = await listRows(notion);
    const kept = await runRetention(notion, rows, { now: date, allowTrash });
    result.trashed = kept.trashed;
    log(`retention: ${kept.wouldTrash.length} row(s) outside the window, ${kept.trashed.length} trashed`);
  } catch (e) { log(`retention skipped: ${say(e)}`); }
  if (pruneRoot !== undefined) { try { pruneLocal(pruneRoot, { now: date, keep: outDir, repo }); } catch (e) { log(`local prune skipped: ${say(e)}`); } }
  return result;
}

// ---- command line: the real outside calls (docker, psql, Notion). The tests above never reach this part. ----

/** Run a command and collect its text output. */
function sh(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const CREDENTIAL_TEXT = {
  'no-credential': 'no Notion credential was handed to the task (the wrapper decrypts it from a DPAPI file)',
  'credential-not-protected': 'the credential file is plain text, not DPAPI protected; it was not used',
  'credential-unreadable': 'the credential file could not be decrypted for this user',
};

/**
 * The token comes from the wrapper in one env variable, for this process only. Never from a file here: a plain file at rest is what the
 * seat ruled out (19:17). The wrapper sets CCV3_BACKUP_CREDENTIAL_STATE when the file is plain text or cannot be decrypted; that state wins.
 */
export function resolveCredential(env) {
  if (env.CCV3_BACKUP_CREDENTIAL_STATE === 'not-protected') return { status: 'credential-not-protected' };
  if (env.CCV3_BACKUP_CREDENTIAL_STATE === 'unreadable') return { status: 'credential-unreadable' };
  const token = (env.CCV3_BACKUP_NOTION_TOKEN ?? '').trim();
  return token ? { token } : { status: 'no-credential' };
}

const today = () => new Date().toLocaleDateString('en-CA');

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  // The notes of .claudedocs are git-excluded: they exist only in the primary checkout. The wrapper passes --repo <primary checkout>.
  const repo = val('--repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const home = homedir();
  const date = val('--date') ?? today();
  const dryRun = flag('--dry-run');
  // A real run gets its own folder under the date, so two runs on one date never share files. Only a default folder is pruned.
  const outDir = val('--out') ?? runOutDir({ home, date });
  const pruneRoot = val('--out') ? undefined : join(home, '.claude', 'state', 'backups');
  if (dryRun && !val('--out')) throw new Error('--dry-run needs --out <dir>');
  const docker = existsSync(DOCKER_EXE) ? DOCKER_EXE : 'docker';
  const node = process.execPath;

  let notion = null;
  let secrets = [];
  if (!dryRun) {
    const cred = resolveCredential(process.env);
    const configFile = process.env.CCV3_BACKUP_CONFIG ?? join(home, '.claude', 'state', 'backup-notion.json');
    const stop = (status, error) => {
      mkdirSync(outDir, { recursive: true });
      writeJson(join(outDir, `FAILED-${date}.json`), { date, status, error });
      console.error(`backup-state: ${status}; nothing uploaded`);
      return 2;
    };
    if (cred.status) return stop(cred.status, CREDENTIAL_TEXT[cred.status]);
    if (!existsSync(configFile)) return stop('no-config', 'the Notion database id file is not set up');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    secrets = [cred.token];
    notion = makeNotion({ token: cred.token, parent: config.parent, queryPath: config.queryPath });
  }

  const dbCtx = { db: 'continuous_claude', container: CONTAINER, user: 'claude', docker };
  const deps = {
    log: (line) => console.log(line),
    readLive: () => readState(sh, dbCtx),
    dump: (outPath) => dumpToFile({ cmd: docker, args: ['exec', CONTAINER, 'pg_dump', '-U', 'claude', '-Fc', '-Z', '9', 'continuous_claude'], outPath }),
    drill: ({ dumpPath, live }) => runDrill({ sh, dumpPath, live, repo, container: CONTAINER, docker, node }),
  };
  const r = await runBackup({ date, home, repo, outDir, dryRun, notion, allowTrash: flag('--allow-trash'), secrets, pruneRoot }, deps);
  console.log(JSON.stringify({ status: r.status, exitCode: r.exitCode, drill: r.drill.drill, files: r.manifest.files.map((f) => ({ name: f.name, bytes: f.bytes })), outDir }));
  return r.exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(maskText(e.message)); process.exit(1); });
}
