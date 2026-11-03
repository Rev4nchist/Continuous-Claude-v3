// Tests for scripts/github/lib/proc.mjs. Every test names the source change that would break it.
// killTree moved here unchanged from pre-pr.mjs; the first test is the pre-pr T6 test, ported.
// Run: node --test scripts/github/lib/proc.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { killTree, processChildren } from './proc.mjs';
import * as prePr from '../pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Breaks if the Windows walk stops going children-first, stops ignoring a pid that is already gone, or the POSIX path stops
// signalling the process group (-pid).
test('killTree stops the children first, then the parent, ignores a process that is gone, and kills the group on POSIX', () => {
  const tree = { 10: [11, 12], 11: [13], 12: [], 13: [] };
  const killed = [];
  killTree(10, { platform: 'win32', children: (p) => tree[p] ?? [], kill: (p) => { killed.push(p); if (p === 12) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.deepEqual(killed, [13, 11, 12, 10]);
  const posix = [];
  killTree(10, { platform: 'linux', kill: (p) => posix.push(p) });
  assert.deepEqual(posix, [-10]);
});

// Breaks if the `seen` set is removed from the walk: a pid that lists itself or an ancestor as a child would loop for ever.
test('killTree stops a pid once even when the process table holds a cycle', () => {
  const tree = { 1: [2], 2: [1] };
  const killed = [];
  killTree(1, { platform: 'win32', children: (p) => tree[p] ?? [], kill: (p) => killed.push(p) });
  assert.deepEqual(killed, [2, 1]);
});

// Breaks if the POSIX fallback after a failed group kill is dropped: a child that does not lead a group must still be stopped.
test('killTree on POSIX falls back to the single pid when the group kill fails', () => {
  const seen = [];
  killTree(10, { platform: 'linux', kill: (p) => { seen.push(p); if (p < 0) throw new Error('no such group'); } });
  assert.deepEqual(seen, [-10, 10]);
});

// Breaks if processChildren stops refusing a bad pid before it reads the process table (a CIM call of about 5 s).
test('processChildren answers an invalid pid with no children and does not read the process table', () => {
  const lookup = processChildren();
  for (const bad of [undefined, null, 0, -4, 1.5, '12']) assert.deepEqual(lookup(bad), []);
});

// Breaks if pre-pr.mjs gets its own copy of killTree again (two copies would drift), or stops re-exporting it for old importers.
test('pre-pr.mjs re-exports the same killTree and processChildren', () => {
  assert.equal(prePr.killTree, killTree);
  assert.equal(prePr.processChildren, processChildren);
});

// Breaks if the Windows tree-kill switch of the task killer is used: it is forbidden on this machine.
test('proc.mjs never calls taskkill', () => {
  assert.doesNotMatch(readFileSync(path.join(HERE, 'proc.mjs'), 'utf8'), /taskkill/i);
});
