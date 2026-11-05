#!/usr/bin/env node
/**
 * apply-registrations -- carry NAMED hook registrations from .claude/settings.json.template into the live settings.json.
 *
 * The live ~/.claude/settings.json is never synced (NEVER_SYNC). render-settings --check reports drift but writes nothing.
 * This is the one script that may change the live file, and only on purpose:
 *
 *   node scripts/settings/apply-registrations.mjs                                   dry run: print every difference, write nothing
 *   node scripts/settings/apply-registrations.mjs --only lane-board-stop-gate,lane-context     dry run with the plan for those hooks
 *   node scripts/settings/apply-registrations.mjs --apply --only lane-board-stop-gate,lane-context     write (after Dave's yes)
 *
 * Rules:
 *   - --apply needs --only <hook,hook> (script basenames, no .mjs). A name the template does not register is refused.
 *   - For each hook in --only: the template row is added as a NEW group holding only that hook when live lacks it; when live
 *     has the same (event, hook) on another matcher, that group's matcher is updated IN PLACE (an add-only rule would register
 *     lane-context twice). A group that also holds a hook outside --only is not rewritten: the run exits 1 and writes nothing.
 *   - A live registration is never removed. A hook outside --only is never touched. Live-only registrations are listed as kept.
 *   - Before the write the live file is copied to <repo>/.claude/cache/backup/<YYYY-MM-DD-HHMMSS>-settings.json
 *     (<repo> is the primary checkout unless --repo is given).
 *     The write is a Node read-modify-write: parse, mutate, write a temp file beside it, rename.
 *   - A second --apply prints "0 changes" and writes nothing.
 *
 * Repo: without --repo the script uses the PRIMARY checkout (<home>/continuous-claude, the path lane.mjs repoPath() gives) for the
 * template and the backup folder, whatever copy of this script runs. A linked worktree is removed by land-pr, and so would be its backup.
 * It prints which repo it used. If the primary checkout is missing it refuses; pass --repo.
 *
 * Seams: --home <dir> (settings at <dir>/.claude/settings.json, template paths rendered for that home), --settings <file>,
 * --repo <dir>, --template <file>, --backup-dir <dir>, --profile <name>.
 * Exit 0 ok, 1 blocked (nothing written), 2 usage or a refused input.
 * After --apply, run: node scripts/settings/render-settings.mjs --check
 */
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookScript, registrations, renderSettings, varsFromPaths } from './render-settings.mjs';
import { resolveMachineProfile } from './machine-profile.mjs';
import { repoPath } from '../coordination/canon-home.mjs';

// Registrations that exist on purpose only on this machine (see capture-active-registrations.mjs MACHINE_LOCAL). Used only to label the kept list.
const MACHINE_LOCAL = new Set(['permission-auto-allow', 'linear-branch-context', 'sentry-deploy-release', 'vercel-deploy-context', 'sentry-error-context']);

/** Every hook registration with its place: { event, matcher, hook, gi (group index), group }. */
function placedRows(settings) {
  const rows = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      for (const h of group?.hooks || []) {
        const hook = hookScript(h);
        if (hook) rows.push({ event, matcher: group.matcher || '', hook, gi, group });
      }
    });
  }
  return rows;
}

const label = (r) => `${r.event} ${r.matcher ? `matcher "${r.matcher}"` : '(no matcher)'} ${r.hook}`;

/**
 * Compare the rendered template with the live settings. Returns
 *   { pairs: [{event, hook, from, to, gi}], renderOnly: [row], liveOnly: [row] }
 * Per (event, hook): the template matchers live lacks (missing) and the live matchers the template lacks (extra) are paired in
 * order. A pair is a matcher change. A leftover missing is render-only. A leftover extra is live-only (kept).
 */
export function diffRegistrations(rendered, live) {
  const t = placedRows(rendered);
  const l = placedRows(live);
  const pairs = [];
  const renderOnly = [];
  const liveOnly = [];
  const keys = new Set([...t, ...l].map((r) => `${r.event}\t${r.hook}`));
  for (const k of [...keys].sort()) {
    const [event, hook] = k.split('\t');
    const tm = t.filter((r) => r.event === event && r.hook === hook);
    const lm = l.filter((r) => r.event === event && r.hook === hook);
    const missing = tm.filter((r) => !lm.some((x) => x.matcher === r.matcher));
    const extra = lm.filter((r) => !tm.some((x) => x.matcher === r.matcher));
    const n = Math.min(missing.length, extra.length);
    for (let i = 0; i < n; i++) pairs.push({ event, hook, from: extra[i].matcher, to: missing[i].matcher, gi: extra[i].gi, group: extra[i].group });
    renderOnly.push(...missing.slice(n));
    liveOnly.push(...extra.slice(n));
  }
  return { pairs, renderOnly, liveOnly };
}

