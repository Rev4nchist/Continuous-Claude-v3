// Failure modes for external-pull.mjs (pinned Hugging Face pull). No network: fetchFn, root and clock are injected. Made-up ids and shas only.
//  P1 an unpinned or odd source is pulled (branch, short or upper-case sha, bad id, bad file path) -> assertPinned loosened
//  P2 the resolve URL does not hold the 40-hex pin                                                  -> resolveUrl uses a branch or drops the sha
//  P3 a 307 first hop is refused as "no size" (the live HF answer for an LFS or xet file)           -> HEAD follows redirects, or reads the 3xx content-length
//  P4 the 3xx content-length (the redirect body, about 355) is taken as the file size               -> declared size read from content-length on a 3xx
//  P5 x-repo-commit names another commit and the pull goes ahead                                    -> commit header never compared with the pin
//  P6 a 3xx with no x-repo-commit is refused (the URL holds the 40-hex pin, so it is safe)          -> commit header made mandatory
//  P7 a declared size over maxBytes is downloaded                                                   -> size check dropped or moved after the GET
//  P8 a stream that passes maxBytes is read to the end                                              -> limit checked only after the whole body arrived
//  P9 the body size differs from x-linked-size and the file is stored                               -> declared size not compared with the bytes received
//  P10 the HEAD 200 with content-length path stops working                                          -> 200 branch removed
//  P11 the HEAD is sent with redirect follow, or the GET is not following                           -> wrong redirect mode on either request
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertPinned, datasetDirName, MAX_BYTES, pullPinned, PullRefusal, resolveUrl } from './external-pull.mjs';

const SHA = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const ID = 'acme/widget-data';
const FILE = 'rows.jsonl';
const NOW = Date.parse('2026-11-13T12:00:00Z');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ext-pull-'));
const pull = (over, deps) => pullPinned({ id: ID, sha: SHA, file: FILE, ...over }, { now: () => NOW, ...deps });
const stored = (root) => existsSync(path.join(root, datasetDirName(ID, SHA)));

const hdrs = (o) => ({ get: (k) => o[String(k).toLowerCase()] ?? null });
const reader = (chunks, state) => ({
  getReader: () => ({
    read: async () => { state.reads += 1; const v = chunks.shift(); return v ? { done: false, value: v } : { done: true, value: undefined }; },
    cancel: async () => { state.cancelled = true; },
  }),
});

// head: { status, headers }; body: Buffer. stream: send the body as chunks of `chunk` bytes through getReader.
function fakeHf({ status = 307, headers = {}, body = Buffer.alloc(20, 7), stream = 0 }) {
  const calls = [];
  const state = { reads: 0, cancelled: false };
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', redirect: init.redirect });
    if (init.method === 'HEAD') return { ok: status >= 200 && status < 300, status, headers: hdrs(headers) };
    const chunks = [];
    for (let i = 0; stream && i < body.length; i += stream) chunks.push(new Uint8Array(body.subarray(i, i + stream)));
    const payload = stream ? { body: reader(chunks, state) } : { arrayBuffer: async () => new Uint8Array(body).buffer };
    return { ok: true, status: 200, headers: hdrs({}), ...payload };
  };
  return { fn, calls, state };
}
const hop = (extra = {}) => ({ 'content-length': '355', 'x-linked-size': '20', 'x-repo-commit': SHA, ...extra });

test('P1 assertPinned refuses every unpinned or odd source and accepts a good pin', () => {
  // Breaks when: any of the checks (sha, id, file path) is loosened.
  const good = { id: ID, sha: SHA, file: 'dir/rows.jsonl' };
  assert.doesNotThrow(() => assertPinned(good));
  const bads = [
    { sha: undefined }, { sha: 'main' }, { sha: 'abc123' }, { sha: 'B'.repeat(40) }, { sha: `${'b'.repeat(39)}g` },
    { id: 'nowhere' }, { id: undefined },
    { file: '' }, { file: '/abs' }, { file: '..' }, { file: '../x' }, { file: 'a\\b' }, { file: 'a//b' }, { file: 'a/../b' }, { file: undefined },
  ];
  for (const bad of bads) assert.throws(() => assertPinned({ ...good, ...bad }), PullRefusal, JSON.stringify(bad));
});

