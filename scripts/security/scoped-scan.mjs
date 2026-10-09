#!/usr/bin/env node
/**
 * scoped-scan.mjs - CCv3 defensive, scope-gated security scanner runner.
 *
 * This is the ONLY sanctioned path for dynamic security scans. It runs
 * defensive tools against targets you own. A network scan is denied unless the
 * target host is in project-registry.json or is loopback. The gate fails closed.
 *
 * It is the control HexStrike AI lacks: the harness decides the scope, not a
 * prompt. See docs/self-improvement/proposals/2026-10-09-hexstrike-ai.md.
 *
 * Commands:
 *   deps [dir]        Dependency CVE scan (npm audit, then osv-scanner). Local.
 *   secrets [dir]     Secret scan (gitleaks). Local.
 *   fs [dir]          Filesystem + IaC scan (trivy fs). Local.
 *   web <url>         DAST baseline (nuclei). SCOPE-GATED to owned targets.
 *   allowlist         Print the computed allowlist and exit.
 *
 * Exit codes: 0 ok / clean / tool-missing; 1 error or findings; 2 scope DENIED.
 *
 * It never installs a tool. A missing tool is reported and skipped.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const DENY = 2;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
// Default is the repo registry. SCOPED_SCAN_REGISTRY overrides the path (used by
// the probe to supply a fixture). The gate still fails closed if it is unreadable.
const REGISTRY = process.env.SCOPED_SCAN_REGISTRY || join(REPO_ROOT, '.claude', 'project-registry.json');

// --- allowlist ------------------------------------------------------------

/** Loopback hosts are always owned. `*.localhost` resolves to loopback. */
function isLoopback(host) {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Registry hosts you own. Fails closed: unreadable registry => loopback only. */
function registryHosts() {
  const hosts = new Set();
  let raw;
  try {
    raw = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  } catch {
    return hosts; // fail closed
  }
  const projects = Array.isArray(raw) ? raw : raw.projects || [];
  for (const p of projects) {
    if (!p || typeof p.url !== 'string') continue;
    try {
      hosts.add(new URL(p.url).hostname.toLowerCase());
    } catch {
      // url field is not a real URL (e.g. "stdio (...)"); skip it
    }
  }
  return hosts;
}

function isAllowed(host) {
  if (!host) return false;
  if (isLoopback(host)) return true;
  return registryHosts().has(host.toLowerCase());
}

// --- tools ----------------------------------------------------------------

/** Resolve an executable on PATH. Returns the path, or null if absent. */
function resolveExe(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return r.stdout.split(/\r?\n/)[0].trim();
  return null;
}

function run(exe, args, opts = {}) {
  console.log(`[scoped-scan] run: ${exe} ${args.join(' ')}`);
  // Node on Windows refuses to spawn a .cmd / .bat without a shell (EINVAL).
  // Quote the exe and args for the shell. Windows paths cannot contain '"', so
  // this is a safe quoting of controlled arguments.
  const useShell = /\.(cmd|bat)$/i.test(exe);
  let r;
  if (useShell) {
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    r = spawnSync([q(exe), ...args.map(q)].join(' '), { stdio: 'inherit', shell: true, cwd: opts.cwd });
  } else {
    r = spawnSync(exe, args, { stdio: 'inherit', cwd: opts.cwd });
  }
  if (r.error) {
    console.error(`[scoped-scan] failed to run ${exe}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function skipMissing(tool, hint) {
  console.log(`[scoped-scan] ${tool} not installed - skipped. Install it yourself (never auto). ${hint || ''}`.trim());
  return 0;
}

function resolveDir(argv) {
  const dir = argv[0] ? resolve(argv[0]) : process.cwd();
  if (!existsSync(dir)) {
    console.error(`[scoped-scan] directory not found: ${dir}`);
    process.exit(1);
  }
  return dir;
}

// --- commands -------------------------------------------------------------

function cmdDeps(argv) {
  const dir = resolveDir(argv);
  let worst = 0;
  if (existsSync(join(dir, 'package.json'))) {
    const npm = process.platform === 'win32' ? resolveExe('npm.cmd') || resolveExe('npm') : resolveExe('npm');
    if (npm) worst = Math.max(worst, run(npm, ['audit', '--audit-level=high'], { cwd: dir }));
    else skipMissing('npm');
  } else {
    console.log('[scoped-scan] no package.json; skipping npm audit.');
  }
  const osv = resolveExe('osv-scanner');
  if (osv) worst = Math.max(worst, run(osv, ['scan', '--recursive', dir]));
  else skipMissing('osv-scanner', 'https://github.com/google/osv-scanner');
  return worst;
}

function cmdSecrets(argv) {
  const dir = resolveDir(argv);
  const gitleaks = resolveExe('gitleaks');
  if (!gitleaks) return skipMissing('gitleaks', 'https://github.com/gitleaks/gitleaks');
  return run(gitleaks, ['detect', '--source', dir, '--no-banner', '--redact']);
}

function cmdFs(argv) {
  const dir = resolveDir(argv);
  const trivy = resolveExe('trivy');
  if (!trivy) return skipMissing('trivy', 'https://github.com/aquasecurity/trivy');
  return run(trivy, ['fs', '--scanners', 'vuln,misconfig,secret', dir]);
}

function cmdWeb(argv) {
  const target = argv[0];
  if (!target) {
    console.error('[scoped-scan] usage: web <url>');
    return 1;
  }
  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    console.error(`[scoped-scan] DENIED: "${target}" is not a valid URL.`);
    return DENY;
  }
  if (!isAllowed(host)) {
    console.error(
      `[scoped-scan] DENIED: ${host} is not a target you own.\n` +
      `  Allowed: loopback (localhost / *.localhost / 127.0.0.1) and hosts in ` +
      `.claude/project-registry.json.\n` +
      `  Add the project to the registry, or scan a target you own. ` +
      `Scanning a host you do not own may be illegal.`
    );
    return DENY;
  }
  console.log(`[scoped-scan] ALLOWED: ${host} is an owned target.`);
  const nuclei = resolveExe('nuclei');
  if (!nuclei) return skipMissing('nuclei', 'https://github.com/projectdiscovery/nuclei');
  return run(nuclei, ['-u', target, '-silent', '-severity', 'medium,high,critical']);
}

function cmdAllowlist() {
  const hosts = [...registryHosts()].sort();
  console.log('[scoped-scan] owned hosts (plus all loopback):');
  console.log('  loopback: localhost, *.localhost, 127.0.0.1, ::1');
  for (const h of hosts) console.log(`  registry: ${h}`);
  return 0;
}

// --- main -----------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const table = { deps: cmdDeps, secrets: cmdSecrets, fs: cmdFs, web: cmdWeb, allowlist: cmdAllowlist };
if (!cmd || !table[cmd]) {
  console.error('usage: scoped-scan.mjs <deps|secrets|fs|web|allowlist> [args]');
  process.exit(1);
}
process.exit(table[cmd](rest));
