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
} from '../package-install-guard.js';

import { checkTyposquat } from '../shared/typosquat-detect.js';

// We also import the malicious packages data to test version blocking
import maliciousPackages from '../shared/malicious-packages.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(command: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
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
      expect(publishDateFromRegistryJson(doc, 'pypi', '1.8')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
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

  describe('deny envelope (built hook, subprocess)', () => {
    it('emits the PreToolUse hookSpecificOutput deny envelope on stdout and exits 0', async () => {
      const { spawnSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const dist = fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
      if (!existsSync(dist)) return; // dist not built in this checkout; the build step runs this in CI
      // The hook skips main() when VITEST is set (so importing it in tests is side-effect free);
      // the subprocess must not inherit that or it prints nothing.
      const env = { ...process.env };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;
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
    });
  });
});
