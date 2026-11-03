#!/usr/bin/env node
/**
 * Package Install Security Guard (PreToolUse: Bash, PowerShell, shell-running MCP tools)
 *
 * Intercepts package install commands and blocks dangerous installs.
 * Protects against supply-chain attacks like:
 * - Typosquatting (requets -> requests)
 * - Known malicious versions (litellm 1.82.7/1.82.8)
 * - Suspiciously new packages (<24h = block, <7d = warn)
 * - Unpinned pip installs (pip, uv pip, python -m pip): every package needs an exact == pin
 *
 * Every executed segment is checked, so `cd x; pip install y` and `Set-Location x; ...` are seen.
 *
 * Output contract: ALWAYS exit 0. A block is the PreToolUse
 * {hookSpecificOutput:{permissionDecision:'deny'}} envelope from shared/output.ts.
 * (Until 2026-09-01 this hook printed its own JSON shape and exited 2, which
 * Claude Code reports as "hook error: No stderr output" and drops the reason.)
 *
 * Override: prefix command with SKIP_PACKAGE_GUARD=1
 */

import { readFileSync } from 'fs';
import https from 'https';
import http from 'http';
import { outputContinue, outputDeny } from './shared/output.js';
import {
  parseExecutable, executableView, normalizeEscapes, wrapperPayloadsFromSegments,
} from './shared/destructive-classifier.js';
import { checkTyposquat } from './shared/typosquat-detect.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { readShellCommand } from './shared/shell-tools.js';
import maliciousPackages from './shared/malicious-packages.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    command?: string;
    description?: string;
  };
}

interface PackageInfo {
  name: string;
  version: string | undefined;
}

type Ecosystem = 'pypi' | 'npm' | 'cargo' | 'go' | 'gem' | 'composer' | null;

interface MaliciousCheckResult {
  blocked: boolean;
  reason?: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Install command patterns
//
// Each entry: regex for the command prefix, ecosystem, and whether pip pins apply.
// Package arguments are the tokens after the matched prefix.
//
// For npm/yarn/pnpm/bun install: bare "install" (no package arg) is NOT
// a targeted install. We require at least one package-looking argument.
// ---------------------------------------------------------------------------

// An optional folder before a launcher: .venv\Scripts\pip.exe, "C:\Program Files\Python312\python.exe".
const DIR = String.raw`(?:&\s*)?(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?`;

interface InstallPattern {
  regex: RegExp;
  ecosystem: Exclude<Ecosystem, null>;
  /** pip forms: every package needs an exact == pin. Lockfile tools (uv add, poetry add) do not. */
  requirePin?: boolean;
}

// pip global options before `install` (-q, --disable-pip-version-check, --proxy URL).
const PIP_OPTS = String.raw`(?:\s+(?:--(?:proxy|log|cache-dir|timeout|retries|cert|client-cert|exists-action|trusted-host|python|use-feature|keyring-provider)\s+\S+|-[-\w]+(?:=\S+)?))*`;
// Interpreter flags before `-m` (-I, -u, -X utf8, -W ignore) and the py launcher version (-3.12).
const PY_OPTS = String.raw`(?:\s+(?:-[XW]\s*\S+|-[IuBEsSOqbdv]+|-\d(?:\.\d+)?))*`;

const INSTALL_PATTERNS: InstallPattern[] = [
  // Python (Windows runs Python.exe and PIP the same as python and pip, so these ignore case)
  { regex: new RegExp(String.raw`^${DIR}pip(?:3(?:\.\d+)?)?(?:\.exe)?["']?${PIP_OPTS}\s+install\b`, 'i'), ecosystem: 'pypi', requirePin: true },
  { regex: new RegExp(String.raw`^${DIR}(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?["']?${PY_OPTS}\s+-m\s+pip${PIP_OPTS}\s+install\b`, 'i'), ecosystem: 'pypi', requirePin: true },
  { regex: /^uv\s+pip\s+install\b/, ecosystem: 'pypi', requirePin: true },
  { regex: /^uv\s+add\b/, ecosystem: 'pypi' },
  { regex: /^poetry\s+add\b/, ecosystem: 'pypi' },

  // JavaScript / Node
  { regex: /^npm\s+install\b/, ecosystem: 'npm' },
  { regex: /^npm\s+i\b/, ecosystem: 'npm' },
  { regex: /^yarn\s+add\b/, ecosystem: 'npm' },
  { regex: /^pnpm\s+(add|install)\b/, ecosystem: 'npm' },
  { regex: /^bun\s+(add|install)\b/, ecosystem: 'npm' },

  // Rust
  { regex: /^cargo\s+(add|install)\b/, ecosystem: 'cargo' },

  // Go
  { regex: /^go\s+get\b/, ecosystem: 'go' },

  // Ruby
  { regex: /^gem\s+install\b/, ecosystem: 'gem' },

  // PHP
  { regex: /^composer\s+require\b/, ecosystem: 'composer' },
];

/** An exact pip pin: name==1.2.3 or name===1.2.3, extras allowed, no wildcard or second clause. */
const EXACT_PIN = /^[A-Za-z0-9_.-]+(?:\[[^\]]*\])?===?[^=<>~!*,;\s]+$/;

