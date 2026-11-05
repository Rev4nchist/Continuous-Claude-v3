#!/usr/bin/env node
/**
 * Render .claude/settings.json.template.
 *
 * Substitutes {{CLAUDE_HOME}} {{OPC_DIR}} {{REPO_ROOT}} {{USER_HOME}},
 * then deep-merges the selected profile's settingsOverlay.
 * --check diffs (event, hook, matcher) against ~/.claude/settings.json (or --settings <file>)
 * and lists overlay entries on their own. A comparison of zero hooks fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMachineProfile } from './machine-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, '..', '..');
const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

export function substitute(text, vars) {
  const missing = new Set();
  const out = text.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      missing.add(name);
      return whole;
    }
    return String(vars[name]).replace(/\\/g, '/');
  });
  if (missing.size) {
    throw new Error(`Unresolved template variables in settings.json: ${[...missing].join(', ')}`);
  }
  return out;
}

export function mergeOverlay(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeOverlay(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function hookScript(hook) {
  const line = [hook?.command, ...(hook?.args || [])].filter(Boolean).join(' ');
  const match = line.match(/([A-Za-z0-9._-]+)\.mjs/);
  return match ? match[1] : null;
}

export function registrations(settings) {
  const rows = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = group?.matcher || '';
      for (const hook of group?.hooks || []) {
        const name = hookScript(hook);
        if (!name) continue;
        rows.push({ event, matcher, hook: name });
      }
    }
  }
  return rows;
}

export function registrationKey(row) {
  return `${row.event}\t${row.matcher}\t${row.hook}`;
}

export function renderSettings({ templateText, vars, overlay }) {
  const substituted = substitute(templateText, vars);
  const parsed = JSON.parse(substituted);
  return mergeOverlay(parsed, overlay || {});
}

export function varsFromPaths(paths) {
  return {
    CLAUDE_HOME: paths.claudeHome,
    OPC_DIR: paths.opcDir,
    REPO_ROOT: paths.repoRoot,
    USER_HOME: paths.userHome,
  };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1 || argv[i + 1] == null) return null;
  return argv[i + 1];
}

function varsFromArgv(argv, paths) {
  const vars = varsFromPaths(paths);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--var' && argv[i + 1]) {
      const eq = argv[i + 1].indexOf('=');
      if (eq === -1) throw new Error(`--var expects KEY=VALUE, got ${argv[i + 1]}`);
      vars[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
    }
  }
  return vars;
}

function diffKeys(left, right) {
  const a = new Set(left.map(registrationKey));
  const b = new Set(right.map(registrationKey));
  return {
    onlyLeft: [...a].filter((k) => !b.has(k)),
    onlyRight: [...b].filter((k) => !a.has(k)),
  };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const repoRoot = flag(argv, '--repo') || DEFAULT_REPO;
  const resolved = resolveMachineProfile({ repoRoot, argv });
  if (resolved.warn) process.stderr.write(`WARN: ${resolved.warn}\n`);
  const templatePath = flag(argv, '--template') || join(repoRoot, '.claude', 'settings.json.template');
  if (!existsSync(templatePath)) {
    process.stderr.write(`Template not found: ${templatePath}\n`);
    process.exit(1);
  }
  const templateText = readFileSync(templatePath, 'utf8');
  const vars = varsFromArgv(argv, resolved.paths);
  let rendered;
  try {
    rendered = renderSettings({
      templateText,
      vars,
      overlay: resolved.paths.settingsOverlay,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const templateOnly = renderSettings({ templateText, vars, overlay: {} });

  if (argv.includes('--check')) {
    // --settings <file> checks a file other than the live one (apply-registrations tests and its temp-home proof).
    const livePath = flag(argv, '--settings') || join(homedir(), '.claude', 'settings.json');
    const renderedRows = registrations(rendered);
    const templateRows = registrations(templateOnly);
    const overlay = diffKeys(renderedRows, templateRows);
    process.stdout.write(`hooks compared: ${renderedRows.length}\n`);
    process.stdout.write(`overlay entries: ${overlay.onlyLeft.length}\n`);
    for (const line of overlay.onlyLeft) process.stdout.write(`  overlay ${line}\n`);
    if (renderedRows.length === 0) {
      process.stdout.write('RESULT: FAIL - compared 0 hooks\n');
      process.exit(1);
    }
    if (!existsSync(livePath)) {
      process.stdout.write(`RESULT: FAIL - no live settings at ${livePath}\n`);
      process.exit(1);
    }
    const live = JSON.parse(readFileSync(livePath, 'utf8'));
    const drift = diffKeys(renderedRows, registrations(live));
    process.stdout.write(`drift only-in-render: ${drift.onlyLeft.length}\n`);
    process.stdout.write(`drift only-in-live: ${drift.onlyRight.length}\n`);
    for (const line of drift.onlyLeft) process.stdout.write(`  render-only ${line}\n`);
    for (const line of drift.onlyRight) process.stdout.write(`  live-only ${line}\n`);
    if (drift.onlyLeft.length || drift.onlyRight.length) {
      process.stdout.write('RESULT: FAIL - (event, hook, matcher) drift\n');
      process.exit(1);
    }
    process.stdout.write('RESULT: OK - no (event, hook, matcher) drift\n');
    process.exit(0);
  }

  const text = JSON.stringify(rendered, null, 2) + '\n';
  const out = flag(argv, '--out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  } else {
    process.stdout.write(text);
  }
}
