#!/usr/bin/env node
/**
 * orphans.mjs: a DRY-RUN report of orphan folders under <primary>/.claude/worktrees.
 *
 * An orphan is a folder there that `git worktree list --porcelain` does not list (the same test as the harness doctor,
 * scripts/harness-doctor.mjs worktreeFolders). This helper only reads. It has no delete flag and no code path that
 * removes, moves or writes a file. Dave decides each folder by hand.
 *
 * Usage: node scripts/worktree/orphans.mjs [--root <primary>] [--json] [--no-lanes] [--lanes-file <file>] | --help
 *   --root         the primary checkout. Default: the primary of this checkout.
 *   --json         print the report as JSON.
 *   --no-lanes     skip the lane board lookup: every lane shows "unknown".
 *   --lanes-file   read the board JSON from a file (the output of `lane.mjs board --json`) instead of running lane.mjs.
 *   An unknown flag: one usage line on stderr, exit 2.
 *
 * Per orphan it shows: age (newest mtime inside), size, file count, links, whether it holds .git, git dirty count and
 * merged-into-main when it has its own repo, the lane match, and a verdict:
 *   candidate  empty (0 files, or only .tldr), or a git repo that is clean and merged into main.
 *   keep       anything else. The reason says why. Checked in this order:
 *              unreadable, younger than 24 h (possibly live), matches an open lane (possibly live), holds a link,
 *              lane lookup failed, has data.
 * A candidate gets one PowerShell line as text. The helper never runs it.
 *
 * Safety: git runs with --no-optional-locks, so a status call does not refresh the index of the folder it reads.
 * The scan uses lstat and never descends into a symlink or junction. Git runs only inside a folder that has its
 * own .git, and only when `git rev-parse --show-toplevel` names that same folder: a folder with a broken .git would
 * otherwise answer for the primary repo. The only child processes are git and lane.mjs board, with no shell.
 * Importing this file does nothing: no I/O until a function is called.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primaryRoot } from '../lib/resolve-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_CHECKOUT = path.resolve(HERE, '..', '..');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const LIVE_WINDOW_MS = DAY;
const CLOSED_LANE_STATES = new Set(['done', 'closed', 'abandoned', 'cancelled']);
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

// ---- small helpers ----
const realOrResolved = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
/** One key for one folder: real path, no trailing slash, lower case on Windows. */
const pathKey = (p) => {
  const k = realOrResolved(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

function runGit(cwd, args) {
  const env = { ...process.env };
  for (const k of GIT_ENV_DROP) delete env[k];
  const r = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env });
  return { ok: r.status === 0, status: r.status, out: String(r.stdout ?? '').trim() };
}

export function humanAge(ms) {
  if (ms < HOUR) return `${Math.max(0, Math.floor(ms / 60000))}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const localStamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The one PowerShell line Dave could paste. Text only: nothing here runs it. */
export const removeCommand = (dir) => `Remove-Item -LiteralPath '${dir.replace(/['‘’‚‛]/g, (c) => c + c)}' -Recurse -Force`;