// Flags that take a value argument (the next token is NOT a package name)
const FLAGS_WITH_VALUE = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable',
  '-t', '--target', '-f', '--find-links', '-i', '--index-url',
  '--extra-index-url', '--prefix', '--root', '--src',
  // pip and uv pip (a value here is not a package; the pin check would deny it)
  '--trusted-host', '--python', '-p', '--python-version', '--platform', '--abi', '--implementation',
  '--timeout', '--retries', '--proxy', '--cert', '--client-cert', '--cache-dir', '--log',
  '--upgrade-strategy', '--progress-bar', '--exists-action', '--report', '-C', '--config-settings',
  '--index', '--default-index', '--index-strategy', '--resolution', '--prerelease',
  '--keyring-provider', '--root-user-action',
  // npm/yarn
  '--registry',
]);

// Flags that are standalone (no value follows)
const STANDALONE_FLAGS = /^-/;

// ---------------------------------------------------------------------------
// Exported detection functions
// ---------------------------------------------------------------------------

/**
 * Determine if a command is a package install command with named packages.
 * Returns false for bare installs (npm install, yarn install) and
 * requirements-file installs (pip install -r requirements.txt).
 */
export function isPackageInstallCommand(command: string): boolean {
  return extractPackageNames(command).length > 0;
}

/**
 * Identify the package ecosystem from a command string.
 */
export function parseEcosystem(command: string): Ecosystem {
  return matchInstall(command)?.pattern.ecosystem ?? null;
}

/**
 * Extract package names (and optional versions) from an install command.
 */
export function extractPackageNames(command: string): PackageInfo[] {
  const install = matchInstall(command);
  if (!install) return [];
  const { ecosystem } = install.pattern;
  return packageTokens(install.args)
    .map((token) => parsePackageToken(token, ecosystem))
    .filter((p): p is PackageInfo => p !== null);
}

/**
 * The pip packages in an install command that lack an exact == pin. Empty for every other
 * installer: uv add and poetry add write a lockfile, npm is out of scope.
 */
export function unpinnedPipPackages(command: string): string[] {
  const install = matchInstall(command);
  if (!install?.pattern.requirePin) return [];
  return packageTokens(install.args)
    .filter((token) => parsePackageToken(token, 'pypi') !== null && !EXACT_PIN.test(pipSpec(token)))
    .map((token) => parsePackageToken(token, 'pypi')!.name);
}

/** A pip requirement without its PEP 508 marker and spaces: "requests >= 2; python_version>'3'" -> requests>=2. */
function pipSpec(token: string): string {
  return token.split(';')[0].replace(/\s+/g, '');
}

/** Drop what runs a command without being it: sudo, time, nohup, a brace or parenthesis. */
function stripLeaders(segment: string): string {
  return segment.trim().replace(/^(?:(?:sudo|time|nohup|command)\s+|[{(]\s*)+/, '').replace(/\s*[})]\s*$/, '');
}

/**
 * The executed segments of a Bash or PowerShell command that install packages. Text blocks that
 * only write text (a literal heredoc, a PowerShell here-string) are dropped and escapes resolved
 * first, as the destructive guard does. Also splits $(...) and shell-wrapper payloads
 * (bash -c "...", powershell -Command "..."). Fails open to the whole command on a parser error.
 */
export function installSegments(command: string, tool = 'Bash', depth = 0): string[] {
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(executableView(command, tool), tool));
    const found = segments.map(stripLeaders).filter(isPackageInstallCommand);
    if (depth >= 3) return found;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...found, ...nested.flatMap((inner) => installSegments(inner, tool, depth + 1))];
  } catch {
    return isPackageInstallCommand(command) ? [command.trim()] : [];
  }
}

