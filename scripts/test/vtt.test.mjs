// vtt.test.mjs — node:test suite for the WebVTT -> transcript pipeline.
// Run: node --test scripts/test/vtt.test.mjs
//
// The fixtures below are verbatim shapes captured from real YouTube responses
// (2026-07-25) so the rolling/karaoke cases stay pinned to reality, not to what
// we imagine the format looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCues, dedupeCues, chunkCues, vttToChunks, stripCueMarkup, countWords,
} from '../lib/vtt.mjs';

// Real ASR shape: 10ms bridge cues, karaoke <c> spans, rolling carry-over.
const ROLLING = `WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.270 align:start position:0%

hi<00:00:00.320><c> everyone</c><00:00:01.280><c> so</c><00:00:01.480><c> recently</c><00:00:01.880><c> I</c><00:00:02.000><c> gave</c><00:00:02.159><c> a</c>

00:00:02.270 --> 00:00:02.280 align:start position:0%
hi everyone so recently I gave a


00:00:02.280 --> 00:00:04.230 align:start position:0%
hi everyone so recently I gave a
30-minute<00:00:02.800><c> talk</c><00:00:03.000><c> on</c><00:00:03.159><c> large</c><00:00:03.439><c> language</c><00:00:03.760><c> models</c>

00:00:04.230 --> 00:00:04.240 align:start position:0%
30-minute talk on large language models

`;

// Manual/clean captions — no rolling, no markup.
const CLEAN = `WEBVTT
Kind: captions
Language: en

00:00:04.220 --> 00:00:05.400
This is a 3.

00:00:06.060 --> 00:00:10.713
It's sloppily written and rendered at an extremely low resolution.
`;

test('stripCueMarkup removes karaoke tags and decodes entities', () => {
  assert.equal(
    stripCueMarkup('hi<00:00:00.320><c> everyone</c>'),
    'hi everyone',
  );
  assert.equal(stripCueMarkup('Tom &amp; Jerry &#39;92'), "Tom & Jerry '92");
  assert.equal(stripCueMarkup('   spaced   out   '), 'spaced out');
});

test('parseCues skips headers and blank-only lines', () => {
  const cues = parseCues(ROLLING);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 0.16);
  // The lone " " line must be dropped, leaving only the real text line.
  assert.deepEqual(cues[0].lines, ['hi everyone so recently I gave a']);
});

test('dedupeCues collapses rolling carry-over without losing new text', () => {
  const out = dedupeCues(parseCues(ROLLING));
  const text = out.map((c) => c.text).join(' ');
  assert.equal(text, 'hi everyone so recently I gave a 30-minute talk on large language models');
  // Each phrase appears exactly once.
  assert.equal(text.match(/hi everyone/g).length, 1);
  assert.equal(text.match(/30-minute talk/g).length, 1);
});

test('dedupe preserves a genuinely repeated phrase separated by other text', () => {
  // Conservative window: only the PREVIOUS cue is compared, so a real repeat
  // that returns after intervening speech must survive.
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
it depends

00:00:02.000 --> 00:00:03.000
on the workload

00:00:03.000 --> 00:00:04.000
it depends
`;
  const out = dedupeCues(parseCues(vtt));
  const text = out.map((c) => c.text).join(' ');
  assert.equal(text, 'it depends on the workload it depends');
});

test('clean captions pass through unchanged', () => {
  const out = dedupeCues(parseCues(CLEAN));
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'This is a 3.');
});

test('chunkCues stamps each chunk with its FIRST cue start time', () => {
  const cues = dedupeCues(parseCues(ROLLING));
  const chunks = chunkCues(cues, { chunkChars: 1000 }); // force a single chunk
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].t, 0.16, 'citation must land at or before the claim');
});

test('chunkCues splits once the char budget is exceeded', () => {
  const cues = dedupeCues(parseCues(ROLLING));
  const chunks = chunkCues(cues, { chunkChars: 10 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].t, 0.16);
});

test('vttToChunks end-to-end produces non-empty, markup-free text', () => {
  const chunks = vttToChunks(ROLLING);
  assert.ok(chunks.length >= 1);
  const all = chunks.map((c) => c.text).join(' ');
  assert.ok(!all.includes('<'), 'no residual markup');
  assert.ok(countWords(chunks) > 0);
});

test('empty and malformed input degrade to empty, not throw', () => {
  assert.deepEqual(vttToChunks(''), []);
  assert.deepEqual(vttToChunks('WEBVTT\n\nnot a cue\n'), []);
  assert.deepEqual(vttToChunks('garbage'), []);
});
