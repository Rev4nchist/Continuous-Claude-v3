// Where the map comes from, and whether the script may run on it.
// Live mode: the script must be the one on main, in the primary checkout, and it reads the map from main.
// Test mode: no self-check; the map comes from a file or a ref. The banner says so.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExitError, refused, usageError } from './errors.mjs';
import { blobAt, blobId, git, isLinkedWorktree, repoRoot, revParse, showFile } from './git.mjs';

export const MAP_PATH = 'docs/review-engine/map.md';
export const DECISIONS_PATH = 'docs/review-engine/decisions.md';
const README = 'scripts/review-engine/README.md';
const DEFAULT_DB = 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
const short = (id) => (id ?? '').slice(0, 7);

// Files outside scripts/review-engine that the script runs from (design C.2). Live mode compares each with main:
// a file that is absent locally, absent on main or different from main is exit 3 and the file is named.
// makeRepo in program-cli.test.mjs and source.test.mjs copy these files into each temp repo.
// The list is a parameter of selfCheck, never an env var or a flag: nothing can narrow it in live mode.
export const EXTRA = [
  'scripts/coordination/lane-dep.mjs',
  'scripts/coordination/lane-seed-file.mjs',
  'scripts/coordination/scratch-db.mjs',
  'scripts/coordination/lane-sort.mjs',
  'scripts/coordination/lane.mjs',
  'scripts/lib/resolve-deps.mjs',
];

// Every .mjs the script runs from, except tests and fixtures, then the EXTRA files. Paths are repo-relative with '/'.
// The prefix comes from git, so short and long Windows paths cannot disagree.
function comparedFiles(scriptDir, extra = EXTRA) {
  const prefix = git(scriptDir, ['rev-parse', '--show-prefix']).trim();
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'fixtures') walk(resolve(dir, e.name), `${rel}${e.name}/`);
      else if (e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(`${rel}${e.name}`);
    }
  };
  walk(scriptDir, prefix);
  return [...new Set([...out, ...extra])].sort();
}

function mismatchLine(repo, sha, rel) {
  if (!existsSync(resolve(repo, rel))) return `${rel} is missing locally`;
  const local = blobId(repo, rel);
  const main = blobAt(repo, sha, rel);
  if (main === null) return `${rel} is not on main (local ${short(local)})`;
  return main === local ? null : `${rel} differs from main (local ${short(local)}, main ${short(main)})`;
}

function selfCheckOrThrow(scriptDir, extra) {
  const repo = repoRoot(scriptDir);
  if (isLinkedWorktree(repo)) {
    throw refused(`refused: this is a linked worktree. Run from the primary checkout (orchestration plan :140), or use --test-mode; see ${README}.`);
  }
  const sha = revParse(repo, 'main');
  if (!sha) throw refused('refused: ref main does not name a commit in this repo.');
  const bad = comparedFiles(scriptDir, extra).map((rel) => mismatchLine(repo, sha, rel)).filter(Boolean);
  if (bad.length) throw refused(`refused: the script is not the one on main.\n  ${bad.join('\n  ')}\nUse the main copy, or test mode (--test-mode); see ${README}.`);
  return { repo, sha };
}

// Live mode gate. Returns { repo, sha } (sha = the resolved main commit). Throws ExitError(3) on any refusal.
export function selfCheck(scriptDir, extra = EXTRA) {
  try {
    return selfCheckOrThrow(scriptDir, extra);
  } catch (e) {
    if (e instanceof ExitError) throw e;
    throw refused(`refused: cannot run the self-check: ${e.message}`);
  }
}

function fromGit(repo, ref, sha) {
  return { text: showFile(repo, sha, MAP_PATH), source: { kind: 'git', ref, sha }, label: `${ref}@${sha.slice(0, 12)} ${MAP_PATH}`, shortLabel: `${ref}@${sha.slice(0, 12)}` };
}

function fromFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw usageError(`cannot read --map file '${path}': ${e.message}`);
  }
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { text, source: { kind: 'file', path, sha256 }, label: `file ${path}`, shortLabel: `file ${path}` };
}

function scriptRepo(scriptDir) {
  try {
    return repoRoot(scriptDir);
  } catch {
    return null;
  }
}

function fromRef(repo, ref) {
  if (!repo) throw usageError('no git repo for --map-ref; pass --repo <dir> or --map <file>');
  const sha = revParse(repo, ref);
  if (!sha) throw usageError(`ref '${ref}' not found in ${repo}; pass --map-ref <ref>`);
  return fromGit(repo, ref, sha);
}

// --map, --map-ref, --repo, --decisions and --lane-cli only make sense in test mode.
// --decisions and --lane-cli would let live mode read a doc or run a CLI that is not the one on main.
function guardTestFlags(flags) {
  if (flags['test-mode']) return;
  const used = ['map', 'map-ref', 'repo', 'decisions', 'lane-cli'].filter((f) => flags[f] !== undefined);
  if (used.length) throw refused(`refused: --${used.join(', --')} needs --test-mode. Live mode reads the map from main only.`);
}

// Read the map. Returns { testMode, repo, mainSha, text, source, label, shortLabel, banner }.
export function readMap(flags, scriptDir) {
  guardTestFlags(flags);
  if (flags.map !== undefined && flags['map-ref'] !== undefined) throw usageError('--map and --map-ref cannot be used together');
  if (!flags['test-mode']) {
    const { repo, sha } = selfCheck(scriptDir);
    const map = fromGit(repo, 'main', sha);
    return { testMode: false, repo, mainSha: sha, ...map, banner: `map ${map.label}` };
  }
  const repo = flags.repo !== undefined ? resolve(flags.repo) : scriptRepo(scriptDir);
  const map = flags.map !== undefined ? fromFile(flags.map) : fromRef(repo, flags['map-ref'] ?? 'main');
  return { testMode: true, repo, mainSha: null, ...map, banner: `TEST MODE: self-check skipped; map ${map.label}` };
}

// A doc of the repo (decisions.md) from the same commit as the map. Returns its text, or null when there is none.
// Test mode with --decisions <file>: that file wins; an unreadable file is a usage error (exit 2).
// Live mode ignores --decisions (readMap already refused it). A map read from a file has no commit, so the doc is null.
export function readDoc(map, path, flags = {}) {
  if (map.testMode && flags.decisions !== undefined) {
    try {
      return readFileSync(flags.decisions, 'utf8');
    } catch (e) {
      throw usageError(`cannot read --decisions file '${flags.decisions}': ${e.message}`);
    }
  }
  if (map.source?.kind !== 'git' || !map.repo) return null;
  return blobAt(map.repo, map.source.sha, path) === null ? null : showFile(map.repo, map.source.sha, path);
}

// The part 2 seam. No part 1 verb calls it. Live mode returns the lane.mjs default chain.
// Test mode needs CONTINUOUS_CLAUDE_DB_URL (first in that chain) and a scratch database name. It never names the URL in a message.
export async function dbTarget({ testMode, env = process.env }) {
  if (!testMode) return env.CONTINUOUS_CLAUDE_DB_URL || env.DATABASE_URL || env.OPC_POSTGRES_URL || DEFAULT_DB;
  const url = env.CONTINUOUS_CLAUDE_DB_URL;
  if (!url) throw refused('refused: test mode needs CONTINUOUS_CLAUDE_DB_URL set to a scratch database (name starts with lanes_pr1_).');
  const { assertScratchUrl } = await import(new URL('../../coordination/scratch-db.mjs', import.meta.url).href);
  try {
    assertScratchUrl(url);
  } catch (e) {
    throw refused(`refused: ${e.message}`);
  }
  return url;
}
