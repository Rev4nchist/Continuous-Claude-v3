// ytdlp-parse.test.mjs — parseListOutput, the guard between yt-dlp's -J output
// and everything downstream. The `null` case is the one that crashed live on
// Claude web (2026-08-04): --ignore-errors + total failure prints literal
// "null", and the old unguarded `data._type` turned yt-dlp's real SSL error
// into an opaque property-access crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListOutput } from '../lib/ytdlp.mjs';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

test('literal "null" stdout throws with yt-dlp\'s OWN stderr, not a property crash', () => {
  assert.throws(
    () => parseListOutput('null', 'ERROR: SSL: CERTIFICATE_VERIFY_FAILED self-signed certificate', URL),
    (e) => e instanceof Error && /CERTIFICATE_VERIFY_FAILED/.test(e.message),
  );
});

test('null stdout with EMPTY stderr still throws a clean Error', () => {
  assert.throws(() => parseListOutput('null', '', URL), /could not extract .*no error detail/);
});

test('empty stdout surfaces stderr too', () => {
  assert.throws(
    () => parseListOutput('', 'ERROR: network unreachable', URL),
    /no data .*network unreachable/,
  );
});

test('non-JSON stdout reports the payload, not a parse stack', () => {
  assert.throws(() => parseListOutput('<html>proxy login</html>', '', URL), /non-JSON .*proxy login/);
});

test('a single video object parses to kind=video with one entry', () => {
  const out = JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: 19, channel: 'jawed' });
  const r = parseListOutput(out, '', URL);
  assert.equal(r.kind, 'video');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, 'jNQXAC9IVRw');
});

test('a playlist object parses entries and drops null/id-less rows', () => {
  const out = JSON.stringify({
    _type: 'playlist',
    channel: 'jawed',
    entries: [{ id: 'a'.repeat(11), title: 't' }, null, { title: 'no id' }],
  });
  const r = parseListOutput(out, '', URL);
  assert.equal(r.kind, 'playlist');
  assert.equal(r.entries.length, 1);
});
