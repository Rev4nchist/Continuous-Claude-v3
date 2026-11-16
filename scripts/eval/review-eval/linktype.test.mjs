// Tests for linktype.mjs (the linkType labels of the real Majors). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { LINK_TYPES, loadLinkTypes, writeLinkTypeLabels } from './linktype.mjs';

const made = [];
const write = (obj) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lt-'));
  made.push(dir);
  const file = path.join(dir, 'linktype-labels.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('the four link classes are fixed in this order (breaks if a class is renamed: the labels file and the scorecard key on them)', () => {
  assert.deepEqual(LINK_TYPES, ['within-hunk', 'same-file', 'cross-file-static', 'cross-file-dynamic']);
});

test('loadLinkTypes returns key -> final class and refuses a class outside the four (breaks if a typo in the file reaches the scorecard)', () => {
  const ok = write({ labels: { 'a:1': { final: 'same-file' }, 'b:2': { final: 'within-hunk' } } });
  assert.deepEqual(loadLinkTypes(ok), { 'a:1': 'same-file', 'b:2': 'within-hunk' });
  assert.throws(() => loadLinkTypes(write({ labels: { 'a:1': { final: 'cross-file' } } })), /1 label.*outside/);
  assert.throws(() => loadLinkTypes(write({ nope: 1 })), /labels/);
});

test('a loadLinkTypes error holds a count and never a finding key, a PR number or a comment id (breaks if the key, the class text or the parse text is in the message)', () => {
  const bad = write({ labels: { '9001:123456789': { final: 'xfile-typo' }, 'ok:1': { final: 'same-file' }, '9002:987654321': { final: 'nope' } } });
  const unparsable = write('{ "9001:123456789": nope');
  for (const file of [bad, unparsable]) {
    let message = '';
    try { loadLinkTypes(file); } catch (e) { message = e.message; }
    assert.notEqual(message, '', 'it throws');
    for (const id of ['9001', '123456789', '9002', '987654321', 'xfile-typo']) assert.equal(message.includes(id), false, `message holds ${id}`);
  }
  assert.match((() => { try { loadLinkTypes(bad); } catch (e) { return e.message; } return ''; })(), /2 label/);
});

test('loadLinkTypes of a missing file is an empty map, so a scorecard without labels still runs (breaks if a missing file throws)', () => {
  assert.deepEqual(loadLinkTypes(path.join(os.tmpdir(), 'no-such-dir-lt', 'x.json')), {});
});

const CLAUDE = { family: 'anthropic', model: 'opus', effort: 'high' };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('writeLinkTypeLabels adds the claude rater with its family and one-rater labels that loadLinkTypes reads (breaks if the rater, final or agreement shape changes)', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'lt-w-')), 'linktype-labels.json');
  made.push(path.dirname(file));
  writeLinkTypeLabels(file, { 'fx:1': 'same-file', 'fx:2': 'within-hunk' }, { 'agent-claude': CLAUDE });
  const json = readJson(file);
  assert.deepEqual(json.raters['agent-claude'], CLAUDE);
  assert.deepEqual(json.labels['fx:1'], { 'agent-claude': 'same-file', final: 'same-file' });
  assert.equal(json.agreement, null);
  assert.deepEqual(json.classes, [...LINK_TYPES]);
  assert.deepEqual(loadLinkTypes(file), { 'fx:1': 'same-file', 'fx:2': 'within-hunk' });
  assert.deepEqual(readdirSync(path.dirname(file)), ['linktype-labels.json'], 'no temp file is left behind');
});

test('writeLinkTypeLabels keeps an entry that has a second rater and refreshes a claude-only one (breaks if a two-rater final is overwritten)', () => {
  const two = { 'agent-claude': 'within-hunk', 'agent-grok': 'same-file', final: 'within-hunk' };
  const file = write({ classes: [...LINK_TYPES], raters: { 'agent-grok': { family: 'grok' } }, agreement: { kappa: 0.5 }, labels: { 'fx:2': two, 'fx:3': { 'agent-claude': 'within-hunk', final: 'within-hunk' } } });
  const res = writeLinkTypeLabels(file, { 'fx:2': 'cross-file-static', 'fx:3': 'same-file', 'fx:4': 'cross-file-dynamic' }, { 'agent-claude': CLAUDE });
  const json = readJson(file);
  assert.deepEqual(json.labels['fx:2'], two);
  assert.equal(json.labels['fx:3'].final, 'same-file');
  assert.equal(json.labels['fx:4'].final, 'cross-file-dynamic');
  assert.deepEqual(json.raters, { 'agent-grok': { family: 'grok' }, 'agent-claude': CLAUDE });
  assert.deepEqual(json.agreement, { kappa: 0.5 });
  assert.deepEqual({ added: res.added, kept: res.kept }, { added: 2, kept: 1 });
});

test('writeLinkTypeLabels refuses a class outside the four and writes nothing (breaks if a typo reaches the file)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lt-bad-'));
  made.push(dir);
  const file = path.join(dir, 'linktype-labels.json');
  assert.throws(() => writeLinkTypeLabels(file, { '9001:123456789': 'xfile-typo' }, { 'agent-claude': CLAUDE }), (e) => /1 entry/.test(e.message) && !/9001|123456789|xfile-typo/.test(e.message));
  assert.equal(existsSync(file), false);
});

test('writeLinkTypeLabels takes the rater name from the raters argument, not a fixed name (breaks if agent-claude is hard-coded)', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'lt-r-')), 'linktype-labels.json');
  made.push(path.dirname(file));
  writeLinkTypeLabels(file, { 'fx:1': 'same-file' }, { 'agent-test': CLAUDE });
  const json = readJson(file);
  assert.deepEqual(json.labels['fx:1'], { 'agent-test': 'same-file', final: 'same-file' });
  assert.deepEqual(Object.keys(json.raters), ['agent-test']);
  assert.throws(() => writeLinkTypeLabels(file, { 'fx:2': 'same-file' }, { a: CLAUDE, b: CLAUDE }), /one rater/);
});
