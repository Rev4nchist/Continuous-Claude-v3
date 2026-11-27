/**
 * Tap scope: which folders outside CCv3 the decision gate judges (card coord-decision-gate-app-repos, rule R2; seat answers S2, S5, S6).
 *
 * A folder is covered when its git toplevel EQUALS the root of a live registry entry, or it is a worktree whose main root equals one.
 * The nearest entry decides and stops: the toplevel entry first, then the main-root entry. An inactive entry, or one with
 * "tapGate": "off", never falls through to another entry. The continuous-claude entry and any CCv3 checkout are never covered here:
 * the old CCv3 code judges CCv3.
 *
 * This file reads the RAW registry JSON itself (path argument, else LANE_REGISTRY_PATH, else <home>/.claude/project-registry.json).
 * It does not use the board key or resolveBoard of lane-board.ts (seat answer S2). Seat review 1, item 4: a file that does not parse is
 * read once more before it counts as 'corrupt' (the gate then denies a push, create or merge outside CCv3); 'missing' stays an allow.
 * LIMIT (seat answer S2): any session can edit the registry or its mirror. Coverage guards against a slip, not against a session
 * that edits the registry to dodge the gate.
 *
 * Sync, no database, no process start. Every file access goes through injected functions (TapScopeDeps); the defaults use fs.
 * F8: an entry root is kept RAW (normPath). A compare tries the raw folder, then its realpath, and resolves entry roots only when neither
 * matched. A root or folder on a network path (// or \\, the rule of claim-target.ts) is never resolved: a sync call there has no time limit.
 * underLiveRoot is the path test the gate runs before any git call: a live root at or above the folder, or the main root that the .git
 * FILE of a linked worktree names (gitdir, then commondir, as claim-target.ts commonDirOf reads it).
 * The functions of scripts/github/lib/repo-identity.mjs come in through the typed door at the end; esbuild bundles the .mjs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-ignore TS7016: repo-identity.mjs has no declaration file.
import * as identity from '../lib/repo-identity.mjs';

export type RegistryState = 'missing' | 'corrupt' | 'ok';
/** `github`: the raw github field of the entry (owner/repo), the key repo of a remote URL with no github.com slug (F5). */
export interface TapEntry { key: string; root: string; status: string; tapGate: string | null; github: string | null }
/**
 * `envPath` (seat review 1, item 4): present and true only when LANE_REGISTRY_PATH named the file (not the path argument, not the home
 * copy). The gate shows its one notice line for a MISSING file named that way.
 */
export interface Registry { state: RegistryState; entries: TapEntry[]; file: string; envPath?: true }
export interface TapScopeDeps {
  /** Read a file as UTF-8 text (the registry; the .git file walk of underLiveRoot). Throws as fs does (err.code 'ENOENT' for a missing file). */
  readFile?: (file: string) => string;
  /** Real path of a folder. Throws when it cannot resolve; the raw path is used then. readRegistry no longer calls it (F8). */
  realpath?: (p: string) => string;
  homedir?: () => string;
}
export interface ReadRegistryOptions { path?: string; env?: NodeJS.ProcessEnv; deps?: TapScopeDeps }

export type CoverageReason = 'ccv3' | 'no-entry' | 'inactive' | 'off' | 'ccv3-root' | 'registry-missing' | 'registry-corrupt' | 'covered';
export interface Coverage { covered: boolean; entryKey: string | null; reason: CoverageReason; github?: string | null }
export interface CoverageInput { toplevel: string; worktreeMainRoot?: string | null; isCcv3: boolean }

const CCV3_ENTRY = 'continuous-claude';
const readUtf8 = (file: string): string => fs.readFileSync(file, 'utf8');
const realNative = (p: string): string => fs.realpathSync.native(p);
/**
 * A path on a network share (// or \\ after the \\?\ prefix is gone): the rule of claim-target.ts isNetworkPath (not exported there).
 * A sync file call on a share has no time limit, so such a path is compared raw and never resolved (F8).
 */
const isNetwork = (p: string): boolean => /^\/\//.test(normPath(p));

