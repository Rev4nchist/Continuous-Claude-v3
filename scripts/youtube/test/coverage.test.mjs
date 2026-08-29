import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditVideoCoverage, auditTopicCoverage } from '../lib/coverage.mjs';

const completeEvidence = {
  videoId: 'video-1',
  duration: 30,
  transcript: {
    status: 'complete',
    speechWindows: [{ id: 'speech:1', start: 0, end: 30 }],
    chunks: [
      { id: 'transcript:1', start: 0, end: 15, text: 'first' },
      { id: 'transcript:2', start: 15, end: 30, text: 'second' },
    ],
  },
  visuals: {
    status: 'complete',
    states: [{ id: 'visual:1', timestamp: 10, reviewed: true, ocrText: '42%' }],
  },
  gaps: [],
};

test('coverage is READY only when every evidence id is mapped and cited', () => {
  const analysis = {
    outlineSegments: [{
      id: 'outline:1', start: 0, end: 30,
      transcriptChunkIds: ['transcript:1', 'transcript:2'],
      visualFrameIds: ['visual:1'],
    }],
    contentUnits: [{ id: 'unit:1', kind: 'metric', text: '42%', evidenceIds: ['visual:1'] }],
  };
  const result = auditVideoCoverage(completeEvidence, analysis);
  assert.equal(result.status, 'READY');
  assert.equal(result.coverage.transcript, 1);
  assert.equal(result.coverage.visual, 1);
});

test('coverage blocks omitted evidence and invalid timestamps', () => {
  const analysis = {
    outlineSegments: [{
      id: 'outline:1', start: 31, end: 35,
      transcriptChunkIds: ['transcript:1'], visualFrameIds: [],
    }],
    contentUnits: [],
  };
  const result = auditVideoCoverage(completeEvidence, analysis);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.issues.some((issue) => issue.code === 'UNMAPPED_TRANSCRIPT'));
  assert.ok(result.issues.some((issue) => issue.code === 'UNMAPPED_VISUAL'));
  assert.ok(result.issues.some((issue) => issue.code === 'INVALID_TIMESTAMP'));
});

test('coverage blocks uncovered detected speech and invented evidence ids', () => {
  const evidence = structuredClone(completeEvidence);
  evidence.transcript.chunks[1].start = 28;
  const analysis = {
    outlineSegments: [{ id: 'outline:1', start: 0, end: 30, transcriptChunkIds: ['transcript:1', 'transcript:2', 'invented'], visualFrameIds: ['visual:1'] }],
    contentUnits: [{ id: 'unit:1', kind: 'claim', text: 'Claim', evidenceIds: ['invented'] }],
  };
  const result = auditVideoCoverage(evidence, analysis);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.issues.some((item) => item.code === 'UNCOVERED_SPEECH'));
  assert.ok(result.issues.some((item) => item.code === 'INVALID_EVIDENCE_REFERENCE'));
});

test('accepted exclusions are explicit and topic readiness still accounts for every playlist entry', () => {
  const topic = auditTopicCoverage({
    entries: [{ entryKey: 'id:a', id: 'a' }, { entryKey: 'position:2', id: null, availability: 'private' }],
    videoAudits: [{ videoId: 'a', status: 'READY', issues: [] }],
    acceptedExclusions: [{ entryKey: 'position:2', reason: 'Private video accepted by owner' }],
  });
  assert.equal(topic.status, 'READY');
  assert.equal(topic.accounting.entries, 2);
  assert.equal(topic.accounting.acceptedExclusions, 1);
});
