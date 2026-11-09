#!/usr/bin/env node
/**
 * remove-registrations -- remove ONE named hook from a settings.json. apply-registrations.mjs never removes a registration; this does.
 *
 *   node scripts/settings/remove-registrations.mjs --hook git-auto-commit [file]            dry run: print each entry, write nothing
 *   node scripts/settings/remove-registrations.mjs --hook git-auto-commit --apply [file]    write (after Dave's yes)
 *
 * Rules:
 *   - --hook is a script basename without path or .mjs. It is required. A hook matches when a path in its args, or a word in its
 *     command, has the exact file name <hook>.mjs. "git-auto-commit" never matches "git-auto-commit-extra".
 *   - Only the matching entries go. The other hooks in a shared group stay. A group left empty, then an event left empty, is dropped.
 *   - [file] defaults to ~/.claude/settings.json. Key order and every other key are kept (parse, filter, write).
 *   - Before the write the file is copied to <backup-dir>/<YYYY-MM-DD-HHMMSS>-settings.json. The default backup dir is
 *     <home>/continuous-claude/.claude/cache/backup (the primary checkout; a linked worktree is removed by land-pr).
 *     The write is a temp file beside the target, then rename.
 *   - 0 matches: exit 0, no backup, no write.
 *
 * Do not use on a CRLF file that must keep its bytes (the template): this rewrites the whole file as LF JSON.
 * Order when a registration lives in both files: live settings first, template second. Never run capture-active-registrations between.
 * Seams: --backup-dir <dir>. Exit 0 ok, 1 unreadable or malformed file (nothing written), 2 usage.
 * After --apply, run: node scripts/settings/render-settings.mjs --check
 */
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: remove-registrations.mjs --hook <name> [--apply] [--backup-dir <dir>] [file]';

export function hookFiles(h) {
  const words = typeof h?.command === 'string' ? h.command.split(/\s+/) : [];
  const args = Array.isArray(h?.args) ? h.args.filter((a) => typeof a === 'string') : [];
  return [...words, ...args].map((w) => basename(w.replace(/^["']|["']$/g, '').replace(/\\/g, '/')));
}

/** Pure: returns { settings, removed: [{event, matcher}] }. The input is not changed. */
export function removeHook(settings, name) {
  const target = `${name}.mjs`;
  const removed = [];
  const out = { ...settings };
  if (!settings.hooks || typeof settings.hooks !== 'object') return { settings: out, removed };
  out.hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { out.hooks[event] = groups; continue; }
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) { kept.push(g); continue; }
      const left = g.hooks.filter((h) => {
        const hit = hookFiles(h).includes(target);
        if (hit) removed.push({ event, matcher: g.matcher ?? '(all)' });
        return !hit;
      });
      if (left.length === g.hooks.length) kept.push(g);
      else if (left.length > 0) kept.push({ ...g, hooks: left });
    }
    // An event emptied by this removal goes. An event that was already empty stays: other keys are not ours to change.
    if (kept.length > 0 || groups.length === 0) out.hooks[event] = kept;
  }
  return { settings: out, removed };
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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
  const o = { apply: false, hook: null, file: null, backupDir: null };
  const val = (i) => { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--hook') o.hook = val(i++);
    else if (a === '--backup-dir') o.backupDir = resolve(val(i++));
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (o.file) throw new Error(`two files named: ${o.file} and ${a}`);
    else o.file = resolve(a);
  }
  if (!o.hook) throw new Error('--hook <name> is required');
  if (!/^[A-Za-z0-9._-]+$/.test(o.hook) || o.hook.endsWith('.mjs')) throw new Error(`--hook takes a script basename without path or .mjs, got "${o.hook}"`);
  return o;
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}\n`); process.exit(2); }
  const file = o.file || join(homedir(), '.claude', 'settings.json');
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { process.stderr.write(`cannot read ${file}: ${e.message}\n`); process.exit(1); }
  const { settings, removed } = removeHook(doc, o.hook);
  const verb = o.apply ? 'removed' : 'would remove';
  process.stdout.write(`${file.replace(/\\/g, '/')}\n`);
  for (const r of removed) process.stdout.write(`  ${r.event} [${r.matcher}] ${o.hook}.mjs\n`);
  process.stdout.write(`${verb} ${removed.length} entries (hook ${o.hook})\n`);
  if (removed.length === 0 || !o.apply) {
    if (!o.apply && removed.length > 0) process.stdout.write('dry run: nothing written. Add --apply to write.\n');
    return;
  }
  const dir = o.backupDir || join(homedir(), 'continuous-claude', '.claude', 'cache', 'backup');
  const saved = backup(file, dir);
  process.stdout.write(`backup ${saved.replace(/\\/g, '/')}\n`);
  const tmp = join(dirname(file), `.${basename(file)}.remove-tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no temp file to remove */ }
    process.stderr.write(`cannot write ${file}: ${e.message}\nThe file is unchanged. The backup is at ${saved.replace(/\\/g, '/')}\n`);
    process.exit(1);
  }
  process.stdout.write(`written ${file.replace(/\\/g, '/')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
