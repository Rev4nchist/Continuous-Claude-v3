import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTargetProfile, hashTargetContent, snapshotTarget,
  validateTargetChanges, verifyTargetBaseline,
} from '../lib/targets.mjs';

test('target hashing is stable for identical normalized content', () => {
  assert.equal(hashTargetContent('hello\r\nworld\r\n'), hashTargetContent('hello\nworld\n'));
});

test('apply verification rejects target drift', () => {
  const packageRecord = { targetId: 'site-1', baselineHash: hashTargetContent('before') };
  const result = verifyTargetBaseline(packageRecord, 'after');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DRIFT');
});

for (const [type, path] of [
  ['markdown', 'scripts/youtube/test/fixtures/target.md'],
  ['html', 'scripts/youtube/test/fixtures/target.html'],
  ['tsx', 'scripts/youtube/test/fixtures/target.tsx'],
]) {
  test(`${type} target snapshot retains content, headings, and baseline hash`, () => {
    const profile = createTargetProfile({ id: `target-${type}`, path, topics: ['Agents'] });
    const snapshot = snapshotTarget(profile);
    assert.match(snapshot.baselineHash, /^[a-f0-9]{64}$/);
    assert.ok(snapshot.content.length > 0);
    assert.ok(snapshot.sections.length > 0);
  });
}

test('impact validation requires supported actions, exact locators, and evidence', () => {
  const valid = { changes: [{ action: 'revise', locator: 'line:1', proposedContent: 'New', rationale: 'Updated evidence', evidenceIds: ['t1'] }] };
  assert.equal(validateTargetChanges(valid), valid);
  assert.throws(() => validateTargetChanges({ changes: [{ ...valid.changes[0], evidenceIds: [] }] }), /no evidence/);
  assert.throws(() => validateTargetChanges({ changes: [{ ...valid.changes[0], action: 'publish' }] }), /Invalid/);
});
