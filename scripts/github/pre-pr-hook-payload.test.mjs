// The hook payload gate is a pre-pr gate of the hooks surface (card coord-hook-payload-gate).
// Each test breaks when the row in SURFACES (scripts/github/pre-pr.mjs) changes: gone, moved, or renamed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatesFor, SURFACES } from './pre-pr.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksRow = () => SURFACES.find((s) => s.id === 'hooks');

describe('hook-payload gate row', () => {
  it('sits in the hooks row, after the build and before the vitest run', () => {
    const ids = hooksRow().gates.map((g) => g.id);
    assert.ok(ids.includes('hook-payload'), `hooks gates are ${ids.join(', ')}`);
    assert.ok(ids.indexOf('hook-payload') > ids.indexOf('hooks-build'), 'the fixtures run against a built dist');
    assert.ok(ids.indexOf('hook-payload') < ids.indexOf('hooks-vitest'), 'it fails fast, before the long vitest run');
  });

  it('runs the real runner script from the repo root', () => {
    const gate = hooksRow().gates.find((g) => g.id === 'hook-payload');
    assert.ok(gate, 'no hook-payload gate');
    assert.equal(gate.cmd, 'node');
    assert.equal(gate.args[0], 'scripts/github/hook-payload.mjs');
    assert.equal(gate.cwd, '.');
    assert.ok(fs.existsSync(path.join(REPO, gate.args[0])), 'the runner file exists');
  });

  it('a change in a hook source selects it, a change outside the hooks surface does not', () => {
    assert.ok(gatesFor(['.claude/hooks/src/decision-gate.ts']).some((g) => g.id === 'hook-payload'));
    assert.ok(!gatesFor(['docs/verify/README.md']).some((g) => g.id === 'hook-payload'));
  });

  it('a change to a fixture alone selects it, and only it of the hooks gates', () => {
    const ids = gatesFor(['.claude/hooks/fixtures/decision-gate/allow-echo.json']).map((g) => g.id);
    assert.ok(ids.includes('hook-payload'), `gates for a fixtures-only diff: ${ids.join(', ')}`);
    for (const heavy of ['hooks-tsc', 'hooks-build', 'hooks-vitest']) assert.ok(!ids.includes(heavy), `${heavy} must not run for a fixtures-only diff`);
  });
});
