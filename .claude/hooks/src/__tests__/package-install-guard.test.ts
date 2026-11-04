/**
 * Package Install Security Guard - Tests (TDD)
 *
 * Tests for package-install-guard.ts, a PreToolUse:Bash hook that intercepts
 * package install commands and blocks dangerous installs.
 *
 * Protects against:
 * - Typosquatting attacks (e.g., 'requets' instead of 'requests')
 * - Known malicious package versions (e.g., litellm 1.82.7/1.82.8)
 * - Suspiciously new packages (<24h = block, <7d = warn)
 *
 * The hook reads PreToolUse JSON from stdin, checks the command, and either
 * allows (exit 0) or blocks (exit 2).
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// We test the exported logic functions directly, not via subprocess.
// The main hook entry point reads stdin and calls these functions.
// ---------------------------------------------------------------------------

import {
  isPackageInstallCommand,
  extractPackageNames,
  parseEcosystem,
  checkOverride,
  checkMaliciousPackage,
  checkOsvAdvisory,
  publishDateFromRegistryJson,
  installSegments,
  unpinnedPipPackages,
} from '../package-install-guard.js';

import { checkTyposquat } from '../shared/typosquat-detect.js';

// We also import the malicious packages data to test version blocking
import maliciousPackages from '../shared/malicious-packages.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(command: string, tool = 'Bash'): string {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { command },
    session_id: 'test-session',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('package-install-guard', () => {
  // =========================================================================
  // Command Detection
  // =========================================================================
  describe('command detection', () => {
    it('detects pip install as package install', () => {
      expect(isPackageInstallCommand('pip install requests')).toBe(true);
    });

    it('detects npm install as package install', () => {
      expect(isPackageInstallCommand('npm install express')).toBe(true);
    });

    it('detects yarn add as package install', () => {
      expect(isPackageInstallCommand('yarn add lodash')).toBe(true);
    });

    it('detects uv add as package install', () => {
      expect(isPackageInstallCommand('uv add fastapi')).toBe(true);
    });

    it('detects uv pip install as package install', () => {
      expect(isPackageInstallCommand('uv pip install httpx')).toBe(true);
    });

    it('detects pnpm add as package install', () => {
      expect(isPackageInstallCommand('pnpm add chalk')).toBe(true);
    });

    it('detects pnpm install with package name as package install', () => {
      expect(isPackageInstallCommand('pnpm install chalk')).toBe(true);
    });

    it('detects cargo add as package install', () => {
      expect(isPackageInstallCommand('cargo add serde')).toBe(true);
    });

    it('detects cargo install as package install', () => {
      expect(isPackageInstallCommand('cargo install ripgrep')).toBe(true);
    });

    it('detects go get as package install', () => {
      expect(isPackageInstallCommand('go get github.com/gin-gonic/gin')).toBe(true);
    });

    it('detects gem install as package install', () => {
      expect(isPackageInstallCommand('gem install rails')).toBe(true);
    });

    it('detects bun add as package install', () => {
      expect(isPackageInstallCommand('bun add zod')).toBe(true);
    });

    it('detects bun install with package name as package install', () => {
      expect(isPackageInstallCommand('bun install zod')).toBe(true);
    });

    it('detects composer require as package install', () => {
      expect(isPackageInstallCommand('composer require laravel/framework')).toBe(true);
    });

    it('detects poetry add as package install', () => {
      expect(isPackageInstallCommand('poetry add django')).toBe(true);
    });

    // Non-install commands -> passthrough
    it('does NOT detect pip list as install', () => {
      expect(isPackageInstallCommand('pip list')).toBe(false);
    });

    it('does NOT detect npm ls as install', () => {
      expect(isPackageInstallCommand('npm ls')).toBe(false);
    });

    it('does NOT detect git status as install', () => {
      expect(isPackageInstallCommand('git status')).toBe(false);
    });

    it('does NOT detect echo hello as install', () => {
      expect(isPackageInstallCommand('echo hello')).toBe(false);
    });

    it('does NOT detect bare npm install (no package) as targeted install', () => {
      // bare `npm install` installs from package.json, not a supply chain risk
      expect(isPackageInstallCommand('npm install')).toBe(false);
    });

    it('does NOT detect bare yarn install as targeted install', () => {
      expect(isPackageInstallCommand('yarn install')).toBe(false);
    });

    it('does NOT detect bare bun install as targeted install', () => {
      expect(isPackageInstallCommand('bun install')).toBe(false);
    });

    it('detects npm install with flags before package name', () => {
      expect(isPackageInstallCommand('npm install --save-dev typescript')).toBe(true);
    });

    it('detects pip install with -r (requirements file) as non-targeted', () => {
      // Installing from requirements.txt is not a single-package risk
      expect(isPackageInstallCommand('pip install -r requirements.txt')).toBe(false);
    });

    it('detects pip install with --upgrade flag', () => {
      expect(isPackageInstallCommand('pip install --upgrade requests')).toBe(true);
    });
  });

  // =========================================================================
  // Ecosystem Detection
  // =========================================================================
  describe('ecosystem detection', () => {
    it('identifies pip as pypi ecosystem', () => {
      expect(parseEcosystem('pip install requests')).toBe('pypi');
    });

    it('identifies uv pip install as pypi ecosystem', () => {
      expect(parseEcosystem('uv pip install httpx')).toBe('pypi');
    });

    it('identifies uv add as pypi ecosystem', () => {
      expect(parseEcosystem('uv add fastapi')).toBe('pypi');
    });

    it('identifies poetry add as pypi ecosystem', () => {
      expect(parseEcosystem('poetry add django')).toBe('pypi');
    });

    it('identifies npm install as npm ecosystem', () => {
      expect(parseEcosystem('npm install express')).toBe('npm');
    });

    it('identifies yarn add as npm ecosystem', () => {
      expect(parseEcosystem('yarn add lodash')).toBe('npm');
    });

    it('identifies pnpm add as npm ecosystem', () => {
      expect(parseEcosystem('pnpm add chalk')).toBe('npm');
    });

    it('identifies bun add as npm ecosystem', () => {
      expect(parseEcosystem('bun add zod')).toBe('npm');
    });

    it('identifies cargo add as cargo ecosystem', () => {
      expect(parseEcosystem('cargo add serde')).toBe('cargo');
    });

    it('identifies go get as go ecosystem', () => {
      expect(parseEcosystem('go get github.com/gin-gonic/gin')).toBe('go');
    });

    it('identifies gem install as gem ecosystem', () => {
      expect(parseEcosystem('gem install rails')).toBe('gem');
    });

    it('identifies composer require as composer ecosystem', () => {
      expect(parseEcosystem('composer require laravel/framework')).toBe('composer');
    });

    it('returns null for non-install commands', () => {
      expect(parseEcosystem('git status')).toBeNull();
    });
  });

  // =========================================================================
  // Package Name Extraction
  // =========================================================================
  describe('package name extraction', () => {
    it('extracts package name from pip install', () => {
      const result = extractPackageNames('pip install requests');
      expect(result).toContainEqual({ name: 'requests', version: undefined });
    });

    it('extracts package name and version from pip install with ==', () => {
      const result = extractPackageNames('pip install litellm==1.82.8');
      expect(result).toContainEqual({ name: 'litellm', version: '1.82.8' });
    });

    it('extracts package name from npm install', () => {
      const result = extractPackageNames('npm install express');
      expect(result).toContainEqual({ name: 'express', version: undefined });
    });

    it('extracts package name and version from npm install with @version', () => {
      const result = extractPackageNames('npm install event-stream@3.3.6');
      expect(result).toContainEqual({ name: 'event-stream', version: '3.3.6' });
    });

    it('extracts multiple packages from pip install', () => {
      const result = extractPackageNames('pip install requests flask django');
      expect(result.length).toBe(3);
      expect(result.map(r => r.name)).toEqual(['requests', 'flask', 'django']);
    });

    it('extracts scoped npm package names', () => {
      const result = extractPackageNames('npm install @types/node');
      expect(result).toContainEqual({ name: '@types/node', version: undefined });
    });

    it('extracts scoped npm package with version', () => {
      const result = extractPackageNames('npm install @types/node@20.0.0');
      expect(result).toContainEqual({ name: '@types/node', version: '20.0.0' });
    });

    it('skips flags when extracting names', () => {
      const result = extractPackageNames('npm install --save-dev typescript');
      expect(result).toContainEqual({ name: 'typescript', version: undefined });
      expect(result.length).toBe(1);
    });

    it('extracts from yarn add', () => {
      const result = extractPackageNames('yarn add lodash');
      expect(result).toContainEqual({ name: 'lodash', version: undefined });
    });

    it('extracts from uv add', () => {
      const result = extractPackageNames('uv add fastapi');
      expect(result).toContainEqual({ name: 'fastapi', version: undefined });
    });

    it('extracts from cargo add', () => {
      const result = extractPackageNames('cargo add serde');
      expect(result).toContainEqual({ name: 'serde', version: undefined });
    });

    it('extracts from composer require with vendor/package', () => {
      const result = extractPackageNames('composer require laravel/framework');
      expect(result).toContainEqual({ name: 'laravel/framework', version: undefined });
    });
  });

  // =========================================================================
  // Typosquat Detection
  // =========================================================================
  describe('typosquat detection', () => {
    it('flags requets as typosquat of requests (pypi)', () => {
      const result = checkTyposquat('requets', 'pypi');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('requests');
    });

    it('flags exprss as typosquat of express (npm)', () => {
      const result = checkTyposquat('exprss', 'npm');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('express');
    });

    it('flags litelm as typosquat of litellm (pypi)', () => {
      const result = checkTyposquat('litelm', 'pypi');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('litellm');
    });

    it('allows requests as legitimate (pypi)', () => {
      const result = checkTyposquat('requests', 'pypi');
      expect(result.isTyposquat).toBe(false);
    });

    it('allows express as legitimate (npm)', () => {
      const result = checkTyposquat('express', 'npm');
      expect(result.isTyposquat).toBe(false);
    });

    it('flags colourama as typosquat of colorama (pypi)', () => {
      const result = checkTyposquat('colourama', 'pypi');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('colorama');
    });

    it('flags requsts as typosquat of requests (pypi) via Levenshtein', () => {
      const result = checkTyposquat('requsts', 'pypi');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('requests');
    });

    it('allows a completely unrelated package name', () => {
      const result = checkTyposquat('my-unique-company-package', 'npm');
      expect(result.isTyposquat).toBe(false);
    });

    it('flags djnago as typosquat of django (pypi)', () => {
      const result = checkTyposquat('djnago', 'pypi');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('django');
    });

    it('flags reakt as typosquat of react (npm)', () => {
      const result = checkTyposquat('reakt', 'npm');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('react');
    });

    it('flags lodasj as typosquat of lodash (npm)', () => {
      const result = checkTyposquat('lodasj', 'npm');
      expect(result.isTyposquat).toBe(true);
      expect(result.similarTo).toBe('lodash');
    });
  });

  // =========================================================================
  // Malicious Package Detection
  // =========================================================================
  describe('malicious package detection', () => {
    it('has litellm in pypi blocklist', () => {
      expect(maliciousPackages.pypi.litellm).toBeDefined();
      expect(maliciousPackages.pypi.litellm.blocked_versions).toContain('1.82.7');
      expect(maliciousPackages.pypi.litellm.blocked_versions).toContain('1.82.8');
    });

    it('has event-stream in npm blocklist', () => {
      const es = maliciousPackages.npm['event-stream'];
      expect(es).toBeDefined();
      expect(es.blocked_versions).toContain('3.3.6');
    });

    it('has ua-parser-js in npm blocklist', () => {
      const uap = maliciousPackages.npm['ua-parser-js'];
      expect(uap).toBeDefined();
      expect(uap.blocked_versions).toContain('0.7.29');
    });

    it('has colors in npm blocklist', () => {
      const colors = maliciousPackages.npm['colors'];
      expect(colors).toBeDefined();
      expect(colors.blocked_versions).toContain('1.4.1');
    });

    it('has node-ipc in npm blocklist', () => {
      const nodeipc = maliciousPackages.npm['node-ipc'];
      expect(nodeipc).toBeDefined();
      expect(nodeipc.blocked_versions).toContain('10.1.1');
    });

    it('colourama is blocked_all in pypi', () => {
      expect(maliciousPackages.pypi.colourama.blocked_all).toBe(true);
    });
  });

  // =========================================================================
  // checkMaliciousPackage function
  // =========================================================================
  describe('checkMaliciousPackage function', () => {
    it('blocks litellm==1.82.8 as known malicious', () => {
      const result = checkMaliciousPackage('litellm', '1.82.8', 'pypi');
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('supply chain');
    });

    it('allows litellm==1.83.0 (safe version)', () => {
      const result = checkMaliciousPackage('litellm', '1.83.0', 'pypi');
      expect(result.blocked).toBe(false);
    });

    it('blocks litellm without version (has blocked versions)', () => {
      // When no version specified and package has known-bad versions, warn but allow
      const result = checkMaliciousPackage('litellm', undefined, 'pypi');
      expect(result.blocked).toBe(false);
      expect(result.warning).toBeDefined();
    });

    it('blocks event-stream@3.3.6 as known malicious', () => {
      const result = checkMaliciousPackage('event-stream', '3.3.6', 'npm');
      expect(result.blocked).toBe(true);
    });

    it('allows event-stream@4.0.0 (safe version)', () => {
      const result = checkMaliciousPackage('event-stream', '4.0.0', 'npm');
      expect(result.blocked).toBe(false);
    });

    it('blocks colourama entirely (blocked_all)', () => {
      const result = checkMaliciousPackage('colourama', undefined, 'pypi');
      expect(result.blocked).toBe(true);
    });

    it('allows an unknown package', () => {
      const result = checkMaliciousPackage('some-random-safe-pkg', undefined, 'npm');
      expect(result.blocked).toBe(false);
    });
  });

  // =========================================================================
  // Override
  // =========================================================================
  describe('override', () => {
    it('allows command with SKIP_PACKAGE_GUARD=1 prefix', () => {
      expect(checkOverride('SKIP_PACKAGE_GUARD=1 pip install requets')).toBe(true);
    });

    it('does not allow command without override prefix', () => {
      expect(checkOverride('pip install requets')).toBe(false);
    });

    it('allows SKIP_PACKAGE_GUARD=1 anywhere in env prefix', () => {
      expect(checkOverride('FOO=bar SKIP_PACKAGE_GUARD=1 npm install evil-pkg')).toBe(true);
    });
  });

  // =========================================================================
  // OSV.dev Advisory Check
  // =========================================================================
  describe('OSV.dev advisory check', () => {
    it('should be exported from the module', () => {
      expect(typeof checkOsvAdvisory).toBe('function');
    });

    it('should return { blocked: false } for cargo ecosystem (unsupported)', async () => {
      const result = await checkOsvAdvisory('serde', undefined, 'cargo');
      expect(result.blocked).toBe(false);
    });

    it('should return { blocked: false } for go ecosystem (unsupported)', async () => {
      const result = await checkOsvAdvisory('github.com/gin-gonic/gin', undefined, 'go');
      expect(result.blocked).toBe(false);
    });

    it('should return { blocked: false } for gem ecosystem (unsupported)', async () => {
      const result = await checkOsvAdvisory('rails', undefined, 'gem');
      expect(result.blocked).toBe(false);
    });

    it('should return { blocked: false } for composer ecosystem (unsupported)', async () => {
      const result = await checkOsvAdvisory('laravel/framework', undefined, 'composer');
      expect(result.blocked).toBe(false);
    });

    it('should accept pypi ecosystem without error', async () => {
      // This calls the real API (fail-open on network errors)
      const result = await checkOsvAdvisory('requests', '2.31.0', 'pypi');
      expect(result).toHaveProperty('blocked');
      expect(typeof result.blocked).toBe('boolean');
    });

    it('should accept npm ecosystem without error', async () => {
      // This calls the real API (fail-open on network errors)
      const result = await checkOsvAdvisory('express', '4.18.2', 'npm');
      expect(result).toHaveProperty('blocked');
      expect(typeof result.blocked).toBe('boolean');
    });

    it('should return OsvResult shape with optional fields', async () => {
      const result = await checkOsvAdvisory('some-nonexistent-pkg-xyz', undefined, 'npm');
      expect(result).toHaveProperty('blocked');
      // warning and advisoryId are optional
      if (result.warning) {
        expect(typeof result.warning).toBe('string');
      }
      if (result.advisoryId) {
        expect(typeof result.advisoryId).toBe('string');
      }
    });
  });

  // =========================================================================
  // 2026-09-01 regressions: legitimate near-misses, pinned-version age check,
  // and the deny envelope shape.
  // =========================================================================
  describe('legitimate near-miss allowlist', () => {
    it.each([
      ['vitest', 'npm'],
      ['vite-node', 'npm'],
      ['chai', 'npm'],
      ['ora', 'npm'],
      ['uid', 'npm'],
      ['zx', 'npm'],
      ['sympy', 'pypi'],
      ['pipx', 'pypi'],
      ['httpie', 'pypi'],
      ['hiredis', 'pypi'],
      ['torchx', 'pypi'],
      ['mcp', 'pypi'],
    ] as const)('does not flag %s (%s) even though it is within 2 edits of a popular name', (name, eco) => {
      expect(checkTyposquat(name, eco).isTyposquat).toBe(false);
    });

    it('still flags real near-miss typosquats', () => {
      expect(checkTyposquat('vitte', 'npm').isTyposquat).toBe(true);
      expect(checkTyposquat('vitest1', 'npm').isTyposquat).toBe(false); // 3 from vite, not in list: fine either way
      expect(checkTyposquat('numpyy', 'pypi').isTyposquat).toBe(true);
    });
  });

  describe('publishDateFromRegistryJson', () => {
    const npmDoc = {
      'dist-tags': { latest: '25.0.0' },
      time: {
        created: '2016-01-01T00:00:00.000Z',
        '24.13.3': '2026-07-08T06:48:03.261Z',
        '25.0.0': '2026-09-01T14:00:00.000Z',
      },
    };
    const pypiDoc = {
      info: { version: '2.0.0' },
      releases: {
        '1.9.0': [{ upload_time_iso_8601: '2026-05-01T00:00:00.000Z' }],
        '2.0.0': [{ upload_time_iso_8601: '2026-09-01T13:00:00.000Z' }],
      },
    };

    it('npm: uses the pinned exact version when the registry knows it', () => {
      expect(publishDateFromRegistryJson(npmDoc, 'npm', '24.13.3')?.toISOString()).toBe('2026-07-08T06:48:03.261Z');
    });
    it('npm: falls back to latest for no version or a range', () => {
      expect(publishDateFromRegistryJson(npmDoc, 'npm')?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
      expect(publishDateFromRegistryJson(npmDoc, 'npm', '^24.13.0')?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
      expect(publishDateFromRegistryJson(npmDoc, 'npm', 'latest')?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
    });
    it('npm: an unknown pinned version falls back to latest rather than passing silently', () => {
      expect(publishDateFromRegistryJson(npmDoc, 'npm', '9.9.9')?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
    });
    it('pypi: same rules', () => {
      expect(publishDateFromRegistryJson(pypiDoc, 'pypi', '1.9.0')?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
      expect(publishDateFromRegistryJson(pypiDoc, 'pypi')?.toISOString()).toBe('2026-09-01T13:00:00.000Z');
    });
    it('pypi: a PEP 440 pre-release pin uses its own date, not the older stable release', () => {
      const doc = {
        info: { version: '1.8.0' },
        releases: {
          '1.8.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00.000Z' }],
          '1.9.0rc1': [{ upload_time_iso_8601: '2026-09-23T10:00:00.000Z' }],
        },
      };
      expect(publishDateFromRegistryJson(doc, 'pypi', '1.9.0rc1')?.toISOString()).toBe('2026-09-23T10:00:00.000Z');
    });
    it('pypi: a shortened pin (1.8) resolves to its PEP 440 equal release (1.8.0), not the fallback', () => {
      const doc = {
        info: { version: '2.0.0' }, // the fallback, with a DIFFERENT date, so the test can tell them apart
        releases: {
          '1.8.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00.000Z' }],
          '2.0.0': [{ upload_time_iso_8601: '2026-09-23T10:00:00.000Z' }],
        },
      };
      expect(publishDateFromRegistryJson(doc, 'pypi', '1.8')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(publishDateFromRegistryJson(doc, 'pypi', '1.8.0.0')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(publishDateFromRegistryJson(doc, 'pypi', '1.9')?.toISOString()).toBe('2026-09-23T10:00:00.000Z'); // unknown -> fallback
    });
    it('pypi: ages a release by its NEWEST file (a new wheel on an old release)', () => {
      const doc = {
        info: { version: '2.0.0' },
        releases: {
          '2.0.0': [
            { upload_time_iso_8601: '2025-01-01T00:00:00.000Z' }, // sdist
            { upload_time_iso_8601: '2026-09-23T09:00:00.000Z' }, // wheel added later
            { upload_time_iso_8601: 'not-a-date' },
          ],
        },
      };
      expect(publishDateFromRegistryJson(doc, 'pypi', '2.0.0')?.toISOString()).toBe('2026-09-23T09:00:00.000Z');
    });
    it('returns null on malformed documents', () => {
      expect(publishDateFromRegistryJson(null, 'npm')).toBeNull();
      expect(publishDateFromRegistryJson({}, 'pypi')).toBeNull();
    });
    it('extractPackageNames carries a pip == pre-release pin through', () => {
      expect(extractPackageNames('pip install example==1.9.0rc1')).toEqual([{ name: 'example', version: '1.9.0rc1' }]);
    });
    it('extractPackageNames carries the pinned version through to the age check input', () => {
      const pkgs = extractPackageNames('pnpm add -Dw @types/node@24.13.3');
      expect(pkgs).toEqual([{ name: '@types/node', version: '24.13.3' }]);
    });
  });

  // Review H2 (FourthCompanyBrain, 2026-10-04): PowerShell is the default shell here, and the
  // "pin every install" rule was prose only.
  describe('PowerShell forms and later segments', () => {
    it('detects python -m pip install', () => {
      expect(extractPackageNames('python -m pip install requests')).toEqual([{ name: 'requests', version: undefined }]);
    });
    it('detects py -3.12 -m pip install', () => {
      expect(isPackageInstallCommand('py -3.12 -m pip install requests')).toBe(true);
    });
    it('detects a pip.exe under a Windows venv path', () => {
      expect(isPackageInstallCommand('.venv\\Scripts\\pip.exe install requests')).toBe(true);
    });
    it('finds an install after cd in Bash', () => {
      expect(installSegments('cd /tmp/x && pip install requests')).toEqual(['pip install requests']);
    });
    it('finds an install after Set-Location in PowerShell', () => {
      expect(installSegments('Set-Location C:\\x; python -m pip install requests', 'PowerShell')).toEqual(['python -m pip install requests']);
    });
    it('does not treat an echoed install as an install', () => {
      expect(installSegments('echo "pip install requests"')).toEqual([]);
    });
    // Critic round 1 on PR #97.
    it('does not treat a literal heredoc line as an install', () => {
      expect(installSegments("cat > README.md <<'EOF'\npip install requests\nEOF")).toEqual([]);
    });
    it('sees an install after a PowerShell backtick escape inside quotes', () => {
      expect(installSegments('Write-Host "done`n"; pip install requests', 'PowerShell')).toEqual(['pip install requests']);
    });
    it('joins a PowerShell backtick line continuation', () => {
      expect(isPackageInstallCommand(installSegments('python -m pip `\n  install requests', 'PowerShell')[0] ?? '')).toBe(true);
    });
    it('sees pip global options and interpreter flags before install', () => {
      expect(isPackageInstallCommand('pip --disable-pip-version-check install requests')).toBe(true);
      expect(isPackageInstallCommand('python -m pip -q install requests')).toBe(true);
      expect(isPackageInstallCommand('pip --proxy http://p:8080 install requests')).toBe(true);
      expect(isPackageInstallCommand('python -I -m pip install requests')).toBe(true);
      expect(isPackageInstallCommand('python -X utf8 -m pip install requests')).toBe(true);
    });
    it('matches launchers in any letter case', () => {
      expect(isPackageInstallCommand('Python -m pip install requests')).toBe(true);
      expect(isPackageInstallCommand('PIP install requests')).toBe(true);
    });
    it('strips sudo, time and a brace before an install', () => {
      expect(installSegments('sudo pip install requests')).toEqual(['pip install requests']);
      expect(installSegments('{ pip install requests; }')).toEqual(['pip install requests']);
    });
    it('splits a command substitution into its segments', () => {
      expect(installSegments('x=$(cd /tmp && pip install requests)')).toEqual(['pip install requests']);
    });
  });

  describe('pip pin check', () => {
    it('flags a bare name', () => {
      expect(unpinnedPipPackages('pip install requests')).toEqual(['requests']);
    });
    it('flags a range and a wildcard', () => {
      expect(unpinnedPipPackages('pip install "requests>=2" httpx==0.*')).toEqual(['requests', 'httpx']);
    });
    it('passes == and === pins, with extras and quotes', () => {
      expect(unpinnedPipPackages('pip install "requests[socks]==2.32.3" mcp===1.26.0')).toEqual([]);
    });
    it('flags uv pip install and python -m pip install', () => {
      expect(unpinnedPipPackages('uv pip install httpx')).toEqual(['httpx']);
      expect(unpinnedPipPackages('python -m pip install -U pip')).toEqual(['pip']);
    });
    it('leaves lockfile tools, requirement files and local paths alone', () => {
      expect(unpinnedPipPackages('uv add httpx')).toEqual([]);
      expect(unpinnedPipPackages('pip install -r requirements.txt')).toEqual([]);
      expect(unpinnedPipPackages('pip install -e .')).toEqual([]);
      expect(unpinnedPipPackages('pip install .')).toEqual([]);
      expect(unpinnedPipPackages('pip install dist\\pkg-1.0-py3-none-any.whl')).toEqual([]);
    });
    it('leaves npm alone', () => {
      expect(unpinnedPipPackages('npm install express')).toEqual([]);
    });
    // Critic round 1 on PR #97: a flag value is not a package.
    it('skips the value of --trusted-host and --python', () => {
      expect(unpinnedPipPackages('pip install --trusted-host pypi.org requests==2.31.0')).toEqual([]);
      expect(unpinnedPipPackages('uv pip install --python 3.12 httpx==0.27.0')).toEqual([]);
    });
    it('reads a quoted specifier with spaces and a PEP 508 marker', () => {
      expect(unpinnedPipPackages('pip install "requests >= 2"')).toEqual(['requests']);
      expect(unpinnedPipPackages('pip install "requests==2.31.0; python_version>=\'3.8\'"')).toEqual([]);
    });
  });

  describe('deny envelope (built hook, subprocess)', () => {
    /** The built hook runs without VITEST, so its guard log must go to a temp file, never ~/.claude/logs. */
    async function builtHookEnv(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const log = join(mkdtempSync(join(tmpdir(), 'pig-guard-log-')), 'guard-decisions.jsonl');
      const env: NodeJS.ProcessEnv = { ...process.env, CCV3_GUARD_DECISIONS_LOG: log };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;
      return { env, log };
    }

    it('denies an unpinned pip install sent through the PowerShell tool', async () => {
      const { spawnSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const dist = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
      if (!existsSync(dist)) return;
      const { env } = await builtHookEnv();
      const res = spawnSync(process.execPath, [dist], {
        input: makePayload('Set-Location C:\\x; python -m pip install requests', 'PowerShell'),
        encoding: 'utf8',
        timeout: 20_000,
        env,
      });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/requests==/);
    });

    it('emits the PreToolUse hookSpecificOutput deny envelope on stdout and exits 0', async () => {
      const { spawnSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const dist = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
      if (!existsSync(dist)) return; // dist not built in this checkout; the build step runs this in CI
      // The hook skips main() when VITEST is set (so importing it in tests is side-effect free);
      // the subprocess must not inherit that or it prints nothing.
      const { env, log } = await builtHookEnv();
      const res = spawnSync(process.execPath, [dist], {
        input: makePayload('pip install requets'),
        encoding: 'utf8',
        timeout: 20_000,
        env,
      });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/typosquat/i);
      // The deny reaches the guard log named by CCV3_GUARD_DECISIONS_LOG, and only that one.
      const { readFileSync } = await import('node:fs');
      const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hook: 'package-install-guard', decision: 'deny', session_id: 'test-session' });
    });
  });
});

