import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTopicRelationships, mergeTopicKnowledge } from '../lib/topics.mjs';

test('topic reconciliation is idempotent and preserves contradiction and supersession links', () => {
  const analyses = [{ videoId: 'v1', contentUnits: [{
    id: 'u1', kind: 'claim', text: 'Agents need evaluation harnesses', evidenceIds: ['t1'],
    relationships: { contradicts: ['old-claim'], supersedes: ['older-guidance'] },
  }] }];
  const first = mergeTopicKnowledge(null, analyses, { topic: 'Agents', now: '2026-08-24T00:00:00.000Z' });
  const second = mergeTopicKnowledge(first, analyses, { topic: 'Agents', now: '2026-08-25T00:00:00.000Z' });
  assert.equal(second.units.length, 1);
  assert.equal(second.units[0].firstSeen, '2026-08-24T00:00:00.000Z');
  assert.equal(second.units[0].lastConfirmed, '2026-08-25T00:00:00.000Z');
  assert.deepEqual(second.units[0].contradicts, ['old-claim']);
  assert.deepEqual(second.units[0].supersedes, ['older-guidance']);
  assert.deepEqual(second.units[0].supportingVideoIds, ['v1']);
});

test('full-topic reconciliation validates and applies cross-source relationships', () => {
  const knowledge = { units: [
    { key: 'new', text: 'New guidance', evidenceIds: ['t1'], contradicts: [], supersedes: [] },
    { key: 'old', text: 'Old guidance', evidenceIds: ['t0'], contradicts: [], supersedes: [] },
  ] };
  const updated = applyTopicRelationships(knowledge, { relationships: [{
    fromKey: 'new', toKey: 'old', type: 'supersedes', rationale: 'Newer tested method', evidenceIds: ['t1'],
  }] });
  assert.deepEqual(updated.units[0].supersedes, ['old']);
  assert.throws(() => applyTopicRelationships(knowledge, { relationships: [{ fromKey: 'new', toKey: 'missing', type: 'contradicts' }] }), /invalid unit keys/);
});
