#!/usr/bin/env node
/**
 * hook-manifest-check.mjs - Audit Claude Code hook registrations.
 *
 * Reads the active settings.json (~/.claude/settings.json) and, optionally,
 * the repo copy (.claude/settings.json with --repo). For every registered
 * hook under every event it extracts the command, the dist .mjs (or .py)
 * file it runs, the matcher, and the timeout. It then:
 *   - asserts each referenced dist/.py file EXISTS on disk (catches the
 *     architecture-stats-sync missing-dist class of settings.json drift)
 *   - flags duplicate registrations (same file twice under one event)
 *
 * Usage:
 *   node scripts/hook-manifest-check.mjs            Human summary (active settings)
 *   node scripts/hook-manifest-check.mjs --json     Machine-readable JSON
 *   node scripts/hook-manifest-check.mjs --repo     Render the template and audit it
 *
 * Exit code: 1 if any registered hook file is missing, else 0.
 * ASCII only, node builtins only (fs/path/os).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { renderSettings } from './settings/render-settings.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const includeRepo = args.includes('--repo');

/**
 * Expand a leading ~ to the user's home directory.
 */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Extract the script file path (dist .mjs or .py) from a hook command string.
 *
 * Commands look like:
 *   node C:/Users/x/.claude/hooks/dist/foo.mjs
 *   node ~/.claude/hooks/dist/foo.mjs
 *   python C:/Users/x/.claude/hooks/bar.py post_tool_use
 *
 * Returns { runner, file } or null if no recognizable script token is found.
 */
function commandLine(hook) {
  if (!hook || typeof hook !== 'object') return '';
  const args = Array.isArray(hook.args) ? hook.args : [];
  return [hook.command, ...args].filter((part) => typeof part === 'string' && part.length > 0).join(' ');
}

function extractScript(command) {
  if (!command || typeof command !== 'string') return null;
  const tokens = command.trim().split(/\s+/);
  let runner = null;
  if (/^node(\.exe)?$/i.test(tokens[0])) runner = 'node';
  else if (/^python(3)?(\.exe)?$/i.test(tokens[0])) runner = 'python';

  // Find the first token that ends in .mjs / .js / .py (the script file).
  for (let i = 1; i < tokens.length; i++) {
    if (/\.(mjs|cjs|js|py)$/i.test(tokens[i])) {
      return { runner: runner || 'unknown', file: tokens[i] };
    }
  }
  return null;
}

/**
 * Resolve a possibly-~ , possibly-relative file path to an absolute path.
 * Relative paths resolve against the supplied base directory.
 */
function resolveFile(file, baseDir) {
  const expanded = expandHome(file);
  if (isAbsolute(expanded)) return expanded;
  return resolve(baseDir, expanded);
}

/**
 * Audit one settings.json file. Returns a report object.
 */
function auditSettings(settingsPath, label) {
  const report = emptyReport(label, settingsPath);

  if (!existsSync(settingsPath)) {
    report.error = `settings.json not found at ${settingsPath}`;
    return report;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    report.error = `failed to parse settings.json: ${err.message}`;
    return report;
  }

  return auditObject(settings, label, settingsPath, homedir());
}

function emptyReport(label, settingsPath) {
  return {
    label,
    settingsPath,
    events: {},
    missing: [],
    duplicates: [],
    registrationCount: 0,
    error: null,
  };
}

function auditObject(settings, label, settingsPath, baseDir) {
  const report = emptyReport(label, settingsPath);
  const hooks = settings.hooks || {};

  for (const eventName of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    const eventEntry = { count: 0, hooks: [] };
    const seenFiles = new Map(); // resolved file -> count (for duplicate detection)

    for (const group of groups) {
      const matcher = group && group.matcher !== undefined ? group.matcher : null;
      const groupHooks = Array.isArray(group?.hooks) ? group.hooks : [];

      for (const h of groupHooks) {
        const command = commandLine(h);
        const timeout = h?.timeout !== undefined ? h.timeout : null;
        const script = extractScript(command);

        const hookInfo = {
          command,
          matcher,
          timeout,
          runner: script ? script.runner : null,
          file: script ? script.file : null,
          resolved: null,
          exists: null,
        };

        if (script) {
          const resolved = resolveFile(script.file, baseDir);
          hookInfo.resolved = resolved;
          const fileExists = existsSync(resolved);
          hookInfo.exists = fileExists;

          if (!fileExists) {
            report.missing.push({
              event: eventName,
              file: script.file,
              resolved,
              command,
            });
          }

          const prev = seenFiles.get(resolved) || 0;
          seenFiles.set(resolved, prev + 1);
        }

        eventEntry.hooks.push(hookInfo);
        eventEntry.count++;
      }
    }

    // Duplicate detection: same resolved file registered >1 time in one event.
    for (const [resolved, n] of seenFiles.entries()) {
      if (n > 1) {
        report.duplicates.push({ event: eventName, resolved, count: n });
      }
    }

    report.events[eventName] = eventEntry;
    report.registrationCount += eventEntry.count;
  }

  return report;
}