/** The actions for the hooks in `only`, and the blocked ones. Pure. */
export function planActions(rendered, live, only) {
  const d = diffRegistrations(rendered, live);
  const want = new Set(only);
  const actions = [];
  const blocked = [];
  const seen = new Set();
  for (const p of d.pairs.filter((x) => want.has(x.hook))) {
    // Every hook in the group follows the group's matcher. Safe only when each of them is in --only and wants the same new matcher.
    const strangers = [...new Set((p.group.hooks || []).map(hookScript).filter((n) => n && !(want.has(n) && d.pairs.some((q) => q.event === p.event && q.gi === p.gi && q.hook === n && q.to === p.to))))];
    if (strangers.length) {
      blocked.push({ ...p, reason: `${p.event} ${p.hook}: its live group shares a group with ${strangers.join(', ')} (not in --only, or it wants another matcher); changing the matcher would change that hook too. Split the group by hand.` });
    } else if (!seen.has(`${p.event}	${p.gi}`)) {
      seen.add(`${p.event}	${p.gi}`);
      actions.push({ kind: 'update', ...p });
    }
  }
  for (const r of d.renderOnly.filter((x) => want.has(x.hook))) actions.push({ kind: 'add', event: r.event, hook: r.hook, matcher: r.matcher, templateGroup: r.group });
  return { actions, blocked, kept: d.liveOnly, diff: d };
}

