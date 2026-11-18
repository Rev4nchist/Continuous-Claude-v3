// Lane board resolver (lane.mjs copy).
//
// Maps a working directory to a lane board key using the project registry.
// TWIN: .claude/hooks/src/shared/lane-board.ts holds the same logic in TypeScript for
// the hooks. No hook imports from scripts/, so there are two copies. The test
// .claude/hooks/src/__tests__/lane-board-resolver.test.ts runs every case against
// both and fails if they differ. Change one copy, change the other.
//
// The board key is cooperative. It picks which board a session sees. It is never
// a security boundary: no allow or deny decision may use it.
//
// Rules, in order:
//   1. Headless (CLAUDE_CODE_ENTRYPOINT starts with 'sdk', LANE_CONTEXT_HEADLESS is
//      not '1') gives null. `opts.cli` or `opts.headlessOk` skips this rule.
//   2. CLI only (`opts.cli`): `opts.projectFlag`, then env.LANE_PROJECT. The key must
//      be a registered, non-inactive entry or the call throws.
//   3. Registry: longest root that is a path-segment prefix of the realpath of cwd.
//      The resolver never stats registry roots.
//   4. Worktree fallback, no process spawn: read `<root>/.git/worktrees/<n>/gitdir`
//      files (max 100 per root). A `.git` file inside the cwd is never read. No git
//      env var is read.
//   5. Otherwise null.
//
// `sessions.project`, `project_alias` and `canonicalProject` are never used.
//
// boardRoots(key, opts): the normalised roots of every non-inactive entry on board `key`
// (a nested entry with `laneBoard` adds its own root to its parent board). lane.mjs uses it
// to decide which sessions belong to a board.
//
// Result: { key, root, source, via }
//   key    the board key
//   root   the normalised registry root of the matched entry
//   source 'flag' | 'env' | 'registry' | 'worktree-gitdir'
//   via    the matched entry key; for 'worktree-gitdir', the gitdir file that matched
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_GITDIR_FILES = 100;

/** Fold a path for comparison: forward slashes, `/c/` to `c:/`, lowercase, no trailing slash. */
export function normalizeRoot(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  s = s.replace(/^\/\/[?.]\//, ''); // extended-length prefix
  s = s.toLowerCase();
  s = s.replace(/^\/([a-z])(?=\/|$)/, '$1:');
  s = s.replace(/(?<=.)\/{2,}/g, '/');
  return s.replace(/\/+$/, '');
}

const isAbsoluteNorm = (s) => /^[a-z]:(\/|$)/.test(s) || s.startsWith('/');

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const isUnder = (child, root) => child === root || child.startsWith(root + '/');

const registryFile = (opts, env) =>
  opts.registryPath ||
  env.LANE_REGISTRY_PATH ||
  path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude', 'project-registry.json');

/** Read the registry. A missing or corrupt file gives []. */
export function loadRegistry(opts = {}) {
  const env = opts.env ?? process.env;
  let projects;
  try {
    const text = fs.readFileSync(registryFile(opts, env), 'utf8').replace(/^\uFEFF/, '');
    projects = JSON.parse(text).projects;
  } catch {
    return [];
  }
  if (!Array.isArray(projects)) return [];
  const out = [];
  for (const p of projects) {
    if (!p || typeof p !== 'object') continue;
    const e = p;
    const name = typeof e.name === 'string' ? e.name : '';
    const key = typeof e.key === 'string' && e.key ? e.key : slugify(name);
    if (!key) continue;
    const root = typeof e.path === 'string' ? normalizeRoot(e.path) : '';
    out.push({
      key,
      name,
      board: typeof e.laneBoard === 'string' && e.laneBoard ? e.laneBoard : key,
      status: typeof e.status === 'string' ? e.status : 'active',
      path: typeof e.path === 'string' ? e.path : '',
      root: root && isAbsoluteNorm(root) ? root : '',
      artifact: typeof e.laneArtifact === 'string' && e.laneArtifact ? e.laneArtifact : null,
    });
  }
  return out;
}

/** Normalised roots of every non-inactive registry entry whose board is `key`. No repeats, registry order. */
export function boardRoots(key, opts = {}) {
  const env = opts.env ?? process.env;
  const roots = loadRegistry({ ...opts, env })
    .filter((e) => e.status.toLowerCase() !== 'inactive' && e.board === key && e.root)
    .map((e) => e.root);
  return [...new Set(roots)];
}

/** True for a headless (SDK) session that has not opted back in. */
export function isHeadless(env = process.env) {
  return String(env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') && env.LANE_CONTEXT_HEADLESS !== '1';
}

function realNorm(p) {
  try {
    return normalizeRoot(fs.realpathSync.native(p));
  } catch {
    return normalizeRoot(p);
  }
}

/** Worktree dirs of one root, read from `.git/worktrees/<n>/gitdir`. No spawn. */
function worktreeDirs(entry) {
  const base = path.join(entry.path, '.git', 'worktrees');
  let names;
  try {
    names = fs.readdirSync(base).sort().slice(0, MAX_GITDIR_FILES);
  } catch {
    return [];
  }
  const found = [];
  for (const n of names) {
    const file = path.join(base, n, 'gitdir');
    try {
      let raw = (fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] ?? '').trim();
      if (!raw) continue;
      if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) raw = path.resolve(path.dirname(file), raw);
      raw = raw.replace(/\\/g, '/');
      if (!/\/\.git$/i.test(raw)) continue;
      const dir = realNorm(raw.slice(0, -5));
      if (dir && isAbsoluteNorm(dir)) found.push({ dir, file });
    } catch {
      // unreadable gitdir file: skip it
    }
  }
  return found;
}