// ---- find the orphans ----
export function listedWorktrees(root) {
  const r = runGit(root, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(`git worktree list failed in ${root}`);
  return r.out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}

/** Splits the entries of the worktrees folder: orphan folders, plain files and links (never followed). */
export function findFolders(wtDir, listed) {
  const out = { orphans: [], plainFiles: [], skippedLinks: [] };
  if (!existsSync(wtDir)) return out;
  const known = new Set(listed.map(pathKey));
  for (const e of readdirSync(wtDir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) out.skippedLinks.push(e.name);
    else if (e.isDirectory()) { if (!known.has(pathKey(path.join(wtDir, e.name)))) out.orphans.push(e.name); }
    else out.plainFiles.push(e.name);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// ---- measure one folder ----
/** Size, file count and newest mtime of a folder. A link is counted and never entered. */
export function scanFolder(dir) {
  const s = { files: 0, nonTldrFiles: 0, bytes: 0, links: 0, errors: 0, newestMs: 0, hasGit: false, gitKind: null };
  const top = lstatSync(dir);
  s.newestMs = top.mtimeMs;
  const stack = [{ p: dir, top: null }];
  while (stack.length) {
    const { p, top: topName } = stack.pop();
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { s.errors++; continue; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      const topOf = topName ?? e.name;
      let st;
      try { st = lstatSync(full); } catch { s.errors++; continue; }
      s.newestMs = Math.max(s.newestMs, st.mtimeMs);
      if (!topName && e.name === '.git') { s.hasGit = true; s.gitKind = st.isDirectory() ? 'dir' : 'file'; }
      if (e.isSymbolicLink()) { s.links++; continue; }
      if (e.isDirectory()) { stack.push({ p: full, top: topOf }); continue; }
      s.files++;
      s.bytes += st.size;
      if (topOf !== '.tldr') s.nonTldrFiles++;
    }
  }
  return s;
}

/** true, false, or null (git cannot say): is the commit an ancestor of main in the primary repo? A commit the primary lacks is not in main. */
function mergedIntoMain(sha, root, main) {
  if (!runGit(root, ['cat-file', '-e', `${sha}^{commit}`]).ok) return false;
  const anc = runGit(root, ['merge-base', '--is-ancestor', sha, main]);
  return anc.status === 0 ? true : anc.status === 1 ? false : null;
}

const lineList = (out) => out.split(/\r?\n/).filter((l) => l.trim());

/**
 * Facts about a folder with its own repo, or null when git cannot answer for that folder alone.
 *   dirty            tracked changes and untracked files
 *   ignored          ignored files and folders (.env, build output): status hides them, a delete loses them
 *   stashes          entries in the stash list
 *   unmergedBranches local branches whose tip is not in main
 * A count of null means that git call failed. decide() keeps the folder then.
 */
export function gitFacts(dir, root, main = 'main') {
  const top = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok || pathKey(top.out) !== pathKey(dir)) return null;
  const status = runGit(dir, ['status', '--porcelain', '--ignored']);
  if (!status.ok) return null;
  const lines = lineList(status.out);
  const ignored = lines.filter((l) => l.startsWith('!!')).length;
  const dirty = lines.length - ignored;
  const branch = runGit(dir, ['branch', '--show-current']).out || '(detached)';
  const head = runGit(dir, ['rev-parse', 'HEAD']);
  const merged = head.ok ? mergedIntoMain(head.out, root, main) : null;
  const stash = runGit(dir, ['stash', 'list']);
  const tips = runGit(dir, ['for-each-ref', '--format=%(objectname)', 'refs/heads']);
  return {
    branch, dirty, merged, ignored,
    stashes: stash.ok ? lineList(stash.out).length : null,
    unmergedBranches: tips.ok ? lineList(tips.out).filter((sha) => mergedIntoMain(sha, root, main) !== true).length : null,
  };
}

// ---- lanes ----
/** Lanes from `lane.mjs board --json` text, or null. Lines before the first "{" (warnings) are skipped. */
export function parseLanes(text) {
  const i = String(text).indexOf('{');
  if (i < 0) return null;
  try {
    const j = JSON.parse(String(text).slice(i));
    return Array.isArray(j?.lanes) ? j.lanes.map((l) => ({ id: String(l.id), state: String(l.state ?? '') })) : null;
  } catch { return null; }
}

/** Runs the lane shim read-only from the primary checkout. null when it fails. */
export function fetchLanes(root, home = os.homedir()) {
  const shim = path.join(home, '.claude', 'scripts', 'lane.mjs');
  if (!existsSync(shim)) return null;
  const r = spawnSync(process.execPath, [shim, 'board', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? parseLanes(r.stdout) : null;
}

/** { text, open } for a folder name against the board lanes. text is "unknown", "none" or "lane <id>, <state>". */
export function laneInfo(lanes, name) {
  if (!lanes) return { text: 'unknown', open: false };
  const hit = lanes.find((l) => l.id === name);
  if (!hit) return { text: 'none', open: false };
  return { text: `lane ${hit.id}, ${hit.state || 'no state'}`, open: !CLOSED_LANE_STATES.has(hit.state) };
}
export const laneMatch = (lanes, name) => laneInfo(lanes, name).text;

// ---- verdict ----
/** { verdict: 'candidate' | 'keep', reason } from the facts of one orphan. */
export function decide({ scan, git, ageMs, lane }) {
  const keep = (reason) => ({ verdict: 'keep', reason });
  if (scan.errors > 0) return keep('cannot read all of the folder');
  if (ageMs < LIVE_WINDOW_MS) return keep('possibly live (newest file is under 24 h old)');
  if (lane.open) return keep(`possibly live (${lane.text})`);
  if (scan.links > 0) return keep('contains a link or junction');
  if (lane.text === 'unknown') return keep('lane unknown, cannot rule out a live lane');
  if (!scan.hasGit) {
    return scan.nonTldrFiles === 0 ? { verdict: 'candidate', reason: 'empty (no files, or only a .tldr folder)' } : keep('has data');
  }
  if (!git) return keep('has a .git that git cannot read for this folder alone');
  if (git.dirty > 0) return keep(`has data (${git.dirty} uncommitted change(s))`);
  if (git.merged === false) return keep('has data (commits not in main)');
  if (git.merged === null) return keep('has data (cannot tell if merged into main)');
  if ([git.ignored, git.stashes, git.unmergedBranches].includes(null)) return keep('has data (cannot read ignored files, stashes or branches)');
  if (git.ignored > 0) return keep(`has data (${git.ignored} ignored file(s) or folder(s))`);
  if (git.stashes > 0) return keep(`has data (${git.stashes} stash entr${git.stashes === 1 ? 'y' : 'ies'})`);
  if (git.unmergedBranches > 0) return keep(`has data (${git.unmergedBranches} local branch(es) not in main)`);
  return { verdict: 'candidate', reason: 'clean and merged into main' };
}

// ---- the report ----
/** The whole report. `lanes` is an array of { id, state } or null for unknown. Read only. */
export function buildReport({ root, now = Date.now(), lanes = null, main = 'main' }) {
  const wtDir = path.join(path.resolve(root), '.claude', 'worktrees');
  const found = findFolders(wtDir, listedWorktrees(root));
  const orphans = found.orphans.map((name) => {
    const dir = path.join(wtDir, name);
    const scan = scanFolder(dir);
    const git = scan.hasGit ? gitFacts(dir, root, main) : null;
    const lane = laneInfo(lanes, name);
    const ageMs = Math.max(0, now - scan.newestMs);
    const d = decide({ scan, git, ageMs, lane });
    return {
      name, path: dir, ageMs, newestMs: scan.newestMs, files: scan.files, bytes: scan.bytes, links: scan.links,
      hasGit: scan.hasGit, gitKind: scan.gitKind, git, lane: lane.text, verdict: d.verdict, reason: d.reason,
      command: d.verdict === 'candidate' ? removeCommand(dir) : null,
    };
  });
  const candidates = orphans.filter((o) => o.verdict === 'candidate').length;
  return { worktreesDir: wtDir, now, orphans, plainFiles: found.plainFiles, skippedLinks: found.skippedLinks, candidates, keeps: orphans.length - candidates };
}

export function formatReport(r) {
  const L = [`ORPHANS under ${r.worktreesDir}  (dry run: nothing is deleted)`, ''];
  for (const o of r.orphans) {
    const g = o.git ? `branch ${o.git.branch}, ${o.git.dirty} dirty, merged into main: ${o.git.merged ?? 'unknown'}, ignored: ${o.git.ignored ?? '?'}, stashes: ${o.git.stashes ?? '?'}, branches not in main: ${o.git.unmergedBranches ?? '?'}` : o.hasGit ? 'unknown (git cannot read it for this folder alone)' : 'n/a';
    L.push(o.name,
      `  age: ${humanAge(r.now - o.newestMs)} (newest change ${localStamp(o.newestMs)})`,
      `  size: ${humanSize(o.bytes)} (${o.bytes.toLocaleString('en-US')} bytes), files: ${o.files}, links: ${o.links}`,
      `  .git: ${o.hasGit ? o.gitKind : 'no'}`,
      `  git: ${g}`,
      `  lane: ${o.lane}`,
      `  verdict: ${o.verdict === 'candidate' ? 'SAFE-TO-DELETE candidate' : 'keep'}: ${o.reason}`, '');
  }
  L.push(`SUMMARY: ${r.orphans.length} orphan folder(s): ${r.candidates} candidate, ${r.keeps} keep.`,
    `Plain files (not folders): ${r.plainFiles.length ? r.plainFiles.join(', ') : 'none'}. Links skipped: ${r.skippedLinks.length ? r.skippedLinks.join(', ') : 'none'}.`);
  const cmds = r.orphans.filter((o) => o.command);
  if (cmds.length) {
    L.push('', 'Manual commands for the candidates. Text only: this helper never runs them. Dave pastes one himself:');
    for (const o of cmds) L.push(`  ${o.command}`);
  }
  return `${L.join('\n')}\n`;
}

// ---- CLI ----
const USAGE = 'usage: node scripts/worktree/orphans.mjs [--root <primary>] [--json] [--no-lanes] [--lanes-file <file>] | --help';

function parseArgs(argv) {
  const o = { root: null, json: false, noLanes: false, lanesFile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-lanes') o.noLanes = true;
    else if ((a === '--root' || a === '--lanes-file') && argv[i + 1] && !argv[i + 1].startsWith('--')) o[a === '--root' ? 'root' : 'lanesFile'] = argv[++i];
    else return null;
  }
  return o;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) { process.stderr.write(`${USAGE}\n`); return 2; }
  if (args.help) { process.stdout.write(`${USAGE}\nDry run only: it reports orphan folders and deletes nothing.\n`); return 0; }
  const root = primaryRoot(args.root ?? OWN_CHECKOUT);
  let lanes = null;
  if (args.lanesFile) lanes = parseLanes(readFileSync(args.lanesFile, 'utf8'));
  else if (!args.noLanes) lanes = fetchLanes(root);
  let report;
  try { report = buildReport({ root, lanes }); } catch (err) { process.stderr.write(`ORPHANS error: ${err.message}\n`); return 1; }
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}

function isEntryScript() {
  if (!process.argv[1]) return false;
  return realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url));
}

if (isEntryScript()) process.exitCode = main(process.argv.slice(2));
