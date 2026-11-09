/**
 * package-install-guard: scan cost and the rc-file read (PR 3 of the lane).
 *
 * Two failure modes, both about work the guard does on a command that installs nothing:
 *
 * 1. Quadratic scans. anyManagerInstall scanned from every manager word to the end of the word list, and
 *    ecosystemInstall copied and scanned the rest of the list at every name hit. A harmless 120 KB command of
 *    repeated words stalled the hook for 20 s. The bounds below are absolute and generous (2 s for 40000 words;
 *    the linear scan takes well under 0.3 s). The change that breaks them: a scan that starts again from every
 *    manager word, or a copy of the rest of the words at every ecosystem name.
 *
 * 2. The rc read. The guard read up to 20 rc files on EVERY shell command. It must read them only when the text
 *    could hold an install. The read stays whenever a manager word, an ECO_RULES name, a hidden command word
 *    ($VAR, quote or backslash inside the word) or a persistent-registry word could be present: the rc file can turn a
 *    bare install into an ask, so a gate that misses one makes the guard MORE permissive.
 *    "Still reads" is read from the ask text. "Does not read" is read from an fs trace written by
 *    package-guard-net-stub.cjs (PIG_STUB_FS_TRACE): the stub logs every statSync or openSync of an rc file name.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlans } from '../package-install-guard.js';

const DIST = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
const NET_STUB = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));

// ---------------------------------------------------------------------------
// 1. Scan cost
// ---------------------------------------------------------------------------

const BOUND_MS = 2000;
const SLOW_TEST_MS = 180_000; // a quadratic scan takes 30 s or more per case today: the bound below must be what fails, not the vitest timeout

type Shape = [label: string, build: (n: number) => string, tool: 'Bash' | 'PowerShell'];
const SHAPES: Shape[] = [
  ['npm x N (anyManagerInstall)', (n) => 'npm '.repeat(n), 'Bash'],
  ['npm a x N (anyManagerInstall, subcommand word)', (n) => 'npm a '.repeat(n), 'Bash'],
  ['pnpm x N', (n) => 'pnpm '.repeat(n), 'Bash'],
  ['Start-Process then npm x N (two callers of anyManagerInstall)', (n) => 'Start-Process ' + 'npm '.repeat(n), 'PowerShell'],
  ['choco x N (ecosystemInstall)', (n) => 'choco '.repeat(n), 'Bash'],
  ['nuget restore x N (ecosystemInstall, source flag scan)', (n) => 'nuget restore '.repeat(n / 2), 'Bash'],
  ['dotnet x N (ecosystemInstall, dotnetInstall scans)', (n) => 'dotnet '.repeat(n), 'Bash'],
  ['dotnet build x N (dotnetInstall source flag scan)', (n) => 'dotnet build '.repeat(n / 2), 'Bash'],
];

describe('package-install-guard: scan cost is linear in the word count', () => {
  for (const words of [20000, 40000]) {
    it.each(SHAPES)(`${words} words: %s finishes under ${BOUND_MS} ms`, (_label, build, tool) => {
      const command = build(words);
      const t0 = performance.now();
      installPlans(command, tool);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(BOUND_MS);
    }, SLOW_TEST_MS);
  }

  // The same through the built hook, with a real payload: a harmless 120 KB command must not stall the hook.
  it('the built hook answers continue for 40000 repeated "npm " words in under 5 s', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pig-scan-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'pig-scan-home-'));
    const t0 = performance.now();
    const res = spawnSync(process.execPath, ['-r', NET_STUB, DIST], {
      input: JSON.stringify({ session_id: 'test-session', tool_name: 'Bash', tool_input: { command: 'npm '.repeat(40000) }, cwd }),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1 << 24,
      env: { ...process.env, CCV3_GUARD_RC_HOME: home, CCV3_GUARD_DECISIONS_LOG: join(home, 'd.jsonl'), CLAUDE_AGENT_ID: '', CI: '', VITEST: '' },
      cwd,
    });
    const ms = performance.now() - t0;
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!)).toEqual({ result: 'continue' });
    expect(ms).toBeLessThan(5000);
  }, SLOW_TEST_MS);
});

// ---------------------------------------------------------------------------
// 2. The rc read
// ---------------------------------------------------------------------------

const EVIL = 'https://evil.example/';

interface RcRun { decision: string | undefined; reason: string; traced: string[] }

/** Run the built hook in an empty cwd with a home folder that holds a .npmrc naming a non-npmjs registry. */
function runWithRc(command: string, tool = 'Bash'): RcRun {
  const home = mkdtempSync(join(tmpdir(), 'pig-rcread-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-rcread-cwd-'));
  writeFileSync(join(home, '.npmrc'), `registry=${EVIL}\n`);
  const trace = join(home, 'fs-trace.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCV3_GUARD_DECISIONS_LOG: join(home, 'd.jsonl'),
    CCV3_GUARD_RC_HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PIG_STUB_FS_TRACE: trace,
    PIG_STUB_AGE_HOURS: '2400',
    PIG_STUB_NEXT_HOURS: '2400',
    CLAUDE_AGENT_ID: '',
    CI: '',
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.CDPATH;
  const res = spawnSync(process.execPath, ['-r', NET_STUB, DIST], {
    input: JSON.stringify({ session_id: 'test-session', tool_name: tool, tool_input: { command }, cwd }),
    encoding: 'utf8',
    timeout: 30_000,
    env,
    cwd,
  });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
  return {
    decision: out.hookSpecificOutput?.permissionDecision,
    reason: String(out.hookSpecificOutput?.permissionDecisionReason ?? ''),
    traced: existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [],
  };
}

type Case = [tool: 'Bash' | 'PowerShell', command: string];

/** One install of every MANAGER_VERBS manager word, in the form the patterns parse. These pass today. */
const MANAGER_WORDS: Case[] = [
  ['Bash', 'npm install x'], ['Bash', 'pnpm add x'], ['Bash', 'yarn add x'], ['Bash', 'bun add x'],
  ['Bash', 'pip install zz-fake-pkg-a1==1.0.0'], ['Bash', 'pip3 install zz-fake-pkg-a1==1.0.0'], ['Bash', 'pip3.12 install zz-fake-pkg-a1==1.0.0'],
  ['Bash', 'python -m pip install zz-fake-pkg-a1==1.0.0'], ['Bash', 'python3 -mpip install zz-fake-pkg-a1==1.0.0'], ['Bash', 'py -m pip install zz-fake-pkg-a1==1.0.0'],
  ['Bash', 'pipx install zz-fake-pkg-a1'], ['Bash', 'pipenv install zz-fake-pkg-a1'], ['Bash', 'uv pip install zz-fake-pkg-a1==1.0.0'], ['Bash', 'uv add zz-fake-pkg-a1'],
  ['Bash', 'uv tool install zz-fake-pkg-a1'], ['Bash', 'uv run --with zz-fake-pkg-a1 y'], ['Bash', 'poetry add zz-fake-pkg-a1'],
  ['Bash', 'cargo add x'], ['Bash', 'cargo install x'], ['Bash', 'brew install x'], ['Bash', 'go get x'], ['Bash', 'gem install x'],
  ['Bash', 'composer require x'], ['Bash', 'deno add npm:x'],
  ['Bash', 'npx x'], ['Bash', 'pnpx x'], ['Bash', 'bunx x'], ['Bash', 'uvx zz-fake-pkg-a1'], ['Bash', 'npm exec x'], ['Bash', 'npm create x'],
  ['Bash', 'dnx x'], ['Bash', 'dotnet add package x'],
  ['Bash', 'npm ci'], ['Bash', 'yarn'], ['Bash', 'pip install -r requirements.txt'],
];

/** One install of every ECO_RULES name. These pass today. */
const ECO_NAMES: Case[] = [
  ['Bash', 'cargo-binstall x'], ['Bash', 'choco install x'], ['Bash', 'cinst x'], ['Bash', 'cup x'], ['Bash', 'winget install x'],
  ['Bash', 'nuget install x'], ['Bash', 'dotnet tool install x'], ['Bash', 'brew bundle'],
  ['PowerShell', 'Install-WingetPackage x'], ['PowerShell', 'Update-WingetPackage x'],
  ['PowerShell', 'Install-Module x'], ['PowerShell', 'Install-Script x'], ['PowerShell', 'Install-Package x'],
  ['PowerShell', 'Install-PSResource x'], ['PowerShell', 'Install-PackageProvider x'],
  ['PowerShell', 'Save-Module x -Path .'], ['PowerShell', 'Save-Script x -Path .'], ['PowerShell', 'Save-Package x -Path .'],
  ['PowerShell', 'Save-PSResource x -Path .'],
  ['PowerShell', 'Update-Module x'], ['PowerShell', 'Update-Script x'], ['PowerShell', 'Update-PSResource x'],
];

/** A manager word hidden from a plain word match: the guard reads each of these as an install. These pass today. */
const HIDDEN: Case[] = [
  ['Bash', '$PM install x'], ['Bash', 'n\\pm install x'], ['Bash', '"npm" install x'], ['Bash', 'pi\\p install x==1.0.0'],
  ['Bash', "'pnpm' add x"], ['Bash', 'sudo npm install x'], ['Bash', 'C:\\nodejs\\npm.cmd install x'], ['Bash', '/usr/bin/npm install x'],
  ['Bash', 'FOO=1 npm i x'], ['Bash', 'cd /tmp && npm i x'], ['Bash', 'echo hi; NPM install x'], ['Bash', 'env -i npm install x'],
  ['Bash', 'bash -c "npm install x"'], ['Bash', 'xargs npm install x'], ['Bash', 'x=$(npm install y)'],
  ['PowerShell', '& npm install x'], ['PowerShell', '& "npm" install x'], ['PowerShell', 'Start-Process npm -ArgumentList install,x'],
  ['PowerShell', 'Invoke-Expression "choco install x"'], ['PowerShell', '& $pm install x'],
  ['PowerShell', 'n`pm install x'],
];

/** Commands with no manager word, no hidden word and no registry word: the rc files stay unread. */
const NO_INSTALL: Case[] = [
  ['Bash', 'echo hello'], ['Bash', 'git status'], ['Bash', 'ls -la'], ['Bash', 'node script.js'], ['Bash', 'cat package.json'],
  ['Bash', 'git commit -m "fix typo"'], ['Bash', 'pytest -q'], ['Bash', 'grep -r foo .'], ['Bash', 'curl https://example.com'],
  ['PowerShell', 'Get-ChildItem'], ['PowerShell', 'Write-Host hello'],
];

const READS = /rc file on disk/i;

describe('package-install-guard: the rc read', () => {
  it('the fs trace works: a manager install reads rc files (control, so the "no read" cases are not vacuous)', () => {
    const r = runWithRc('npm ci');
    expect(r.traced.length).toBeGreaterThan(0);
    expect(r.traced.some((l) => l.includes('.npmrc'))).toBe(true);
  });

  describe('still reads, and the ask names the rc file', () => {
    it.each([...MANAGER_WORDS, ...ECO_NAMES, ...HIDDEN])('[%s] %s', (tool, command) => {
      const r = runWithRc(command, tool);
      expect(['ask', 'deny']).toContain(r.decision);
      expect(r.reason).toMatch(READS);
      expect(r.reason).toContain('evil.example');
      expect(r.traced.length).toBeGreaterThan(0);
    });
  });

  // pdm and conda are installs too (their patterns came in this PR): the rc read must cover them.
  describe('still reads for pdm and conda', () => {
    it.each<Case>([['Bash', 'pdm add zz-fake-pkg-a1'], ['Bash', 'conda install x'], ['Bash', 'mamba install x']])('[%s] %s', (tool, command) => {
      const r = runWithRc(command, tool);
      expect(r.reason).toMatch(READS);
      expect(r.traced.length).toBeGreaterThan(0);
    });
  });

  describe('a command with no manager word does not read the rc files', () => {
    it.each(NO_INSTALL)('[%s] %s', (tool, command) => {
      const r = runWithRc(command, tool);
      expect(r.decision).toBeUndefined();
      expect(r.traced).toEqual([]);
    });
  });

  // A registry or rc word keeps the read: rawConfigMarkers has its own raw rules for them.
  describe('a registry or rc-file word keeps the read', () => {
    it.each<Case>([
      ['Bash', 'echo registry=https://x.example/ > .npmrc'],
      ['Bash', 'cat .npmrc'],
      ['Bash', 'export PIP_INDEX_URL=https://x.example/simple'],
    ])('[%s] %s', (tool, command) => {
      expect(runWithRc(command, tool).traced.length).toBeGreaterThan(0);
    });
  });

  // The verdict of an install does not change with the gate: the same command with no rc file asks or allows as before.
  it('an install with no rc file on disk keeps its verdict (control)', () => {
    const home = mkdtempSync(join(tmpdir(), 'pig-rcread-empty-'));
    const cwd = mkdtempSync(join(tmpdir(), 'pig-rcread-cwd2-'));
    const res = spawnSync(process.execPath, ['-r', NET_STUB, DIST], {
      input: JSON.stringify({ session_id: 'test-session', tool_name: 'Bash', tool_input: { command: 'npm install lodash' }, cwd }),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CCV3_GUARD_RC_HOME: home, APPDATA: join(home, 'a'), CCV3_GUARD_DECISIONS_LOG: join(home, 'd.jsonl'), CLAUDE_AGENT_ID: '', CI: '', VITEST: '' },
      cwd,
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!).hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});
