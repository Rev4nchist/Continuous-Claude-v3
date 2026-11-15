/**
 * package-install-guard: installs from ecosystems the guard has no registry check for (PR 2 of the lane).
 *
 * The guard reads only the npm and PyPI registries. cargo, nuget, brew, Chocolatey, winget and the
 * PowerShell Gallery have no blocklist, OSV or age check, so an install from one asks ("cannot verify
 * this registry"), and denies where no human can answer. These tests run the BUILT hook
 * (dist/package-install-guard.mjs) with a real PreToolUse payload, the way Claude Code runs it.
 *
 * Failure modes, one table each:
 * - ASK: the bare install forms and every disguise the guard already handles for other managers
 *   (path, .exe suffix, quote or escape splitting, sudo and env prefixes, chains, call operator, wrappers).
 * - The reason names the ecosystem and is not the generic "cannot parse" text.
 * - ALLOW: read-only and local forms stay `continue` (a guard that asks on `dotnet build` is unusable).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSegments } from '../package-install-guard.js';
import { assertScaling } from './helpers/scaling.js';

const DIST = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
const NET_STUB = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));

interface Run { decision: string | undefined; reason: string }

/** Run the built hook. The network is stubbed, the cwd and rc home are empty temp folders. */
function runHook(command: string, tool = 'Bash', env: Record<string, string> = {}): Run {
  const rcHome = mkdtempSync(join(tmpdir(), 'pig-eco-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-eco-cwd-'));
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

/** Commands that must ask, grouped by the ecosystem the reason must name. */
const ASK: Record<string, Case[]> = {
  cargo: [
    ['Bash', 'cargo-binstall ripgrep'],
    ['Bash', 'cargo-binstall.exe ripgrep'],
    ['Bash', 'sudo cargo-binstall ripgrep'],
    ['Bash', 'cargo-binstall -y ripgrep'],
    ['Bash', 'echo hi; cargo-binstall ripgrep'],
    ['Bash', 'C:\\Users\\dave\\.cargo\\bin\\cargo-binstall.exe ripgrep'],
    ['Bash', 'cargo-bin\\stall ripgrep'],
    ['Bash', 'if true; then cargo-binstall ripgrep; fi'],
    ['Bash', 'cmd /c cargo-binstall ripgrep'],
    ['PowerShell', '& cargo-binstall ripgrep'],
    ['PowerShell', '& "C:\\Users\\dave\\.cargo\\bin\\cargo-binstall.exe" ripgrep'],
    ['Bash', 'cargo binstall ripgrep'],
  ],
  nuget: [
    ['Bash', 'nuget install Newtonsoft.Json'],
    ['Bash', 'nuget.exe install Newtonsoft.Json'],
    ['Bash', 'NuGet.exe Install Newtonsoft.Json -OutputDirectory packages'],
    ['Bash', 'nuget update ./x.sln'],
    ['Bash', 'nuget restore x.sln -Source https://nuget.example/v3/index.json'],
    ['PowerShell', 'C:\\tools\\nuget.exe install Newtonsoft.Json'],
    ['PowerShell', '& nuget.exe install Newtonsoft.Json'],
    ['Bash', 'sudo nuget install Newtonsoft.Json'],
    ['Bash', 'nu\\get install Newtonsoft.Json'],
    ['Bash', 'dotnet new install Foo.Templates'],
    ['Bash', 'dotnet new --install Foo.Templates'],
    ['Bash', 'dotnet new -i Foo.Templates'],
    ['Bash', 'dotnet.exe new install Foo.Templates'],
    ['Bash', 'dotnet --verbosity q new install Foo.Templates'],
    ['Bash', 'dotnet workload install maui'],
    ['Bash', 'dotnet workload update'],
    ['Bash', 'dotnet workload restore'],
    ['Bash', 'dotnet restore --source https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet restore -s https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet restore --add-source https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet restore -s:https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet restore x.sln --source=https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet restore --configfile nuget.evil.config'],
    ['Bash', 'dotnet restore /p:RestoreSources=https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet test -p:RestoreSources=https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet run -p:RestoreSources=https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet msbuild -restore -p:RestoreSources=https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet build --source https://nuget.example/v3/index.json'],
    ['Bash', 'dotnet publish -s https://nuget.example/v3/index.json'],
    ['PowerShell', 'dotnet restore --source https://nuget.example/v3/index.json'],
    ['PowerShell', '& dotnet new install Foo.Templates'],
    ['Bash', 'dot\\net add package Foo'],
    ['Bash', 'dot\\net new install Foo.Templates'],
    ['Bash', 'dotnet add package Foo'],
    ['Bash', 'dotnet tool install -g foo'],
  ],
  brew: [
    ['Bash', 'brew bundle'],
    ['Bash', 'brew bundle install'],
    ['Bash', 'brew bundle --file x'],
    ['Bash', 'brew bundle --file=Brewfile'],
    ['Bash', 'brew bundle install --no-lock'],
    ['Bash', 'brew bundle add jq'],
    ['Bash', 'brew --debug bundle'],
    ['Bash', '/opt/homebrew/bin/brew bundle'],
    ['Bash', 'sudo brew bundle'],
    ['Bash', 'HOMEBREW_NO_AUTO_UPDATE=1 brew bundle'],
    ['Bash', 'cd ~/dotfiles && brew bundle'],
    ['Bash', 'bre\\w bundle'],
    ['Bash', 'brew install jq'],
  ],
  chocolatey: [
    ['Bash', 'choco install git'],
    ['Bash', 'choco upgrade git'],
    ['Bash', 'choco upgrade all -y'],
    ['Bash', 'choco update git'],
    ['Bash', 'choco download git'],
    ['Bash', 'choco -y install git'],
    ['Bash', 'choco install git --source https://choco.example/api/v2'],
    ['Bash', 'cinst git'],
    ['Bash', 'cup git'],
    ['Bash', 'cup all'],
    ['Bash', 'cinst.exe git'],
    ['Bash', 'choco.exe install git'],
    ['Bash', 'CHOCO INSTALL git'],
    ['Bash', 'sudo choco install git'],
    ['Bash', 'FOO=1 choco install git'],
    ['Bash', 'echo hi; choco install git'],
    ['Bash', 'true && choco upgrade all || echo no'],
    ['Bash', 'npm test; choco install git'],
    ['Bash', 'npm install lodash && choco install git'],
    ['Bash', 'ch\\oco install git'],
    ['Bash', 'choco in\\stall git'],
    ['Bash', '"choco" install git'],
    ['Bash', "ch'o'co install git"],
    ['Bash', 'choco "install" git'],
    ['Bash', 'cmd /c choco install git'],
    ['Bash', 'bash -c "choco install git"'],
    ['Bash', 'xargs choco install'],
    ['Bash', 'for x in a; do cinst $x; done'],
    ['Bash', 'if true; then cup git; fi'],
    ['Bash', 'if true; then choco install git; fi'],
    ['PowerShell', 'Invoke-Command -ScriptBlock { choco install git }'],
    ['PowerShell', "Invoke-Expression 'choco install git'"],
    ['PowerShell', 'if ($true) { cup git }'],
    ['Bash', 'choco $VERB git'],
    ['Bash', 'C:\\ProgramData\\chocolatey\\bin\\choco.exe install git'],
    ['PowerShell', 'choco install git'],
    ['PowerShell', 'cinst git'],
    ['PowerShell', '& choco install git'],
    ['PowerShell', '& choco.exe upgrade all'],
    ['PowerShell', 'C:\\ProgramData\\chocolatey\\bin\\choco.exe install git'],
    ['PowerShell', "& 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' install git"],
    ['PowerShell', '& "C:\\Program Files\\Chocolatey\\bin\\choco.exe" install git'],
    ['PowerShell', 'ch`oco install git'],
    ['PowerShell', 'Write-Host hi; choco install git'],
    ['PowerShell', 'Start-Process choco -ArgumentList "install","git" -Verb RunAs'],
    ['PowerShell', 'powershell -Command "choco install git"'],
  ],
  winget: [
    ['Bash', 'winget install Git.Git'],
    ['Bash', 'winget upgrade Git.Git'],
    ['Bash', 'winget upgrade --all'],
    ['Bash', 'winget upgrade'],
    ['Bash', 'winget update Git.Git'],
    ['Bash', 'winget import -i packages.json'],
    ['Bash', 'winget download Git.Git'],
    ['Bash', 'winget install --manifest x.yaml'],
    ['Bash', 'winget install -e --id Git.Git --source winget'],
    ['Bash', 'winget --disable-interactivity install Git.Git'],
    ['Bash', 'winget.exe install Git.Git'],
    ['Bash', 'WINGET INSTALL Git.Git'],
    ['Bash', 'sudo winget install Git.Git'],
    ['Bash', 'FOO=1 winget install Git.Git'],
    ['Bash', 'echo hi; winget install Git.Git'],
    ['Bash', 'xargs winget install'],
    ['PowerShell', 'iex "winget install x"'],
    ['Bash', 'wing\\et install Git.Git'],
    ['PowerShell', 'winget install Git.Git'],
    ['PowerShell', '& winget install Git.Git'],
    ['PowerShell', 'C:\\Users\\dave\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe install Git.Git'],
    ['PowerShell', 'Install-WinGetPackage -Id Git.Git'],
  ],
  powershell: [
    ['PowerShell', 'Install-Module Foo'],
    ['PowerShell', 'Install-Script Foo'],
    ['PowerShell', 'Install-Package Foo'],
    ['PowerShell', 'Install-PSResource Foo'],
    ['PowerShell', 'Save-Module Foo -Path .'],
    ['PowerShell', 'Save-Script Foo -Path .'],
    ['PowerShell', 'Save-Package Foo -Path .'],
    ['PowerShell', 'Save-PSResource Foo -Path .'],
    ['PowerShell', 'Update-Module Foo'],
    ['PowerShell', 'Update-Script Foo'],
    ['PowerShell', 'Update-PSResource Foo'],
    ['PowerShell', 'Install-PackageProvider NuGet'],
    ['PowerShell', 'install-module foo'],
    ['PowerShell', 'INSTALL-MODULE Foo'],
    ['PowerShell', 'Install-Module -Name Foo -Scope CurrentUser -Force'],
    ['PowerShell', '& Install-Module Foo'],
    ['PowerShell', 'PowerShellGet\\Install-Module Foo'],
    ['PowerShell', 'Microsoft.PowerShell.PSResourceGet\\Install-PSResource Foo'],
    ['PowerShell', 'Set-Location x; Install-Module Foo'],
    ['PowerShell', 'Write-Host hi; Install-Module Foo'],
    ['PowerShell', 'Install-Module Foo | Out-Null'],
    ['PowerShell', 'Invoke-Expression "Install-Module Foo"'],
    ['PowerShell', "iex 'Install-Module Foo -Force'"],
    // Found while implementing: a command inside a script block or a shell block is still a command.
    ['PowerShell', 'foreach ($m in "a","b") { Install-Module $m -Force }'],
    ['PowerShell', 'try { Install-Module Foo } catch {}'],
    ['PowerShell', 'if ($true) {Install-Module Foo}'],
    ['PowerShell', 'Invoke-Command -ScriptBlock { Install-Module Foo }'],
    ['PowerShell', 'Start-Job { Install-Module Foo }'],
    ['PowerShell', '1..3 | ForEach-Object {Install-Module Foo}'],
    ['PowerShell', '"Foo" | Install-Module'],
    ['PowerShell', 'Install-Mod`ule Foo'],
    ['PowerShell', 'Start-Process pwsh -ArgumentList "-c","Install-Module Foo"'],
    ['PowerShell', 'pwsh -c "Install-Module Foo"'],
    ['PowerShell', 'powershell.exe -Command "Install-Module Foo"'],
    ['Bash', 'pwsh -c "Install-Module Foo"'],
    ['Bash', 'powershell -Command "Install-PSResource Foo"'],
  ],
  // PR 3: conda, mamba and micromamba had no pattern, so they passed with no check.
  conda: [
    ['Bash', 'conda install numpy'],
    ['Bash', 'conda install -c conda-forge numpy'],
    ['Bash', 'conda create -n e python=3.12'],
    ['Bash', 'conda update --all'],
    ['Bash', 'conda env create -f environment.yml'],
    ['Bash', 'conda.exe install numpy'],
    ['Bash', 'sudo conda install numpy'],
    ['Bash', 'mamba install numpy'],
    ['Bash', 'micromamba install numpy'],
    ['Bash', 'echo hi; conda install numpy'],
    ['Bash', 'cond\\a install numpy'],
    ['PowerShell', '& conda install numpy'],
  ],
};

/** Commands that must stay allowed: read-only, local, or not an install. */
const ALLOW: Case[] = [
  ['Bash', 'conda list'],
  ['Bash', 'conda info'],
  ['Bash', 'conda activate base'],
  ['Bash', 'conda env list'],
  ['Bash', 'conda search numpy'],
  ['Bash', 'conda config --show'],
  ['Bash', 'echo "conda install numpy"'],
  ['Bash', 'dotnet build'],
  ['Bash', 'dotnet test'],
  ['Bash', 'dotnet test -s my.runsettings'],
  ['Bash', 'dotnet run'],
  ['Bash', 'dotnet restore'],
  ['Bash', 'dotnet restore x.sln'],
  ['Bash', 'dotnet tool restore'],
  ['Bash', 'dotnet tool list'],
  ['Bash', 'dotnet new console'],
  ['Bash', 'dotnet new list'],
  ['Bash', 'dotnet new console -n install'],
  ['Bash', 'dotnet workload list'],
  ['Bash', 'dotnet add reference ../x.csproj'],
  ['Bash', 'dotnet ef database update'],
  ['Bash', 'echo "dotnet new install Foo"'],
  ['Bash', 'brew list'],
  ['Bash', 'brew update'],
  ['Bash', 'brew info x'],
  ['Bash', 'brew --version'],
  ['Bash', 'brew bundle check'],
  ['Bash', 'brew bundle list'],
  ['Bash', 'brew bundle dump'],
  ['Bash', 'choco list'],
  ['Bash', 'choco list install'],
  ['Bash', 'choco --version'],
  ['Bash', 'choco search git'],
  ['Bash', 'choco info git'],
  ['Bash', 'choco outdated'],
  ['Bash', 'echo coffee cup'],
  ['Bash', 'which choco'],
  ['Bash', 'which cargo-binstall'],
  ['Bash', 'where winget'],
  ['Bash', 'echo "choco install git"'],
  ['Bash', 'git commit -m "winget install Git.Git"'],
  ['Bash', 'winget list'],
  ['Bash', 'winget search x'],
  ['Bash', 'winget search install'],
  ['Bash', 'winget show Git.Git'],
  ['Bash', 'winget --version'],
  ['Bash', 'cargo build'],
  ['Bash', 'cargo test'],
  ['Bash', 'nuget locals all -list'],
  ['Bash', 'nuget sources list'],
  ['Bash', 'nuget restore x.sln'],
  ['PowerShell', 'Get-Module'],
  ['PowerShell', 'Get-Module -ListAvailable'],
  ['PowerShell', 'Import-Module x'],
  ['PowerShell', 'Find-Module x'],
  ['PowerShell', 'Uninstall-Module x'],
  ['PowerShell', 'Get-Help Install-Module'],
  ['PowerShell', 'Get-Command Install-Module'],
  ['PowerShell', 'Write-Host Install-Module Foo'],
  ['Bash', 'man cargo-binstall'],
  ['PowerShell', 'Write-Host "Install-Module Foo"'],
  ['PowerShell', 'choco list'],
  ['PowerShell', 'winget list'],
];

const NAMED_ECOSYSTEM = (eco: string) => new RegExp(`No blocklist, OSV or age check exists for ${eco} packages`);

describe('package-install-guard: installs from ecosystems with no registry check', { timeout: 60_000 }, () => {
  for (const [eco, cases] of Object.entries(ASK)) {
    describe(`${eco}: asks and names the ecosystem`, () => {
      it.each(cases)('[%s] %s', (tool, command) => {
        const { decision, reason } = runHook(command, tool);
        expect(decision).toBe('ask');
        expect(reason).toMatch(NAMED_ECOSYSTEM(eco));
        expect(reason).not.toMatch(/cannot parse/);
      });
    });
  }

  describe('allow controls stay continue', () => {
    it.each(ALLOW)('[%s] %s', (tool, command) => {
      expect(runHook(command, tool).decision).toBeUndefined();
    });
  });

  describe('where no human can answer, the ask is a deny', () => {
    it.each<Case>([
      ['Bash', 'choco install git'],
      ['Bash', 'brew bundle'],
      ['Bash', 'nuget install Newtonsoft.Json'],
      ['PowerShell', 'Install-Module Foo'],
      ['PowerShell', 'winget install Git.Git'],
    ])('[%s] %s denies in a subagent', (tool, command) => {
      const { decision, reason } = runHook(command, tool, { CLAUDE_AGENT_ID: 'agent-1' });
      expect(decision).toBe('deny');
      expect(reason).toMatch(/No blocklist, OSV or age check exists for/);
    });
  });

  describe('the SKIP_PACKAGE_GUARD override works as it does for other managers', () => {
    it('Bash: a leading SKIP_PACKAGE_GUARD=1 allows the segment it prefixes', () => {
      expect(runHook('SKIP_PACKAGE_GUARD=1 choco install git').decision).toBeUndefined();
    });
    it('PowerShell: a $env:SKIP_PACKAGE_GUARD=1; first statement allows the command', () => {
      expect(runHook('$env:SKIP_PACKAGE_GUARD=1; Install-Module Foo', 'PowerShell').decision).toBeUndefined();
    });
    it('the override covers only its own segment: a later install still asks', () => {
      expect(runHook('SKIP_PACKAGE_GUARD=1 choco install git; winget install x').decision).toBe('ask');
    });
  });

  describe('segment detection and cost', () => {
    it('installSegments returns the one chained install segment', () => {
      expect(installSegments('echo hi; choco install git && ls')).toEqual(['choco install git']);
    });
    it('installSegments returns nothing for a read-only choco call', () => {
      expect(installSegments('choco list && winget search x')).toEqual([]);
    });
    // Card hooks-timing-tests-under-load: growth, not a wall-clock limit (a busy suite cannot fail it). Was: 1500 words under 1 s.
    it('repeated "winget install" and "dotnet new" words scan in time that grows linearly with the count', async () => {
      await assertScaling((n) => {
        installSegments('echo' + ' winget install'.repeat(n) + ' x');
        installSegments('echo' + ' dotnet new'.repeat(n) + ' x');
      }, 100);
    });
  });
});