/**
 * Fold a path for an equality test: forward slashes, no \\?\ prefix, /c/ to c:/, lower case on a drive path only, no trailing slash.
 * The rule lives in repo-identity.mjs, so app-ask.mjs folds a registry root the same way (fix round 1).
 */
export const normPath: (p: string) => string = identity.normPath;

const isAbsolute = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);

/** normPath of the real path when it resolves, else of the raw path. A relative or empty path gives ''. A network path is never resolved. */
function realNorm(p: string, realpath: (p: string) => string): string {
  if (!p || !isAbsolute(p)) return '';
  if (isNetwork(p)) return normPath(p);
  try {
    return normPath(realpath(p));
  } catch {
    return normPath(p);
  }
}

function registryFile(opts: ReadRegistryOptions): string {
  const env = opts.env ?? process.env;
  if (opts.path) return opts.path;
  if (env.LANE_REGISTRY_PATH) return env.LANE_REGISTRY_PATH;
  const home = env.USERPROFILE || env.HOME || (opts.deps?.homedir ?? os.homedir)();
  return path.join(home, '.claude', 'project-registry.json');
}

const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** One entry with its RAW root (normPath, no realpath: F8). An entry root is resolved only when a compare finds no raw match (entryReal). */
function entryOf(item: unknown): TapEntry | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const e = item as Record<string, unknown>;
  const key = typeof e.key === 'string' && e.key ? e.key : slugify(typeof e.name === 'string' ? e.name : '');
  const raw = typeof e.path === 'string' ? e.path : '';
  const root = raw && isAbsolute(raw) ? normPath(raw) : '';
  if (!key || !root) return null;
  const status = typeof e.status === 'string' ? e.status : 'active';
  return { key, root, status, tapGate: typeof e.tapGate === 'string' ? e.tapGate : null, github: typeof e.github === 'string' ? e.github : null };
}

/**
 * Read the registry. ENOENT is 'missing'; any other read error, bad JSON or a `projects` that is not an array is 'corrupt'.
 * Seat review 1, item 4: a corrupt read is tried once more (a session may be writing the file); the second answer stands. The gate DENIES
 * a push, create or merge outside CCv3 on 'corrupt', so one torn read must not block. `envPath` marks a file named by LANE_REGISTRY_PATH.
 */
export function readRegistry(opts: ReadRegistryOptions = {}): Registry {
  const file = registryFile(opts);
  const named = !opts.path && Boolean((opts.env ?? process.env).LANE_REGISTRY_PATH);
  const first = readOnce(file, opts);
  const r = first.state === 'corrupt' ? readOnce(file, opts) : first;
  return named ? { ...r, envPath: true } : r;
}

function readOnce(file: string, opts: ReadRegistryOptions): Registry {
  let text: string;
  try {
    text = (opts.deps?.readFile ?? readUtf8)(file);
  } catch (err) {
    return { state: (err as { code?: unknown })?.code === 'ENOENT' ? 'missing' : 'corrupt', entries: [], file };
  }
  let projects: unknown;
  try {
    projects = (JSON.parse(text.replace(/^\uFEFF/, '')) as { projects?: unknown }).projects;
  } catch {
    return { state: 'corrupt', entries: [], file };
  }
  if (!Array.isArray(projects)) return { state: 'corrupt', entries: [], file };
  const entries = projects.map(entryOf).filter((e): e is TapEntry => e !== null);
  return { state: 'ok', entries, file };
}

const notCovered = (reason: CoverageReason, entryKey: string | null = null): Coverage => ({ covered: false, entryKey, reason });

/** The real root of an entry (a network root stays raw). Only called when no raw compare matched. */
const entryReal = (e: TapEntry, realpath: (p: string) => string): string => realNorm(e.root, realpath);

/**
 * The first entry whose root passes `test` for one of the folder spellings: the raw folder against the raw roots first, then the real
 * folder, and only then the real roots (F8: a raw match needs no realpath of any entry root, and a network root is never resolved).
 */
