import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptAllowed, clipName, isSafeId, label, labelWithAgent, listIdentities, readIdentity, resolveName, validAgent,
  writeIdentity,
} from './session-label.mjs';

const U1 = '0d40499c-1111-4111-8111-111111111111';
const U2 = '5f0e7e56-2222-4222-8222-222222222222';
const U3 = 'aaaaaaaa-3333-4333-8333-333333333333';
const U4 = 'bbbbbbbb-4444-4444-8444-444444444444';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ccv3-label-test-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- label

test('label is "name #sid8", or "#sid8" with no name or no file', () => {
  const ids = new Map([[U1, { name: 'trex' }], [U2, { name: null }]]);
  assert.equal(label(U1, ids), 'trex #0d40499c');
  assert.equal(label(U2, ids), '#5f0e7e56');
  assert.equal(label(U3, ids), '#aaaaaaaa');
});

test('label clips a long name to 16 characters', () => {
  const ids = new Map([[U1, { name: 'a-very-long-session-name' }]]);
  assert.equal(label(U1, ids), 'a-very-long-sess #0d40499c');
});

// ---- identity file

test('writeIdentity merges: a later writer without previous/endedAt does not drop them', () => {
  const t = tmp();
  try {
    writeIdentity(U1, { name: 'trex', previous: U2, endedAt: '2026-11-03T10:00:00Z', endReason: 'clear' }, t.dir);
    writeIdentity(U1, { name: 'trex2', previous: undefined }, t.dir);
    const id = readIdentity(U1, t.dir);
    assert.equal(id.name, 'trex2');
    assert.equal(id.previous, U2);
    assert.equal(id.endedAt, '2026-11-03T10:00:00Z');
    assert.equal(id.short, '0d40499c');
    writeIdentity(U1, { endedAt: null }, t.dir);
    assert.equal(readIdentity(U1, t.dir).endedAt, null, 'an explicit null clears');
  } finally { t.done(); }
});

test('writeIdentity leaves no temp file and a parseable file', () => {
  const t = tmp();
  try {
    writeIdentity(U1, { name: 'trex' }, t.dir);
    assert.deepEqual(readdirSync(t.dir), [`${U1}.json`]);
  } finally { t.done(); }
});

test('a corrupt or non-object file reads as absent and listIdentities skips it', () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, `${U1}.json`), '{not json');
    writeFileSync(join(t.dir, `${U2}.json`), '[1,2]');
    writeFileSync(join(t.dir, `${U3}.json.tmp`), '{}');
    writeIdentity(U4, { name: 'ok' }, t.dir);
    assert.equal(readIdentity(U1, t.dir), null);
    assert.equal(readIdentity(U2, t.dir), null);
    assert.deepEqual([...listIdentities(t.dir).keys()], [U4]);
    assert.equal(listIdentities(join(t.dir, 'missing')).size, 0);
  } finally { t.done(); }
});

test('a session id that could leave the folder is refused', () => {
  const t = tmp();
  try {
    assert.equal(readIdentity('../secret', t.dir), null);
    assert.throws(() => writeIdentity('..\\x', { name: 'a' }, t.dir), /bad session id/);
  } finally { t.done(); }
});

test('the SAFE id rule is 8 to 64 hex or dash characters', () => {
  assert.equal(isSafeId(U1), true);
  assert.equal(isSafeId('ABCDEF12'), true);
  for (const bad of ['good-session', 'abc', 'abcdef1', `${'a'.repeat(65)}`, 'abcdef12/..', 'abcdef12_x', '', null, undefined]) {
    assert.equal(isSafeId(bad), false, String(bad));
    assert.equal(readIdentity(bad, tmpdir()), null);
  }
  assert.throws(() => writeIdentity('good-session', { name: 'a' }, tmpdir()), /bad session id/);
});

test('clipName collapses whitespace, trims and clips to 16', () => {
  assert.equal(clipName('  a \t b\n\nc  '), 'a b c');
  assert.equal(clipName('x'.repeat(40)), 'x'.repeat(16));
  const ids = new Map([[U1, { name: '  two   words  ' }]]);
  assert.equal(label(U1, ids), `two words #0d40499c`);
});

