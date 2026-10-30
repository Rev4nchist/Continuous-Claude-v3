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

test('DW-91 guard clauses: Dave-only override, read-only allow list, no Autofix checkbox', () => {
  assert.match(rule, /SKIP_CODERABBIT_GUARD=1`? is \*\*Dave-only\*\*/);
  assert.match(rule, /agent never sets it/i);
  for (const cmd of ['cr doctor', 'cr usage', 'cr auth login', 'cr auth status', 'cr --help', 'cr --version']) {
    assert.ok(rule.includes('`' + cmd), `read-only command listed: ${cmd}`);
  }
  assert.match(rule, /Read-only commands\*\*, which never count as a run/i);
  assert.match(rule, /Autofix\*\* or autopilot checkbox/);
  assert.match(rule, /Click or tick/);
});

test('DW-91 .coderabbit.yaml: label gate kept, Fix comments off, no billing flags', () => {
  const yaml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../.coderabbit.yaml'),
    'utf8',
  );
  assert.match(yaml, /review:coderabbit/);
  assert.match(yaml, /review:deep/);
  assert.match(yaml, /finishing_touches:\s*\n\s+autofix:\s*\n\s+enabled: false/);
  assert.doesNotMatch(yaml, /use-credits|api-key/);
});

test('DW-91 review round: override only as a leading assignment and logged; quotes are data; loops count once', () => {
  assert.match(rule, /leading\s+assignment/i);
  assert.match(rule, /`override` line/);
  assert.match(rule, /Text inside quotes, heredocs/);
  assert.match(rule, /A loop counts as one run/);
  for (const w of ['sudo', 'xargs', 'eval', 'iex', 'Start-Process']) assert.ok(rule.includes('`' + w + '`'), `wrapper listed: ${w}`);
});

test('DW-91 .coderabbit.yaml: a push does not start a review, and the recovery step is written down', () => {
  const yaml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../.coderabbit.yaml'),
    'utf8',
  );
  assert.match(yaml, /auto_incremental_review: false/);
  assert.match(yaml, /@coderabbitai review/);
});
