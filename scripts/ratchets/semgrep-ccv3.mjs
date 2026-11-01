#!/usr/bin/env node
/**
 * semgrep-ccv3.mjs - run the repo's own Semgrep rules (scripts/ratchets/semgrep-ccv3/) and ratchet the result.
 *
 * One Docker scan with the pack only, on the pinned Semgrep image, then scan-ratchet.mjs against
 * semgrep-ccv3-baseline.json. A finding in a file the change did not touch is DRIFT: printed, not blocking.
 * It does not run p/default (that needs a registry fetch; the CI semgrep job runs it).
 *
 * Usage:
 *   node scripts/ratchets/semgrep-ccv3.mjs [--changed <file>] [--report <file>] [--root <dir>]
 *   node scripts/ratchets/semgrep-ccv3.mjs --update --reason "<why>"   (rewrite the baseline)
 * Env: SEMGREP_IMAGE (default: the digest CI pins), DOCKER_BIN.
 * The rule folder is always mounted at /rules, so the check ids (rules.<id>) match on every machine.
 *
 * Exit: 0 no new finding, 1 new finding or Docker is not running, 2 bad input or a scan that did not return JSON.
 * Node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InputError, run as runRatchet } from './scan-ratchet.mjs';

// Keep equal to SEMGREP_IMAGE in .github/workflows/ccv3-checks.yml (semgrep-ccv3.test.mjs SG2 checks it).
export const DEFAULT_IMAGE = 'semgrep/semgrep@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES_DIR = path.join(here, 'semgrep-ccv3');
export const BASELINE = path.join(here, 'semgrep-ccv3-baseline.json');
const DOCKER_WIN = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';

// The fixtures are wrong on purpose; the cache holds archived pre-fix trees; worktrees are other checkouts.
export const EXCLUDES = ['scripts/ratchets/semgrep-ccv3', '.claude/cache', '.claude/worktrees', 'node_modules'];

export const DOCKER_DOWN_MESSAGE = 'semgrep-ccv3: Docker is not running or not installed. Start Docker Desktop, then run this again.';
const DAEMON_DOWN = /daemon|docker_engine|dockerDesktopLinuxEngine|error during connect|connection refused|cannot connect|is the docker/i;

export function dockerArgs({ root, rulesDir = RULES_DIR, image }) {
  return [
    'run', '--rm',
    '-v', `${root}:/src`,
    '-v', `${rulesDir}:/rules:ro`,
    '-w', '/src',
    image,
    'semgrep', 'scan', '--config', '/rules', '--metrics=off', '--json', '--quiet', '--timeout', '30',
    ...EXCLUDES.flatMap((e) => ['--exclude', e]),
  ];
}

function parseArgs(argv) {
  const o = { update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') o.update = true;
    else if (['--changed', '--report', '--root', '--reason'].includes(a)) {
      if (i + 1 >= argv.length) throw new InputError(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new InputError(`unknown argument: ${a}`);
  }
  return o;
}

const realSpawn = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });

/** deps: { spawn(cmd, args) -> { status, stdout, stderr, error }, ratchet(argv, log) -> code, env, log, tmp() -> dir } */
export function main(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? realSpawn;
  const ratchet = deps.ratchet ?? runRatchet;
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    log(`semgrep-ccv3: ${e.message}`);
    return 2;
  }
  const root = path.resolve(o.root ?? path.join(here, '..', '..'));
  const docker = env.DOCKER_BIN ?? (existsSync(DOCKER_WIN) ? DOCKER_WIN : 'docker');
  const image = env.SEMGREP_IMAGE ?? DEFAULT_IMAGE;
  const r = spawn(docker, dockerArgs({ root, image }));
  if (r.error) {
    // No docker binary at all (ENOENT) or it could not start.
    log(DOCKER_DOWN_MESSAGE);
    return 1;
  }
  if (r.status !== 0 && DAEMON_DOWN.test(String(r.stderr))) {
    log(DOCKER_DOWN_MESSAGE);
    return 1;
  }
  if (r.status !== 0) {
    log(`semgrep-ccv3: the scan failed (exit ${r.status}): ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
    return 2;
  }
  let report;
  try {
    report = JSON.parse(String(r.stdout));
  } catch {
    log('semgrep-ccv3: the scan output is not JSON, so nothing was checked.');
    return 2;
  }
  const reportFile = o.report ?? path.join((deps.tmp ?? (() => mkdtempSync(path.join(tmpdir(), 'semgrep-ccv3-'))))(), 'report.json');
  writeFileSync(reportFile, JSON.stringify(report));
  const args = ['--tool', 'semgrep', '--report', reportFile, '--baseline', deps.baseline ?? BASELINE];
  if (o.changed) args.push('--changed', o.changed);
  if (o.update) args.push('--update', '--reason', o.reason ?? '');
  try {
    return ratchet(args, log);
  } catch (e) {
    log(`semgrep-ccv3: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
