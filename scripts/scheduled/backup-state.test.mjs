// Tests of the task body of the nightly state backup (card ops-state-backup-nightly).
// Files are real (a temp tree); docker, the drill and Notion are fakes. One test per failure named in the design note, sections 3 to 7.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { collectSets, dumpToFile, pruneLocal, runBackup, runOutDir } from './backup-state.mjs';

const TOKEN = 'secret_' + 'x'.repeat(20); // fake, low entropy on purpose (gitleaks)
const sha = (b) => createHash('sha256').update(b).digest('hex');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const mods = '.claude/state/ccv3-mods';
  for (const n of ['decisions.json', 'decision-log.jsonl', 'decision-log-2026-11.jsonl', 'ask-dialogs.jsonl', 'other.json']) put(`home/${mods}/${n}`, n);
  for (const n of ['a.md', 'b.json', 'c.mjs', 'd.jsonl', 'e.txt', 'f.png', 'g.log', 'h.html', 'sub/i.md', 'seat-standing-rules.md']) put(`repo/.claudedocs/coordination/${n}`, n);
  for (const n of ['x.md', 'stall-watch.mjs', 'y.png', 'deep/z.txt']) put(`repo/.claudedocs/re-execution/${n}`, n);
  return { root, home, repo, put, out: path.join(root, 'out'), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const names = (set) => set.map((e) => e.name).sort();

const PLAIN = 'plain-credential-98765'; // does not look like a Notion token: only an explicit secret hides it
function oldRows() {
  return Array.from({ length: 16 }, (_, i) => ({ id: `old${i}`, properties: { Date: { date: { start: `2026-10-${String(i + 1).padStart(2, '0')}` } }, Kind: { select: { name: 'nightly' } }, Status: { select: { name: 'ok' } }, Drill: { select: { name: 'pass' } }, Task: { rich_text: [{ plain_text: 'CCV3-State-Backup' }] } } }));
}
function fakeClient({ failUpload, failRow, listed = [] } = {}) {
  const c = { calls: [], rows: [], queryPath: '/q', parent: { database_id: 'd' } };
  let n = 0;
  c.call = async (method, p, opts) => {
    c.calls.push({ method, p, opts });
    if (p === '/v1/file_uploads') { if (opts.json.filename === failUpload) throw new Error(`upload broke ${TOKEN} ${PLAIN}`); n += 1; return { id: `up${n}` }; }
    if (p === '/q') return { results: listed, has_more: false };
    return {};
  };
  c.createRow = async (props) => { if (failRow) throw new Error(`row broke ${TOKEN} ${PLAIN}`); c.rows.push(props); return { id: 'row1' }; };
  return c;
}
const liveState = { counts: { lane: 1 }, ids: ['a'] };
function deps(over = {}) {
  const logs = [];
  return { logs, dump: async (p) => { fs.writeFileSync(p, Buffer.alloc(2000, 1)); }, readLive: async () => liveState,
    drill: async () => ({ drill: 'pass', detail: 'lane 1 of 1' }), log: (l) => logs.push(l), ...over };
}
const base = (t, extra = {}) => ({ date: '2026-11-25', home: t.home, repo: t.repo, outDir: t.out, minDumpBytes: 1000, ...extra });

test('S1 the sets hold the right text files and nothing else', async () => {
  const t = tree();
  try {
    const s = await collectSets({ home: t.home, repo: t.repo });
    assert.deepEqual(names(s.state), ['ask-dialogs.jsonl', 'decision-log-2026-11.jsonl', 'decision-log.jsonl', 'decisions.json']);
    assert.deepEqual(names(s.coordination), ['a.md', 'b.json', 'c.mjs', 'd.jsonl', 'e.txt', 'seat-standing-rules.md', 'sub/i.md']);
    assert.deepEqual(names(s.seat), ['deep/z.txt', 'stall-watch.mjs', 'x.md']);
  } finally { t.clean(); }
});

test('S1b a link inside a folder is never followed', async () => {
  const t = tree();
  try {
    t.put('outside/secret.md', 'private');
    try { fs.symlinkSync(path.join(t.root, 'outside'), path.join(t.repo, '.claudedocs/coordination/link'), 'junction'); } catch { return; } // no link rights: nothing to prove
    const s = await collectSets({ home: t.home, repo: t.repo });
    assert.ok(!names(s.coordination).some((n) => n.includes('secret') || n.startsWith('link')), names(s.coordination).join());
    assert.ok(fs.existsSync(path.join(t.root, 'outside/secret.md')), 'the target of the link is untouched');
  } finally { t.clean(); }
});

/** A tree where a folder the backup lists is a FILE (readdir gives ENOTDIR, not ENOENT): the folder cannot be listed. */
function brokenTree(which) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-broken-'));
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('home/.claude/state/ccv3-mods/decisions.json', 'd');
  put('repo/.claudedocs/coordination/a.md', 'a');
  put('repo/.claudedocs/re-execution/x.md', 'x');
  const fileInstead = { seat: 'repo/.claudedocs/re-execution', mods: 'home/.claude/state/ccv3-mods' }[which];
  fs.rmSync(path.join(root, fileInstead), { recursive: true, force: true }); // a folder this function made one line above
  put(fileInstead, 'a file where the backup expects a folder');
  return { root, home: path.join(root, 'home'), repo: path.join(root, 'repo'), out: path.join(root, 'out'), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('S1c a folder that cannot be listed rejects the collection; a missing folder is optional', async () => {
  for (const which of ['seat', 'mods']) {
    const t = brokenTree(which);
    try {
      await assert.rejects(collectSets({ home: t.home, repo: t.repo }), (e) => ['ENOTDIR', 'EACCES', 'EPERM'].includes(e.code), which);
    } finally { t.clean(); }
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-empty-'));
  try {
    const s = await collectSets({ home: path.join(empty, 'home'), repo: path.join(empty, 'repo') });
    assert.deepEqual([s.state, s.coordination, s.seat], [[], [], []]);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('S1d one zip that cannot be made is a named collect-failed night; the dump and the other zips still go up', async () => {
  // Breaks when a failed set stops the night before the upload (the dump is lost too), or the Status loses the name of the zip.
  const t = brokenTree('seat');
  try {
    const client = fakeClient();
    const r = await runBackup({ ...base(t), notion: client }, deps());
    assert.equal(r.status, 'collect-failed:ccv3-seat-2026-11-25.zip');
    assert.equal(r.exitCode, 1);
    assert.match(r.row['Drill detail'].rich_text[0].text.content, /ENOTDIR/, 'the row names the listing error, not a side effect such as an empty zip');
    const up = client.calls.filter((c) => c.p === '/v1/file_uploads').map((c) => c.opts.json.filename);
    assert.deepEqual(up, ['ccv3-lanedb-2026-11-25.dump.gz', 'ccv3-state-2026-11-25.zip', 'ccv3-coordination-2026-11-25.zip']);
    assert.equal(client.rows.length, 1, 'a failed night still gets its row');
  } finally { t.clean(); }
});

test('S1e an absent optional folder gives a zip with one EMPTY.txt entry and the night stays ok', async () => {
  // Breaks when an empty set reaches makeZip as an empty list: "zip has no entries" fails the night and nothing goes up.
  const t = tree();
  try {
    fs.rmSync(path.join(t.repo, '.claudedocs', 're-execution'), { recursive: true, force: true }); // made by tree() above
    const r = await runBackup({ ...base(t), dryRun: true }, deps());
    assert.equal(r.status, 'ok');
    assert.ok(fs.readFileSync(path.join(t.out, 'ccv3-seat-2026-11-25.zip')).includes('EMPTY.txt'));
  } finally { t.clean(); }
});

test('S1f a collection root that is itself a link is refused and nothing behind it is read', async () => {
  // Breaks when the root is listed without an lstat: the files of the link target would enter the zip.
  const t = tree();
  try {
    t.put('outside/secret.md', 'private-text');
    const root = path.join(t.repo, '.claudedocs', 'coordination');
    fs.rmSync(root, { recursive: true, force: true }); // made by tree() above
    try { fs.symlinkSync(path.join(t.root, 'outside'), root, 'junction'); } catch { return; } // no link rights: nothing to prove
    await assert.rejects(collectSets({ home: t.home, repo: t.repo }), /collection root is a link/);
    const r = await runBackup({ ...base(t), dryRun: true }, deps());
    assert.equal(r.status, 'collect-failed:ccv3-coordination-2026-11-25.zip');
    assert.ok(fs.existsSync(path.join(t.root, 'outside', 'secret.md')), 'the target of the link is untouched');
    for (const f of fs.readdirSync(t.out)) if (f.endsWith('.zip')) assert.ok(!fs.readFileSync(path.join(t.out, f)).includes('private-text'), f);
  } finally { t.clean(); }
});

test('S2 the dump is gzipped byte for byte, and a failed dump leaves no partial file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-dump-'));
  try {
    const out = path.join(dir, 'a.dump.gz');
    const code = "const b=Buffer.alloc(256);for(let i=0;i<256;i++)b[i]=i;for(let i=0;i<4096;i++)process.stdout.write(b)";
    const r = await dumpToFile({ cmd: process.execPath, args: ['-e', code], outPath: out });
    const want = Buffer.concat(Array.from({ length: 4096 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
    assert.equal(r.bytes, want.length, 'bytes counts the raw output of the child, not the file');
    assert.equal(sha(zlib.gunzipSync(fs.readFileSync(out))), sha(want));
    const bad = path.join(dir, 'b.dump.gz');
    await assert.rejects(dumpToFile({ cmd: process.execPath, args: ['-e', "process.stdout.write('part');process.stderr.write('pg boom');process.exit(3)"], outPath: bad }), /exit 3.*pg boom/s);
    assert.equal(fs.existsSync(bad), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S2b a sink that cannot be written rejects at once with "dump write failed", kills the child, and leaves no file', { timeout: 10000 }, async () => {
  // Breaks when a write error waits for the child to exit: this child writes 2 MiB into a pipe nobody reads, so it blocks and never exits by itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-sink-'));
  const pidFile = path.join(dir, 'child.pid');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const code = "require('fs').writeFileSync(process.argv[1], String(process.pid));const b=Buffer.alloc(65536,1);for(let i=0;i<32;i++)process.stdout.write(b);setInterval(()=>{},1000)";
    const outPath = path.join(dir, 'missing-folder', 'a.dump.gz');
    const pending = dumpToFile({ cmd: process.execPath, args: ['-e', code, pidFile], outPath });
    pending.catch(() => {});
    const watchdog = new Promise((_, no) => setTimeout(no, 8000, new Error('dumpToFile did not settle within 8 s')).unref());
    await assert.rejects(Promise.race([pending, watchdog]), /^Error: dump write failed: /);
    assert.equal(fs.existsSync(path.dirname(outPath)), false);
    // The write error comes before the child has started node, so it may be killed before it writes its pid. A child that was NOT killed writes it within seconds and stays alive.
    await new Promise((r) => setTimeout(r, 2500));
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    assert.ok(!pid || !alive(pid), 'the child must be killed, not left running');
  } finally {
    try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid && alive(pid)) process.kill(pid); } catch { /* the child never started or is gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S2d a write failure kills a child that writes nothing and never exits', { timeout: 10000 }, async () => {
  // Breaks when the child is not killed: it has no output, so closing our end of its pipe does not stop it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-idle-'));
  const pidFile = path.join(dir, 'child.pid');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const code = "require('fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)";
    await assert.rejects(dumpToFile({ cmd: process.execPath, args: ['-e', code, pidFile], outPath: path.join(dir, 'missing-folder', 'a.dump.gz') }), /^Error: dump write failed: /);
    await new Promise((r) => setTimeout(r, 2500)); // a child that was not killed has written its pid by now
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    assert.ok(!pid || !alive(pid), 'the child must be killed, not left running');
  } finally {
    try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid && alive(pid)) process.kill(pid); } catch { /* the child never started or is gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S2c a command that cannot start rejects with "dump could not start" and leaves no file', { timeout: 10000 }, async () => {
  // Breaks when the spawn error is lost: the promise would never settle.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-nostart-'));
  try {
    const out = path.join(dir, 'a.dump.gz');
    await assert.rejects(dumpToFile({ cmd: path.join(dir, 'no-such-command.exe'), args: [], outPath: out }), /^Error: dump could not start: /);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S3 a dry run writes the four files, the manifest and the row, and makes no Notion call', async () => {
  const t = tree();
  try {
    const trap = new Proxy({}, { get() { throw new Error('Notion must not be touched in a dry run'); } });
    const r = await runBackup({ ...base(t), dryRun: true, notion: trap }, deps());
    assert.equal(r.status, 'ok');
    assert.equal(r.exitCode, 0);
    const files = fs.readdirSync(t.out).sort();
    assert.deepEqual(files, ['ccv3-coordination-2026-11-25.zip', 'ccv3-lanedb-2026-11-25.dump.gz', 'ccv3-seat-2026-11-25.zip', 'ccv3-state-2026-11-25.zip', 'drill.json', 'manifest.json', 'row.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(t.out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.length, 4);
    assert.deepEqual(manifest.files.map((f) => [f.name, f.type]), [['ccv3-lanedb-2026-11-25.dump.gz', 'application/gzip'], ['ccv3-state-2026-11-25.zip', 'application/zip'], ['ccv3-coordination-2026-11-25.zip', 'application/zip'], ['ccv3-seat-2026-11-25.zip', 'application/zip']]);
    for (const f of manifest.files) {
      const bytes = fs.readFileSync(path.join(t.out, f.name));
      assert.equal(f.bytes, bytes.length);
      assert.equal(f.sha256, sha(bytes));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.out, 'row.json'), 'utf8')).Status.select.name, 'ok');
  } finally { t.clean(); }
});

test('S4 a failed dump is a row with the name dump-failed, no files and a non-zero exit', async () => {
  const t = tree();
  try {
    const client = fakeClient();
    const r = await runBackup({ ...base(t), notion: client }, deps({ dump: async () => { throw new Error('pg_dump exit 1'); } }));
    assert.equal(r.status, 'dump-failed');
    assert.equal(r.exitCode, 1);
    assert.equal(client.rows[0].Status.select.name, 'dump-failed');
    assert.deepEqual(client.rows[0].Files.files, []);
    assert.ok(!client.calls.some((c) => c.p === '/v1/file_uploads'), 'nothing is uploaded after a failed dump');
  } finally { t.clean(); }
});

test('S5 a dump under the size floor counts as a failed dump', async () => {
  const t = tree();
  try {
    const client = fakeClient();
    const r = await runBackup({ ...base(t), minDumpBytes: 5000, notion: client }, deps());
    assert.equal(r.status, 'dump-failed');
    assert.match(client.rows[0]['Drill detail'].rich_text[0].text.content, /too small/);
  } finally { t.clean(); }
});

test('S6 a failed drill still uploads the files, and the row says drill-failed with Drill fail', async () => {
  const t = tree();
  try {
    const client = fakeClient();
    const r = await runBackup({ ...base(t), notion: client }, deps({ drill: async () => ({ drill: 'fail', detail: 'counts outside the rule: lane' }) }));
    assert.equal(r.status, 'drill-failed');
    assert.equal(r.exitCode, 1);
    assert.equal(client.rows[0].Files.files.length, 4);
    assert.equal(client.rows[0].Drill.select.name, 'fail');
  } finally { t.clean(); }
});

test('S7 an upload that fails names the file, keeps the files already up, and stops', async () => {
  const t = tree();
  try {
    const client = fakeClient({ failUpload: 'ccv3-coordination-2026-11-25.zip' });
    const r = await runBackup({ ...base(t), notion: client }, deps());
    assert.equal(r.status, 'upload-failed:ccv3-coordination-2026-11-25.zip');
    assert.equal(r.exitCode, 1);
    assert.deepEqual(client.rows[0].Files.files.map((f) => f.name), ['ccv3-lanedb-2026-11-25.dump.gz', 'ccv3-state-2026-11-25.zip']);
    assert.ok(!client.calls.some((c) => c.opts?.json?.filename === 'ccv3-seat-2026-11-25.zip'), 'no upload after the failed one');
  } finally { t.clean(); }
});

test('S8 when the row itself cannot be made, a FAILED file stays on disk, masked, and the exit is non-zero', async () => {
  const t = tree();
  try {
    const client = fakeClient({ failRow: true });
    const r = await runBackup({ ...base(t), notion: client, secrets: [TOKEN, PLAIN] }, deps());
    assert.equal(r.exitCode, 1);
    const failed = fs.readFileSync(path.join(t.out, 'FAILED-2026-11-25.json'), 'utf8');
    assert.match(failed, /row broke/);
    assert.ok(!failed.includes(TOKEN) && !failed.includes(PLAIN), failed);
  } finally { t.clean(); }
});

test('S9 a good night: files in order, one ok row, a weekly kind on Sunday, retention named but not run', async () => {
  const t = tree();
  try {
    const client = fakeClient({ listed: oldRows() });
    const r = await runBackup({ ...base(t, { date: '2026-11-29' }), notion: client }, deps());
    assert.equal(r.status, 'ok');
    assert.equal(r.exitCode, 0);
    const up = client.calls.filter((c) => c.p === '/v1/file_uploads').map((c) => c.opts.json.filename);
    assert.deepEqual(up, ['ccv3-lanedb-2026-11-29.dump.gz', 'ccv3-state-2026-11-29.zip', 'ccv3-coordination-2026-11-29.zip', 'ccv3-seat-2026-11-29.zip']);
    assert.equal(client.rows[0].Kind.select.name, 'weekly');
    assert.equal(client.rows[0].Drill.select.name, 'pass');
    assert.ok(!client.calls.some((c) => c.method === 'PATCH'), 'no trash without allowTrash');
    const yes = fakeClient({ listed: oldRows() });
    const trashing = await runBackup({ ...base(t, { date: '2026-11-29' }), notion: yes, allowTrash: true }, deps());
    assert.equal(trashing.trashed.length, 2);
    assert.equal(yes.calls.filter((c) => c.method === 'PATCH').length, 2);
    const nightly = await runBackup({ ...base(t), notion: fakeClient() }, deps());
    assert.equal(nightly.manifest.kind, 'nightly');
  } finally { t.clean(); }
});

test('S10 the token never reaches a log line or a file written to disk', async () => {
  const t = tree();
  try {
    const d = deps();
    await runBackup({ ...base(t), notion: fakeClient({ failUpload: 'ccv3-state-2026-11-25.zip' }), secrets: [TOKEN, PLAIN] }, d);
    assert.ok(!d.logs.join('\n').includes(TOKEN));
    for (const f of fs.readdirSync(t.out)) if (!f.endsWith('.dump.gz') && !f.endsWith('.zip')) { const text = fs.readFileSync(path.join(t.out, f), 'utf8'); assert.ok(!text.includes(TOKEN) && !text.includes(PLAIN), f); }
  } finally { t.clean(); }
});

test('S11 local copies: dated folders older than 14 days go, other names and files stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-prune-'));
  try {
    for (const n of ['2026-11-25', '2026-11-11', '2026-11-10', '2026-10-01', 'notes', '2026-13-45']) fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, '2026-01-01'), 'a file with a date name');
    fs.mkdirSync(path.join(dir, 'keepme'));
    const gone = pruneLocal(dir, { now: '2026-11-25' });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-01-01', '2026-11-11', '2026-11-25', '2026-13-45', 'keepme', 'notes']);
    assert.deepEqual(gone.sort(), ['2026-10-01', '2026-11-10']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- finding 4: each real run has its own folder; the local prune is a delete path, so it is fenced ----
const exists = (p) => fs.existsSync(p);
const unlinkLink = (p) => { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* not a link, or gone */ } } };

test('P1 runOutDir: two runs on one date never share a folder, and all sit under backups/<date>', () => {
  const now = new Date(2026, 10, 25, 3, 10, 7); // local time
  const a = runOutDir({ home: 'H', date: '2026-11-25', now, pid: 1234 });
  assert.equal(a, path.join('H', '.claude', 'state', 'backups', '2026-11-25', 'run-031007-1234'));
  const samePid = runOutDir({ home: 'H', date: '2026-11-25', now: new Date(2026, 10, 25, 7, 40, 0), pid: 1234 });
  const sameTime = runOutDir({ home: 'H', date: '2026-11-25', now, pid: 99 });
  for (const other of [samePid, sameTime]) {
    assert.notEqual(other, a);
    assert.equal(path.dirname(other), path.dirname(a));
  }
  assert.equal(path.basename(path.dirname(a)), '2026-11-25');
});

test('P2 runBackup prunes the backups root only when pruneRoot is set', async () => {
  const t = tree();
  try {
    const rootA = path.join(t.root, 'backups-a');
    const rootB = path.join(t.root, 'backups-b');
    for (const r of [rootA, rootB]) { t.put(`${path.basename(r)}/2026-09-01/old.txt`); t.put(`${path.basename(r)}/2026-11-24/recent.txt`); }
    await runBackup({ ...base(t, { outDir: path.join(rootA, '2026-11-25', 'run-1'), pruneRoot: rootA }), notion: fakeClient() }, deps());
    assert.equal(exists(path.join(rootA, '2026-09-01')), false, 'old dated folder removed when pruneRoot is set');
    assert.equal(exists(path.join(rootA, '2026-11-24', 'recent.txt')), true);
    await runBackup({ ...base(t, { outDir: path.join(rootB, '2026-11-25'), repo: t.repo }), notion: fakeClient() }, deps());
    assert.equal(exists(path.join(rootB, '2026-09-01', 'old.txt')), true, 'no pruneRoot: no prune, even when the folder is named like the date');
  } finally { t.clean(); }
});

test('P3 pruneLocal removes nothing outside the folder it is given', () => {
  const t = tree();
  try {
    t.put('a/backups/2026-09-01/old.txt');
    t.put('a/2026-09-01/sibling.txt'); // a sibling of the prune root, named like an old date
    t.put('a/outside.txt');
    const gone = pruneLocal(path.join(t.root, 'a', 'backups'), { now: '2026-11-25' });
    assert.deepEqual(gone, ['2026-09-01']);
    assert.equal(exists(path.join(t.root, 'a', 'backups', '2026-09-01')), false);
    assert.equal(exists(path.join(t.root, 'a', '2026-09-01', 'sibling.txt')), true);
    assert.equal(exists(path.join(t.root, 'a', 'outside.txt')), true);
  } finally { t.clean(); }
});

test('P4 pruneLocal never follows a junction: the old folder goes, the target of the link stays', () => {
  const t = tree();
  const link = path.join(t.root, 'backups', '2026-09-01', 'link');
  try {
    t.put('backups/2026-09-01/old.txt');
    t.put('target/marker.txt', 'must survive');
    try { fs.symlinkSync(path.join(t.root, 'target'), link, 'junction'); } catch { return; } // no link rights: nothing to prove
    const gone = pruneLocal(path.join(t.root, 'backups'), { now: '2026-11-25' });
    assert.deepEqual(gone, ['2026-09-01']);
    assert.equal(exists(path.join(t.root, 'backups', '2026-09-01')), false);
    assert.equal(fs.readFileSync(path.join(t.root, 'target', 'marker.txt'), 'utf8'), 'must survive');
  } finally { unlinkLink(link); t.clean(); }
});

test('P4b a dated folder that is itself a link is skipped', () => {
  const t = tree();
  const link = path.join(t.root, 'backups', '2026-09-01');
  try {
    t.put('target/marker.txt', 'must survive');
    fs.mkdirSync(path.join(t.root, 'backups'), { recursive: true });
    try { fs.symlinkSync(path.join(t.root, 'target'), link, 'junction'); } catch { return; }
    assert.deepEqual(pruneLocal(path.join(t.root, 'backups'), { now: '2026-11-25' }), []);
    assert.equal(fs.readFileSync(path.join(t.root, 'target', 'marker.txt'), 'utf8'), 'must survive');
  } finally { unlinkLink(link); t.clean(); }
});

test('P5 the run folder of the current run is never removed, even inside an old dated folder', async () => {
  const t = tree();
  try {
    const root = path.join(t.root, 'backups');
    t.put('backups/2026-09-01/other-run/x.txt');
    t.put('backups/2026-10-01/y.txt');
    const outDir = path.join(root, '2026-09-01', 'run-own');
    assert.deepEqual(pruneLocal(root, { now: '2026-11-25', keep: outDir }), ['2026-10-01']);
    assert.equal(exists(path.join(root, '2026-09-01', 'other-run', 'x.txt')), true, 'the dated folder that holds the current run stays whole');
    const r = await runBackup({ ...base(t, { outDir, pruneRoot: root }), notion: fakeClient() }, deps());
    assert.equal(r.status, 'ok');
    assert.equal(exists(path.join(outDir, 'manifest.json')), true, 'files of the current run stay');
    assert.equal(exists(path.join(outDir, 'ccv3-lanedb-2026-11-25.dump.gz')), true);
  } finally { t.clean(); }
});

test('P6 a bad prune root is an error: pruneLocal throws, runBackup logs "local prune skipped", nothing is deleted', async () => {
  const t = tree();
  try {
    t.put('repo/2026-09-01/precious.txt'); // an old dated folder inside the repo root
    t.put('notes.txt');
    // 1990-01-01 as now: even a guard that failed here could not remove a real folder of the home or the drive root.
    const long = { now: '1990-01-01' };
    const bad = [undefined, '', 42, null, 'backups', path.join('relative', 'backups'), path.join(t.root, 'no-such-folder'), path.join(t.root, 'notes.txt'), os.homedir(), path.parse(os.tmpdir()).root];
    for (const dir of bad) assert.throws(() => pruneLocal(dir, long), Error, `pruneRoot ${String(dir)}`);
    assert.throws(() => pruneLocal(t.repo, { now: '2026-11-25', repo: t.repo }), /repo/);
    t.put('backups2/2026-09-01/x.txt');
    for (const now of [undefined, '', 'today', '2026-13-45']) assert.throws(() => pruneLocal(path.join(t.root, 'backups2'), { now }), Error, `a bad date ${String(now)} must not delete everything`);
    assert.equal(exists(path.join(t.root, 'backups2', '2026-09-01', 'x.txt')), true);
    assert.equal(exists(path.join(t.repo, '2026-09-01', 'precious.txt')), true);
    for (const pruneRoot of ['', 42, 'backups', path.join(t.root, 'no-such-folder'), t.repo]) {
      const d = deps();
      await runBackup({ ...base(t, { pruneRoot }), notion: fakeClient() }, d);
      assert.ok(d.logs.some((l) => l.startsWith('local prune skipped: ')), `pruneRoot ${String(pruneRoot)}: ${d.logs.join(' | ')}`);
    }
    assert.equal(exists(path.join(t.repo, '2026-09-01', 'precious.txt')), true, 'the repo root is never pruned');
    assert.equal(exists(path.join(t.root, 'notes.txt')), true);
  } finally { t.clean(); }
});

// ---- credential at rest (seat ruling 19:17): the token comes from the wrapper in one env variable, never from a plain file ----
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCredential, takeCredential } from './backup-state.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup-state.mjs');
const FRESH = 'secret_' + 'y'.repeat(20); // fake, low entropy on purpose (gitleaks)

test('C1 resolveCredential: a token needs the env variable; a named state fails closed; nothing is no-credential', () => {
  assert.deepEqual(resolveCredential({ CCV3_BACKUP_NOTION_TOKEN: FRESH }), { token: FRESH });
  assert.deepEqual(resolveCredential({ CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CREDENTIAL_STATE: 'not-protected' }), { status: 'credential-not-protected' });
  assert.deepEqual(resolveCredential({ CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CREDENTIAL_STATE: 'unreadable' }), { status: 'credential-unreadable' });
  assert.deepEqual(resolveCredential({}), { status: 'no-credential' });
  assert.deepEqual(resolveCredential({ CCV3_BACKUP_NOTION_TOKEN: '   ' }), { status: 'no-credential' });
});

test('C1b takeCredential hands over the token and removes it from the env that every child process inherits', () => {
  // Breaks when the token stays in process.env: docker and the scratch CLI would start with it.
  const env = { CCV3_BACKUP_NOTION_TOKEN: FRESH, KEEP: '1' };
  assert.deepEqual(takeCredential(env), { token: FRESH });
  assert.deepEqual(env, { KEEP: '1' });
  const flagged = { CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CREDENTIAL_STATE: 'unreadable' };
  assert.deepEqual(takeCredential(flagged), { status: 'credential-unreadable' });
  assert.equal('CCV3_BACKUP_NOTION_TOKEN' in flagged, false, 'a refused credential leaves no token behind either');
});

/** A live (not dry-run) start in a child process, with a clean env. Stops at the credential check: no Docker, no Notion. */
function liveRun(t, env) {
  const clean = { ...process.env, USERPROFILE: t.home, HOME: t.home };
  for (const k of Object.keys(clean)) if (k.startsWith('CCV3_BACKUP_')) delete clean[k];
  const r = spawnSync(process.execPath, [SCRIPT, '--date', '2026-11-25', '--out', t.out, '--repo', t.repo], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 60000 });
  const failedPath = path.join(t.out, 'FAILED-2026-11-25.json');
  const failed = fs.existsSync(failedPath) ? JSON.parse(fs.readFileSync(failedPath, 'utf8')) : null;
  return { code: r.status, failed, text: `${r.stdout}\n${r.stderr}\n${failed ? JSON.stringify(failed) : ''}` };
}

test('C2 a plain-text or unreadable credential fails closed with a named status, exit 2, and no token in any output', () => {
  const t = tree();
  try {
    const notProtected = liveRun(t, { CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CREDENTIAL_STATE: 'not-protected' });
    assert.equal(notProtected.code, 2);
    assert.equal(notProtected.failed.status, 'credential-not-protected');
    assert.ok(!notProtected.text.includes(FRESH), notProtected.text);
    const unreadable = liveRun(t, { CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CREDENTIAL_STATE: 'unreadable' });
    assert.equal(unreadable.failed.status, 'credential-unreadable');
    assert.ok(!unreadable.text.includes(FRESH));
  } finally { t.clean(); }
});

test('C3 with no credential the run exits 2 as no-credential; an old plain token file is never read', () => {
  const t = tree();
  try {
    t.put('home/.claude/state/backup-notion-token', FRESH);
    const none = liveRun(t, {});
    assert.equal(none.code, 2);
    assert.equal(none.failed.status, 'no-credential');
    assert.ok(!none.text.includes(FRESH), 'the plain file must not be read or printed');
  } finally { t.clean(); }
});

test('C4 a token without the database config is no-config: exit 2, a FAILED file, the token nowhere in the output', () => {
  const t = tree();
  try {
    const r = liveRun(t, { CCV3_BACKUP_NOTION_TOKEN: FRESH, CCV3_BACKUP_CONFIG: path.join(t.root, 'missing.json') });
    assert.equal(r.code, 2);
    assert.equal(r.failed.status, 'no-config');
    assert.ok(!r.text.includes(FRESH), r.text);
  } finally { t.clean(); }
});
