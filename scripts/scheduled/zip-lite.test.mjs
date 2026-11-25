// Tests for scripts/scheduled/zip-lite.mjs (card ops-state-backup-nightly): a small zip writer, because Node has none and the backup
// files are zips Dave can open. The test reads the zip with its OWN minimal reader (end record, central directory, local header,
// inflate), so a wrong field in the writer shows as a failed read, not as two copies of one mistake.
//
// How the writer can fail, one test each:
//   Z1  a name, a byte or a checksum of an entry is wrong after a round trip (also a binary entry with every byte value 0..255)
//   Z2  a name that leaves the archive (absolute, drive letter, "..", empty, NUL) is accepted, or a backslash is kept
//   Z3  two runs with the same input give different bytes (a time stamp in the file would make the sha256 of a backup unstable)
//   Z4  an empty list gives a "good" archive of nothing, or an entry over 4 GiB is accepted (a zip64 field is not written)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

const lib = () => import('./zip-lite.mjs'); // dynamic: a missing module fails each test, not the whole file

/** An independent reader: the end record, the central directory, each local header. Returns [{ name, data, crc }]. */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end record signature');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'central directory signature');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, 'local header signature');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, `${name}: size`);
    out.push({ name, data, crc });
    at += 46 + nlen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

test('Z1 a round trip gives the same names, bytes and checksums, binary data included', async () => {
  // Breaks when a field of a header is off (size, offset, crc, name length), or the data is cut or changed.
  const { makeZip } = await lib();
  const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const entries = [
    { name: 'decisions.json', data: Buffer.from('{"a":1}\n'.repeat(500)) },
    { name: 'dir/sub/notes.md', data: Buffer.from('# Titel mit Umlaut \u00e4\u00f6\u00fc\n') },
    { name: 'bytes.bin', data: every },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(makeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => {
    assert.ok(e.data.equals(entries[i].data), `${e.name}: bytes`);
    assert.equal(e.crc, crc32(entries[i].data), `${e.name}: crc`);
  });
});

test('Z2 a name that leaves the archive is refused and a backslash becomes a slash', async () => {
  // Breaks when the name check is dropped: a restore on another machine could write outside its folder (path traversal).
  const { makeZip } = await lib();
  for (const bad of ['', '/etc/passwd', 'C:/x', 'C:\\x', '../x', 'a/../../x', 'a\0b']) {
    assert.throws(() => makeZip([{ name: bad, data: Buffer.from('x') }]), /name/, JSON.stringify(bad));
  }
  assert.deepEqual(readZip(makeZip([{ name: 'a\\b\\c.txt', data: Buffer.from('x') }])).map((e) => e.name), ['a/b/c.txt']);
});

test('Z3 the same input gives the same bytes', async () => {
  // Breaks when a clock value goes into a header: the sha256 in the manifest would differ between two runs of one night.
  const { makeZip } = await lib();
  const entries = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.txt', data: Buffer.from('world') }];
  const first = makeZip(entries);
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(first.equals(makeZip(entries)));
});

test('Z4 an empty list and an entry over 4 GiB are refused', async () => {
  // Breaks when an empty archive counts as a backup, or a size over 32 bits wraps in a header (no zip64 support).
  const { makeZip } = await lib();
  assert.throws(() => makeZip([]), /no entries/);
  const huge = { name: 'big.bin', data: { length: 2 ** 32, fake: true } };
  assert.throws(() => makeZip([huge]), /too large/);
});
