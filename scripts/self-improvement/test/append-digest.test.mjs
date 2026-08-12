// append-digest.test.mjs — pure tests for the deterministic PENDING-DIGEST queue append.
// Run: node --test "scripts/self-improvement/test/*.test.mjs"
// (explicit glob, NEVER the bare directory — collects 1 and fails on this Node/Windows combo)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseFrontmatter, buildDigestBlock, hasDigestFor, appendDigest,
} from '../append-digest.mjs';

const FM = `---
verdict: ADOPT
component_name: Cross-Session Coordination
headline: Field converged on worktree-per-agent isolation; keep the fenced lock layer.
---

## 1. Body starts here
`;

test('parseFrontmatter extracts verdict/name/headline; ignores body', () => {
  const fm = parseFrontmatter(FM);
  assert.equal(fm.verdict, 'ADOPT');
  assert.equal(fm.component_name, 'Cross-Session Coordination');
  assert.match(fm.headline, /worktree-per-agent/);
  assert.equal(fm['## 1. Body starts here'], undefined);
});

test('parseFrontmatter: no frontmatter -> empty object', () => {
  assert.deepEqual(parseFrontmatter('# just a doc\n'), {});
});

const block = buildDigestBlock({
  date: '2026-08-05', componentId: 'coordination',
  name: 'Cross-Session Coordination', verdict: 'ADOPT', headline: 'H.',
});

test('buildDigestBlock carries date, component, verdict, headline, proposal path', () => {
  assert.match(block, /^## 2026-08-05 — coordination \(Cross-Session Coordination\)/);
  assert.match(block, /\*\*Verdict:\*\* ADOPT/);
  assert.match(block, /proposals\/2026-08-05-coordination\.md/);
  assert.match(block, /---\n$/);
});

test('hasDigestFor matches its own block AND the headless-written heading shape', () => {
  assert.equal(hasDigestFor(block, '2026-08-05', 'coordination'), true);
  // Real headless-written heading from 2026-08-04 (em-dash separator):
  const headless = '## 2026-08-04 — coordination (Cross-Session Coordination)\n';
  assert.equal(hasDigestFor(headless, '2026-08-04', 'coordination'), true);
  // Different date or component: no match.
  assert.equal(hasDigestFor(block, '2026-08-04', 'coordination'), false);
  assert.equal(hasDigestFor(block, '2026-08-05', 'memory'), false);
});

test('appendDigest inserts ABOVE the Queue-clear footer when present', () => {
  const content = '# header\n\n---\n\n## old entry\n\n---\n\n*Queue clear above this line — no pending digests. Last sweep: X.*\n';
  const out = appendDigest(content, block);
  const footerAt = out.indexOf('*Queue clear');
  const blockAt = out.indexOf('## 2026-08-05');
  assert.ok(blockAt !== -1 && footerAt !== -1 && blockAt < footerAt, 'block must precede footer');
  assert.match(out, /## old entry/);
});

test('appendDigest appends at end when no footer', () => {
  const out = appendDigest('# header\n\n---\n', block);
  assert.ok(out.endsWith(block));
});