function firstEntry(dir: string, entries: TapEntry[], realpath: (p: string) => string, test: (folder: string, root: string) => boolean): TapEntry | null {
  if (!dir || !isAbsolute(dir)) return null;
  const raw = normPath(dir);
  const byRaw = entries.find((e) => test(raw, e.root));
  if (byRaw) return byRaw;
  const real = realNorm(dir, realpath);
  const byReal = entries.find((e) => test(real, e.root));
  if (byReal) return byReal;
  return entries.find((e) => [raw, real].some((folder) => test(folder, entryReal(e, realpath)))) ?? null;
}

const sameDir = (folder: string, root: string): boolean => folder === root;
/** `root` is the folder or a folder above it, by whole path segments (D:/Work/App is not above D:/Work/Apple). */
const isUnder = (folder: string, root: string): boolean => folder === root || folder.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The entry that decides for a folder: the first entry whose root equals the toplevel, else the first that equals the main root. */
function nearestEntry(input: CoverageInput, entries: TapEntry[], realpath: (p: string) => string): TapEntry | null {
  return firstEntry(input.toplevel, entries, realpath, sameDir) ?? firstEntry(input.worktreeMainRoot ?? '', entries, realpath, sameDir);
}

/** Is this folder judged by the app tap gate? isCcv3 is tested first, so a CCv3 checkout never gets a registry reason. */
export function coverageOf(input: CoverageInput, registry: Registry, deps: Pick<TapScopeDeps, 'realpath'> = {}): Coverage {
  if (input.isCcv3) return notCovered('ccv3');
  if (registry.state === 'missing') return notCovered('registry-missing');
  if (registry.state === 'corrupt') return notCovered('registry-corrupt');
  const entry = nearestEntry(input, registry.entries, deps.realpath ?? realNative);
  if (!entry) return notCovered('no-entry');
  if (entry.key === CCV3_ENTRY) return notCovered('ccv3-root', entry.key);
  if (entry.status.toLowerCase() === 'inactive') return notCovered('inactive', entry.key);
  if (entry.tapGate?.trim().toLowerCase() === 'off') return notCovered('off', entry.key);
  return { covered: true, entryKey: entry.key, reason: 'covered', github: entry.github };
}

// ---------- the path test: no git process (F8, fix round 1) ----------

export interface PathTestOptions {
  /** Also false when the folder is under the continuous-claude root (a git throw there may be a CCv3 checkout: keep its old scope). */
  outsideCcv3?: boolean;
}
const isLive = (e: TapEntry): boolean => e.key !== CCV3_ENTRY && e.status.toLowerCase() !== 'inactive' && e.tapGate?.trim().toLowerCase() !== 'off';
const parentOf = (p: string): string => { const up = p.replace(/\/[^/]*$/, ''); return up === '' ? '/' : up; };
const dotGitOf = (dir: string): string => (dir.endsWith('/') ? `${dir}.git` : `${dir}/.git`);

/** The main root named by the text of a .git FILE (a linked worktree): gitdir, then its commondir. Null when it names no <root>/.git. */
function rootOfGitFile(top: string, text: string, readFile: (p: string) => string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = joinPath(top, m[1]);
  let common = gitdir;
  try { common = joinPath(gitdir, readFile(`${gitdir}/commondir`).trim()); } catch { /* no commondir: the gitdir is the common dir */ }
  return common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : null;
}

/** `rel` under `base`, both in normPath form, with . and .. folded. The same on every platform (a drive path on Linux CI too). */
function joinPath(base: string, rel: string): string {
  if (isAbsolute(rel)) return normPath(rel);
  return normPath(path.posix.normalize(`${normPath(base)}/${rel.replace(/\\/g, '/')}`));
}

/**
 * The main root of a linked worktree that holds `dir`, read from files only (as claim-target.ts commonDirOf): the nearest `.git` on the
 * walk up decides. A `.git` folder (a main checkout), a read error other than not-found, or no `.git` at all: null.
 */
