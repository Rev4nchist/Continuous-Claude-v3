#!/usr/bin/env node
/**
 * scoped-scan.mjs - CCv3 defensive, scope-gated security scanner runner.
 *
 * The only sanctioned path for dynamic security scans. It runs defensive tools
 * against targets you own. A network scan is denied unless the target host is
 * loopback or in the project registry. The gate fails closed.
 *
 * Installed at ~/.claude/scripts/security/ by the forward sync, so it works
 * from any project. The local commands scan the current directory.
 *
 * Commands:
 *   deps [dir]        Dependency CVE scan (npm audit, osv-scanner).
 *   secrets [dir]     Secret scan (gitleaks).
 *   fs [dir]          Filesystem + IaC scan (trivy fs).
 *   web <url>         DAST baseline (nuclei). SCOPE-GATED to owned targets.
 *   check <url>       Print the gate decision only. Never scans.
 *   allowlist         Print the owned hosts.
 *
 * Exit codes: 0 ok / clean / tool-missing / allowed; 1 error or findings;
 * 2 scope DENIED.
 *
 * It never installs a tool. A missing tool is reported and skipped.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { decide, loadRegistryHosts } from './scope-gate.mjs';

const DENY = 2;
const __dirname = dirname(fileURLToPath(import.meta.url));
// <claude dir>/scripts/security -> <claude dir>. Repo: .claude. Active: ~/.claude.
const CLAUDE_DIR = resolve(__dirname, '..', '..');
const REGISTRY = join(CLAUDE_DIR, 'project-registry.json');

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
  // Quote the exe and args for the shell. Windows paths cannot contain '"'.
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

/** Gate a target. Prints the decision. Returns true only when allowed. */
function gate(target) {
  const d = decide(target, loadRegistryHosts(REGISTRY));
  if (d.allowed) {
    console.log(`[scoped-scan] ALLOWED: ${d.host} (${d.reason}).`);
    return true;
  }
  console.error(
    `[scoped-scan] DENIED: ${d.reason}.\n` +
    `  Allowed: loopback (localhost / *.localhost / 127.0.0.1) and hosts in ${REGISTRY}.\n` +
    `  Add the project to the registry, or scan a target you own. ` +
    `Scanning a host you do not own may be illegal.`
  );
  return false;
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
  if (!gate(target)) return DENY;
  const nuclei = resolveExe('nuclei');
  if (!nuclei) return skipMissing('nuclei', 'https://github.com/projectdiscovery/nuclei');
  return run(nuclei, ['-u', target, '-silent', '-severity', 'medium,high,critical']);
}

function cmdCheck(argv) {
  if (!argv[0]) {
    console.error('[scoped-scan] usage: check <url>');
    return 1;
  }
  return gate(argv[0]) ? 0 : DENY;
}

function cmdAllowlist() {
  const hosts = [...loadRegistryHosts(REGISTRY)].sort();
  console.log(`[scoped-scan] owned hosts (registry: ${REGISTRY}):`);
  console.log('  loopback: localhost, *.localhost, 127.0.0.1, ::1');
  for (const h of hosts) console.log(`  registry: ${h}`);
  return 0;
}

// --- main -----------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const table = { deps: cmdDeps, secrets: cmdSecrets, fs: cmdFs, web: cmdWeb, check: cmdCheck, allowlist: cmdAllowlist };
if (!cmd || !table[cmd]) {
  console.error('usage: scoped-scan.mjs <deps|secrets|fs|web|check|allowlist> [args]');
  process.exit(1);
}
process.exit(table[cmd](rest));
