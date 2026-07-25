// search.test.mjs — chunk parsing, windowing, and merge behaviour (SI-02 P0a).
// Run: node --test --test-reporter=spec "scripts/youtube/test/*.test.mjs"
//
// These guard the fix for a MEASURED defect: returning a filename and letting the
// caller read the file cost ~4,300 tokens at the median transcript and ~25,000 at
// the largest, versus ~300 for the ±2 window that actually contains the claim.
// The merge rule matters as much as the window: without it, two nearby hits
// return overlapping text twice and hand the amplification straight back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptChunks, searchChunks, parseFrontmatter, renderFrontmatter } from '../lib/corpus.mjs';

const DOC = `---
video_id: abc12345678
title: "Test"
---

# Test

## Transcript

[0:00] alpha one
[0:15] bravo two
[0:30] charlie three
[0:45] delta four
[1:00] echo five
[1:15] foxtrot six
[1:30] golf seven
`;

const chunks = transcriptChunks(DOC);
const re = (p) => new RegExp(p, 'ig');

test('transcriptChunks parses timestamps into seconds', () => {
  assert.equal(chunks.length, 7);
  assert.equal(chunks[0].t, 0);
  assert.equal(chunks[1].t, 15);
  assert.equal(chunks[4].t, 60);
  assert.equal(chunks[0].text, 'alpha one');
});

test('transcriptChunks handles H:MM:SS', () => {
  const c = transcriptChunks('## Transcript\n\n[1:02:03] late line\n');
  assert.equal(c.length, 1);
  assert.equal(c[0].t, 3723);
});

test('transcriptChunks returns empty when there is no transcript section', () => {
  assert.deepEqual(transcriptChunks('# Title\n\nno transcript here'), []);
});

test('a single match yields a window of +/-N around it', () => {
  const g = searchChunks(chunks, re('delta'), 2);
  assert.equal(g.length, 1);
  assert.equal(g[0].anchor, 3);
  assert.equal(g[0].from, 1);
  assert.equal(g[0].to, 5);
  assert.equal(g[0].matchCount, 1);
});

test('window 0 returns only the matching chunk', () => {
  const g = searchChunks(chunks, re('delta'), 0);
  assert.deepEqual([g[0].from, g[0].to], [3, 3]);
});

test('window clamps at the start of the transcript', () => {
  const g = searchChunks(chunks, re('alpha'), 2);
  assert.equal(g[0].from, 0, 'must not index before the first chunk');
  assert.equal(g[0].to, 2);
});

test('window clamps at the end of the transcript', () => {
  const g = searchChunks(chunks, re('golf'), 2);
  assert.equal(g[0].to, chunks.length - 1, 'must not index past the last chunk');
});

test('adjacent matches MERGE into one window instead of duplicating text', () => {
  // bravo(1) and delta(3) are 2 apart; with window 2 their spans overlap.
  const g = searchChunks(chunks, re('bravo|delta'), 2);
  assert.equal(g.length, 1, 'overlapping windows must merge');
  assert.equal(g[0].matchCount, 2);
  assert.equal(g[0].anchor, 1, 'anchored at the FIRST match');
  assert.deepEqual([g[0].from, g[0].to], [0, 5]);
});

test('distant matches stay separate', () => {
  // alpha(0) and golf(6) are 6 apart; with window 1 they do not overlap.
  const g = searchChunks(chunks, re('alpha|golf'), 1);
  assert.equal(g.length, 2);
  assert.equal(g[0].anchor, 0);
  assert.equal(g[1].anchor, 6);
});

test('merge boundary is exact at the overlap threshold', () => {
  // gap of exactly 2*win+1 merges; one more does not.
  const wide = Array.from({ length: 12 }, (_, i) => ({ t: i, timestamp: `0:${i}`, text: `w${i}` }));
  assert.equal(searchChunks(wide, re('^w0$|^w3$'), 1).length, 1, 'gap 3 == 2*1+1 merges');
  assert.equal(searchChunks(wide, re('^w0$|^w4$'), 1).length, 2, 'gap 4 > 2*1+1 splits');
});

test('no matches yields no groups', () => {
  assert.deepEqual(searchChunks(chunks, re('zulu'), 2), []);
});

test('a global regex does not leak lastIndex between chunks', () => {
  // A /g regex whose lastIndex is not reset between chunks would skip alternating
  // ones. Assert on matchCount, not group count: at window 0 the seven CONSECUTIVE
  // matches correctly merge into a single contiguous passage (gap 1 <= 2*0+1).
  const g = searchChunks(chunks, /[a-z]+/ig, 0);
  assert.equal(g.length, 1, 'consecutive matches form one passage');
  assert.equal(g[0].matchCount, chunks.length, 'every chunk matched — no lastIndex leak');
  assert.deepEqual([g[0].from, g[0].to], [0, chunks.length - 1]);
});

test('consecutive matches merge into one passage even at window 0', () => {
  // Continuous speech that matches across adjacent chunks is one passage, not N
  // hits — emitting it N times would hand back the amplification we removed.
  const g = searchChunks(chunks, re('bravo|charlie'), 0);
  assert.equal(g.length, 1);
  assert.equal(g[0].matchCount, 2);
  assert.deepEqual([g[0].from, g[0].to], [1, 2]);
});

test('frontmatter round-trips so retagging cannot corrupt a doc', () => {
  const { meta, body } = parseFrontmatter(DOC);
  meta.project_id = 'agentic-os';
  const rebuilt = renderFrontmatter(meta) + body;
  const again = parseFrontmatter(rebuilt);
  assert.equal(again.meta.video_id, 'abc12345678');
  assert.equal(again.meta.title, 'Test');
  assert.equal(again.meta.project_id, 'agentic-os');
  assert.equal(again.body, body, 'transcript body must be preserved byte-for-byte');
});
