#!/usr/bin/env node
/**
 * Resolve the machine profile.
 *
 * Precedence: --profile > CCV3_MACHINE_PROFILE > ~/.claude/state/machine-profile > none.
 * None keeps today's paths (home directory and this repo) and sets warn.
 * A named profile that is not on disk warns and falls back the same way.
 * The only profile file shipped is machine/personal.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = resolve(HERE, '..', '..');

export function readProfileName(home, env, argv) {
  const fromArg = flag(argv, '--profile');
  if (fromArg) return { name: fromArg, source: '--profile' };
  if (env.CCV3_MACHINE_PROFILE && env.CCV3_MACHINE_PROFILE.trim()) {
    return { name: env.CCV3_MACHINE_PROFILE.trim(), source: 'CCV3_MACHINE_PROFILE' };
  }
  const state = join(home, '.claude', 'state', 'machine-profile');
  if (existsSync(state)) {
    const name = readFileSync(state, 'utf8').trim();
    if (name) return { name, source: 'state' };
  }
  return { name: null, source: null };
}

export function defaultsFor(repoRoot, home) {
  const slash = (p) => p.replace(/\\/g, '/');
  return {
    userHome: slash(home),
    repoRoot: slash(repoRoot),
    claudeHome: slash(join(home, '.claude')),
    opcDir: slash(join(repoRoot, 'opc')),
    gitBash: 'C:/Program Files/Git/bin/bash.exe',
    powershellProfile: slash(join(home, 'OneDrive', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')),
    skipSkills: [],
    settingsOverlay: {},
    shellAliases: {},
    scheduledTasks: 'scripts/scheduled/tasks.json',
  };
}

export function resolveMachineProfile(opts = {}) {
  const repoRoot = resolve(opts.repoRoot || DEFAULT_REPO);
  const home = opts.home || homedir();
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv.slice(2);
  const picked = readProfileName(home, env, argv);
  const base = defaultsFor(repoRoot, home);
  if (!picked.name) {
    return {
      name: null,
      source: null,
      warn: 'no machine profile selected (--profile, CCV3_MACHINE_PROFILE, or ~/.claude/state/machine-profile); using home-directory defaults',
      profile: null,
      paths: base,
    };
  }
  const file = join(repoRoot, 'machine', `${picked.name}.json`);
  if (!existsSync(file)) {
    return {
      name: picked.name,
      source: picked.source,
      warn: `machine profile "${picked.name}" was selected via ${picked.source} but ${file} is missing; using home-directory defaults`,
      profile: null,
      paths: base,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`machine profile ${file} is unreadable or malformed: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`machine profile ${file} is unreadable or malformed: expected a JSON object`);
  }
  const paths = {
    ...base,
    userHome: slash(raw.userHome || base.userHome),
    repoRoot: slash(raw.repoRoot || base.repoRoot),
    claudeHome: slash(raw.claudeHome || base.claudeHome),
    opcDir: slash(raw.opcDir || base.opcDir),
    gitBash: raw.gitBash || base.gitBash,
    powershellProfile: raw.powershellProfile || base.powershellProfile,
    skipSkills: Array.isArray(raw.skipSkills) ? raw.skipSkills : [],
    settingsOverlay: raw.settingsOverlay && typeof raw.settingsOverlay === 'object' ? raw.settingsOverlay : {},
    shellAliases: raw.shellAliases && typeof raw.shellAliases === 'object' ? raw.shellAliases : {},
    scheduledTasks: raw.scheduledTasks || base.scheduledTasks,
  };
  return { name: picked.name, source: picked.source, warn: null, profile: raw, paths, file };
}

export function writeState(home, name) {
  const dir = join(home, '.claude', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'machine-profile'), name + '\n', 'utf8');
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1 || !argv[i + 1]) return null;
  return argv[i + 1];
}

function slash(p) {
  return String(p).replace(/\\/g, '/');
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function exportBat(resolved) {
  const p = resolved.paths;
  const lines = [
    `USER_HOME=${p.userHome}`,
    `REPO_ROOT=${p.repoRoot}`,
    `CLAUDE_HOME=${p.claudeHome}`,
    `OPC_DIR=${p.opcDir}`,
    `GIT_BASH=${p.gitBash}`,
    `POWERSHELL_PROFILE=${p.powershellProfile}`,
    `SKIP_SKILLS=${p.skipSkills.join(' ')}`,
    `PROFILE_NAME=${resolved.name || ''}`,
  ];
  if (resolved.warn) lines.push(`WARN=${resolved.warn}`);
  return lines.join('\n') + '\n';
}

function exportBash(resolved) {
  const p = resolved.paths;
  return [
    `GIT_BASH_PROFILE=${shQuote(resolved.profile ? p.gitBash : '')}`,
    `SKIP_SKILLS=${shQuote((p.skipSkills || []).join(' '))}`,
    `PROFILE_NAME=${shQuote(resolved.name || '')}`,
    `PROFILE_WARN=${shQuote(resolved.warn || '')}`,
    '',
  ].join('\n');
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const repoRoot = flag(argv, '--repo') || DEFAULT_REPO;
  const resolved = resolveMachineProfile({ repoRoot, argv });
  if (argv.includes('--write-state')) {
    if (!resolved.name || !resolved.profile) {
      process.stderr.write(`WARN: ${resolved.warn}\n`);
      process.exit(0);
    }
    writeState(homedir(), resolved.name);
  }
  const exportAs = flag(argv, '--export');
  if (exportAs === 'bat') {
    process.stdout.write(exportBat(resolved));
  } else if (exportAs === 'bash') {
    process.stdout.write(exportBash(resolved));
  } else if (flag(argv, '--print')) {
    const key = flag(argv, '--print');
    const value = key === 'warn' ? (resolved.warn || '') : (resolved.paths[key] ?? '');
    const shown = Array.isArray(value) ? value.join(' ') : String(value);
    process.stdout.write(shown + '\n');
  } else {
    process.stdout.write(JSON.stringify({
      name: resolved.name,
      source: resolved.source,
      warn: resolved.warn,
      file: resolved.file || null,
      paths: resolved.paths,
    }, null, 2) + '\n');
  }
  if (resolved.warn && !argv.includes('--quiet')) process.stderr.write(`WARN: ${resolved.warn}\n`);
}
