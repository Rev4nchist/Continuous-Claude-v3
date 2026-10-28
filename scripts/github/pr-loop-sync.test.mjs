// Drift guard: the ccv3-mods pr-loop mod is TypeScript and cannot import review-status.mjs, so it holds two
// strings by value. This test fails when they differ from review-status.mjs. Run: node --test scripts/github/pr-loop-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROOF_REASON_PREFIX } from './review-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = readFileSync(path.join(HERE, '..', '..', '.claude', 'plugins', 'ccv3-mods', 'hooks', 'pr-loop', 'model.ts'), 'utf8');
const STATUS = readFileSync(path.join(HERE, 'review-status.mjs'), 'utf8');

test('the mod holds the same PROOF_REASON_PREFIX as review-status.mjs', () => {
  const m = /export const PROOF_REASON_PREFIX = '([^']+)'/.exec(MODEL);
  assert.ok(m, 'model.ts no longer declares PROOF_REASON_PREFIX');
  assert.equal(m[1], PROOF_REASON_PREFIX);
});

test('the mod reads the rate-limit reason review-status.mjs writes', () => {
  const written = /reasons\.push\('(CodeRabbit rate limited:)/.exec(STATUS);
  assert.ok(written, 'review-status.mjs no longer writes a "CodeRabbit rate limited:" reason');
  const read = /const CODERABBIT_RATE_LIMITED = \/\^([^/]+)\//.exec(MODEL);
  assert.ok(read, 'model.ts no longer declares CODERABBIT_RATE_LIMITED');
  assert.equal(read[1], written[1]);
});
