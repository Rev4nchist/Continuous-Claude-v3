import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisWindows, combineWindowResults, validateWindowResult } from '../lib/analysis.mjs';

const evidence = {
  videoId: 'v1', duration: 40,
  transcript: { chunks: [
    { id: 't1', start: 0, end: 10, text: 'alpha'.repeat(20) },
    { id: 't2', start: 10, end: 20, text: 'beta'.repeat(20) },
    { id: 't3', start: 20, end: 30, text: 'gamma'.repeat(20) },
  ] },
  visuals: {
    states: [{ id: 'f1', timestamp: 15, path: 'frame.jpg', ocrText: '42%' }],
    contactSheets: [{ id: 'sheet:1', path: 'sheet.jpg', frameIds: ['f1'], frames: [{ id: 'f1', timestamp: 15 }] }],
  },
};

test('analysis windows are bounded and account for every evidence id', () => {
  const windows = buildAnalysisWindows(evidence, { maxChars: 230, overlapItems: 1 });
  assert.ok(windows.length > 1);
  assert.ok(windows.every((window) => window.items.reduce((sum, item) => sum + item.size, 0) <= 330));
  const ids = new Set(windows.flatMap((window) => window.items.map((item) => item.id)));
  assert.deepEqual(ids, new Set(['t1', 't2', 't3', 'f1']));
  assert.ok(windows.some((window) => window.contactSheets.some((sheet) => sheet.id === 'sheet:1')));
});

test('window validation rejects model output that silently omits input evidence', () => {
  const window = { id: 'window:1', items: [{ id: 't1' }, { id: 'f1' }] };
  assert.throws(() => validateWindowResult(window, {
    windowId: 'window:1', consumedEvidenceIds: ['t1'], outlineSegments: [], contentUnits: [], visualReviews: [],
  }), /omitted evidence f1/);
});

test('window composition deduplicates equivalent evidence spans without dropping citations', () => {
  const result = combineWindowResults('v1', [{
    windowId: 'w1', consumedEvidenceIds: ['t1'],
    outlineSegments: [{ id: 's1', start: 0, end: 10, title: 'A', details: ['Detail'], transcriptChunkIds: ['t1'], visualFrameIds: [] }],
    contentUnits: [{ id: 'u1', kind: 'claim', text: 'Claim', evidenceIds: ['t1'], stance: 'asserted' }], visualReviews: [],
  }, {
    windowId: 'w2', consumedEvidenceIds: ['t1'],
    outlineSegments: [{ id: 's2', start: 0, end: 10, title: 'A repeated', details: ['Detail'], transcriptChunkIds: ['t1'], visualFrameIds: [] }],
    contentUnits: [{ id: 'u2', kind: 'claim', text: 'Claim', evidenceIds: ['t1'], stance: 'asserted' }], visualReviews: [],
  }]);
  assert.equal(result.outlineSegments.length, 1);
  assert.equal(result.contentUnits.length, 1);
  assert.deepEqual(result.contentUnits[0].evidenceIds, ['t1']);
});