// F07 (2026-11-03 Cloudflare paper eval): shell-running MCP tools skipped this guard.
describe('shell-running MCP tools (F07), built hook, subprocess', () => {
  const START = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
  const INTERACT = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process';

  async function run(payload: object): Promise<Record<string, any>> {
    const { spawnSync } = await import('node:child_process');
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dist = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
    expect(existsSync(dist)).toBe(true);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCV3_GUARD_DECISIONS_LOG: join(mkdtempSync(join(tmpdir(), 'pig-f07-')), 'guard-decisions.jsonl'),
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    const res = spawnSync(process.execPath, [dist], {
      input: JSON.stringify({ session_id: 'test-session', ...payload }),
      encoding: 'utf8',
      timeout: 20_000,
      env,
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout.trim().split('\n').pop()!);
  }

  it('denies an unpinned pip install sent through start_process', async () => {
    const out = await run({ tool_name: START, tool_input: { command: 'pip install requests', timeout_ms: 5000 } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/requests==/);
  });

  it('reads interact_with_process text from its input field', async () => {
    const out = await run({ tool_name: INTERACT, tool_input: { pid: 4242, input: 'python -m pip install requests' } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies when a listed MCP tool has no readable command text', async () => {
    const out = await run({ tool_name: START, tool_input: { cmd: 'pip install requests', timeout_ms: 5000 } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/unreadable/i);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-03 Cloudflare paper eval, package guard findings F08-F15.
// Every case below runs the BUILT hook in a subprocess with the registry and OSV stubbed
// (package-guard-net-stub.cjs, loaded by `node -r`), so no case touches the network.
// GREEN needs `npm run build` in .claude/hooks first: the cases read dist/package-install-guard.mjs.
// A decision is "gated" when permissionDecision is ask or deny. "Allowed" is no permissionDecision.
// ---------------------------------------------------------------------------
describe('cloudflare eval bypasses (F08-F15)', { timeout: 30_000 }, () => {
  type Stub = { ageHours?: number; nextHours?: number };

  async function runHook(
    command: string,
    opts: { tool?: string; stub?: Stub; cwd?: string } = {},
  ): Promise<string | undefined> {
    const { spawnSync } = await import('node:child_process');
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dist = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
    const netStub = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));
    expect(existsSync(dist)).toBe(true);
    expect(existsSync(netStub)).toBe(true);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCV3_GUARD_DECISIONS_LOG: join(mkdtempSync(join(tmpdir(), 'pig-f08-')), 'guard-decisions.jsonl'),
      PIG_STUB_AGE_HOURS: String(opts.stub?.ageHours ?? 2400),
      PIG_STUB_NEXT_HOURS: String(opts.stub?.nextHours ?? 2400),
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    const payload = {
      session_id: 'test-session',
      tool_name: opts.tool ?? 'Bash',
      tool_input: { command },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
    const res = spawnSync(process.execPath, ['-r', netStub, dist], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20_000,
      env,
      cwd: opts.cwd,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
    return out.hookSpecificOutput?.permissionDecision;
  }

  const FRESH: Stub = { ageHours: 1 }; // the package was published an hour ago: a detected install is denied
  const OLD: Stub = { ageHours: 2400 }; // 100 days old and clean
  const gated = (decision: string | undefined) => expect(['ask', 'deny']).toContain(decision);

  // ----- F08: the override must be a leading env assignment -----
  describe('F08 override anchoring', () => {
    const notLeading = [
      'npm install zz-fake-pkg-a1 # SKIP_PACKAGE_GUARD=1',
      'echo SKIP_PACKAGE_GUARD=1; npm install zz-fake-pkg-a1',
      'npm install zz-fake-pkg-a1 && echo SKIP_PACKAGE_GUARD=1',
      '# SKIP_PACKAGE_GUARD=1\nnpm install zz-fake-pkg-a1',
    ];
    it.each(notLeading)('checkOverride is false for %j', (cmd) => {
      expect(checkOverride(cmd)).toBe(false);
    });
    it.each(notLeading)('hook gates a fresh package when the override is not leading: %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });
    it('regression: a leading SKIP_PACKAGE_GUARD=1 is honoured (hook allows a fresh package)', async () => {
      expect(await runHook('SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1', { stub: FRESH })).toBeUndefined();
    });
    it('regression: SKIP_PACKAGE_GUARD=1 among several leading assignments is honoured', async () => {
      expect(await runHook('FOO=bar SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1', { stub: FRESH })).toBeUndefined();
    });
    it('regression: checkOverride is true for the leading forms', () => {
      expect(checkOverride('SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1')).toBe(true);
      expect(checkOverride('FOO=bar SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1')).toBe(true);
    });
  });

  // ----- F10: leaders and flags hide the install -----
  describe('F10 leaders and flags before the install', () => {
    const hidden = [
      'npm --prefix /tmp/zz-fake-dir install zz-fake-pkg-a1',
      'npm -g install zz-fake-pkg-a1',
      'npm add zz-fake-pkg-a1',
      'pnpm i zz-fake-pkg-a1',
      'bun i zz-fake-pkg-a1',
      'env FOO=1 npm install zz-fake-pkg-a1',
      'timeout 60 npm install zz-fake-pkg-a1',
      'exec npm install zz-fake-pkg-a1',
      'sudo npm install zz-fake-pkg-a1',
      'FOO=bar npm install zz-fake-pkg-a1',
      'yarn --cwd /tmp/zz-fake-dir add zz-fake-pkg-a1',
    ];
    it.each(hidden)('gates a fresh package behind %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });
    it('regression: plain npm install of an old, clean package allows', async () => {
      expect(await runHook('npm install zz-fake-pkg-a1', { stub: OLD })).toBeUndefined();
    });
    it('regression: plain npm install of a fresh package still denies', async () => {
      expect(await runHook('npm install zz-fake-pkg-a1', { stub: FRESH })).toBe('deny');
    });
    it('regression: a scoped package that is old and clean allows', async () => {
      expect(await runHook('npm install @zz-fake/pkg-a1', { stub: OLD })).toBeUndefined();
    });
    it('regression: a bare npm install (no package named) allows', async () => {
      expect(await runHook('npm install', { stub: FRESH })).toBeUndefined();
    });
  });

  // ----- F11: -f and -r are not value flags everywhere; a custom pip index should ask -----
  describe('F11 flags read as value flags', () => {
    const swallowed = [
      'npm install -f zz-fake-pkg-a1',
      'npm install -r zz-fake-pkg-a1',
      'pnpm add -r zz-fake-pkg-a1',
      'bun add -f zz-fake-pkg-a1',
    ];
    it.each(swallowed)('gates a fresh package in %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });
    const customIndex = [
      'pip install -i https://zz-fake-host.example/simple zz-fake-pkg-a1==1.0.0',
      'pip install --index-url https://zz-fake-host.example/simple zz-fake-pkg-a1==1.0.0',
      'pip install --index-url=https://zz-fake-host.example/simple zz-fake-pkg-a1==1.0.0',
      'pip install --extra-index-url https://zz-fake-host.example/simple zz-fake-pkg-a1==1.0.0',
      'uv pip install --index-url https://zz-fake-host.example/simple zz-fake-pkg-a1==1.0.0',
    ];
    it.each(customIndex)('asks or denies for a custom index in %j (stub says the pin is old and clean)', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it('regression: pip install of an exact, old, clean pin allows', async () => {
      expect(await runHook('pip install zz-fake-pkg-a1==1.0.0', { stub: OLD })).toBeUndefined();
    });
    it('regression: pip install requests==2.32.3 (old, clean) allows', async () => {
      expect(await runHook('pip install requests==2.32.3', { stub: OLD })).toBeUndefined();
    });
    it('regression: pip install requests with no pin still denies (the pin rule)', async () => {
      expect(await runHook('pip install requests', { stub: OLD })).toBe('deny');
    });
  });

  // ----- F12: URL, VCS, github: and user/repo installs are dropped by the '/' rule -----
  describe('F12 non-registry sources', () => {
    const remote = [
      'npm install https://zz-fake-host.example/zz-fake-pkg-a1.tgz',
      'npm install git+https://zz-fake-host.example/zz-fake-org/zz-fake-pkg-a1.git',
      'npm install github:zz-fake-org/zz-fake-pkg-a1',
      'npm install zz-fake-org/zz-fake-pkg-a1',
      'npm install ./zz-fake-pkg-a1.tgz',
      'npm install file:../zz-fake-pkg-a1',
      'pnpm add github:zz-fake-org/zz-fake-pkg-a1',
      'yarn add git+https://zz-fake-host.example/zz-fake-org/zz-fake-pkg-a1.git',
      'bun add https://zz-fake-host.example/zz-fake-pkg-a1.tgz',
      'pip install git+https://zz-fake-host.example/zz-fake-org/zz-fake-pkg-a1.git',
      'pip install https://zz-fake-host.example/zz-fake-pkg-a1-1.0.tar.gz',
    ];
    it.each(remote)('asks or denies for %j (stub says any registry package is old and clean)', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it('regression: pip install -r requirements.txt still allows', async () => {
      expect(await runHook('pip install -r requirements.txt', { stub: OLD })).toBeUndefined();
    });
    it('regression: pip install -e . still allows', async () => {
      expect(await runHook('pip install -e .', { stub: OLD })).toBeUndefined();
    });
  });

  // ----- F13: runners and npm ci are not matched; other ecosystems are matched then skipped -----
  describe('F13 runners, npm ci and the unchecked ecosystems', () => {
    const runners = [
      'npx zz-fake-pkg-a1',
      'npx -y zz-fake-pkg-a1',
      'npx --yes zz-fake-pkg-a1@1.0.0',
      'pnpm dlx zz-fake-pkg-a1',
      'yarn dlx zz-fake-pkg-a1',
      'npm exec zz-fake-pkg-a1',
      'bunx zz-fake-pkg-a1',
      'uvx zz-fake-pkg-a1',
    ];
    it.each(runners)('gates a fresh package run through %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });

    // Reading of "intended": npm ci installs exactly what the lockfile pins and names no package,
    // so it is the same class as a bare `npm install`, which the guard allows (guard comment,
    // "bare install is NOT a targeted install"). With package-lock.json in the working directory
    // it allows. Without one there is nothing pinned to trust, so it asks.
    // The working directory is the `cwd` field of the hook payload.
    async function tempDir(withLockfile: boolean): Promise<string> {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'pig-npmci-'));
      if (withLockfile) writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
      return dir;
    }
    it('npm ci with no lockfile in the working directory asks or denies', async () => {
      gated(await runHook('npm ci', { stub: FRESH, cwd: await tempDir(false) }));
    });
    it('regression: npm ci with a lockfile in the working directory allows', async () => {
      expect(await runHook('npm ci', { stub: FRESH, cwd: await tempDir(true) })).toBeUndefined();
    });

    const unchecked = [
      'cargo add zz-fake-pkg-a1',
      'cargo install zz-fake-pkg-a1',
      'gem install zz-fake-pkg-a1',
      'go get github.com/zz-fake-org/zz-fake-pkg-a1@v1.0.0',
      'composer require zz-fake-org/zz-fake-pkg-a1',
    ];
    it.each(unchecked)('does not silently allow %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
  });

  // ----- F15: a tag pin is aged by the tag that was asked for -----
  describe('F15 npm tag pins', () => {
    const doc = {
      'dist-tags': { latest: '1.0.0', next: '2.0.0-next.1', beta: '2.0.0-beta.1' },
      time: {
        '1.0.0': '2026-01-01T00:00:00.000Z',
        '2.0.0-next.1': '2026-11-03T10:00:00.000Z',
        '2.0.0-beta.1': '2026-11-02T10:00:00.000Z',
      },
    };
    it('publishDateFromRegistryJson: @next uses the next tag publish time', () => {
      expect(publishDateFromRegistryJson(doc, 'npm', 'next')?.toISOString()).toBe('2026-11-03T10:00:00.000Z');
    });
    it('publishDateFromRegistryJson: @beta uses the beta tag publish time', () => {
      expect(publishDateFromRegistryJson(doc, 'npm', 'beta')?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    });
    it('regression: @latest and no tag still use latest', () => {
      expect(publishDateFromRegistryJson(doc, 'npm', 'latest')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(publishDateFromRegistryJson(doc, 'npm')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
    it('hook denies zz-fake-pkg-a1@next when latest is old but next is an hour old', async () => {
      expect(await runHook('npm install zz-fake-pkg-a1@next', { stub: { ageHours: 2400, nextHours: 1 } })).toBe('deny');
    });
    it('hook denies pnpm add zz-fake-pkg-a1@beta when beta is an hour old', async () => {
      expect(await runHook('pnpm add zz-fake-pkg-a1@beta', { stub: { ageHours: 2400, nextHours: 1 } })).toBe('deny');
    });
    it('regression: zz-fake-pkg-a1@latest with an old latest allows', async () => {
      expect(await runHook('npm install zz-fake-pkg-a1@latest', { stub: { ageHours: 2400, nextHours: 1 } })).toBeUndefined();
    });
  });

  // ----- Repair round: E2E failures and adversarial review items -----
  const URL_TGZ = 'https://zz-fake-host.example/zz.tgz';
  const IDX = 'https://zz-fake-host.example/simple';
  const NEXT_FRESH: Stub = { ageHours: 2400, nextHours: 1 };
  const names = (cmd: string) => extractPackageNames(cmd).map((p) => p.name);

  describe('repair: F08 PowerShell override keeps the base deny for a quoted value', () => {
    it('a quoted $env:SKIP_PACKAGE_GUARD=\'1\' is not the override (the base guard denied it)', async () => {
      gated(await runHook("$env:SKIP_PACKAGE_GUARD='1'; npm install zz-fake-pkg-a1", { tool: 'PowerShell', stub: FRESH }));
    });
    it('regression: the unquoted $env:SKIP_PACKAGE_GUARD=1; first statement is the override', async () => {
      expect(await runHook('$env:SKIP_PACKAGE_GUARD=1; npm install zz-fake-pkg-a1', { tool: 'PowerShell', stub: FRESH })).toBeUndefined();
    });
  });

  describe('repair: F10 a quoted or escaped manager or verb', () => {
    it.each([
      '"pip" install litellm==1.82.7',
      'npm "i" event-stream@3.3.6',
    ])('the blocklist still denies %j', async (cmd) => {
      expect(await runHook(cmd, { stub: OLD })).toBe('deny');
    });
    it.each([
      'pip "install" zz-fake-pkg-a1',
      String.raw`pi\p install zz-fake-pkg-a1`,
      String.raw`np\m install ${URL_TGZ}`,
      `'npm' i ${URL_TGZ}`,
    ])('Bash: gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it.each([
      '& "pip" install zz-fake-pkg-a1',
      `& 'npm' install ${URL_TGZ}`,
      `npm 'install' ${URL_TGZ}`,
    ])('PowerShell: gates %j', async (cmd) => {
      gated(await runHook(cmd, { tool: 'PowerShell', stub: OLD }));
    });
    it.each([
      'echo "npm install zz-fake-pkg-a1"',
      'git commit -m "pip install zz-fake-pkg-a1"',
    ])('regression: install text inside a quoted argument still allows: %j', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBeUndefined();
    });
  });

  describe('repair: F10 a variable or substitution in the command or verb position', () => {
    it.each([
      `V=install; npm $V ${URL_TGZ}`,
      `npm $(echo install) ${URL_TGZ}`,
      `npm \${V:-install} ${URL_TGZ}`,
      `PM=npm; $PM install ${URL_TGZ}`,
    ])('gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it('regression: npm run $TARGET is not an install', async () => {
      expect(await runHook('npm run $TARGET', { stub: FRESH })).toBeUndefined();
    });
  });

  describe('repair: F10 python -mpip (flag attached to its value)', () => {
    it.each([
      'python -mpip install zz-fake-pkg-a1',
      'python3 -mpip install zz-fake-pkg-a1',
      'py -mpip install zz-fake-pkg-a1',
    ])('denies the unpinned install in %j', async (cmd) => {
      expect(await runHook(cmd, { stub: OLD })).toBe('deny');
    });
  });

  describe('repair: F11 combined short flags with an attached index URL', () => {
    it.each([
      `pip install -qi${IDX} zz-fake-pkg-a1==1.0.0`,
      `pip install -Ui${IDX} zz-fake-pkg-a1==1.0.0`,
      'pip install -qfhttps://zz-fake-host.example/links zz-fake-pkg-a1==1.0.0',
    ])('gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
  });

  describe('repair: F11 an index or registry set elsewhere in the command or in a config file', () => {
    it.each([
      `export PIP_INDEX_URL=${IDX}; pip install zz-fake-pkg-a1==1.0.0`,
      'export npm_config_registry=https://zz-fake-host.example; npm install zz-fake-pkg-a1',
      'npm config set registry https://zz-fake-host.example && npm install zz-fake-pkg-a1',
      'npm install --@zz-scope:registry=https://zz-fake-host.example @zz-scope/zz-fake-pkg-a1',
      'npm install --userconfig ./zz.npmrc zz-fake-pkg-a1',
      'NPM_CONFIG_USERCONFIG=./zz.npmrc npm install zz-fake-pkg-a1',
      'PIP_CONFIG_FILE=./zz.conf pip install zz-fake-pkg-a1==1.0.0',
    ])('Bash: gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it('PowerShell: gates $env:PIP_INDEX_URL set in an earlier statement', async () => {
      gated(await runHook(`$env:PIP_INDEX_URL='${IDX}'; pip install zz-fake-pkg-a1==1.0.0`, { tool: 'PowerShell', stub: OLD }));
    });
  });

  describe('repair: F11/F13 runner flags take the package slot', () => {
    it('uvx --directory /tmp zz-fake-pkg-a1 is checked (fresh: gated)', async () => {
      gated(await runHook('uvx --directory /tmp zz-fake-pkg-a1', { stub: FRESH }));
    });
    it.each([
      ['uvx --color never zz-fake-pkg-a1', ['zz-fake-pkg-a1']],
      ['uvx --with zz-fake-pkg-b2 zz-fake-pkg-a1', ['zz-fake-pkg-b2', 'zz-fake-pkg-a1']],
      ['uv tool install --with zz-fake-pkg-b2 zz-fake-pkg-a1', ['zz-fake-pkg-b2', 'zz-fake-pkg-a1']],
      ['npx -w zz-ws zz-fake-pkg-a1', ['zz-fake-pkg-a1']],
    ])('%j checks %j', (cmd, expected) => {
      expect(names(cmd)).toEqual(expected);
    });
    it('an unknown runner flag before the first word asks (it may take that word as its value)', async () => {
      gated(await runHook('npx --zz-unknown-flag zz-value zz-fake-pkg-a1', { stub: OLD }));
    });
    it('regression: npx -y with an old, clean package allows (a known bare flag does not ask)', async () => {
      expect(await runHook('npx -y zz-fake-pkg-a1', { stub: OLD })).toBeUndefined();
    });
    it.each(['npx -- zz-fake-pkg-a1', 'uvx -- zz-fake-pkg-a1'])('regression: the -- separator is not an unknown flag: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: OLD })).toBeUndefined();
    });
  });

  describe('repair: F13 more runner and installer verbs', () => {
    it.each([
      'npm create zz-fake-pkg-a1',
      'npm init zz-fake-pkg-a1',
      'yarn create zz-fake-pkg-a1',
      'pnpm create zz-fake-pkg-a1',
      'bun create zz-fake-pkg-a1',
      'uv run --with zz-fake-pkg-a1 python -c 1',
      'pipenv install zz-fake-pkg-a1',
      'go run github.com/zz-user/zz-repo@latest',
      'pip download zz-fake-pkg-a1',
      'pip wheel zz-fake-pkg-a1',
      'yarn up zz-fake-pkg-a1',
      'pnpm update zz-fake-pkg-a1 --latest',
      'deno install npm:zz-fake-pkg-a1',
    ])('gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });
    it.each([
      ['npm create zz-fake-pkg-a1', ['create-zz-fake-pkg-a1']],
      ['npm init @zz-scope', ['@zz-scope/create']],
      ['npm init @zz-scope/zz-fake-pkg-a1@1.0.0', ['@zz-scope/create-zz-fake-pkg-a1']],
      ['uv run --with zz-fake-pkg-a1 python -c 1', ['zz-fake-pkg-a1']],
    ])('%j checks %j (the package that runs, not the word typed)', (cmd, expected) => {
      expect(names(cmd)).toEqual(expected);
    });
    it.each([
      'npm init -y',
      'npm init',
      'go run main.go',
      'uv run pytest',
    ])('regression: %j names no remote package and allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBeUndefined();
    });
  });

  describe('repair: F12 sources the checks cannot read', () => {
    it.each([
      'npm install @zz-scope/zz-fake-pkg-a1@zz-user/zz-repo',
      'npm install @zz-scope/zz-fake-pkg-a1@../zz-dir',
      'pip install ./zz-fake-pkg-a1-1.0-py3-none-any.whl',
      'pip install //zz-fake-host.example/share/zz_fake-1.0-py3-none-any.whl',
      'curl -o zz.whl https://zz-fake-host.example/zz.whl && pip install zz.whl',
    ])('Bash: gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it('PowerShell: gates a pip install from a UNC share', async () => {
      gated(await runHook(String.raw`pip install \\zz-fake-host.example\share\zz_fake-1.0-py3-none-any.whl`, { tool: 'PowerShell', stub: OLD }));
    });
    it('regression: pip install . (the local project folder) allows', async () => {
      expect(await runHook('pip install .', { stub: OLD })).toBeUndefined();
    });
  });

  describe('repair: F15 a range or --tag ages the version that installs', () => {
    it.each([
      'npm install zz-fake-pkg-a1@^2.0.0-next.0',
      'npm install zz-fake-pkg-a1@>=2.0.0-0',
      'npx zz-fake-pkg-a1@^2.0.0-next.0',
      'npm install --tag next zz-fake-pkg-a1',
      'npm i zz-fake-pkg-a1 --tag=next',
    ])('denies %j when next is an hour old and latest is old', async (cmd) => {
      expect(await runHook(cmd, { stub: NEXT_FRESH })).toBe('deny');
    });
    it('publishDateFromRegistryJson: a pre-release range ages the newest version', () => {
      const doc = {
        'dist-tags': { latest: '1.0.0', next: '2.0.0-next.1' },
        time: { created: '2025-01-01T00:00:00.000Z', modified: '2026-11-03T11:00:00.000Z', '1.0.0': '2026-01-01T00:00:00.000Z', '2.0.0-next.1': '2026-11-03T10:00:00.000Z' },
      };
      expect(publishDateFromRegistryJson(doc, 'npm', '^2.0.0-next.0')?.toISOString()).toBe('2026-11-03T10:00:00.000Z');
    });
  });

  describe('repair: F10 PowerShell Start-Process launcher', () => {
    it.each([
      `Start-Process npm -ArgumentList "install","${URL_TGZ}"`,
      `Start-Process -FilePath npm -ArgumentList install,${URL_TGZ} -Wait`,
    ])('gates %j', async (cmd) => {
      gated(await runHook(cmd, { tool: 'PowerShell', stub: OLD }));
    });
  });

  // ----- False positives: a runner that runs a local bin fetches nothing -----
  // The fixture holds node_modules/.bin/<name> files with names no registry or real project has.
  // The stub says every package is an hour old, so a checked package is denied.
  describe('repair: npx, npm exec and bunx run a local node_modules/.bin file', () => {
    async function binFixture(bins: string[], sub = false): Promise<string> {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = mkdtempSync(join(tmpdir(), 'pig-localbin-'));
      const binDir = join(root, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      for (const b of bins) writeFileSync(join(binDir, b), '');
      if (!sub) return root;
      const child = join(root, 'zz-sub', 'zz-deeper');
      mkdirSync(child, { recursive: true });
      return child;
    }
    async function emptyDir(): Promise<string> {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      return mkdtempSync(join(tmpdir(), 'pig-nobin-'));
    }
    const BINS = ['zz-local-bin-a1', 'zz-local-bin-a1.cmd', 'zz-local-bin-a1.ps1', 'zz-local-bin-b2.cmd', 'zz-fake-pkg-a1'];

    it.each([
      'npx zz-local-bin-a1 run',
      'npx zz-local-bin-a1 run -t "package-install"',
      'npx -y zz-local-bin-a1',
      'npm exec zz-local-bin-a1',
      'npm x -- zz-local-bin-a1 run',
      'bunx zz-local-bin-a1',
      'bun x zz-local-bin-a1',
      'npx zz-local-bin-b2',
    ])('local bin present: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH, cwd: await binFixture(BINS) })).toBeUndefined();
    });
    it('local bin in an ancestor folder: npx zz-local-bin-a1 run allows', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: await binFixture(BINS, true) })).toBeUndefined();
    });
    it('bypass: bin only above the npm local prefix (child has package.json): npx still denies', async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const child = await binFixture(BINS, true);
      writeFileSync(join(child, 'package.json'), '{}');
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: child })).toBe('deny');
    });
    it.each([
      'npx -c "npm install zz-fake-pkg-a1"',
      'npx -c "npx zz-fake-pkg-a1"',
      'npm exec --call "npm install zz-fake-pkg-a1"',
      'npm exec --call="npm install zz-fake-pkg-a1"',
    ])('CodeRabbit #285: a command string in -c/--call is not hidden: %j asks or denies', async (cmd) => {
      expect(['ask', 'deny']).toContain(await runHook(cmd, { stub: FRESH, cwd: await emptyDir() }));
    });
    it('PowerShell: local bin present: npx zz-local-bin-a1 run allows', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { tool: 'PowerShell', stub: FRESH, cwd: await binFixture(BINS) })).toBeUndefined();
    });
    it('regression: local bin absent: npx zz-local-bin-a1 run still denies', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
    });
    it.each([
      'npx zz-local-bin-a1@1.0.0',
      'npx zz-local-bin-a1@latest',
      'npx --tag next zz-local-bin-a1',
      'npx -p zz-fake-pkg-a1 zz-local-bin-a1',
      'npx --package=zz-fake-pkg-a1 zz-local-bin-a1',
      'pnpm dlx zz-local-bin-a1',
      'pnpx zz-local-bin-a1',
      'yarn dlx zz-local-bin-a1',
      'uvx zz-local-bin-a1',
      'npx @zz-scope/zz-local-bin-a1',
    ])('regression: local bin present but %j still checks the package (fresh: denied)', async (cmd) => {
      expect(await runHook(cmd, { stub: { ageHours: 1, nextHours: 1 }, cwd: await binFixture(BINS) })).toBe('deny');
    });
  });

  // ----- False positives: the loose verb scan read a test filter as an install verb -----
  describe('repair: a non-install subcommand ends the loose verb scan', () => {
    it.each([
      'npm test -- -t install',
      'npm run test -- install',
      'pnpm test -- -t add',
      'npm start -- i',
      'yarn run test -- add',
    ])('%j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBeUndefined();
    });
    it.each([
      'npm --prefix x install zz-fake-pkg-a1',
      'npm "i" zz-fake-pkg-a1',
    ])('regression: %j still denies (fresh)', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBe('deny');
    });
    it.each([
      // A flag value named like a subcommand is not the subcommand: npm installs in workspace "test".
      'npm -w test install zz-fake-pkg-a1',
      // -- before any subcommand only ends the options: npm still runs install.
      'npm -w ws -- install zz-fake-pkg-a1',
      'npm -w ws install zz-fake-pkg-a1',
    ])('regression: %j still gates (fresh)', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH }));
    });
  });
});

