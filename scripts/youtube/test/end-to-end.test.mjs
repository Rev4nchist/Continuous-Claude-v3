import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTopicCoverage, auditVideoCoverage } from '../lib/coverage.mjs';
import { computeRunStatus } from '../lib/outcomes.mjs';
import { diffPlaylistEntries } from '../lib/sources.mjs';
import { mergeTopicKnowledge } from '../lib/topics.mjs';

function readyVideo(videoId, provenance, withVisual = false) {
  const evidence = {
    videoId, duration: 20, gaps: [],
    transcript: {
      status: 'complete', provenance,
      speechWindows: [{ id: `speech:${videoId}`, start: 0, end: 20 }],
      chunks: [{ id: `transcript:${videoId}:00001`, start: 0, end: 20, text: 'Complete spoken evidence', provenance }],
    },
    visuals: { status: 'complete', states: withVisual ? [{ id: `visual:${videoId}:00001`, timestamp: 10, reviewed: true, ocrText: 'Screen demo' }] : [] },
  };
  const analysis = {
    videoId,
    outlineSegments: [{ id: `outline:${videoId}`, start: 0, end: 20, details: ['All content'], transcriptChunkIds: [`transcript:${videoId}:00001`], visualFrameIds: withVisual ? [`visual:${videoId}:00001`] : [] }],
    contentUnits: [{ id: `unit:${videoId}`, kind: 'example', text: `${videoId} example`, stance: withVisual ? 'demonstrated' : 'asserted', evidenceIds: [`transcript:${videoId}:00001`] }],
  };
  return { evidence, analysis, audit: auditVideoCoverage(evidence, analysis) };
}

test('end-to-end fixture accounts for manual captions, Whisper fallback, screen demo, and removed history', () => {
  const previous = [
    { id: 'manual', position: 1 }, { id: 'no-caption', position: 2 },
    { id: 'screen-demo', position: 3 }, { id: 'removed', position: 4 },
  ];
  const current = previous.slice(0, 3);
  const diff = diffPlaylistEntries(previous, current);
  assert.deepEqual(diff.removed.map((entry) => entry.id), ['removed']);

  const records = [
    readyVideo('manual', 'manual-caption'),
    readyVideo('no-caption', 'whisper'),
    readyVideo('screen-demo', 'whisper', true),
  ];
  assert.ok(records.every((record) => record.audit.status === 'READY'));
  const topicAudit = auditTopicCoverage({
    entries: current.map((entry) => ({ ...entry, entryKey: `id:${entry.id}#1` })),
    videoAudits: records.map((record) => record.audit),
  });
  assert.equal(topicAudit.status, 'READY');

  const once = mergeTopicKnowledge(null, records.map((record) => record.analysis), { topic: 'Fixture', now: '2026-08-24T00:00:00.000Z' });
  const twice = mergeTopicKnowledge(once, records.map((record) => record.analysis), { topic: 'Fixture', now: '2026-08-25T00:00:00.000Z' });
  assert.equal(twice.units.length, 3, 'idempotent rerun must not duplicate content units');
  assert.equal(computeRunStatus({ videos: records.map(() => ({ status: 'Ready' })), changed: false }), 'NoChange');
});
