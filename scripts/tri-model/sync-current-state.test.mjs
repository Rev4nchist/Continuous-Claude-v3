// sync-current-state.test.mjs — --check must fail loud and leave the dated record untouched.
// Run: node --test scripts/tri-model/sync-current-state.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'sync-current-state.mjs');
const doc = path.join(here, '..', '..', 'docs', 'tri-model', 'CURRENT-STATE.md');

test('--check exits non-zero and does not rewrite the dated record', () => {
  const before = readFileSync(doc);
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--check/);
  assert.deepEqual(readFileSync(doc), before);
});
