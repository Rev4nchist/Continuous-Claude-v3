// Pins the review-waiver phrase in the two places that must agree: the watcher (model.ts WAIVER_PREFIX) and the rule
// that tells sessions what to post (pr-review-loop.md). Run: node --test scripts/github/waiver-phrase.test.mjs
//
// How it can fail: the mod's phrase changes and the rule keeps the old one (sessions post a comment the watcher
// ignores, with no alarm); the rule loses the instruction; the constant is renamed so the test finds nothing.
//   WP1: model.ts defines WAIVER_PREFIX as a string literal
//   WP2: the rule names that exact phrase, in backticks, and ties it to Dave's explicit yes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function modelPhrase() {
  const m = /export const WAIVER_PREFIX = '([^']+)'/.exec(read('.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts'));
  assert.ok(m, 'model.ts must define: export const WAIVER_PREFIX = \'...\'');
  return m[1];
}

test('WP1: model.ts defines the waiver phrase as a string literal', () => {
  assert.match(modelPhrase(), /^Review waived by Dave/);
});

test('WP2: pr-review-loop.md tells sessions to post the exact phrase, only after Dave\'s explicit yes', () => {
  const rule = read('.claude/rules-ondemand/pr-review-loop.md').replace(/\s+/g, ' ');
  assert.ok(rule.includes(`\`${modelPhrase()}\``), `the rule must name \`${modelPhrase()}\` in backticks`);
  assert.match(rule, /after Dave's explicit yes to waive/);
});
