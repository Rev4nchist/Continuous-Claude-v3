// Failure modes (P0 F8; main spec 5.2 engineVersion).
//  F8 prompt changed after the freeze   -> skip the sha256 compare in checkFreeze
//  no freeze recorded                   -> treat a missing freeze as ok
//  engineVersion changes with the prompt, is 12 hex -> leave promptSha256 out of the hash
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt } from '../../github/cursor-review.mjs';
import { checkFreeze, engineVersion, promptSha256, recordFreeze } from './freeze.mjs';

const tmp = () => mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'freeze-'));

test('F8 checkFreeze is ok when the prompt hash matches and not ok after the prompt changes', () => {
  // Breaks when: checkFreeze skips the sha256 compare (the changed prompt would still pass).
  const cfg = { freeze: { promptSha256: promptSha256({ build: () => 'PROMPT v0' }) } };
  assert.equal(checkFreeze(cfg, { build: () => 'PROMPT v0' }).ok, true);
  const changed = checkFreeze(cfg, { build: () => 'PROMPT v1' });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /prompt/i);
  assert.notEqual(changed.promptSha256, cfg.freeze.promptSha256);
});

test('F8 a config with no freeze is not ok', () => {
  // Breaks when: a missing freeze block is read as "nothing to compare, ok".
  assert.equal(checkFreeze({}, { build: () => 'x' }).ok, false);
  assert.equal(checkFreeze({ freeze: {} }, { build: () => 'x' }).ok, false);
});

test('recordFreeze writes the live prompt hash and blob, and checkFreeze then accepts the real prompt', () => {
  // Breaks when: recordFreeze hashes a different text than checkFreeze (for example a different buildPrompt call).
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ cursorEvalBudget: 40 }));
  const git = (args) => ({ status: 0, stdout: args.includes('--verify') || args[0] === 'rev-parse' ? `${'ab'.repeat(20)}\n` : 'x\n' });
  const f = recordFreeze({ git, cfgPath: file });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cfg.cursorEvalBudget, 40);
  assert.equal(cfg.freeze.promptSha256, f.promptSha256);
  assert.equal(cfg.freeze.promptSha256, promptSha256({ build: buildPrompt }));
  assert.equal(checkFreeze(cfg).ok, true);
});

test('engineVersion is 12 hex and changes with the prompt hash', () => {
  // Breaks when: promptSha256 is left out of the hash input.
  const a = engineVersion({ model: 'grok-4.7-high', promptSha256: 'aaa' });
  const b = engineVersion({ model: 'grok-4.7-high', promptSha256: 'bbb' });
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(a, engineVersion({ model: 'grok-4.7-high', promptSha256: 'aaa' }));
});

// ---------- the engine freeze (phase 1, bridge) ----------
import { buildEnginePrompt } from '../../github/local-review/prompt.mjs';
import { checkEngineFreeze, enginePromptSha256, recordEngineFreeze } from './freeze.mjs';

test('enginePromptSha256 is the sha256 of the engine rules for full and delta mode, not of the cursor-review prompt (breaks if it hashes buildPrompt)', () => {
  const got = enginePromptSha256();
  assert.equal(got.full, buildEnginePrompt({ mode: 'full' }).promptSha256);
  assert.equal(got.delta, buildEnginePrompt({ mode: 'delta' }).promptSha256);
  assert.notEqual(got.full, got.delta);
  assert.notEqual(got.full, promptSha256());
});

test('checkEngineFreeze is ok when the full hash matches and not ok after the engine prompt changes or with no engine freeze (breaks if the compare is skipped or reads the old freeze)', () => {
  const build = () => ({ full: 'F1', delta: 'D1' });
  const cfg = { freeze: { promptSha256: 'old' }, engineFreeze: { promptSha256: { full: 'F1', delta: 'D1' } } };
  assert.deepEqual(checkEngineFreeze(cfg, { build }), { ok: true, promptSha256: 'F1' });
  const changed = checkEngineFreeze(cfg, { build: () => ({ full: 'F2', delta: 'D1' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /engine prompt/);
  assert.equal(checkEngineFreeze({ freeze: { promptSha256: 'old' } }, { build }).ok, false);
});

test('recordEngineFreeze writes engineFreeze with both hashes and the prompt.mjs blob, and leaves the old freeze alone (breaks if it overwrites freeze)', () => {
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ cursorEvalBudget: 120, freeze: { promptSha256: 'old' } }));
  const asked = [];
  const git = (args) => { asked.push(args.join(' ')); return { status: 0, stdout: `${'cd'.repeat(20)}\n` }; };
  const f = recordEngineFreeze({ git, cfgPath: file, build: () => ({ full: 'F1', delta: 'D1' }), now: () => Date.parse('2026-11-04T12:00:00Z') });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.engineFreeze, f);
  assert.deepEqual(cfg.engineFreeze.promptSha256, { full: 'F1', delta: 'D1' });
  assert.equal(cfg.engineFreeze.at, '2026-11-04T12:00:00.000Z');
  assert.equal(cfg.freeze.promptSha256, 'old');
  assert.ok(asked.some((a) => a.includes('HEAD:scripts/github/local-review/prompt.mjs')));
});
