// failure-audit.test.mjs: the over_ask class and the --exclude flag, run through the real CLI.
// Run: node --test "scripts/self-improvement/test/*.test.mjs"
// Fixtures are .jsonl transcripts under test/fixtures/<case>/<project>/<session>.jsonl.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'failure-audit.mjs');

function audit(fixture, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-audit-'));
  const out = path.join(dir, 'out.json');
  try {
    execFileSync(process.execPath, [
      SCRIPT, '--root', path.join(here, 'fixtures', fixture),
      '--days', '36500', '--json', out, '--out', path.join(dir, 'out.md'), ...extra,
    ], { stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('over_ask: a question, then "stop asking, just pick one" -> over_ask, not stopped_early', () => {
  const r = audit('over-ask-q');
  assert.equal(r.classTotals.over_ask, 1);
  assert.equal(r.classTotals.stopped_early, undefined);
});

test('over_ask: previous assistant text does not end in "?" -> no over_ask', () => {
  const r = audit('over-ask-period');
  assert.equal(r.classTotals.over_ask, undefined);
});

test('over_ask: a question followed by the mandatory Next steps block still counts as a question', () => {
  assert.equal(audit('over-ask-nextsteps').classTotals.over_ask, 1);
});

test('over_ask: an AskUserQuestion tool call counts as the agent having asked', () => {
  assert.equal(audit('over-ask-tool').classTotals.over_ask, 1);
});

test('stopped_early: "why did you stop" still lands in stopped_early', () => {
  const r = audit('stopped');
  assert.equal(r.classTotals.stopped_early, 1);
  assert.equal(r.classTotals.over_ask, undefined);
});

test('--exclude drops sessions whose id starts with the prefix', () => {
  assert.equal(audit('exclude').classTotals.over_ask, 2);
  assert.equal(audit('exclude', ['--exclude', 'aaaa1111']).classTotals.over_ask, 1);
});
