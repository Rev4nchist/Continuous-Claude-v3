// Tests for linktype.mjs (the linkType labels of the real Majors). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { LINK_TYPES, loadLinkTypes } from './linktype.mjs';

const made = [];
const write = (obj) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lt-'));
  made.push(dir);
  const file = path.join(dir, 'linktype-labels.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('the four link classes are fixed in this order (breaks if a class is renamed: the labels file and the scorecard key on them)', () => {
  assert.deepEqual(LINK_TYPES, ['within-hunk', 'same-file', 'cross-file-static', 'cross-file-dynamic']);
});

test('loadLinkTypes returns key -> final class and refuses a class outside the four (breaks if a typo in the file reaches the scorecard)', () => {
  const ok = write({ labels: { 'a:1': { final: 'same-file' }, 'b:2': { final: 'within-hunk' } } });
  assert.deepEqual(loadLinkTypes(ok), { 'a:1': 'same-file', 'b:2': 'within-hunk' });
  assert.throws(() => loadLinkTypes(write({ labels: { 'a:1': { final: 'cross-file' } } })), /a:1.*cross-file/);
  assert.throws(() => loadLinkTypes(write({ nope: 1 })), /labels/);
});

test('loadLinkTypes of a missing file is an empty map, so a scorecard without labels still runs (breaks if a missing file throws)', () => {
  assert.deepEqual(loadLinkTypes(path.join(os.tmpdir(), 'no-such-dir-lt', 'x.json')), {});
});
