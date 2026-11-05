// Tests for the model check on a stream-json run (cursor-review.mjs parseReviewOutput, normalizeModelName).
// The stream-json result line has no `model` field (fixtures/cursor-review/stream-json-read-glob.jsonl, a real grok-4.7-high run), but the
// system/init event names the model as a display name ("Grok 4.7 256K High"). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeModelName, parseReviewOutput } from './cursor-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(HERE, 'fixtures', 'cursor-review', 'stream-json-read-glob.jsonl'), 'utf8');

test('the init model of a stream run verifies the expected model (breaks if the init event is not read)', () => {
  const p = parseReviewOutput(RAW, { expectModel: 'grok-4.7-high' });
  assert.equal(p.modelVerified, true);
  assert.equal(p.modelMismatch, false);
});

test('an init model that names another model is a mismatch, so the run is void (breaks if the mismatch rule is skipped for streams)', () => {
  const p = parseReviewOutput(RAW, { expectModel: 'grok-4.7-xhigh' });
  assert.equal(p.modelVerified, false);
  assert.equal(p.modelMismatch, true);
});

test('a stream with no init event leaves modelVerified false and is not a mismatch (breaks if a missing init counts as a mismatch)', () => {
  const noInit = RAW.split('\n').filter((l) => !l.includes('"subtype":"init"')).join('\n');
  const p = parseReviewOutput(noInit, { expectModel: 'grok-4.7-high' });
  assert.equal(p.modelVerified, false);
  assert.equal(p.modelMismatch, false);
});

test('a model field on the result line still wins over the init event (breaks if the init model replaces the result model)', () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', model: 'grok-4.7-xhigh' });
  const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'Grok 4.7 256K High' });
  const p = parseReviewOutput(`${init}\n${result}\n`, { expectModel: 'grok-4.7-high' });
  assert.equal(p.modelMismatch, true);
});

test('normalizeModelName turns a display name into a model id (breaks if the size token or the effort word is kept)', () => {
  assert.equal(normalizeModelName('Grok 4.7 256K High'), 'grok-4.7-high');
  assert.equal(normalizeModelName('Grok 4.7 256K Extra High'), 'grok-4.7-xhigh');
  assert.equal(normalizeModelName('Composer 2.5'), 'composer-2.5');
  assert.equal(normalizeModelName('grok-4.7-high'), 'grok-4.7-high');
});

test('an init name that is only less specific than the expected model (no effort word) is neither verified nor a mismatch (breaks if a short display name voids a good run)', () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'Grok 4.7' });
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x' });
  const p = parseReviewOutput(`${init}\n${result}\n`, { expectModel: 'grok-4.7-high' });
  assert.equal(p.modelVerified, false);
  assert.equal(p.modelMismatch, false);
});
