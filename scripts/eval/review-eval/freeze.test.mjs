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
