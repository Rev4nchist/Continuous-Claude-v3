/**
 * A small zip writer for the nightly state backup (card ops-state-backup-nightly). Node has none. Deflate entries, UTF-8 names,
 * a fixed time stamp (1980-01-01), so the same input always gives the same bytes and the sha256 in the manifest is stable.
 * No zip64: an entry of 4 GiB or more, or more than 65535 entries, is refused. A module only: no shebang, no argv read.
 */
import { crc32, deflateRawSync } from 'node:zlib';

const MAX32 = 0xffffffff;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

/** A name inside the archive: forward slashes, relative, no "..", no NUL, not empty. Throws on any other name. */
function safeName(raw) {
  const name = String(raw ?? '').replace(/\\/g, '/');
  // An absolute name ("/x") splits into an empty first part, so the empty-part test refuses it too.
  const bad = !name || name.includes('\0') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '');
  if (bad) throw new Error(`zip name is not allowed: ${JSON.stringify(String(raw))}`);
  return name;
}

/** entries: [{ name, data: Buffer }]. Returns the zip as one Buffer. */
export function makeZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('zip has no entries');
  if (entries.length > 0xffff) throw new Error('zip has too many entries (no zip64)');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeName(entry.name), 'utf8');
    if (!(entry.data?.length <= MAX32 - 1) || entry.data.length >= 2 ** 32) throw new Error(`zip entry too large (no zip64): ${name.toString('utf8')}`);
    const data = entry.data;
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    local.copy(central, 6, 4, 26); // version needed, flags, method, time, date, crc, compressed size, size
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
    if (offset > MAX32) throw new Error('zip too large (no zip64)');
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
