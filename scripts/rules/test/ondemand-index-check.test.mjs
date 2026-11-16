// The always-loaded index (rules-src/on-demand-rules.md) is how a session plans around rules that
// load later; manifest.json is what actually loads them. Each test is one way the two can drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIndex } from '../ondemand-index-check.mjs';

const index = (rows) => `# On-demand rules\n\n| Rule file | Loads on | Mode |\n|---|---|---|\n${rows.join('\n')}\n\nSee \`every-surface-checklist.md\`.\n`;
const rule = (id, files, mode = 'inject') => ({ id, files, mode });

test('a clean set has no problems', () => {
  const problems = checkIndex({
    manifest: { rules: [rule('a', ['a.md'], 'deny-first'), rule('b', ['b.md']), rule('b2', ['b.md'], 'deny-first')] },
    indexText: index(['| `a.md` | x | block |', '| `b.md` | y | inject / block |']),
    files: ['a.md', 'b.md'],
  });
  assert.deepEqual(problems, []);
});

test('a manifest file missing on disk is reported (the router would fail open on it)', () => {
  const problems = checkIndex({ manifest: { rules: [rule('a', ['a.md'])] }, indexText: index(['| `a.md` | x | inject |']), files: [] });
  assert.match(problems.join('\n'), /a\.md.*missing from rules-ondemand/);
});

test('a manifest file with no index row is reported', () => {
  const problems = checkIndex({ manifest: { rules: [rule('a', ['a.md'])] }, indexText: index([]), files: ['a.md'] });
  assert.match(problems.join('\n'), /a\.md.*no row in the index/);
});

test('an index row naming a file that does not exist is reported', () => {
  const problems = checkIndex({ manifest: { rules: [] }, indexText: index(['| `gone.md` | x | inject |']), files: [] });
  assert.match(problems.join('\n'), /gone\.md.*index row names a file/);
});

test('a rule file that no manifest entry loads is reported', () => {
  const problems = checkIndex({ manifest: { rules: [] }, indexText: index(['| `orphan.md` | x | inject |']), files: ['orphan.md'] });
  assert.match(problems.join('\n'), /orphan\.md.*no manifest entry loads it/);
});

test('a deny-first rule whose row does not say block is reported', () => {
  const problems = checkIndex({ manifest: { rules: [rule('a', ['a.md'], 'deny-first')] }, indexText: index(['| `a.md` | x | inject |']), files: ['a.md'] });
  assert.match(problems.join('\n'), /a\.md.*deny-first.*"block"/);
});

test('an inject rule whose row does not say inject is reported', () => {
  const problems = checkIndex({ manifest: { rules: [rule('a', ['a.md'])] }, indexText: index(['| `a.md` | x | block |']), files: ['a.md'] });
  assert.match(problems.join('\n'), /a\.md.*inject.*"inject"/);
});

// Claude Code cuts a hook additionalContext string above 10,000 characters to a 2,000 character
// preview. An inject rule over that size never reaches the session (findings row 56, 2026-11-11).
const sized = (mode, chars, subagent = undefined) => checkIndex({
  manifest: { rules: [{ ...rule('big', ['big.md'], mode), ...(subagent ? { subagent } : {}) }] },
  indexText: index([`| \`big.md\` | x | ${mode === 'deny-first' ? 'block' : 'inject'} |`]),
  files: ['big.md'],
  sizes: { 'big.md': chars },
});

test('an inject rule whose emitted text is over the hook cap is reported', () => {
  assert.match(sized('inject', 9600).join('\n'), /big\.md.*over the 10,000 character hook cap/);
});

test('an inject rule that fits under the hook cap with the router lines is not reported', () => {
  assert.deepEqual(sized('inject', 9400), []);
});

test('a deny-first rule with subagent block over the cap is not reported (a deny reason is not cut)', () => {
  assert.deepEqual(sized('deny-first', 30000, 'block'), []);
});

test('a deny-first rule over the cap with no subagent block is reported (the router sends it to a subagent as inject)', () => {
  assert.match(sized('deny-first', 30000).join('\n'), /big\.md.*subagent.*over the 10,000 character hook cap/);
});

test('a deny-first rule under the cap needs no subagent block', () => {
  assert.deepEqual(sized('deny-first', 3000), []);
});

// A reference-only file is a long rule that no manifest entry loads. A short loaded rule names it by its active path
// and tells the session to read it (lane pr-review-loop-10k-cut). Each test is one way that link can break.
const REF = 'full.md';
const refCheck = (over = {}) => checkIndex({
  manifest: { rules: [rule('core', ['core.md'])] },
  indexText: index(['| `core.md` | x | inject |']),
  files: ['core.md', REF],
  sizes: { 'core.md': 3000, [REF]: 64000 },
  texts: { 'core.md': 'Full rule: C:/Users/x/.claude/rules-ondemand/full.md', [REF]: 'long' },
  referenceOnly: [REF],
  ...over,
});

test('a reference-only file that exists, is not loaded, and is named by a loaded rule that fits is clean', () => {
  assert.deepEqual(refCheck(), []);
});

test('a reference-only file that a manifest entry also loads is reported', () => {
  const problems = refCheck({ manifest: { rules: [rule('core', ['core.md']), rule('both', [REF])] }, indexText: index(['| `core.md` | x | inject |', `| \`${REF}\` | x | inject |`]), sizes: { 'core.md': 3000, [REF]: 3000 } });
  assert.match(problems.join('\n'), /full\.md.*reference only.*also loaded/);
});

