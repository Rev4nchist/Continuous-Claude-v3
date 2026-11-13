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

// ---------- versioned engine freezes (re-eval-contract) ----------
// Failure modes:
//  V1 a v2 freeze overwrites engineFreeze (v1) or another version     -> record writes engineFreeze
//  V2 v1 with no versioned entry is refused although engineFreeze holds v1 -> no fallback
//  V3 v2 with no entry falls back to the v1 freeze                    -> fallback for every version
//  V4 an unknown prompt version is frozen                            -> no PROMPT_VERSIONS check
//  V5 enginePromptSha256 ignores promptVersion (v2 gets v1's hash)    -> the version is not passed to the builder
import { checkVersionedFreeze, frozenEngineSha, recordVersionedFreeze } from './freeze.mjs';

test('V5 enginePromptSha256 hashes the asked prompt version; v1 is the default and equals the old call', () => {
  // Breaks when: the version is not passed to buildEnginePrompt.
  const v1 = enginePromptSha256({ promptVersion: 'v1' });
  const v2 = enginePromptSha256({ promptVersion: 'v2' });
  assert.deepEqual(v1, enginePromptSha256());
  assert.notEqual(v1.full, v2.full);
  assert.equal(v2.full, buildEnginePrompt({ mode: 'full', promptVersion: 'v2' }).promptSha256);
});

test('V1 recordVersionedFreeze writes engineFreezes[v] and keeps engineFreeze, freeze and other versions', () => {
  // Breaks when: the versioned write replaces engineFreeze or the whole engineFreezes object.
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ freeze: { promptSha256: 'old' }, engineFreeze: { promptSha256: { full: 'E1', delta: 'D' } }, engineFreezes: { v1: { promptSha256: { full: 'E1', delta: 'D' } } } }));
  const git = () => ({ status: 0, stdout: `${'ef'.repeat(20)}\n` });
  const f = recordVersionedFreeze({ git, cfgPath: file, promptVersion: 'v2', build: () => ({ full: 'F2', delta: 'D2' }), now: () => Date.parse('2026-11-13T12:00:00Z') });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.engineFreezes.v2, f);
  assert.equal(cfg.engineFreezes.v2.promptVersion, 'v2');
  assert.deepEqual(cfg.engineFreezes.v1.promptSha256, { full: 'E1', delta: 'D' });
  assert.deepEqual(cfg.engineFreeze.promptSha256, { full: 'E1', delta: 'D' });
  assert.equal(cfg.freeze.promptSha256, 'old');
});

test('V1 a versioned v1 freeze also writes engineFreeze, so replay (checkEngineFreeze) and score read one v1 hash', () => {
  // Breaks when: v1 is written only under engineFreezes and the two v1 hashes drift.
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ engineFreeze: { promptSha256: { full: 'OLD', delta: 'D' } } }));
  recordVersionedFreeze({ git: () => ({ status: 0, stdout: 'x\n' }), cfgPath: file, promptVersion: 'v1', build: () => ({ full: 'NEW', delta: 'D2' }) });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([cfg.engineFreezes.v1.promptSha256.full, cfg.engineFreeze.promptSha256.full], ['NEW', 'NEW']);
  assert.equal(checkEngineFreeze(cfg, { build: () => ({ full: 'NEW' }) }).ok, true);
});

test('V1 a plain freeze --engine after a versioned v1 freeze also refreshes engineFreezes.v1 (no stale v1 entry for score)', () => {
  // Breaks when: recordEngineFreeze writes only engineFreeze, so frozenEngineSha reads the stale versioned v1 hash first.
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ engineFreeze: { promptSha256: { full: 'OLD' } }, engineFreezes: { v1: { promptSha256: { full: 'OLD' } }, v2: { promptSha256: { full: 'V2' } } } }));
  recordEngineFreeze({ git: () => ({ status: 0, stdout: 'x\n' }), cfgPath: file, build: () => ({ full: 'NEW', delta: 'D' }) });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([frozenEngineSha(cfg, 'v1'), cfg.engineFreeze.promptSha256.full, cfg.engineFreezes.v2.promptSha256.full], ['NEW', 'NEW', 'V2']);
  writeFileSync(file, JSON.stringify({ engineFreeze: { promptSha256: { full: 'OLD' } } }));
  recordEngineFreeze({ git: () => ({ status: 0, stdout: 'x\n' }), cfgPath: file, build: () => ({ full: 'NEW', delta: 'D' }) });
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'engineFreezes'), false, 'no versioned key is created on a config that has none');
});

test('V4 an unknown prompt version is refused and nothing is written', () => {
  // Breaks when: any string is accepted as a prompt version.
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, '{}');
  assert.throws(() => recordVersionedFreeze({ git: () => ({ status: 0, stdout: 'x' }), cfgPath: file, promptVersion: 'v9' }), /unknown prompt version/);
  assert.equal(readFileSync(file, 'utf8'), '{}');
  assert.equal(checkVersionedFreeze({}, { promptVersion: 'v9' }).ok, false);
});

test('V2 V3 checkVersionedFreeze: the entry wins; v1 falls back to engineFreeze; v2 has no fallback', () => {
  // Breaks when: v1 does not fall back, v2 falls back to v1, or the compare is skipped.
  const build = ({ promptVersion }) => ({ full: `F-${promptVersion}`, delta: 'D' });
  const legacy = { engineFreeze: { promptSha256: { full: 'F-v1' } } };
  assert.equal(checkVersionedFreeze(legacy, { promptVersion: 'v1', build }).ok, true);
  const v2 = checkVersionedFreeze(legacy, { promptVersion: 'v2', build });
  assert.equal(v2.ok, false);
  assert.match(v2.reason, /no engine freeze for v2/);
  const both = { ...legacy, engineFreezes: { v2: { promptSha256: { full: 'F-v2' } } } };
  assert.equal(checkVersionedFreeze(both, { promptVersion: 'v2', build }).ok, true);
  const changed = checkVersionedFreeze(both, { promptVersion: 'v2', build: () => ({ full: 'other' }) });
  assert.deepEqual([changed.ok, /changed since the freeze/.test(changed.reason)], [false, true]);
});

test('frozenEngineSha reads engineFreezes[v] first, then engineFreeze for v1 only', () => {
  // Breaks when: score reads only the old key, or a v2 run is scored against the v1 hash.
  const cfg = { engineFreeze: { promptSha256: { full: 'OLD' } }, engineFreezes: { v2: { promptSha256: { full: 'NEW2' } } } };
  assert.deepEqual(['v1', 'v2', 'v3'].map((v) => frozenEngineSha(cfg, v)), ['OLD', 'NEW2', null]);
  assert.equal(frozenEngineSha({ engineFreezes: { v1: { promptSha256: { full: 'V1' } } }, engineFreeze: { promptSha256: { full: 'OLD' } } }, 'v1'), 'V1');
});

test('the live config: the v1 engine freeze still passes through the versioned check', async () => {
  // Breaks when: the versioned path breaks the frozen v1 engine of config.json.
  const { loadConfig } = await import('./config.mjs');
  assert.equal(checkVersionedFreeze(loadConfig(), { promptVersion: 'v1' }).ok, true);
  assert.equal(checkEngineFreeze(loadConfig()).ok, true);
});
