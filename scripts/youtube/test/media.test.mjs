import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCanonicalTranscript, parseTesseractTsv, shouldRetainVisual,
  transcriptDisagreements, visualSelectionFilter, whisperArguments,
} from '../lib/media.mjs';

test('Whisper runtime overrides are forwarded to the local adapter', () => {
  const args = whisperArguments('sample.wav', {
    model: 'medium.en', device: 'cpu', computeType: 'int8', language: 'en',
  });
  assert.equal(args[1], '--audio');
  assert.match(args[2], /sample\.wav$/);
  assert.deepEqual(args.slice(3), [
    '--model', 'medium.en', '--device', 'cpu', '--compute-type', 'int8',
    '--language', 'en', '--task', 'transcribe',
  ]);
});

test('manual captions win only when they cover every detected speech window', () => {
  const manual = [{ id: 'c1', start: 0, end: 10, text: 'manual' }];
  const whisper = [{ id: 'w1', start: 0, end: 20, text: 'fallback' }];
  assert.equal(chooseCanonicalTranscript({ captionProvenance: 'manual', captionChunks: manual, whisperChunks: whisper, speechWindows: [{ start: 0, end: 10 }] }).provenance, 'manual-caption');
  assert.equal(chooseCanonicalTranscript({ captionProvenance: 'manual', captionChunks: manual, whisperChunks: whisper, speechWindows: [{ start: 0, end: 20 }] }).provenance, 'whisper');
  assert.equal(chooseCanonicalTranscript({ captionProvenance: 'auto', captionChunks: manual, whisperChunks: whisper, speechWindows: [{ start: 0, end: 10 }] }).provenance, 'whisper');
});

test('caption reconciliation flags risky names and numbers', () => {
  const flags = transcriptDisagreements([{ text: 'Use GPT-5 at 42%' }], [{ text: 'Use GPT-4 at 40%' }]);
  assert.deepEqual(flags.map((flag) => flag.term).sort(), ['40%', '42%', 'GPT-4', 'GPT-5']);
});

test('OCR TSV returns text and mean confidence', () => {
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t80\tAgent\n5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t60\tLoop';
  assert.deepEqual(parseTesseractTsv(tsv), { text: 'Agent Loop', confidence: 70 });
});

test('visual dedup retains OCR changes and periodic fail-safe is present', () => {
  const previous = { perceptualHash: '0'.repeat(64), ocrHash: 'different-hash' };
  assert.equal(shouldRetainVisual(previous, { perceptualHash: '0'.repeat(64), ocrText: 'new label' }), true);
  assert.match(visualSelectionFilter(30), /gte\(t-prev_selected_t,30\)/);
});