function fromSelector(value, source, entries) {
  const live = entries.filter((e) => e.status.toLowerCase() !== 'inactive');
  const hit = live.find((e) => e.key === value) ?? live.find((e) => e.board === value);
  if (!hit) {
    const keys = [...new Set(live.map((e) => e.key))];
    throw new Error(`unknown board '${value}'; registered: ${keys.length ? keys.join(', ') : '(none)'}`);
  }
  return { key: hit.board, root: hit.root, source, via: hit.key };
}

/** Resolve the board for `cwd`, or null when it has none. Throws only for an unknown --project / LANE_PROJECT. */
export function resolveBoard(cwd, opts = {}) {
  const env = opts.env ?? process.env;
  if (!opts.cli && !opts.headlessOk && isHeadless(env)) return null;

  const entries = loadRegistry({ ...opts, env });
  if (opts.cli) {
    const flag = (opts.projectFlag ?? '').trim();
    if (flag) return fromSelector(flag, 'flag', entries);
    const fromEnv = String(env.LANE_PROJECT ?? '').trim();
    if (fromEnv) return fromSelector(fromEnv, 'env', entries);
  }

  const live = entries.filter((e) => e.status.toLowerCase() !== 'inactive' && e.root);
  const here = realNorm(cwd);

  let best = null;
  for (const e of live) {
    if (isUnder(here, e.root) && (!best || e.root.length > best.root.length)) best = e;
  }
  if (best) return { key: best.board, root: best.root, source: 'registry', via: best.key };

  let wt = null;
  for (const e of live) {
    for (const w of worktreeDirs(e)) {
      if (isUnder(here, w.dir) && (!wt || w.dir.length > wt.dir.length)) wt = { entry: e, ...w };
    }
  }
  if (wt) return { key: wt.entry.board, root: wt.entry.root, source: 'worktree-gitdir', via: wt.file };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Derived helpers (PR2). Pure: no cache, no DB. Hooks, lane.mjs and render-board all read these.
// ---------------------------------------------------------------------------------------------

/** The board every lane and event belongs to until a command says otherwise. */
export const DEFAULT_BOARD = 'continuous-claude';

/** Watermark row key: the bare session id on the default board, `<id>@<board>` on any other. */
export function wmKey(sid, board) {
  return board === DEFAULT_BOARD ? sid : `${sid}@${board}`;
}

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const userHome = (env) => fwd(env.CCV3_USER_HOME || os.homedir());

/** The primary checkout: `<CCV3_USER_HOME or home>/continuous-claude`, forward slashes, no literal `~`. */
export function primaryRepo(env = process.env) {
  return `${userHome(env)}/continuous-claude`;
}

/** The lane CLI shim that model-run text names: `<home>/.claude/scripts/lane.mjs`. */
export function laneShimPath(env = process.env) {
  return `${userHome(env)}/.claude/scripts/lane.mjs`;
}

/** The command a hint prints to run the lane CLI. */
export function laneCliCmd(env = process.env) {
  return `node ${laneShimPath(env)}`;
}

/** The command that renders one board's page. Absolute path to the primary checkout, never relative. */
export function renderBoardCmd(board, env = process.env) {
  return `node ${primaryRepo(env)}/scripts/coordination/render-board.mjs --project ${board}`;
}

/** The artifacts.json entry that holds the default board's phone page. */
const ARTIFACT_ID = 'agentic-os-lane-board';

const LANE_ARTIFACT_RE = /^https:\/\/claude\.ai\/artifact\/([A-Za-z0-9_-]+)$/;
const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The artifact id of a strict `https://claude.ai/artifact/<id>` url, else null. */
export function artifactIdOf(raw) {
  return (typeof raw === 'string' ? LANE_ARTIFACT_RE.exec(raw)?.[1] : undefined) ?? null;
}

/**
 * The phone page of a non-default board: the `laneArtifact` of the active registry entry where
 * `board === key === <board>` and key is not the default board. A nested entry (its `laneBoard` names another
 * board) and the default board's entry are ignored. The url is rebuilt from the id, never echoed. Null when the
 * key or url is malformed, or the id is also the default board's page or another board's.
 */
function registryBoardArtifact(board, opts, env) {
  if (!BOARD_KEY_RE.test(board)) return null;
  const owners = loadRegistry({ ...opts, env }).filter(
    (e) => e.status.toLowerCase() !== 'inactive' && e.key !== DEFAULT_BOARD && e.board === e.key && e.artifact !== null,
  );
  const mine = owners.filter((e) => e.key === board);
  const id = mine.length === 1 ? artifactIdOf(mine[0].artifact) : null;
  if (!id) return null;
  if (owners.some((e) => e !== mine[0] && artifactIdOf(e.artifact) === id)) return null;
  if (boardArtifact(DEFAULT_BOARD, { ...opts, env })?.id === id) return null;
  return { id, url: `https://claude.ai/artifact/${id}`, publishFrom: `lane-board-${board}.html` };
}

/**
 * The default board's page from `<primaryRepo>/.claude/artifacts.json`: the entry whose id is ARTIFACT_ID and whose
 * url is a strict `https://claude.ai/artifact/<id>` url. There is no fixed fallback id: a fixed id names the wrong
 * page after each switch of claude.ai account (card coord-board-id-followup, 2026-11-17). On any failure the page is
 * null and `problem` says why. Result: { page, problem }, exactly one of them not null.
 */
function readDefaultArtifact(opts, env) {
  const file = opts.artifactsPath || `${primaryRepo(env)}/.claude/artifacts.json`;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return { page: null, problem: `${file} is missing or unreadable` };
  }
  let list;
  try {
    list = JSON.parse(text).artifacts;
  } catch {
    return { page: null, problem: `${file} is not valid JSON` };
  }
  const entry = Array.isArray(list) ? list.find((a) => a && typeof a === 'object' && a.id === ARTIFACT_ID) : undefined;
  if (!entry) return { page: null, problem: `${file} has no ${ARTIFACT_ID} entry` };
  const id = artifactIdOf(entry.url);
  if (!id) return { page: null, problem: `the ${ARTIFACT_ID} url in ${file} is not https://claude.ai/artifact/<id>` };
  const publishFrom = typeof entry.publish_from === 'string' && entry.publish_from ? entry.publish_from : 'lane-board.html';
  return { page: { id, url: `https://claude.ai/artifact/${id}`, publishFrom }, problem: null };
}

