#!/usr/bin/env node
/**
 * capture-active-registrations.mjs -- harness-security lane (2026-08-31).
 *
 * One-direction capture: hook registrations present in the ACTIVE
 * ~/.claude/settings.json but missing from the repo .claude/settings.json and
 * .claude/settings.json.template are appended to the repo copies, so the
 * active harness stays rebuildable from the repo. The ACTIVE file is never
 * written (it stays NEVER_SYNC).
 *
 * Per-entry dispositions (Codex premortem finding: a permission-bypass policy
 * must not be exported to future machines via the template):
 *   - MACHINE_LOCAL entries are never captured; they are reported instead and
 *     documented in .claude/rules-src/sync-known-gaps.md.
 *   - Everything else is captured ONLY if its code exists in the repo
 *     (hooks/dist/<name>.mjs or hooks/<name>.py) -- no dangling registrations.
 *
 * Whole-file atomic writes (temp + rename). Idempotent: a second run is a
 * no-op. Run: node scripts/settings/capture-active-registrations.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIVE = join(homedir(), '.claude', 'settings.json');
const REPO = join(REPO_ROOT, '.claude', 'settings.json');
const TEMPLATE = join(REPO_ROOT, '.claude', 'settings.json.template');
const DRY = process.argv.includes('--dry-run');

// Never exported to the repo/template. Reasons live in sync-known-gaps.md.
// Deliberately DEREGISTERED by the Phase-2 hook audit; the template guard
// (settings-template-validation.test.ts) fails if these reappear. A live
// registration of one of these is stale drift to clean up, not to capture.
const STALE_DEREGISTERED = new Set([
  'auto-build.mjs',
  'navigator-safety.mjs',
  'pageindex-navigator.mjs',
  'periodic-extract.mjs',
  'sync-to-repo.mjs',
]);

const MACHINE_LOCAL = new Set([
  'permission-auto-allow.mjs', // SECURITY: permission-bypass policy; must be opted into per machine
  'linear-branch-context.mjs', // vendor-specific (Linear) machine integration
  'sentry-deploy-release.mjs', // vendor-specific (Sentry)
  'vercel-deploy-context.mjs', // vendor-specific (Vercel)
  'sentry-error-context.mjs', // vendor-specific (Sentry)
]);

const EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'PreCompact',
  'Stop',
];

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

function entryKey(h) {
  // A hook entry is identified by the basename of the script it runs plus any
  // extra args (braintrust_hooks.py runs once per event with different args).
  const args = h.args || [];
  return [scriptOf(h), ...args.slice(1)].join(' ');
}

function eventKeys(settings, ev) {
  const out = new Set();
  for (const g of settings.hooks?.[ev] || []) {
    for (const h of g.hooks || []) out.add((g.matcher || '*') + ' :: ' + entryKey(h));
  }
  return out;
}

// Script path of a hook entry: exec form uses args[0]; command form embeds the
// path in the command string ("node C:/.../dist/foo.mjs").
function scriptOf(h) {
  if (h.args?.[0]) return basename(h.args[0]);
  const m = (h.command || '').match(/\S+\.(?:mjs|py|sh|ps1)\b/);
  return m ? basename(m[0]) : h.command;
}

function codeExistsInRepo(h) {
  const script = scriptOf(h);
  if (!script) return false;
  if (script.endsWith('.mjs')) return existsSync(join(REPO_ROOT, '.claude', 'hooks', 'dist', script));
  if (script.endsWith('.py')) return existsSync(join(REPO_ROOT, '.claude', 'hooks', script));
  if (script.endsWith('.ps1') || script.endsWith('.sh'))
    return existsSync(join(REPO_ROOT, '.claude', 'hooks', script));
  return false;
}

const HOME_RE = /([A-Za-z]:)?[/\\]Users[/\\][^/\\ ]+[/\\]\.claude/g;

function templatize(h) {
  const clone = JSON.parse(JSON.stringify(h));
  if (clone.args) {
    clone.args = clone.args.map((a) => a.replace(HOME_RE, '{{CLAUDE_HOME}}'));
  }
  if (typeof clone.command === 'string') {
    clone.command = clone.command.replace(HOME_RE, '{{CLAUDE_HOME}}');
  }
  return clone;
}

function appendEntry(settings, ev, matcher, entry) {
  settings.hooks = settings.hooks || {};
  settings.hooks[ev] = settings.hooks[ev] || [];
  let group = settings.hooks[ev].find((g) => (g.matcher || '*') === matcher);
  if (!group) {
    group = matcher === '*' ? { hooks: [] } : { matcher, hooks: [] };
    settings.hooks[ev].push(group);
  }
  group.hooks.push(entry);
}

function atomicWrite(p, data) {
  const tmp = p + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, p);
}

const active = read(ACTIVE);
const repo = read(REPO);
const template = read(TEMPLATE);

const report = { captured: [], machineLocal: [], danglingSkipped: [], staleSkipped: [] };

// Iterate the ACTIVE file's own event keys, not just the known list -- a fixed
// list silently skipped events like SubagentStop (CodeRabbit PR #31). Unknown
// events are still captured, and reported so the EVENTS list gets updated.
const activeEvents = Object.keys(active.hooks || {});
report.unknownEvents = activeEvents.filter((ev) => !EVENTS.includes(ev));

for (const ev of activeEvents) {
  const repoKeys = eventKeys(repo, ev);
  const tplKeys = eventKeys(template, ev);
  for (const g of active.hooks?.[ev] || []) {
    const matcher = g.matcher || '*';
    for (const h of g.hooks || []) {
      const key = matcher + ' :: ' + entryKey(h);
      const script = scriptOf(h);
      const inRepo = repoKeys.has(key);
      const inTpl = tplKeys.has(key);
      if (inRepo && inTpl) continue;
      if (MACHINE_LOCAL.has(script)) {
        report.machineLocal.push(`${ev} | ${key}`);
        continue;
      }
      if (STALE_DEREGISTERED.has(script)) {
        report.staleSkipped.push(`${ev} | ${key}`);
        continue;
      }
      if (!codeExistsInRepo(h)) {
        report.danglingSkipped.push(`${ev} | ${key}`);
        continue;
      }
      if (!inRepo) {
        appendEntry(repo, ev, matcher, JSON.parse(JSON.stringify(h)));
        report.captured.push(`settings.json | ${ev} | ${key}`);
      }
      if (!inTpl) {
        appendEntry(template, ev, matcher, templatize(h));
        report.captured.push(`template | ${ev} | ${key}`);
      }
    }
  }
}

if (!DRY && report.captured.length) {
  atomicWrite(REPO, repo);
  atomicWrite(TEMPLATE, template);
}

console.log(JSON.stringify(report, null, 2));
console.log(
  `${DRY ? '[DRY RUN] ' : ''}captured=${report.captured.length} machineLocal=${report.machineLocal.length} staleSkipped=${report.staleSkipped.length} danglingSkipped=${report.danglingSkipped.length}`,
);
if (report.danglingSkipped.length) {
  console.error('WARNING: active registrations with NO code in the repo were skipped -- investigate:');
  for (const d of report.danglingSkipped) console.error('  ' + d);
  process.exitCode = 2;
}