function worktreeRootOf(dir: string, readFile: (p: string) => string): string | null {
  let cur = normPath(dir);
  for (let i = 0; i < 64; i++) {
    let text: string | null = null;
    try { text = readFile(dotGitOf(cur)); } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    if (text !== null) return rootOfGitFile(cur, text, readFile);
    const up = parentOf(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * True when a live entry root (not continuous-claude, not inactive, not off) is the folder or a folder above it, or is the main root of
 * the linked worktree that holds it. Reads files only, never starts git: the gate runs it before any git call for coverage, so an
 * unregistered folder costs no process start. A network folder is compared raw only (no realpath, no file read).
 */
export function underLiveRoot(dir: string, registry: Registry, deps: Pick<TapScopeDeps, 'realpath' | 'readFile'> = {}, opts: PathTestOptions = {}): boolean {
  if (registry.state !== 'ok' || !dir || !isAbsolute(dir)) return false;
  const realpath = deps.realpath ?? realNative;
  if (opts.outsideCcv3 && firstEntry(dir, registry.entries.filter((e) => e.key === CCV3_ENTRY), realpath, isUnder)) return false;
  const live = registry.entries.filter(isLive);
  if (firstEntry(dir, live, realpath, isUnder)) return true;
  if (isNetwork(dir)) return false;
  const main = worktreeRootOf(dir, deps.readFile ?? readUtf8);
  return main !== null && firstEntry(main, live, realpath, isUnder) !== null;
}

// ---------- typed door to scripts/github/lib/repo-identity.mjs ----------

/** Lowercased 'owner/repo' of a github.com remote URL, else null. */
export const repoSlug: (url: unknown) => string | null = identity.repoSlug;
/**
 * The repo part of a decision key for one target: no URL is 'local:<entryKey>'; a github.com URL its slug; a host URL whose owner/repo
 * equals the github field that repo; any other URL or path 'local:<entryKey>:<target>'. Null when it needs the entry key and has none.
 */
export const keyRepo: (a: { url?: string | null; entryKey?: string | null; github?: string | null }) => string | null = identity.keyRepo;
/** One plain line (NFKC, control and format characters to a space, single spaces, trimmed), clipped to max code points with an ellipsis. */
export const oneLine: (text: unknown, max: number) => string = identity.oneLine;

/** A git call of one folder, as Deps.git gives it. */
export type GitRun = (args: string[]) => { status: number; stdout: string };
export interface KeyIdentity { entryKey?: string | null; github?: string | null }
export type PushKeyResult =
  | { ok: true; key: string; remote: string; branch: string; configured: boolean }
  | { ok: false; why: 'name-remote' | 'unknown-remote' | 'no-key' | 'multi-pushurl' | 'no-branch'; remote?: string; keys?: string[]; key?: string };
export type GhKeyResult =
  | { ok: true; key: string; remote: string | null }
  | { ok: false; why: 'repo-differs' | 'two-remotes' | 'unnamed' | 'fetch-push-differ' | 'no-key'; key?: string | null; remote?: string | null; remotes?: string[]; pushKeys?: (string | null)[] };
/** The key of a push (repo-identity.mjs pushKey): the push URLs of the remote, the destination branch. app-ask.mjs builds the same. */
export const pushKey: (git: GitRun, o: KeyIdentity & { remote?: string | null; branch?: string | null }) => PushKeyResult = identity.pushKey;
/** The key of a create or merge (repo-identity.mjs ghKey): the fetch repo of a remote, or the named repo when a remote fetches it. */
export const ghKey: (git: GitRun, o: KeyIdentity & { named?: string | null }) => GhKeyResult = identity.ghKey;
/** Fixer G, item 4: the remote and branch a push takes when the command names none (repo-identity.mjs pushDefaults, the rule of pushKey). */
export const pushDefaults: (git: GitRun, remote?: string | null) => { remote: string | null; branch: string } = identity.pushDefaults;
/** Fixer G, item 4: the remote gh reads for a create or a merge with no -R (repo-identity.mjs ghRemote, the rule of app-ask). */
export const ghRemote: (git: GitRun) => string | null = (git) => identity.ghRemote(git);
/** Fix round 5 (F8): the open-pr key of an app repo, repo@branch plus :base when the create names one (repo-identity.mjs openPrKey). */
export const openPrKey: (a: { repo: string; branch: string; base?: string | null }) => string = identity.openPrKey;
/** Fixer G, item 7: an SSH host alias remote URL of an entry with no github field (repo-identity.mjs needsGithubField). */
export const needsGithubField: (url: string, github: string | null) => boolean = identity.needsGithubField;