/** The first install pattern a command matches, and the text after the matched prefix. */
function matchInstall(command: string): { pattern: InstallPattern; args: string } | null {
  const trimmed = stripEnvPrefix(command).trim();
  for (const pattern of INSTALL_PATTERNS) {
    const m = trimmed.match(pattern.regex);
    if (m) return { pattern, args: trimmed.slice(m[0].length) };
  }
  return null;
}

/** The argument tokens that are not flags or flag values. */
function packageTokens(args: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const token of tokenize(args)) {
    if (skipNext) { skipNext = false; continue; }
    // A flag that consumes the next token (-r file, --index-url url)
    if (FLAGS_WITH_VALUE.has(token)) { skipNext = true; continue; }
    // Standalone flags (--save-dev, --global, -U, etc.)
    if (STANDALONE_FLAGS.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Check if the command has the SKIP_PACKAGE_GUARD=1 override.
 */
export function checkOverride(command: string): boolean {
  return /\bSKIP_PACKAGE_GUARD=1\b/.test(command);
}

/**
 * Check if a package+version is in the malicious packages blocklist.
 */
export function checkMaliciousPackage(
  name: string,
  version: string | undefined,
  ecosystem: Exclude<Ecosystem, null>
): MaliciousCheckResult {
  const ecosystemKey = ecosystem === 'pypi' ? 'pypi' : 'npm';

  // Only pypi and npm have blocklist entries currently
  if (ecosystemKey !== 'pypi' && ecosystemKey !== 'npm') {
    return { blocked: false };
  }

  const registry = (maliciousPackages as Record<string, Record<string, any>>)[ecosystemKey];
  if (!registry) return { blocked: false };

  const entry = registry[name.toLowerCase()];
  if (!entry) return { blocked: false };

  // blocked_all = true means ALL versions are blocked
  if (entry.blocked_all === true) {
    return {
      blocked: true,
      reason: entry.reason || `Package "${name}" is entirely blocked`,
    };
  }

  // Check specific version blocks
  if (entry.blocked_versions && Array.isArray(entry.blocked_versions)) {
    if (version && entry.blocked_versions.includes(version)) {
      return {
        blocked: true,
        reason: entry.reason || `Version ${version} of "${name}" is known malicious`,
      };
    }

    // No version specified but package has known-bad versions -> warn
    if (!version && entry.blocked_versions.length > 0) {
      return {
        blocked: false,
        warning: `Package "${name}" has known malicious versions: ${entry.blocked_versions.join(', ')}. Ensure you are installing a safe version.`,
      };
    }
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// OSV.dev real-time vulnerability check
// ---------------------------------------------------------------------------

interface OsvResult {
  blocked: boolean;
  warning?: string;
  advisoryId?: string;
}

export async function checkOsvAdvisory(
  name: string,
  version: string | undefined,
  ecosystem: Exclude<Ecosystem, null>
): Promise<OsvResult> {
  // Only check pypi and npm
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') {
    return { blocked: false };
  }

  const osvEcosystem = ecosystem === 'pypi' ? 'PyPI' : 'npm';

  try {
    const vulns = await queryOsv(name, version, osvEcosystem);

    // Check for MAL- prefixed IDs (confirmed malware from OSSF)
    const malware = vulns.find((v: any) => v.id?.startsWith('MAL-'));
    if (malware) {
      return {
        blocked: true,
        advisoryId: malware.id,
        warning: `OSV.dev reports malware: ${malware.id}. ${malware.summary || malware.details?.slice(0, 200) || 'No details available'}.`,
      };
    }

    // Check for CRITICAL severity CVEs
    const critical = vulns.find((v: any) => {
      const severity = v.database_specific?.severity ||
        v.severity?.find((s: any) => s.type === 'CVSS_V3')?.score;
      if (typeof severity === 'string') return severity === 'CRITICAL';
      if (typeof severity === 'number') return severity >= 9.0;
      return false;
    });
    if (critical) {
      return {
        blocked: true,
        advisoryId: critical.id,
        warning: `OSV.dev reports CRITICAL vulnerability: ${critical.id}. ${critical.summary || 'No summary'}.`,
      };
    }

    // Check for HIGH severity -- warn but allow
    const high = vulns.find((v: any) => {
      const severity = v.database_specific?.severity ||
        v.severity?.find((s: any) => s.type === 'CVSS_V3')?.score;
      if (typeof severity === 'string') return severity === 'HIGH';
      if (typeof severity === 'number') return severity >= 7.0 && severity < 9.0;
      return false;
    });
    if (high) {
      return {
        blocked: false,
        advisoryId: high.id,
        warning: `OSV.dev reports HIGH severity vulnerability: ${high.id}. ${high.summary || 'No summary'}.`,
      };
    }

    return { blocked: false };
  } catch {
    // Fail-open on network/API errors
    return { blocked: false };
  }
}

function queryOsv(
  name: string,
  version: string | undefined,
  ecosystem: string
): Promise<any[]> {
  return new Promise((resolve) => {
    const body: any = {
      package: { name, ecosystem },
    };
    if (version) {
      body.version = version;
    }

    const postData = JSON.stringify(body);
    const timer = setTimeout(() => resolve([]), 5000);

    const req = https.request(
      {
        hostname: 'api.osv.dev',
        path: '/v1/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            resolve(json.vulns || []);
          } catch {
            resolve([]);
          }
        });
      }
    );

    req.on('error', () => { clearTimeout(timer); resolve([]); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve([]); });
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Registry age check (PyPI / npm)
// ---------------------------------------------------------------------------

interface AgeCheckResult {
  ageHours: number | null;
  blocked: boolean;
  warning?: string;
  error?: string;
}

export async function checkPackageAge(
  name: string,
  ecosystem: Exclude<Ecosystem, null>,
  requestedVersion?: string
): Promise<AgeCheckResult> {
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') {
    return { ageHours: null, blocked: false };
  }

  try {
    const publishDate = await fetchPublishDate(name, ecosystem, requestedVersion);
    if (!publishDate) {
      return { ageHours: null, blocked: false };
    }

    const ageMs = Date.now() - publishDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < 24) {
      return {
        ageHours,
        blocked: true,
        warning: `Package "${name}" was published less than 24 hours ago (${Math.round(ageHours)}h). This is suspicious for supply-chain attacks.`,
      };
    }

    if (ageHours < 168) { // 7 days
      const ageDays = Math.round(ageHours / 24);
      return {
        ageHours,
        blocked: false,
        warning: `Package "${name}" was published ${ageDays} day(s) ago. Proceed with caution.`,
      };
    }

    return { ageHours, blocked: false };
  } catch {
    // Fail-open for network issues
    return { ageHours: null, blocked: false, error: 'Registry check failed (network)' };
  }
}

/**
 * Pick the publish date to age-check from a registry document.
 *
 * If the command pinned an EXACT version that the registry knows, use that
 * version's date -- that is what will be installed. Otherwise (no version, or
 * a range like ^1.2.0 / >=1.0) fall back to the latest release, which is the
 * conservative choice because a range usually resolves to it.
 *
 * Before 2026-09-01 this always used latest, so `@types/node@24.13.3`
 * (8 weeks old) was blocked because 25.x had shipped an hour earlier.
 */
export function publishDateFromRegistryJson(
  json: unknown,
  ecosystem: 'pypi' | 'npm',
  requestedVersion?: string
): Date | null {
  const doc = json as Record<string, any> | null;
  if (!doc) return null;

  if (ecosystem === 'pypi') {
    // PEP 440 public versions, which npm's semver pattern rejects: 1.9.0rc1, 2.0, 1.0.post1,
    // 3.1.dev4. A rejected pin fell back to info.version, so a brand-new pre-release could be
    // aged by an older stable release's date and pass.
    const exact = requestedVersion && /^v?\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/i.test(requestedVersion)
      ? requestedVersion.replace(/^v/, '')
      : undefined;
    // PEP 440 treats trailing zero release segments as equal (1.8 == 1.8.0), but PyPI keys the
    // release dict by the published string. Match on the normalized form so a shortened pin
    // does not fall back to info.version and age-check the wrong release.
    const norm = (v: string) => v.toLowerCase().replace(/^v/, '').replace(/^(\d+(?:\.\d+)*)/, (rel) => rel.replace(/(\.0+)+$/, ''));
    const releaseKey = exact
      ? (doc.releases?.[exact] ? exact : Object.keys(doc.releases ?? {}).find((k) => norm(k) === norm(exact)))
      : undefined;
    const version = releaseKey ?? doc.info?.version;
    // A release is several files uploaded separately, and pip may pick a wheel added long after
    // the sdist. Age-check the NEWEST upload, or a fresh wheel on an old release passes.
    let newest: Date | null = null;
    for (const file of doc.releases?.[version] ?? []) {
      const d = file?.upload_time_iso_8601 ? new Date(file.upload_time_iso_8601) : null;
      if (d && !Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d;
    }
    return newest;
  }

  const exact = requestedVersion && /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(requestedVersion)
    ? requestedVersion.replace(/^v/, '')
    : undefined;
  const version = exact && doc.time?.[exact] ? exact : doc['dist-tags']?.latest;
  const timeEntry = doc.time?.[version];
  return timeEntry ? new Date(timeEntry) : null;
}

function fetchPublishDate(
  name: string,
  ecosystem: 'pypi' | 'npm',
  requestedVersion?: string
): Promise<Date | null> {
  return new Promise((resolve) => {
    const url = ecosystem === 'pypi'
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      : `https://registry.npmjs.org/${encodeURIComponent(name)}`;

    const timer = setTimeout(() => {
      resolve(null);
    }, 5000);

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(publishDateFromRegistryJson(JSON.parse(data), ecosystem, requestedVersion));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip env var prefixes like "FOO=bar BAZ=1 " from a command. */
function stripEnvPrefix(command: string): string {
  return command.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, '');
}

/** Simple tokenizer that respects quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse a single token into a PackageInfo.
 * Handles npm-style @scope/name@version and pip-style name==version.
 */
function parsePackageToken(
  token: string,
  ecosystem: Exclude<Ecosystem, null>
): PackageInfo | null {
  // Skip tokens that look like file paths or URLs
  if (token.includes('/') && !token.startsWith('@') && ecosystem !== 'go' && ecosystem !== 'composer') {
    return null;
  }

  if (ecosystem === 'pypi') {
    // A local folder or archive (., .\pkg, dist\x.whl) is not a registry package.
    if (/^\.|\\|\.(?:whl|zip|tgz|tar\.gz)$/i.test(token)) return null;
    // pip: name==version, name>=version, name~=version, name[extras]==version
    const match = pipSpec(token).match(/^([a-zA-Z0-9_.-]+)(?:\[.*?\])?(?:[=<>~!]+(.+))?$/);
    if (match) {
      return { name: match[1], version: match[2] || undefined };
    }
  } else if (ecosystem === 'npm') {
    // npm: @scope/name@version or name@version
    if (token.startsWith('@')) {
      // Scoped package: @scope/name or @scope/name@version
      const lastAt = token.lastIndexOf('@');
      if (lastAt > 0) {
        // Could be @scope/name@version
        const name = token.slice(0, lastAt);
        const version = token.slice(lastAt + 1);
        if (name.includes('/')) {
          return { name, version: version || undefined };
        }
      }
      // @scope/name without version
      return { name: token, version: undefined };
    } else {
      // Unscoped: name or name@version
      const atIdx = token.indexOf('@');
      if (atIdx > 0) {
        return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) || undefined };
      }
      return { name: token, version: undefined };
    }
  } else if (ecosystem === 'go') {
    // go get: github.com/user/repo@version
    const atIdx = token.indexOf('@');
    if (atIdx > 0) {
      return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) };
    }
    return { name: token, version: undefined };
  } else if (ecosystem === 'composer') {
    // composer: vendor/package:version or vendor/package
    const colonIdx = token.indexOf(':');
    if (colonIdx > 0) {
      return { name: token.slice(0, colonIdx), version: token.slice(colonIdx + 1) };
    }
    return { name: token, version: undefined };
  } else {
    // cargo, gem, etc.
    return { name: token, version: undefined };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function outputAllowWithAdvisory(advisory: string): void {
  const output = {
    hookSpecificOutput: {
      additionalContext: advisory,
    },
  };
  console.log(JSON.stringify(output));
}

function outputAllowOk(): void {
  outputContinue();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

const OVERRIDE = 'To override: prefix command with SKIP_PACKAGE_GUARD=1';

/**
 * Run every check on one install segment. The local checks (typosquat, blocklist, pin) run
 * before the network checks (OSV, package age), so a deny on them costs no request.
 */
async function checkInstall(segment: string): Promise<{ deny?: string; advisories: string[] }> {
  const ecosystem = parseEcosystem(segment);
  const advisories: string[] = [];
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') return { advisories };
  const packages = extractPackageNames(segment);

  for (const pkg of packages) {
    const typo = checkTyposquat(pkg.name, ecosystem);
    if (typo.isTyposquat) {
      return { advisories, deny: `PACKAGE SECURITY: Suspected typosquat. "${pkg.name}" looks like "${typo.similarTo}". ${typo.reason}. Package: ${pkg.name}. ${OVERRIDE}` };
    }
    const malCheck = checkMaliciousPackage(pkg.name, pkg.version, ecosystem);
    if (malCheck.blocked) {
      return { advisories, deny: `PACKAGE SECURITY: Known malicious package/version. ${malCheck.reason}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. ${OVERRIDE}` };
    }
    if (malCheck.warning) advisories.push(malCheck.warning);
  }

  const unpinned = unpinnedPipPackages(segment);
  if (unpinned.length > 0) {
    return { advisories, deny: `PACKAGE SECURITY: Unpinned pip install. Every pip install needs an exact == pin. Unpinned: ${unpinned.join(', ')}. Pin each one, for example ${unpinned[0]}==<version>, with a version at least 7 days old on PyPI.` };
  }

  for (const pkg of packages) {
    const osvResult = await checkOsvAdvisory(pkg.name, pkg.version, ecosystem);
    if (osvResult.blocked) {
      return { advisories, deny: `PACKAGE SECURITY: ${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. ${OVERRIDE}` };
    }
    if (osvResult.warning) advisories.push(`OSV ADVISORY: ${osvResult.warning}`);

    const ageResult = await checkPackageAge(pkg.name, ecosystem, pkg.version);
    if (ageResult.blocked) {
      return { advisories, deny: `PACKAGE SECURITY: ${ageResult.warning} Package: ${pkg.name}. ${OVERRIDE}` };
    }
    if (ageResult.warning) advisories.push(`PACKAGE ADVISORY: ${ageResult.warning}`);
  }
  return { advisories };
}

async function main() {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readStdin());
  } catch (err) {
    logGuardError('package-install-guard', err);
    outputContinue();
    return;
  }

  // Bash, PowerShell and the shell-running MCP tools (F07) all run installs. The list lives in
  // shared/shell-tools.ts. The settings.json matchers must name the same tools (two gates).
  const shell = readShellCommand(input);
  if (shell.kind === 'not-shell') {
    outputContinue();
    return;
  }
  if (shell.kind === 'unreadable') {
    // Fail closed: this guard has no ask, so an unreadable shell command is denied.
    const reason = `PACKAGE SECURITY: Unreadable command text. ${shell.tool} has no string field "${shell.field}", so the install check cannot run.`;
    logGuardDecision('package-install-guard', input, 'deny', 'unreadable command text', { command: shell.tool });
    outputDeny(reason);
    return;
  }

  const command = shell.text;
  if (!command) {
    outputContinue();
    return;
  }

  // Fast path: no segment installs a package -> passthrough immediately.
  // A desktop-commander shell is chosen at run time, so its text is read as Bash and PowerShell.
  const installs = [...new Set(shell.dialects.flatMap((dialect) => installSegments(command, dialect)))];
  if (installs.length > 0 && checkOverride(command)) {
    logGuardDecision('package-install-guard', input, 'override', 'SKIP_PACKAGE_GUARD', { command });
  }
  if (installs.length === 0 || checkOverride(command)) {
    outputContinue();
    return;
  }

  const advisories: string[] = [];
  for (const segment of installs) {
    const result = await checkInstall(segment);
    if (result.deny) {
      logGuardDecision('package-install-guard', input, 'deny', result.deny.replace(/^PACKAGE SECURITY:\s*/, '').split(/\.\s/)[0], { command });
      outputDeny(result.deny);
      return;
    }
    advisories.push(...result.advisories);
  }

  // All checks passed
  if (advisories.length > 0) {
    outputAllowWithAdvisory(advisories.join('\n'));
  } else {
    outputAllowOk();
  }
}

// Only run main() when executed as a standalone script, not when imported
// by vitest or other test runners. Vitest sets VITEST=true and
// VITEST_WORKER_ID in the environment.
if (!process.env.VITEST) {
  main().catch((err) => {
    // Fail-open: if the hook itself crashes, allow the command. Log the crash first.
    logGuardError('package-install-guard', err);
    outputContinue();
  });
}
