// Content tests for .claude/rules-ondemand/coderabbit-cli.md (DW-91 AC5–AC7)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const rule = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../.claude/rules-ondemand/coderabbit-cli.md'),
  'utf8',
);

test('AC5: run cap, timeout, incomplete, confirmation stops, advisory, forbidden flags', () => {
  assert.match(rule, /2.*`cr review --agent`/);
  assert.match(rule, /15 minutes/);
  assert.match(rule, /35 minutes/);
  assert.match(rule, /incomplete/i);
  assert.match(rule, /awaiting_confirmation/);
  assert.match(rule, /action_required/);
  assert.match(rule, /advisory/i);
  assert.match(rule, /never.*READY/i);
  assert.match(rule, /--use-credits/);
  assert.match(rule, /--api-key/);
  assert.match(rule, /code new/);
  assert.match(rule, /code push/);
});

test('AC6: no CodeRabbit skill installs', () => {
  assert.match(rule, /npx skills add coderabbitai\/skills/);
  assert.match(rule, /coderabbit skills/);
});

test('AC7: ban autofix skill; allow read-only autofix subagent', () => {
  assert.match(rule, /coderabbit:autofix/);
  assert.match(rule, /read-only autofix subagent/i);
});
