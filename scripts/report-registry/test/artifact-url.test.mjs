import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePageId, notionPageUrl, artifactUrlForType, loadIds, NOTION_PAGE_BASE,
} from '../artifact-url.mjs';

test('normalizePageId accepts dashed and bare ids, case-insensitively', () => {
  assert.equal(normalizePageId('39576fd7-ac82-8187-91ca-f012ac9728a3'), '39576fd7ac82818791caf012ac9728a3');
  assert.equal(normalizePageId('39576fd7ac82818791caf012ac9728a3'), '39576fd7ac82818791caf012ac9728a3');
  assert.equal(normalizePageId('39576FD7-AC82-8187-91CA-F012AC9728A3'), '39576fd7ac82818791caf012ac9728a3');
  assert.equal(normalizePageId('  39576fd7ac82818791caf012ac9728a3  '), '39576fd7ac82818791caf012ac9728a3');
});

// The whole point of the guard: these all pass make-run's http(s) check once glued onto
// the base URL, and every one of them links nowhere.
for (const bad of ['', '   ', 'undefined', 'null', '39576fd7', '39576fd7ac82818791caf012ac9728a3ff', 'zzzzzfd7ac82818791caf012ac9728a3', null, undefined, 42, {}]) {
  test(`normalizePageId rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(normalizePageId(bad), null);
    assert.equal(notionPageUrl(bad), null, 'and therefore yields no URL at all, not a base-only one');
  });
}

test('notionPageUrl builds the dashless form', () => {
  assert.equal(
    notionPageUrl('39576fd7-ac82-8187-91ca-f012ac9728a3'),
    `${NOTION_PAGE_BASE}39576fd7ac82818791caf012ac9728a3`,
  );
});

test('artifactUrlForType resolves a known type', () => {
  const ids = { childPages: { 'FourthOS Sponsor': '39576fd7-ac82-8187-91ca-f012ac9728a3' } };
  assert.deepEqual(artifactUrlForType('FourthOS Sponsor', ids), {
    url: `${NOTION_PAGE_BASE}39576fd7ac82818791caf012ac9728a3`,
  });
});

test('artifactUrlForType reports, never throws, on an unknown type', () => {
  const ids = { childPages: { 'Team Dashboard': '39576fd7-ac82-810b-9fc8-c2d1f4f76fc3' } };
  const r = artifactUrlForType('Nope', ids);
  assert.equal(r.url, undefined);
  assert.match(r.error, /no childPages entry for "Nope"/);
  assert.match(r.error, /Team Dashboard/, 'names what it does know, so the fix is obvious');
});

test('artifactUrlForType reports a malformed id rather than emitting a base-only URL', () => {
  const r = artifactUrlForType('FourthOS Sponsor', { childPages: { 'FourthOS Sponsor': 'not-an-id' } });
  assert.equal(r.url, undefined);
  assert.match(r.error, /not a valid 32-hex Notion page id/);
});

test('artifactUrlForType survives a missing or empty ids object', () => {
  assert.match(artifactUrlForType('X', {}).error, /no childPages entry/);
  assert.match(artifactUrlForType('X', null).error, /no childPages entry/);
  assert.match(artifactUrlForType('', { childPages: {} }).error, /no report type given/);
});

// Guards the real file, not a fixture: if someone edits report-runs.ids.json and breaks an
// id, this fails here rather than silently emitting a dead link into the registry.
test('every childPages id in the REAL report-runs.ids.json resolves', () => {
  const ids = loadIds();
  const entries = Object.entries(ids.childPages);
  assert.ok(entries.length >= 6, 'expected the full set of report child pages');
  for (const [type, id] of entries) {
    const r = artifactUrlForType(type, ids);
    assert.equal(r.error, undefined, `${type}: ${r.error}`);
    assert.match(r.url, /^https:\/\/www\.notion\.so\/[0-9a-f]{32}$/, type);
  }
});

test('FourthOS Sponsor resolves to its known child page', () => {
  assert.equal(
    artifactUrlForType('FourthOS Sponsor', loadIds()).url,
    `${NOTION_PAGE_BASE}39576fd7ac82818791caf012ac9728a3`,
  );
});
