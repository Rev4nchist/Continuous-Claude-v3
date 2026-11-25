// Tests of the Notion client of the nightly state backup (card ops-state-backup-nightly).
// A real local http server plays Notion: every request is recorded, so a test reads what the client really sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { makeNotion, uploadFile, rowProperties, listRows, runRetention } from './backup-notion.mjs';
import { MiB } from './backup-state-lib.mjs';

const TOKEN = 'secret_' + 'x'.repeat(20); // fake, low entropy on purpose (gitleaks)

/** routes: (req) => { status?, json } | undefined. Returns { url, seen, close }. */
async function fakeNotion(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const rec = { method: req.method, path: req.url, headers: req.headers, body };
      seen.push(rec);
      const out = (await handler(rec, seen)) ?? { json: {} };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
const client = (url, extra = {}) => makeNotion({ base: url, token: TOKEN, parent: { database_id: 'db1' }, queryPath: '/v1/databases/db1/query', ...extra });
const json = (rec) => JSON.parse(rec.body.toString('utf8'));
const file = (size, fill = 7) => { const b = Buffer.alloc(size, fill); return { size, readSlice: (s, e) => b.subarray(s, e), buf: b }; };

test('N1 single part: create, then send the exact bytes, and return the id', async () => {
  const srv = await fakeNotion((rec) => {
    if (rec.path === '/v1/file_uploads') return { json: { id: 'up1', status: 'pending' } };
    if (rec.path === '/v1/file_uploads/up1/send') return { json: { id: 'up1', status: 'uploaded' } };
  });
  try {
    const f = file(1000);
    const out = await uploadFile(client(srv.url), { filename: 'a.dump', contentType: 'application/octet-stream', ...f });
    assert.equal(out.id, 'up1');
    assert.equal(out.mode, 'single');
    assert.deepEqual(srv.seen.map((r) => r.path), ['/v1/file_uploads', '/v1/file_uploads/up1/send']);
    const create = json(srv.seen[0]);
    assert.equal(create.filename, 'a.dump');
    assert.equal(create.content_type, 'application/octet-stream');
    assert.ok(create.mode === undefined || create.mode === 'single_part');
    const form = await new Response(srv.seen[1].body, { headers: { 'content-type': srv.seen[1].headers['content-type'] } }).formData();
    const sent = Buffer.from(await form.get('file').arrayBuffer());
    assert.equal(createHash('sha256').update(sent).digest('hex'), createHash('sha256').update(f.buf).digest('hex'));
    assert.equal(form.get('part_number'), null);
  } finally { await srv.close(); }
});

test('N2 multi part: parts numbered 1..n of 10 MiB, complete only after the last part', async () => {
  const srv = await fakeNotion((rec) => {
    if (rec.path === '/v1/file_uploads') return { json: { id: 'up2', status: 'pending' } };
    return { json: { id: 'up2', status: 'uploaded' } };
  });
  try {
    const f = file(25 * MiB);
    const out = await uploadFile(client(srv.url), { filename: 'big.dump', contentType: 'application/octet-stream', ...f });
    assert.equal(out.mode, 'multi');
    assert.equal(json(srv.seen[0]).mode, 'multi_part');
    assert.equal(json(srv.seen[0]).number_of_parts, 3);
    const sends = srv.seen.filter((r) => r.path === '/v1/file_uploads/up2/send');
    assert.equal(sends.length, 3);
    const sizes = [];
    for (const [i, rec] of sends.entries()) {
      const form = await new Response(rec.body, { headers: { 'content-type': rec.headers['content-type'] } }).formData();
      assert.equal(form.get('part_number'), String(i + 1));
      sizes.push((await form.get('file').arrayBuffer()).byteLength);
    }
    assert.deepEqual(sizes, [10 * MiB, 10 * MiB, 5 * MiB]);
    assert.equal(srv.seen.at(-1).path, '/v1/file_uploads/up2/complete');
    assert.equal(srv.seen.at(-1).method, 'POST');
  } finally { await srv.close(); }
});

test('N3 an empty file and a file over the workspace limit stop before any request', async () => {
  const srv = await fakeNotion(() => ({ json: {} }));
  try {
    await assert.rejects(uploadFile(client(srv.url), { filename: 'e', contentType: 'x/y', ...file(0) }), (e) => e.code === 'empty');
    await assert.rejects(uploadFile(client(srv.url), { filename: 'o', contentType: 'x/y', maxBytes: 500, ...file(1000) }), (e) => e.code === 'over-limit');
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('N4 an error from Notion carries the status and never the token', async () => {
  const srv = await fakeNotion((rec) => ({ status: 401, json: { message: `bad token ${rec.headers.authorization}` } }));
  try {
    await assert.rejects(uploadFile(client(srv.url), { filename: 'a', contentType: 'x/y', ...file(10) }), (e) => {
      assert.equal(e.status, 401);
      assert.ok(!e.message.includes(TOKEN), e.message);
      assert.ok(!e.message.includes('x'.repeat(20)), e.message);
      return true;
    });
  } finally { await srv.close(); }
});

test('N5 every request has the bearer token, the pinned version and the row is built from the manifest', async () => {
  const srv = await fakeNotion(() => ({ json: { id: 'row1', url: 'https://notion.example/row1' } }));
  try {
    const manifest = { date: '2026-11-25', kind: 'weekly', files: [
      { name: 'a.dump', bytes: 10, sha256: 'aa'.repeat(32), uploadId: 'u1' },
      { name: 'b.zip', bytes: 20, sha256: 'bb'.repeat(32), uploadId: 'u2' } ] };
    const props = rowProperties(manifest, { status: 'ok', drill: 'pass', drillDetail: 'lane 150 of 150' });
    const c = client(srv.url);
    const row = await c.createRow(props);
    assert.equal(row.id, 'row1');
    const rec = srv.seen[0];
    assert.equal(rec.path, '/v1/pages');
    assert.equal(rec.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(rec.headers['notion-version'], '2026-03-11');
    const body = json(rec);
    assert.deepEqual(body.parent, { database_id: 'db1' });
    assert.equal(body.properties.Name.title[0].text.content, '2026-11-25');
    assert.equal(body.properties.Date.date.start, '2026-11-25');
    assert.equal(body.properties.Kind.select.name, 'weekly');
    assert.equal(body.properties.Status.select.name, 'ok');
    assert.equal(body.properties.Drill.select.name, 'pass');
    assert.equal(body.properties.Task.rich_text[0].text.content, 'CCV3-State-Backup');
    assert.deepEqual(body.properties.Files.files.map((f) => [f.name, f.file_upload.id]), [['a.dump', 'u1'], ['b.zip', 'u2']]);
    assert.match(body.properties['Sizes and sha256'].rich_text[0].text.content, /a\.dump 10 B aaaa/);
  } finally { await srv.close(); }
});

test('N6 a failed night still has a row: no files, a named status, the error masked and cut', () => {
  const props = rowProperties({ date: '2026-11-25', kind: 'nightly', files: [] }, { status: 'dump-failed', drill: 'not-run', drillDetail: `x ${TOKEN} ${'y'.repeat(900)}` });
  assert.equal(props.Status.select.name, 'dump-failed');
  assert.deepEqual(props.Files.files, []);
  const detail = props['Drill detail'].rich_text[0].text.content;
  assert.ok(detail.length <= 600);
  assert.ok(!detail.includes(TOKEN));
});

test('N7 listRows follows the cursor and reads the properties back into retention rows', async () => {
  const page = (id, date, kind, status, drill, task = 'CCV3-State-Backup') => ({ id, properties: {
    Date: { date: { start: date } }, Kind: { select: { name: kind } }, Status: { select: { name: status } },
    Drill: { select: { name: drill } }, Task: { rich_text: [{ plain_text: task }] } } });
  const srv = await fakeNotion((rec) => {
    const cursor = rec.body.length ? JSON.parse(rec.body.toString('utf8')).start_cursor : undefined;
    return cursor ? { json: { results: [page('r2', '2026-11-23', 'weekly', 'ok', 'pass')], has_more: false } }
      : { json: { results: [page('r1', '2026-11-24', 'nightly', 'ok', 'pass')], has_more: true, next_cursor: 'c1' } };
  });
  try {
    const rows = await listRows(client(srv.url));
    assert.deepEqual(rows, [
      { id: 'r1', date: '2026-11-24', kind: 'nightly', status: 'ok', drill: 'pass', task: 'CCV3-State-Backup' },
      { id: 'r2', date: '2026-11-23', kind: 'weekly', status: 'ok', drill: 'pass', task: 'CCV3-State-Backup' } ]);
    assert.equal(srv.seen.length, 2);
  } finally { await srv.close(); }
});

test('N8 runRetention trashes only what chooseRetention names, and only when allowed', async () => {
  const mk = (n, day) => ({ id: `r${n}`, date: `2026-10-${String(day).padStart(2, '0')}`, kind: 'nightly', status: 'ok', drill: 'pass', task: 'CCV3-State-Backup' });
  const rows = Array.from({ length: 16 }, (_, i) => mk(i, i + 1)); // 16 nightly rows, days 1..16: the two oldest leave the 14 newest
  const srv = await fakeNotion(() => ({ json: {} }));
  try {
    const none = await runRetention(client(srv.url), rows, { now: '2026-11-25', allowTrash: false });
    assert.deepEqual(none.trashed, []);
    assert.deepEqual(none.wouldTrash.sort(), ['r0', 'r1']);
    assert.equal(srv.seen.length, 0);
    const done = await runRetention(client(srv.url), rows, { now: '2026-11-25', allowTrash: true });
    assert.deepEqual(done.trashed.sort(), ['r0', 'r1']);
    assert.ok(srv.seen.every((r) => r.method === 'PATCH' && /^\/v1\/pages\/r[01]$/.test(r.path) && json(r).in_trash === true));
    assert.equal(srv.seen.length, 2);
  } finally { await srv.close(); }
});
