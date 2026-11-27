/**
 * ship-ask-texts.test.mjs -- card coord-shipask-texts.
 *
 * Since PR 764 `ship-ask.mjs <step>` exits 2 without --json (or --text). A text that tells a session to run or ask a step without the flag now sends it
 * into an error. This test finds every `ship-ask(.mjs) <step>` mention in the tracked source files and fails a mention that holds neither --json nor
 * --text on its own line. Test files, the built hook folder, archive folders and ship-ask.mjs itself are not read.
 *
 * Two lists:
 *   OWNED  files this card keeps clean. A bad mention here fails T1.
 *   OPEN   files with a known bad mention that another card fixes. T2 fails when a listed file no longer has one, so the card that fixes it
 *          must delete its entry; a file in neither list with a bad mention fails T2.
 *
 *   T1  the owned files hold no bad mention                          -> names file:line
 *   T2  the open list is exact, and no other file has a bad mention  -> a stale entry or a new bad mention fails
 *   T3  the finder: one good and one bad mention give one hit        -> the check cannot pass on a text it did not read
 *       and two commands on one line are each checked                  -> the rest of the line stops at the next ship-ask
 *   T4  the finder read the real tree: at least 8 mentions in the owned files, and at least 100 files in the tree
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const STEPS = ['commit-and-push', 'open-pr', 'land', 'paid-round', 'cli-skip', 'cap-override'];
// A command mention: the step word is followed by a flag, by punctuation that closes the mention, or by the end of the line. Prose such as
// "a ship-ask cap-override question" names the step as a noun and is no mention. The rest of the line ends at the next ship-ask, so two commands
// on one line are each checked.
const MENTION = new RegExp(`ship-ask(?:\\.mjs)?\\s+(${STEPS.join('|')})(?![\\w-])(?=\\s+--|\\s*[)\`'".,;:]|\\s*$)((?:(?!ship-ask[ .])[^\\n])*)`, 'g');

const OWNED = [
  'scripts/github/land-pr.ps1',
  'scripts/github/land-decision.mjs',
  '.claude/rules-ondemand/pr-review-loop.md',
  '.claude/rules-ondemand/pr-review-loop-core.md',
  '.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts',
];
// A file that holds a bad mention another card fixes, with that card. Delete the entry in the commit that fixes the file.
const OPEN = {
  '.claude/hooks/src/decision-gate.ts': 'coord-gate-timeout-hole',
};

/** Every ship-ask step mention of a text: { line, step, ok }. ok is true when the rest of its line holds --json or --text. */
export function mentionsOf(text) {
  const out = [];
  String(text).split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(MENTION)) out.push({ line: i + 1, step: m[1], ok: /--(?:json|text)\b/.test(m[2]) });
  });
  return out;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const bad = (rel) => mentionsOf(read(rel)).filter((m) => !m.ok);

const SKIP = [/\.test\./, /(^|\/)__tests__\//, /^\.claude\/hooks\/dist\//, /^\.claudedocs\//, /^thoughts\//, /^docs\/research\//, /^scripts\/github\/ship-ask\.mjs$/, /(^|\/)node_modules\//];
const TEXT_EXT = /\.(mjs|cjs|js|ts|tsx|md|ps1|sh|json|yml|yaml|html)$/;

function treeFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f && TEXT_EXT.test(f) && !SKIP.some((re) => re.test(f)));
}

describe('T1 the owned files hold no bad mention', () => {
  for (const rel of OWNED) {
    it(rel, () => {
      const hits = bad(rel).map((m) => `${rel}:${m.line} (${m.step})`);
      assert.deepEqual(hits, [], `a ship-ask step with no --json or --text: ${hits.join(', ')}`);
    });
  }
});

/** The two ways the open list can be wrong: a file with a bad mention that is not on it, and an entry whose file has no bad mention any more. */
export function openProblems(withBad, open) {
  return { unlisted: withBad.filter((f) => !(f in open)), stale: Object.keys(open).filter((f) => !withBad.includes(f)) };
}

describe('T2 the open list is exact, and no other file has a bad mention', () => {
  const withBad = treeFiles().filter((f) => !OWNED.includes(f) && bad(f).length > 0);
  const problems = openProblems(withBad, OPEN);
  it('every file with a bad mention is on the open list', () => {
    assert.deepEqual(problems.unlisted, [], `a bad mention in a file that is on no list: ${problems.unlisted.join(', ')}`);
  });
  it('every open entry still has a bad mention', () => {
    assert.deepEqual(problems.stale, [], `no bad mention any more: delete the entry from OPEN (${problems.stale.map((f) => `${f}, owner ${OPEN[f]}`).join('; ')})`);
  });
  it('the check itself: an unlisted file and a stale entry are both reported', () => {
    const p = openProblems(['a.md', 'b.md'], { 'b.md': 'card x', 'c.md': 'card y' });
    assert.deepEqual(p, { unlisted: ['a.md'], stale: ['c.md'] });
  });
});

describe('T3 the finder', () => {
  it('one good and one bad mention give one hit', () => {
    const text = [
      'Run `node scripts/github/ship-ask.mjs land --pr 5 --json`.',
      'Or ask (ship-ask.mjs paid-round --pr 5) with no flag.',
      'The words ship-ask and land, apart, are no mention.',
      'ship-ask open-pr --text prints a view.',
    ].join('\n');
    const all = mentionsOf(text);
    assert.equal(all.length, 3);
    assert.deepEqual(all.filter((m) => !m.ok).map((m) => [m.line, m.step]), [[2, 'paid-round']]);
  });
  it('a step name inside a longer word is no mention', () => {
    assert.equal(mentionsOf('ship-ask landing page, ship-ask land-pr.ps1').length, 0);
  });
  it('two commands on one line are each checked (the rest of the line stops at the next ship-ask)', () => {
    const bad = (text) => mentionsOf(text).filter((m) => !m.ok).length;
    assert.equal(bad('ship-ask land --json, then ship-ask open-pr.'), 1, 'good then bad');
    assert.equal(bad('ship-ask land, then ship-ask open-pr --json'), 1, 'bad then good');
    // The cut is only at ship-ask followed by a space or a dot: a branch or a path that holds the word does not end the rest of the line.
    assert.equal(bad('ship-ask cli-skip --branch coord/ship-ask-x --json'), 0, 'a branch that holds the word, flag after it');
    assert.equal(bad('ship-ask land --branch coord/ship-ask-x'), 1, 'a branch that holds the word, no flag (guard)');
    assert.equal(bad('ship-ask land --json, then ship-ask open-pr --text'), 0, 'good and good');
    assert.equal(bad('ship-ask land, then ship-ask open-pr.'), 2, 'bad and bad');
  });
  it('prose that uses a step name as a noun is no mention; a closing mark or the line end is', () => {
    assert.equal(mentionsOf('the tap is a ship-ask cap-override question, stored as').length, 0);
    assert.deepEqual(mentionsOf('(ship-ask.mjs land).').map((m) => m.ok), [false]);
    assert.deepEqual(mentionsOf('run `ship-ask.mjs cli-skip`').map((m) => m.ok), [false]);
    assert.deepEqual(mentionsOf('run ship-ask land').map((m) => m.ok), [false]);
  });
});

describe('T4 the finder read the real tree', () => {
  it('finds at least 8 mentions in the owned files and reads at least 100 files', () => {
    const owned = OWNED.reduce((n, rel) => n + mentionsOf(read(rel)).length, 0);
    assert.ok(owned >= 8, `only ${owned} mentions found in the owned files`);
    assert.ok(treeFiles().length >= 100, 'the tree list is too short: git ls-files failed');
  });
});
