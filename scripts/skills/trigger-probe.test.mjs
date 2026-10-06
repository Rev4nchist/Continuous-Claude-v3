// trigger-probe.test.mjs: scoreCase, the hit rule of scripts/skills/trigger-probe.mjs.
// Run: node --test scripts/skills/trigger-probe.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreCase } from './trigger-probe.mjs';

const bug = { prompt: 'sync exits 1', expect: ['systematic-debugging'], forbid: ['fix'] };

test('scoreCase: the expected skill fires together with a forbidden one is a miss', () => {
  const s = scoreCase(bug, ['systematic-debugging', 'fix']);
  assert.equal(s.hit, false);
  assert.deepEqual(s.falseFires, ['fix']);
});

test('scoreCase: only the expected skill fires is a hit', () => {
  assert.equal(scoreCase(bug, ['systematic-debugging']).hit, true);
});

test('scoreCase: a case with expect and forbid still needs the expected skill', () => {
  assert.equal(scoreCase(bug, []).hit, false);
  assert.equal(scoreCase(bug, ['build']).hit, false);
});

test('scoreCase: a negative case (empty expect) is a hit when nothing forbidden fires', () => {
  const neg = { prompt: 'copilot studio', expect: [], forbid: ['fabric'] };
  assert.equal(scoreCase(neg, []).hit, true);
  assert.equal(scoreCase(neg, ['databases']).hit, true);
  assert.equal(scoreCase(neg, ['fabric']).hit, false);
});

test('scoreCase: a case without forbid keeps the old rule', () => {
  const c = { prompt: 'x', expect: ['commit'] };
  assert.equal(scoreCase(c, ['commit', 'fix']).hit, true);
  assert.deepEqual(scoreCase(c, ['commit', 'fix']).falseFires, ['fix']);
});