// F15 blocklist exact-string half: a probe. The blocklist compares version and name as plain strings.
// These cases decide whether it reproduces: if a case fails, the form slips past the blocklist.
describe('F15 blocklist exact-string probe', () => {
  const blockedFor = (command: string, eco: 'npm' | 'pypi') => {
    const [pkg] = extractPackageNames(command);
    return checkMaliciousPackage(pkg.name, pkg.version, eco).blocked;
  };
  it('control: colors@1.4.1 is blocked', () => {
    expect(blockedFor('npm install colors@1.4.1', 'npm')).toBe(true);
  });
  it('control: litellm==1.82.7 is blocked', () => {
    expect(blockedFor('pip install litellm==1.82.7', 'pypi')).toBe(true);
  });
  it('npm: colors@=1.4.1 is blocked', () => {
    expect(blockedFor('npm install colors@=1.4.1', 'npm')).toBe(true);
  });
  it('npm: colors@v1.4.1 is blocked', () => {
    expect(blockedFor('npm install colors@v1.4.1', 'npm')).toBe(true);
  });
  it('npm: colors@1.4.1+build is blocked', () => {
    expect(blockedFor('npm install colors@1.4.1+build', 'npm')).toBe(true);
  });
  it('npm: a range that includes a blocked version (colors@^1.4.1) at least warns', () => {
    const [pkg] = extractPackageNames('npm install colors@^1.4.1');
    const r = checkMaliciousPackage(pkg.name, pkg.version, 'npm');
    expect(r.blocked || !!r.warning).toBe(true);
  });
  it('pypi: litellm==1.82.7.0 (PEP 440 equal to 1.82.7) is blocked', () => {
    expect(blockedFor('pip install litellm==1.82.7.0', 'pypi')).toBe(true);
  });
  it('pypi: litellm==01.82.7 (PEP 440 equal) is blocked', () => {
    expect(blockedFor('pip install litellm==01.82.7', 'pypi')).toBe(true);
  });
  it('pypi: litellm==v1.82.7 (PEP 440 equal) is blocked', () => {
    expect(blockedFor('pip install litellm==v1.82.7', 'pypi')).toBe(true);
  });
  it('pypi: the key jeIlyfish (capital I) blocks the same name', () => {
    expect(checkMaliciousPackage('jeIlyfish', undefined, 'pypi').blocked).toBe(true);
  });
  it('pypi: python3_dateutil (PyPI name normalisation of python3-dateutil) is blocked', () => {
    expect(checkMaliciousPackage('python3_dateutil', undefined, 'pypi').blocked).toBe(true);
  });
  it('pypi: Python3.Dateutil is blocked', () => {
    expect(checkMaliciousPackage('Python3.Dateutil', undefined, 'pypi').blocked).toBe(true);
  });
});
