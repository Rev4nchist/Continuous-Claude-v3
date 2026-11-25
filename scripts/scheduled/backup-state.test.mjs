// Tests of the task body of the nightly state backup (card ops-state-backup-nightly).
// Files are real (a temp tree); docker, the drill and Notion are fakes. One test per failure named in the design note, sections 3 to 7.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectSets, dumpToFile, pruneLocal, runBackup } from './backup-state.mjs';

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

test('S2 the dump is copied byte for byte, and a failed dump leaves no partial file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-dump-'));
  try {
    const out = path.join(dir, 'a.dump');
    const code = "const b=Buffer.alloc(256);for(let i=0;i<256;i++)b[i]=i;for(let i=0;i<4096;i++)process.stdout.write(b)";
    const r = await dumpToFile({ cmd: process.execPath, args: ['-e', code], outPath: out });
    const want = Buffer.concat(Array.from({ length: 4096 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
    assert.equal(r.bytes, want.length);
    assert.equal(sha(fs.readFileSync(out)), sha(want));
    const bad = path.join(dir, 'b.dump');
    await assert.rejects(dumpToFile({ cmd: process.execPath, args: ['-e', "process.stdout.write('part');process.stderr.write('pg boom');process.exit(3)"], outPath: bad }), /exit 3.*pg boom/s);
    assert.equal(fs.existsSync(bad), false);
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
    assert.deepEqual(files, ['ccv3-coordination-2026-11-25.zip', 'ccv3-lanedb-2026-11-25.dump', 'ccv3-seat-2026-11-25.zip', 'ccv3-state-2026-11-25.zip', 'drill.json', 'manifest.json', 'row.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(t.out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.length, 4);
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
    assert.deepEqual(client.rows[0].Files.files.map((f) => f.name), ['ccv3-lanedb-2026-11-25.dump', 'ccv3-state-2026-11-25.zip']);
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
    assert.deepEqual(up, ['ccv3-lanedb-2026-11-29.dump', 'ccv3-state-2026-11-29.zip', 'ccv3-coordination-2026-11-29.zip', 'ccv3-seat-2026-11-29.zip']);
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
    for (const f of fs.readdirSync(t.out)) if (!f.endsWith('.dump') && !f.endsWith('.zip')) { const text = fs.readFileSync(path.join(t.out, f), 'utf8'); assert.ok(!text.includes(TOKEN) && !text.includes(PLAIN), f); }
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