test('P2 the resolve URL holds the 40-hex pin and never a branch name', () => {
  // Breaks when: resolveUrl builds the path from a ref other than the sha.
  const url = resolveUrl(ID, SHA, 'dir/rows file.jsonl');
  assert.equal(url, `https://huggingface.co/datasets/${ID}/resolve/${SHA}/dir/rows%20file.jsonl`);
  assert.match(url, /\/resolve\/[0-9a-f]{40}\//);
});

test('P3 P11 a 307 first hop with x-linked-size and the pinned x-repo-commit is pulled; HEAD is manual, GET follows', async () => {
  // Breaks when: the 3xx hop is refused, HEAD follows redirects, GET does not follow, or the manifest is wrong.
  const hf = fakeHf({ headers: hop() });
  const root = tmp();
  const { manifest, filePath } = await pull({}, { fetchFn: hf.fn, root });
  assert.deepEqual(hf.calls.map((c) => [c.method, c.redirect]), [['HEAD', 'manual'], ['GET', 'follow']]);
  assert.ok(hf.calls.every((c) => c.url.includes(`/resolve/${SHA}/`)));
  assert.equal(manifest.bytes, 20);
  assert.equal(manifest.sha256, createHash('sha256').update(Buffer.alloc(20, 7)).digest('hex'));
  assert.deepEqual(Object.keys(manifest).sort(), ['bytes', 'fetchedAt', 'file', 'id', 'sha', 'sha256']);
  assert.equal(manifest.fetchedAt, '2026-11-13T12:00:00.000Z');
  assert.equal(readFileSync(filePath).length, 20);
  assert.equal(JSON.parse(readFileSync(path.join(root, datasetDirName(ID, SHA), 'manifest.json'), 'utf8')).sha256, manifest.sha256);
});

test('P5 a 307 whose x-repo-commit is another sha is refused and nothing is written', async () => {
  // Breaks when: the commit header is ignored.
  const hf = fakeHf({ headers: hop({ 'x-repo-commit': OTHER }) });
  const root = tmp();
  await assert.rejects(pull({}, { fetchFn: hf.fn, root }), (e) => e instanceof PullRefusal && /commit/.test(e.message));
  assert.deepEqual(hf.calls.map((c) => c.method), ['HEAD'], 'no GET');
  assert.equal(stored(root), false);
});

test('P6 a 307 with no x-repo-commit is allowed because the request URL holds the 40-hex pin', async () => {
  // Breaks when: the commit header is made mandatory.
  const hf = fakeHf({ headers: hop({ 'x-repo-commit': undefined }) });
  const { manifest } = await pull({}, { fetchFn: hf.fn, root: tmp() });
  assert.equal(manifest.bytes, 20);
  assert.ok(hf.calls[0].url.includes(`/resolve/${SHA}/`));
});

test('P4 a 307 with only the redirect content-length (355) and no x-linked-size is refused', async () => {
  // Breaks when: the 3xx content-length is used as the file size.
  for (const extra of [{ 'x-linked-size': undefined }, { 'x-linked-size': '0' }, { 'x-linked-size': 'abc' }, { 'x-linked-size': '-5' }]) {
    const hf = fakeHf({ headers: hop(extra), body: Buffer.alloc(355, 1) });
    const root = tmp();
    await assert.rejects(pull({}, { fetchFn: hf.fn, root }), (e) => e instanceof PullRefusal && /size/.test(e.message), JSON.stringify(extra));
    assert.deepEqual(hf.calls.map((c) => c.method), ['HEAD']);
    assert.equal(stored(root), false);
  }
});

test('P4 every redirect status reads x-linked-size, none reads content-length', async () => {
  // Breaks when: one of 301/302/303/307/308 is missed.
  for (const status of [301, 302, 303, 307, 308]) {
    const { manifest } = await pull({}, { fetchFn: fakeHf({ status, headers: hop() }).fn, root: tmp() });
    assert.equal(manifest.bytes, 20, `status ${status}`);
  }
});

test('P7 a declared size over maxBytes is refused before the GET', async () => {
  // Breaks when: the size check is dropped or runs after the GET.
  const hf = fakeHf({ headers: hop({ 'x-linked-size': String(MAX_BYTES + 1) }) });
  const root = tmp();
  await assert.rejects(pull({}, { fetchFn: hf.fn, root }), (e) => e instanceof PullRefusal && /byte limit/.test(e.message));
  assert.deepEqual(hf.calls.map((c) => c.method), ['HEAD'], 'GET must not be called');
  assert.equal(stored(root), false);
  await assert.rejects(pull({ maxBytes: 10 }, { fetchFn: fakeHf({ headers: hop() }).fn, root }), PullRefusal);
});

test('P8 a GET stream that passes maxBytes is refused while reading and nothing is written', async () => {
  // Breaks when: the stream is read to the end before the limit is checked, or the file is written first.
  const hf = fakeHf({ headers: hop({ 'x-linked-size': '50' }), body: Buffer.alloc(200, 3), stream: 40 });
  const root = tmp();
  await assert.rejects(pull({ maxBytes: 100 }, { fetchFn: hf.fn, root }), (e) => e instanceof PullRefusal && /byte limit/.test(e.message));
  assert.equal(hf.state.reads, 3, 'stops at the chunk that passes 100 bytes (40+40+40), not at the end of 5 chunks');
  assert.equal(hf.state.cancelled, true);
  assert.equal(stored(root), false);
});

test('P9 a body whose size differs from x-linked-size is refused, with a stream and without', async () => {
  // Breaks when: the byte count is not compared with the declared size.
  for (const stream of [0, 8]) {
    for (const size of [10, 40]) {
      const hf = fakeHf({ headers: hop({ 'x-linked-size': String(size) }), body: Buffer.alloc(20, 7), stream });
      const root = tmp();
      await assert.rejects(pull({}, { fetchFn: hf.fn, root }), (e) => e instanceof PullRefusal && /declared/.test(e.message), `stream ${stream} size ${size}`);
      assert.equal(stored(root), false);
    }
  }
});

test('P9 a streamed body of the declared size is stored whole', async () => {
  // Breaks when: chunks are dropped or joined wrongly.
  const body = Buffer.from('x'.repeat(30) + 'y'.repeat(30));
  const hf = fakeHf({ headers: hop({ 'x-linked-size': '60' }), body, stream: 7 });
  const { filePath, manifest } = await pull({}, { fetchFn: hf.fn, root: tmp() });
  assert.deepEqual(readFileSync(filePath), body);
  assert.equal(manifest.bytes, 60);
});

test('P10 a HEAD 200 with content-length still works, and a 200 without one is refused', async () => {
  // Breaks when: the 200 branch is removed or the no-size refusal is dropped.
  const hf = fakeHf({ status: 200, headers: { 'content-length': '20' } });
  const { manifest } = await pull({}, { fetchFn: hf.fn, root: tmp() });
  assert.equal(manifest.bytes, 20);
  const none = fakeHf({ status: 200, headers: {} });
  await assert.rejects(pull({}, { fetchFn: none.fn, root: tmp() }), /size unknown/);
  assert.deepEqual(none.calls.map((c) => c.method), ['HEAD']);
});

test('P10 a HEAD error status other than 200 or 3xx is an error, not a pull', async () => {
  // Breaks when: any status is treated as a redirect.
  await assert.rejects(pull({}, { fetchFn: fakeHf({ status: 404, headers: hop() }).fn, root: tmp() }), (e) => !(e instanceof PullRefusal) && /HTTP 404/.test(e.message));
});
