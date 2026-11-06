// Tests for the retirement of `reap.ps1 -Force`. reap.ps1 only lists. repro.ps1 never calls it and
// stops only the process trees it started itself.
//
// Why: the reap filter (age over N seconds and CPU under M seconds) cannot tell a stuck shell from a live
// peer-session shell that waits at ~0 CPU. `-Force` killed such shells. repro.ps1's circuit breaker ran
// `reap.ps1 -Force` and so could kill bash processes that repro never started.
// See docs/windows/msys-fork-storm-investigation.md.
//
// How it can fail, one test each below, and the source change that makes it fail:
//   reap has no kill path: someone adds back -Force, the Stop-ProcessTree dot-source, Stop-Process or taskkill
//   reap rejects -Force: someone re-adds the [switch]$Force parameter
//   reap lists and exits 0: someone breaks the list path (a throw, a non-zero exit, no "[reap]" line)
//   repro does not call reap: someone puts `reap.ps1` back in the breaker
//   repro breaker stops its own trees: someone removes the Stop-ProcessTree calls over $procs / $warmProc,
//     or replaces them with a kill of every bash from Get-Process
//   repro breaker leaves a foreign bash alone (real bash): the breaker kills a bash it did not start
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAP = join(ROOT, 'scripts', 'msys', 'reap.ps1');
const REPRO = join(ROOT, 'scripts', 'msys', 'repro.ps1');
const BASH = join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe');
const win = process.platform === 'win32';

const read = (f) => readFileSync(f, 'utf8');
const pwsh = (args) => spawnSync('pwsh', ['-NoProfile', '-File', ...args], { encoding: 'utf8', windowsHide: true, timeout: 90000 });

/** The text of the circuit-breaker `if` block in repro.ps1, from its `if` line to its `break`. */
function breakerBlock(text) {
  const m = text.match(/if \(\$alive\.Count -gt \$MaxBashAlive\) \{[\s\S]*?\bbreak\b/);
  assert.ok(m, 'repro.ps1 must keep the circuit breaker block');
  return m[0];
}

test('reap.ps1 has no kill path: no -Force, no Stop-ProcessTree, no Stop-Process, no taskkill', () => {
  const text = read(REAP);
  assert.doesNotMatch(text, /-Force\b|\$Force\b/i, 'reap.ps1 must not have a -Force switch');
  assert.doesNotMatch(text, /Stop-ProcessTree/i, 'reap.ps1 must not load or call the tree-kill helper');
  assert.doesNotMatch(text, /Stop-Process\b/i);
  assert.doesNotMatch(text, /taskkill/i);
});

test('reap.ps1 -Force fails: unknown parameter', { skip: !win }, () => {
  // Safe on the old code too: -MaxCpuSeconds 0 matches no process (cpu is never under 0), so nothing can be killed.
  const r = pwsh([REAP, '-Force', '-MaxCpuSeconds', '0']);
  assert.notEqual(r.status, 0, `-Force must be rejected. stdout: ${r.stdout}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /parameter|Force/i);
  assert.doesNotMatch(r.stdout, /\[reap\]/, 'the script must stop at parameter binding, before it lists anything');
});

test('reap.ps1 with no arguments lists and exits 0', { skip: !win }, () => {
  const r = pwsh([REAP]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[reap\]/);
  assert.doesNotMatch(r.stdout, /killed/i, 'the list-only script must never print a "killed" line');
});

test('repro.ps1 does not reference reap.ps1', () => {
  const text = read(REPRO);
  assert.doesNotMatch(text, /reap\.ps1/i);
  assert.doesNotMatch(text, /reap\b.*-Force|-Force.*\breap\b/i);
});

test('repro.ps1 breaker stops only its own process trees through Stop-ProcessTree', () => {
  const text = read(REPRO);
  assert.match(text, /^\. \(Join-Path \$PSScriptRoot '\.\.\\lib\\Stop-ProcessTree\.ps1'\)/m, 'repro.ps1 keeps the helper dot-source');
  const block = breakerBlock(text);
  assert.match(block, /Stop-ProcessTree -RootId/, 'the breaker must call Stop-ProcessTree');
  assert.match(block, /\$procs\b/, 'the breaker must walk the trial $procs list');
  assert.match(block, /\$warmProc\b/, 'the breaker must also stop the warm keeper');
  assert.doesNotMatch(block, /\$alive\s*\|/, 'the breaker must not act on the list of every live bash');
  assert.doesNotMatch(block, /Stop-Process\b|taskkill/i, 'the breaker must use only the tree helper');
});

test('repro.ps1 breaker leaves a bash it did not start alive', { skip: !win || !existsSync(BASH), timeout: 180000 }, async () => {
  const sentinel = spawn(BASH, ['-c', 'sleep 120'], { stdio: 'ignore', windowsHide: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(alive(sentinel.pid), 'the sentinel bash must run before the repro');
    // -MaxBashAlive 0 trips the breaker after the first trial, because the sentinel counts as alive.
    const r = pwsh([REPRO, '-Trials', '1', '-Cold', '1', '-HoldSeconds', '1', '-MaxBashAlive', '0']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /ABORT/, 'the breaker must trip in this run');
    assert.ok(alive(sentinel.pid), 'a bash that repro did not start must still be alive');
  } finally {
    try { sentinel.kill(); } catch { /* already gone */ }
  }
});
