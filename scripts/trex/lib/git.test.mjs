import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { makeTrexGit } from './git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

test('makeTrexGit: the git child gets a stripped env and a hidden window', () => {
  // Breaks when the env is not stripped (the Anthropic key then reaches every git child) or windowsHide is dropped.
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
  process.env.CLAUDE_CODE_SESSION = 'abc';
  try {
    let seen;
    const spawn = (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: 'ok', stderr: '' }; };
    const r = makeTrexGit('C:\\repo', { spawn })(['status']);
    assert.deepEqual(r, { status: 0, stdout: 'ok', stderr: '' });
    assert.equal(seen.cmd, 'git');
    assert.equal(seen.opts.cwd, 'C:\\repo');
    assert.equal(seen.opts.windowsHide, true);
    assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(seen.opts.env.CLAUDE_CODE_SESSION, undefined);
    assert.ok(seen.opts.env.PATH || seen.opts.env.Path);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_SESSION;
  }
});

test('makeTrexGit: a spawn failure gives status 1, never a throw', () => {
  // Breaks when a null status is passed on: callers compare the status to 0.
  const r = makeTrexGit('C:\\repo', { spawn: () => ({ status: null, error: new Error('x') }) })(['status']);
  assert.deepEqual(r, { status: 1, stdout: '', stderr: '' });
});

test('makeTrexGit: a real git call runs', () => {
  // Breaks when the spawn options are wrong (a bad cwd or env makes git unreachable).
  const r = makeTrexGit(ROOT)(['rev-parse', '--is-inside-work-tree']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'true');
});
