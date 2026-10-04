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

test('a file named outside the table (a pointer line) is not an index row', () => {
  const problems = checkIndex({ manifest: { rules: [] }, indexText: index([]), files: [] });
  assert.deepEqual(problems, []);
});