test('a reference-only file that is not on disk is reported', () => {
  assert.match(refCheck({ files: ['core.md'] }).join('\n'), /full\.md.*reference only.*missing from rules-ondemand/);
});

test('a reference-only file that no loaded rule file names is reported', () => {
  const problems = refCheck({ texts: { 'core.md': 'nothing here', [REF]: 'long' } });
  assert.match(problems.join('\n'), /full\.md.*reference only.*no loaded rule file.*names it/);
});

test('a name in a file that no manifest entry loads does not count', () => {
  const problems = refCheck({ files: ['core.md', REF, 'other.md'], texts: { 'core.md': 'nothing', 'other.md': 'rules-ondemand/full.md', [REF]: 'long' } });
  assert.match(problems.join('\n'), /full\.md.*reference only.*no loaded rule file.*names it/);
});

test('a name in a loaded rule that is itself over the hook cap does not count', () => {
  const problems = refCheck({ sizes: { 'core.md': 12000, [REF]: 64000 } });
  assert.match(problems.join('\n'), /full\.md.*reference only.*no loaded rule file.*names it/);
});

test('a path that only starts like the name (full.md.bak) is no link', () => {
  const problems = refCheck({ texts: { 'core.md': 'see C:/x/.claude/rules-ondemand/full.md.bak', [REF]: 'long' } });
  assert.match(problems.join('\n'), /full\.md.*reference only.*names it/);
});

test('a link written with backslashes counts', () => {
  assert.deepEqual(refCheck({ texts: { 'core.md': 'see C:\\x\\.claude\\rules-ondemand\\full.md', [REF]: 'long' } }), []);
});

test('a ## section of the reference file with no line in the loaded namer is reported', () => {
  const problems = refCheck({ texts: { 'core.md': 'rules-ondemand/full.md\n- Alpha: when to read', [REF]: '## Alpha\n\n## Beta (2026-11-16)\n' } });
  assert.match(problems.join('\n'), /full\.md.*no line for its section.*Beta/);
  assert.doesNotMatch(problems.join('\n'), /Alpha/);
});

test('a heading with a date or an aside is matched by its plain name', () => {
  assert.deepEqual(refCheck({ texts: { 'core.md': 'rules-ondemand/full.md\n- Paid reviews', [REF]: '## Paid reviews (Dave, 2026-10-30)\n## Thread — verify\n' } }).filter((p) => /Paid/.test(p)), []);
});

// The router joins the rules that fire on one call. Two rules that share an identical trigger pattern fire together.
const group = (aChars, bChars, over = {}) => checkIndex({
  manifest: { rules: [{ ...rule('a', ['a.md']), command: ['^x\\b'] }, { ...rule('b', ['b.md']), command: ['^x\\b'], ...over }] },
  indexText: index(['| `a.md` | x | inject |', `| \`b.md\` | x | ${over.mode === 'deny-first' ? 'block' : 'inject'} |`]),
  files: ['a.md', 'b.md'],
  sizes: { 'a.md': aChars, 'b.md': bChars },
  knownCofire: [],
});

test('two inject rules that share a trigger and join over the hook cap are reported', () => {
  assert.match(group(4000, 6000).join('\n'), /a and b fire on one call and join to 11002 characters/);
});

test('two inject rules that share a trigger and join under the hook cap are not reported', () => {
  assert.deepEqual(group(3000, 5000), []);
});

test('a deny-first rule in the group makes the output a deny reason, which is not cut', () => {
  assert.deepEqual(group(4000, 6000, { mode: 'deny-first', subagent: 'block' }), []);
});

test('rules with different trigger patterns are not a group', () => {
  const problems = checkIndex({
    manifest: { rules: [{ ...rule('a', ['a.md']), command: ['^x\\b'] }, { ...rule('b', ['b.md']), command: ['^y\\b'] }] },
    indexText: index(['| `a.md` | x | inject |', '| `b.md` | x | inject |']),
    files: ['a.md', 'b.md'], sizes: { 'a.md': 6000, 'b.md': 6000 },
  });
  assert.deepEqual(problems, []);
});

test('a known over-cap group is not reported while it is over, and is reported when it fits', () => {
  const run = (a, b) => checkIndex({
    manifest: { rules: [{ ...rule('a', ['a.md']), command: ['^x'] }, { ...rule('b', ['b.md']), command: ['^x'] }] },
    indexText: index(['| `a.md` | x | inject |', '| `b.md` | x | inject |']),
    files: ['a.md', 'b.md'], sizes: { 'a.md': a, 'b.md': b }, knownCofire: ['a+b'],
  });
  assert.deepEqual(run(4000, 6000), []);
  assert.match(run(1000, 1000).join('\n'), /a\+b: listed in KNOWN_COFIRE_OVER.*not over the cap now/);
});

test('a rule file that is not on the reference-only list and that nobody loads is still reported', () => {
  assert.match(refCheck({ files: ['core.md', REF, 'stray.md'] }).join('\n'), /stray\.md.*no manifest entry loads it/);
});

test('with no sizes given, no size check runs', () => {
  const problems = checkIndex({ manifest: { rules: [rule('big', ['big.md'])] }, indexText: index(['| `big.md` | x | inject |']), files: ['big.md'] });
  assert.deepEqual(problems, []);
});

test('a file named outside the table (a pointer line) is not an index row', () => {
  const problems = checkIndex({ manifest: { rules: [] }, indexText: index([]), files: [] });
  assert.deepEqual(problems, []);
});
