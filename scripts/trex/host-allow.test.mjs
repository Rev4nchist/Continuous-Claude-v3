// Tests for host-allow.mjs (spec 13.2). Every test imports the real function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_SHAPES, hostActionOk, hostPs1Path } from './host-allow.mjs';

const has = (...paths) => ({ treeHas: (p) => paths.includes(p) });
const cmd = (file) => ({ cmd: ['pwsh', '-NoProfile', '-File', file] });

test('hostActionOk allows a {test} mod-event and a pwsh -File of a tree .ps1', () => {
  assert.equal(hostActionOk('mod-event', { test: 'brief-hook' }, has()), null);
  assert.equal(hostActionOk('cli', cmd('scripts/land-pr.ps1'), has('scripts/land-pr.ps1')), null);
});

test('hostActionOk refuses a .ps1 that the tree does not hold', () => {
  assert.match(hostActionOk('cli', cmd('scripts/gone.ps1'), has('scripts/other.ps1')), /does not exist/);
  assert.match(hostActionOk('cli', cmd('scripts/x.ps1'), {}), /does not exist/);
  assert.match(hostActionOk('cli', cmd('scripts/x.ps1'), { treeHas: () => { throw new Error('boom'); } }), /does not exist/);
});

test('hostActionOk refuses a .ps1 under the bench flows dir or .trex', () => {
  const all = { treeHas: () => true };
  for (const p of ['scripts/trex/bench/flows/S1/run.ps1', '.trex/flows/run.ps1', '.TREX/run.ps1', 'Scripts/Trex/Bench/Flows/S1/run.ps1']) {
    assert.match(hostActionOk('cli', cmd(p), all), /author|flows|\.trex/i, p);
  }
});

test('hostActionOk refuses an unsafe path or the wrong extension', () => {
  const all = { treeHas: () => true };
  for (const p of ['../x.ps1', 'a/../x.ps1', '/etc/x.ps1', 'C:/x.ps1', 'a\\x.ps1', './x.ps1', 'a//x.ps1', '.git/x.ps1', 'x.sh', 'x.ps1.txt', '']) {
    assert.ok(hostActionOk('cli', cmd(p), all), `passed: ${p}`);
  }
});

test('hostActionOk refuses every other argv shape and driver', () => {
  const all = { treeHas: () => true };
  const bad = [
    ['cli', { cmd: ['node', 'x.mjs'] }],
    ['cli', { cmd: ['pwsh', '-File', 'x.ps1'] }],
    ['cli', { cmd: ['pwsh', '-NoProfile', '-Command', 'rm'] }],
    ['cli', { cmd: ['pwsh', '-NoProfile', '-File', 'x.ps1', 'extra'] }],
    ['cli', { cmd: ['pwsh', '-NoProfile', '-File', 'x.ps1'], env: { A: 'b' } }],
    ['cli', { cmd: ['pwsh', '-NoProfile', '-File', 'x.ps1'], stdin: 'hi' }],
    ['cli', { cmd: 'pwsh -NoProfile -File x.ps1' }],
    ['mod-event', { test: '-rf' }],
    ['mod-event', { test: 't', extra: 1 }],
    ['mod-event', {}],
    ['hook', { hook: 'a.mjs', payload: 'p.json' }],
    ['api', { method: 'GET', path: '/x' }],
    ['browser', { playwright: 'x' }],
    ['cli', null],
  ];
  for (const [driver, action] of bad) assert.ok(hostActionOk(driver, action, all), `passed: ${driver} ${JSON.stringify(action)}`);
});

test('hostPs1Path returns the .ps1 of a cli shape and null otherwise', () => {
  assert.equal(hostPs1Path('cli', cmd('scripts/a.ps1')), 'scripts/a.ps1');
  assert.equal(hostPs1Path('mod-event', { test: 't' }), null);
  assert.equal(hostPs1Path('cli', { cmd: ['node', 'x'] }), null);
});

test('HOST_SHAPES lists the two shapes', () => {
  assert.deepEqual(HOST_SHAPES.map((s) => s.driver), ['mod-event', 'cli']);
  assert.ok(Object.isFrozen(HOST_SHAPES));
});
