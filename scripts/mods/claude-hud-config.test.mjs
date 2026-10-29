// The claude-hud status-line config (/os redesign, Band reliability item 1). The band shows helpers, so the status line must not:
// its tools, skills, mcp and agents rows take the bottom slot, which is capped at half the terminal rows.
// This is a node test, not a file in .claude/plugins/ccv3-mods/tests: `claude plugin test` cannot import a file outside the
// plugin folder ("cannot import ... it is outside the plugin's folder") and gives a test no fs. Run: node --test scripts/mods/claude-hud-config.test.mjs
// Ways the config can fail, one test each:
// C1 elementOrder still lists tools, skills, mcp or agents (the rows come back)
// C2 display.showTools or display.showAgents is still true (the rows come back by the display switch)
// C3 the cut is too wide: project, addedDirs, promptCache, memory, environment, todos or sessionTime is gone or listed twice
// C4 the file is not valid JSON, or has another set of top-level keys
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = join(repoRoot, '.claude', 'plugins', 'claude-hud', 'config.json');
const raw = readFileSync(file, 'utf8');
const config = JSON.parse(raw);
const order = Array.isArray(config.elementOrder) ? config.elementOrder : [];

test('C1 elementOrder lists none of tools, skills, mcp, agents', () => {
  assert.ok(order.length > 0, 'elementOrder is an array with elements');
  for (const gone of ['tools', 'skills', 'mcp', 'agents']) assert.ok(!order.includes(gone), `${gone} is still in elementOrder`);
});

test('C2 display.showTools and display.showAgents are false', () => {
  assert.equal(config.display?.showTools, false);
  assert.equal(config.display?.showAgents, false);
});

test('C3 the remaining elements are listed once each, and only they', () => {
  const keep = ['project', 'addedDirs', 'promptCache', 'memory', 'environment', 'todos', 'sessionTime'];
  for (const name of keep) assert.equal(order.filter(one => one === name).length, 1, `${name} must be listed once`);
  assert.deepEqual([...order].sort(), [...keep].sort());
});

test('C4 the file stays valid JSON with the same top-level keys', () => {
  assert.deepEqual(Object.keys(config).sort(), ['display', 'elementOrder']);
});