/**
 * Render a human-readable summary for one report.
 */
function renderHuman(report) {
  const lines = [];
  lines.push(`=== ${report.label} (${report.settingsPath}) ===`);

  if (report.error) {
    lines.push(`  ERROR: ${report.error}`);
    return lines.join('\n');
  }

  const eventNames = Object.keys(report.events);
  if (eventNames.length === 0) {
    lines.push('  (no hooks configured)');
  }

  for (const ev of eventNames) {
    lines.push(`  ${ev}: ${report.events[ev].count} hook(s)`);
  }

  lines.push('');
  if (report.missing.length === 0) {
    lines.push('  MISSING: none');
  } else {
    lines.push(`  MISSING (${report.missing.length}):`);
    for (const m of report.missing) {
      lines.push(`    [${m.event}] ${m.file} -> ${m.resolved}`);
    }
  }

  if (report.duplicates.length === 0) {
    lines.push('  DUPLICATES: none');
  } else {
    lines.push(`  DUPLICATES (${report.duplicates.length}):`);
    for (const d of report.duplicates) {
      lines.push(`    [${d.event}] ${d.resolved} (x${d.count})`);
    }
  }

  return lines.join('\n');
}

// --- main ---

const reports = [];

const activePath = join(homedir(), '.claude', 'settings.json');
reports.push(auditSettings(activePath, 'active'));

if (includeRepo) {
  const repoRoot = resolve(process.cwd());
  const templatePath = join(repoRoot, '.claude', 'settings.json.template');
  const claudeHome = join(repoRoot, '.claude');
  try {
    const rendered = renderSettings({
      templateText: readFileSync(templatePath, 'utf8'),
      vars: {
        CLAUDE_HOME: claudeHome,
        OPC_DIR: join(repoRoot, 'opc'),
        REPO_ROOT: repoRoot,
        USER_HOME: homedir(),
      },
      overlay: {},
    });
    const repoReport = auditObject(rendered, 'repo', `${templatePath} (rendered)`, claudeHome);
    if (repoReport.registrationCount === 0) {
      repoReport.error = 'rendered template has 0 hook registrations';
    }
    reports.push(repoReport);
  } catch (err) {
    const repoReport = emptyReport('repo', templatePath);
    repoReport.error = err.message;
    reports.push(repoReport);
  }
}

let anyMissing = false;
for (const r of reports) {
  if (r.missing && r.missing.length > 0) anyMissing = true;
  if (r.label === 'repo' && (r.error || r.registrationCount === 0)) anyMissing = true;
}

if (asJson) {
  // Single report when no --repo, array shape collapses to the active report's
  // events/missing/duplicates per the documented schema; include all reports
  // under `reports` so --repo callers get both.
  const primary = reports[0];
  const out = {
    events: primary.events,
    missing: primary.missing,
    duplicates: primary.duplicates,
  };
  if (includeRepo) {
    out.reports = reports.map((r) => ({
      label: r.label,
      settingsPath: r.settingsPath,
      error: r.error,
      events: r.events,
      missing: r.missing,
      duplicates: r.duplicates,
    }));
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  for (const r of reports) {
    process.stdout.write(renderHuman(r) + '\n');
  }
  if (anyMissing) {
    process.stdout.write('\nRESULT: FAIL - one or more registered hook files are missing.\n');
  } else {
    process.stdout.write('\nRESULT: OK - all registered hook files exist.\n');
  }
}

process.exit(anyMissing ? 1 : 0);