/** A copy of `live` with the actions applied. Pure. */
export function applyActions(live, actions) {
  const out = JSON.parse(JSON.stringify(live));
  for (const a of actions) {
    if (a.kind === 'update') {
      const group = out.hooks[a.event][a.gi];
      if (a.to) group.matcher = a.to; else delete group.matcher;
    } else {
      const { hooks, ...rest } = JSON.parse(JSON.stringify(a.templateGroup));
      const entry = hooks.find((h) => hookScript(h) === a.hook);
      out.hooks ??= {};
      out.hooks[a.event] ??= [];
      out.hooks[a.event].push({ ...rest, hooks: [entry] });
    }
  }
  return out;
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Serialise like the file we read: same indent, same line ending, same final newline. */
function serialise(doc, original) {
  const indent = /^\{\r?\n(\t| +)"/.exec(original)?.[1] ?? '  ';
  let text = JSON.stringify(doc, null, indent);
  if (original.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  return /\r?\n$/.test(original) ? text + eol : text;
}

function backup(file, dir) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 100; i++) {
    const dest = join(dir, `${stamp()}${i ? `-${i}` : ''}-settings.json`);
    try { copyFileSync(file, dest, constants.COPYFILE_EXCL); return dest; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`cannot name a backup file in ${dir}`);
}

function parseArgs(argv) {
  const o = { apply: false, only: [], repo: null, home: homedir(), settings: null, template: null, backupDir: null };
  const val = (i) => { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--only') o.only = val(i++).split(',').map((s) => s.trim().replace(/\.mjs$/, '')).filter(Boolean);
    else if (a === '--repo') o.repo = resolve(val(i++));
    else if (a === '--home') o.home = resolve(val(i++));
    else if (a === '--settings') o.settings = resolve(val(i++));
    else if (a === '--template') o.template = resolve(val(i++));
    else if (a === '--backup-dir') o.backupDir = resolve(val(i++));
    else if (a === '--profile') i++; // read by resolveMachineProfile from argv
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const readJsonFile = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function main(argv) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const fail = (code, s) => { process.stderr.write(`${s}\n`); process.exit(code); };
  let o;
  try { o = parseArgs(argv); } catch (e) { fail(2, `${e.message}\nusage: apply-registrations.mjs [--apply --only <hook,hook>] [--home <dir>] [--settings <file>] [--repo <dir>]`); }
  if (o.apply && !o.only.length) fail(2, 'refused: --apply needs --only <hook,hook> (script names such as lane-board-stop-gate,lane-context). Run without --apply for the dry run.');

  if (o.repo) o.repoHow = '--repo';
  else {
    o.repo = repoPath(o.home);
    o.repoHow = 'primary checkout';
    if (!existsSync(join(o.repo, '.claude'))) fail(2, `refused: the primary checkout ${o.repo.replace(/\\/g, '/')} was not found (no .claude folder). Pass --repo <dir> to name the checkout on purpose.`);
  }
  const resolved = resolveMachineProfile({ repoRoot: o.repo, home: o.home, argv });
  if (resolved.warn) process.stderr.write(`WARN: ${resolved.warn}\n`);
  const templatePath = o.template || join(o.repo, '.claude', 'settings.json.template');
  const settingsPath = o.settings || join(o.home, '.claude', 'settings.json');
  if (!existsSync(templatePath)) fail(2, `refused: template not found: ${templatePath}`);
  if (!existsSync(settingsPath)) fail(2, `refused: no live settings at ${settingsPath} (this script edits a file, it never creates one)`);

  let rendered;
  let liveText;
  let live;
  try {
    rendered = renderSettings({ templateText: readFileSync(templatePath, 'utf8'), vars: varsFromPaths(resolved.paths), overlay: resolved.paths.settingsOverlay });
    liveText = readFileSync(settingsPath, 'utf8');
    live = JSON.parse(liveText.replace(/^﻿/, ''));
  } catch (e) { fail(2, `refused: ${e.message}`); }

  const known = new Set(registrations(rendered).map((r) => r.hook));
  const unknown = o.only.filter((n) => !known.has(n));
  if (unknown.length) fail(2, `refused: --only names a hook the template does not register: ${unknown.join(', ')}`);

  const plan = planActions(rendered, live, o.only);
  const { diff } = plan;
  out(`apply-registrations (${o.apply ? 'APPLY' : 'dry run'})`);
  out(`  repo ${o.repo.replace(/\\/g, '/')} (${o.repoHow})`);
  out(`  template ${templatePath.replace(/\\/g, '/')}`);
  out(`  settings ${settingsPath.replace(/\\/g, '/')}`);
  out(`hooks: ${registrations(rendered).length} rendered, ${registrations(live).length} live`);
  out(`differences (template vs live): ${diff.pairs.length + diff.renderOnly.length + diff.liveOnly.length}`);
  for (const p of diff.pairs) out(`  matcher      ${p.event} ${p.hook}: live "${p.from}" -> template "${p.to}"`);
  for (const r of diff.renderOnly) out(`  render-only  ${label(r)}`);
  for (const r of diff.liveOnly) out(`  live-only    ${label(r)}${MACHINE_LOCAL.has(r.hook) ? ' [machine-local]' : ''}`);
  out(o.only.length ? `plan for --only ${o.only.join(',')}:` : 'plan: no --only given, so nothing would be applied');
  for (const a of plan.actions) {
    out(a.kind === 'add' ? `  add     ${a.event} ${a.matcher ? `matcher "${a.matcher}"` : '(no matcher)'} ${a.hook}` : `  update  ${a.event} ${a.hook} matcher "${a.from}" -> "${a.to}"`);
  }
  for (const b of plan.blocked) out(`  BLOCKED ${b.reason}`);
  out(`kept (live registrations are never removed): ${diff.liveOnly.length}`);
  for (const r of diff.liveOnly) out(`  kept ${label(r)}${MACHINE_LOCAL.has(r.hook) ? ' [machine-local]' : ''}`);

  if (plan.blocked.length) fail(1, `RESULT: blocked, wrote nothing: ${plan.blocked.length} hook(s) cannot be changed safely`);
  if (!o.apply) {
    out(`RESULT: dry run, wrote nothing. ${plan.actions.length} change(s) planned${o.only.length ? '' : ' (none: pass --only to plan)'}. To write: --apply --only ${o.only.join(',') || '<hook,hook>'}`);
    return;
  }
  if (!plan.actions.length) { out(`RESULT: 0 changes, wrote nothing: live already matches the template for ${o.only.join(',')}`); return; }

  const backupDir = o.backupDir || join(o.repo, '.claude', 'cache', 'backup');
  const saved = backup(settingsPath, backupDir);
  out(`backup ${saved.replace(/\\/g, '/')}`);
  const next = applyActions(live, plan.actions);
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, serialise(next, liveText));
  renameSync(tmp, settingsPath);
  const after = planActions(rendered, readJsonFile(settingsPath), o.only);
  if (after.actions.length || after.blocked.length) fail(1, `RESULT: wrote ${settingsPath} but ${after.actions.length} change(s) remain; restore from ${saved}`);
  out(`RESULT: applied ${plan.actions.length} change(s); verified 0 changes remain for ${o.only.join(',')}. Next: node scripts/settings/render-settings.mjs --check`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