/**
 * The published artifact of a board, or null when the board has none.
 *
 * The default board (continuous-claude) is the entry whose id is ARTIFACT_ID in `<primaryRepo>/.claude/artifacts.json`;
 * its url and publish_from come from that entry. A missing file, bad JSON, no entry or a url that is not a strict
 * artifact url gives null (boardArtifactProblem says why). artifacts.json gains NO new field: the primary checkout
 * edits that file too, and a PR2 hunk made land-pr's ff-merge refuse.
 *
 * Any other board has a page only when its own project-registry entry carries `laneArtifact` (see
 * registryBoardArtifact). No field, no page (null, render-only).
 * opts: { env, artifactsPath, registryPath }.
 */
export function boardArtifact(board, opts = {}) {
  const env = opts.env ?? process.env;
  if (board !== DEFAULT_BOARD) return registryBoardArtifact(board, opts, env);
  return readDefaultArtifact(opts, env).page;
}

/**
 * Why the default board has no page, or null. Null for every other board (no laneArtifact is not a fault) and for
 * a default board whose artifacts.json entry is good.
 */
export function boardArtifactProblem(board, opts = {}) {
  if (board !== DEFAULT_BOARD) return null;
  return readDefaultArtifact(opts, opts.env ?? process.env).problem;
}

/** File name stem of a pending-publish file: the watermark key, sanitised for a file name. */
export function pendingKey(sid, board) {
  return wmKey(sid, board).replace(/[^A-Za-z0-9@_-]/g, '_');
}