test('listIdentities keys on the file name: a uuid inside the content cannot redirect it', () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, `${U1}.json`), JSON.stringify({ uuid: U2, name: 'trex' }));
    const ids = listIdentities(t.dir);
    assert.deepEqual([...ids.keys()], [U1]);
    assert.equal(ids.get(U1).uuid, U1);
  } finally { t.done(); }
});

// ---- agent tag

test('validAgent keeps 1 to 40 letters, digits, _ and - and drops the rest', () => {
  assert.equal(validAgent('kraken'), 'kraken');
  assert.equal(validAgent('code-reviewer_2'), 'code-reviewer_2');
  for (const bad of ['', 'a b', 'a;b', 'x'.repeat(41), true, undefined, null, 'a\nb']) assert.equal(validAgent(bad), null, String(bad));
});

test('labelWithAgent: "name/agent #sid8", "#sid8 (agent)" with no name, plain label for a bad agent', () => {
  const ids = new Map([[U1, { name: 'trex' }], [U2, { name: null }]]);
  assert.equal(labelWithAgent(U1, ids, 'kraken'), 'trex/kraken #0d40499c');
  assert.equal(labelWithAgent(U2, ids, 'kraken'), '#5f0e7e56 (kraken)');
  assert.equal(labelWithAgent(U1, ids, 'bad agent'), 'trex #0d40499c');
  assert.equal(labelWithAgent(U1, ids, undefined), 'trex #0d40499c');
});

// ---- name lookup

const idMap = (o) => new Map(Object.entries(o).map(([u, v]) => [u, { uuid: u, updatedAt: '2026-11-03T10:00:00Z', ...v }]));

test('resolveName matches an exact name, any case, among live sessions only', () => {
  const ids = idMap({ [U1]: { name: 'Trex' }, [U2]: { name: 'cat' } });
  assert.deepEqual(resolveName('tREX', ids, new Set([U1, U2])), [U1]);
  assert.deepEqual(resolveName('tre', ids, new Set([U1, U2])), [], 'no prefix matching');
  assert.deepEqual(resolveName('trex', ids, new Set([U2])), [], 'not live');
});

test('resolveName drops the session another file names as previous, and ended sessions', () => {
  const ids = idMap({
    [U1]: { name: 'trex' },
    [U2]: { name: 'trex', previous: U1 },
    [U3]: { name: 'trex', endedAt: '2026-11-03T09:00:00Z' },
  });
  assert.deepEqual(resolveName('trex', ids, new Set([U1, U2, U3])), [U2]);
});

test('resolveName returns every distinct live holder of one name, newest first', () => {
  const ids = idMap({
    [U1]: { name: 'trex', updatedAt: '2026-11-03T10:00:00Z' },
    [U2]: { name: 'trex', updatedAt: '2026-11-03T11:00:00Z' },
  });
  assert.deepEqual(resolveName('trex', ids, new Set([U1, U2])), [U2, U1]);
});

// ---- adopt guard

test('adoptAllowed: same name, or the new file names the old uuid as previous', () => {
  assert.equal(adoptAllowed(U1, U2, { name: 'Trex' }, { name: 'trex' }), true);
  assert.equal(adoptAllowed(U1, U2, null, { name: 'x', previous: U1 }), true);
});

test('adoptAllowed refuses a stranger, two unnamed sessions, and itself', () => {
  assert.equal(adoptAllowed(U1, U2, { name: 'trex' }, { name: 'cat' }), false);
  assert.equal(adoptAllowed(U1, U2, { name: null }, { name: null }), false);
  assert.equal(adoptAllowed(U1, U2, null, null), false);
  assert.equal(adoptAllowed(U1, U1, { name: 'trex' }, { name: 'trex' }), false);
  assert.equal(adoptAllowed(U1, U2, { name: 'trex' }, { name: 'x', previous: U3 }), false);
});
