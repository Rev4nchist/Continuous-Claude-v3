/**
 * Scoped cleanup: the one recursive delete destructive-command-guard allows (replay item 9.1).
 *
 * The whole command must be exactly ONE bare recursive delete of ONE literal absolute path:
 *   Bash:       rm -rf | rm -fr | rm -r -f | rm -f -r   <path>
 *   PowerShell: Remove-Item with -Recurse, optional -Force, and one path
 *               (-Path value, -LiteralPath value, or one positional value), any order
 * and the path must lie strictly inside (a) the current session scratchpad or (b)
 * <primary repo>/.claude/worktrees/<name> (the worktree directory itself counts).
 *
 * Hand lexers in guards never converge (memory: guard-shell-lexer-arms-race). So this is not a
 * shell parser. It is one anchored match per tool, a character blacklist on the path, and a
 * path check that fails closed. Any doubt returns null and the guard keeps its old behaviour:
 * ask when interactive, deny when unattended.
 *
 * Path checks, in order:
 *   1. absolute only; no `..` segment at all (a `link/..` is physical on disk but lexical here,
 *      so normalising it away would be wrong); Windows hazards (trailing dot/space, `:`) refused.
 *   2. lexical containment under the root, case-insensitive on Windows.
 *   3. real containment: realpath of the target (deepest existing ancestor when the target does
 *      not exist) must lie under the REAL root, so a junction or symlink that points out is refused.
 *      The worktrees root is anchored: its realpath must equal <real repo>/.claude/worktrees, so a
 *      junction AS `.claude` or `worktrees` is refused too.
 *   4. tree scan: lstat walk of the target. Any symlink or junction anywhere below it, an
 *      unreadable entry, or more than `maxEntries` (2000) entries refuses. A recursive delete may
 *      follow a nested junction (Windows PowerShell 5.1 has), so it is not checked once at the root only.
 *   Paths with any character outside printable ASCII are refused before all of this.
 *   Not covered: a swap between this check and the delete (TOCTOU).
 *
 * Scratchpad: <os tmpdir>/claude/<slug>/<session_id>/scratchpad. The session id comes from the
 * payload only. The slug is NOT derived: the project dir can differ from the payload cwd (cwd may be
 * a subfolder or a worktree), so any single slug segment is accepted. The exact session id and the
 * fixed `claude` and `scratchpad` names carry the match.
 *
 * Worktree root: the primary checkout that owns the payload cwd, PROVEN from plain fs reads
 * (lstat, readFileSync; no shell, no lexer). Git alone is not trusted: a planted `.git` FILE
 * (`gitdir: <other repo>/.git`) makes `git rev-parse --git-common-dir` name the OTHER repo (TREX
 * verify N3). The cwd itself must be a real path: its realpath equals its lexical path, so a cwd
 * reached through a junction or symlink is refused (git would follow it to another repo). The
 * nearest `.git` above the real cwd decides:
 *   - a real DIRECTORY with HEAD, objects and refs, and no `commondir` or `gitdir` file: that is the
 *     primary checkout;
 *   - a FILE `gitdir: <P>/.git/worktrees/<name>` (absolute or relative): the admin folder must name
 *     this exact file back in its `gitdir` and name `<P>/.git` in its `commondir`, and `<P>/.git`
 *     must be a genuine directory;
 *   - a link, a missing or odd entry, an empty `.git` directory or any failed check: no match.
 * Then `git rev-parse --git-common-dir` must name the same directory (second witness; a mismatch,
 * no git or a git failure means no match). Not covered: `GIT_CEILING_DIRECTORIES`, bare repos and
 * `--separate-git-dir` primaries; they fail closed. The repo is whatever repo the payload cwd
 * resolves to: any `.claude/worktrees/<x>` of that repo is deletable, including a worktree of
 * another session. The log row carries the cwd, so an audit can name the repo.
 *
 * Every function here catches its own errors and returns "no match": a throw in decide() would
 * reach main()'s fail-open catch and allow the command.
 */

import { execFileSync } from 'child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as nodePath from 'path';

export type ScopedKind = 'scratchpad' | 'worktree';

export interface ScopedCleanupDeps {
  platform?: NodeJS.Platform;
  /** The OS temp dir the scratchpad lives under. Default os.tmpdir(). */
  tmpdir?: string;
  /** Resolve symlinks and junctions. Throws when the path does not exist. */
  realpath?: (p: string) => string;
  /** Absolute path of the git common dir for a cwd, or null. */
  gitCommonDir?: (cwd: string) => string | null;
  /** Most entries the nested-link scan reads before it gives up and refuses. Default 2000. */
  maxEntries?: number;
}

export interface ScopedCleanupInput {
  tool_name?: string;
  tool?: string;
  session_id?: string;
  cwd?: string;
}

const BASH_RM = /^rm[ \t]+(?:-rf|-fr|-r[ \t]+-f|-f[ \t]+-r)[ \t]+(?:'([^']*)'|"([^"]*)"|([^\s'"]+))$/;
const PS_HEAD = /^Remove-Item[ \t]+/i;
const PS_TOKEN = /[ \t]*(-[A-Za-z]+(?=[ \t]|$)|'[^']*'|"[^"]*"|[^\s'"]+)/y;

/**
 * Anything outside printable ASCII (control characters, smart quotes, look-alikes such as U+212A
 * Kelvin, which toLowerCase folds to `k` but NTFS does not), and the characters that make a path more
 * than one literal: expansion, globs, chaining, redirection. Both roots are ASCII on this machine.
 */
const PATH_BLACKLIST = /[^\x20-\x7e]|[$`%*?[\]{}~;&|<>()!#,@]/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** The literal path of a lone `rm -rf <path>`, or null. */
function bashRmPath(command: string): string | null {
  const m = BASH_RM.exec(command);
  if (!m) return null;
  const [, single, double, bare] = m;
  if (bare !== undefined && bare.includes('\\')) return null; // bash eats the backslash
  if (double !== undefined && /\\[\\$`"]|\\$/.test(double)) return null; // an escape inside double quotes
  return single ?? double ?? bare ?? null;
}

/** The literal path of a lone `Remove-Item -Recurse [-Force] <path>`, or null. */
function powershellPath(command: string): string | null {
  const head = PS_HEAD.exec(command);
  if (!head) return null;
  PS_TOKEN.lastIndex = head[0].length;
  const tokens: string[] = [];
  let end = head[0].length;
  for (let m = PS_TOKEN.exec(command); m; m = PS_TOKEN.exec(command)) {
    tokens.push(m[1]);
    end = PS_TOKEN.lastIndex;
  }
  if (command.slice(end).trim() !== '') return null;
  return interpretPowershellTokens(tokens);
}

function unquote(token: string): string | null {
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) return token.slice(1, -1);
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) return token.slice(1, -1);
  if (token.startsWith("'") || token.startsWith('"')) return null;
  return token;
}

function interpretPowershellTokens(tokens: string[]): string | null {
  let recurse = false;
  let force = false;
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (lower === '-recurse') { if (recurse) return null; recurse = true; continue; }
    if (lower === '-force') { if (force) return null; force = true; continue; }
    if (lower === '-path' || lower === '-literalpath') {
      const value = tokens[++i];
      if (value === undefined || /^-[A-Za-z]/.test(value)) return null;
      const v = unquote(value);
      if (v === null) return null;
      paths.push(v);
      continue;
    }
    if (/^-[A-Za-z]/.test(t)) return null; // any other parameter
    const v = unquote(t);
    if (v === null) return null;
    paths.push(v);
  }
  if (!recurse || paths.length !== 1) return null;
  return paths[0];
}

function literalPath(command: string, tool: string): string | null {
  if (/[\r\n\u0000]/.test(command)) return null;
  const c = command.trim();
  if (!c) return null;
  const path = tool === 'PowerShell' ? powershellPath(c) : tool === 'Bash' ? bashRmPath(c) : null;
  if (!path || path.startsWith('-') || PATH_BLACKLIST.test(path)) return null;
  return path;
}

interface Ctx {
  platform: NodeJS.Platform;
  p: typeof nodePath.win32;
  realpath: (p: string) => string;
}

/** Absolute, normalised path, or null. Refuses `..` segments and Windows name tricks. */
function absolute(raw: string, tool: string, ctx: Ctx): string | null {
  let s = raw;
  if (ctx.platform === 'win32') {
    if (tool === 'Bash') { // Git Bash spells C:\x as /c/x
      const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
      if (m) s = `${m[1]}:${m[2] ?? '/'}`;
    }
    if (!/^[a-zA-Z]:[\\/]/.test(s) || s.slice(2).includes(':')) return null;
    if (s.split(/[\\/]/).includes('..')) return null;
    const out = ctx.p.resolve(s);
    return out.split('\\').slice(1).some((seg) => /[. ]$/.test(seg)) ? null : out;
  }
  if (!s.startsWith('/') || s.split('/').includes('..')) return null;
  return ctx.p.resolve(s);
}

const fold = (s: string, ctx: Ctx): string => (ctx.platform === 'win32' ? s.toLowerCase() : s);

/** Segments of `target` below `base`, or null when it is not strictly inside. */
function below(base: string, target: string, ctx: Ctx): string[] | null {
  const b = fold(base, ctx).replace(/[\\/]+$/, '');
  const t = fold(target, ctx);
  if (!t.startsWith(b + ctx.p.sep)) return null;
  const rest = target.slice(b.length + 1).split(ctx.p.sep).filter(Boolean);
  return rest.length ? rest : null;
}

/** realpath of the deepest existing ancestor plus the missing tail; null when nothing resolves. */
function realResolve(p: string, ctx: Ctx): string | null {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const r = ctx.realpath(cur);
      return tail.length ? ctx.p.join(r, ...tail.reverse()) : r;
    } catch { /* walk up */ }
    const parent = ctx.p.dirname(cur);
    if (parent === cur) return null;
    tail.push(ctx.p.basename(cur));
    cur = parent;
  }
}

function sameName(a: string, b: string, ctx: Ctx): boolean {
  return fold(a, ctx) === fold(b, ctx);
}

/** [slug, session id, 'scratchpad', ...at least one more] below <tmp>/claude. */
function isScratchShape(segs: string[] | null, sessionId: string, ctx: Ctx): boolean {
  return !!segs && segs.length >= 4 && sameName(segs[1], sessionId, ctx) && sameName(segs[2], 'scratchpad', ctx);
}

function inScratchpad(target: string, real: string, sessionId: string, tmp: string, ctx: Ctx): boolean {
  if (!SESSION_ID.test(sessionId)) return false;
  const realClaude = realResolve(ctx.p.join(tmp, 'claude'), ctx);
  if (!realClaude) return false;
  const realTmp = realResolve(tmp, ctx);
  const lexicalBases = [ctx.p.join(tmp, 'claude'), ...(realTmp ? [ctx.p.join(realTmp, 'claude')] : [])];
  const lexical = lexicalBases.some((base) => isScratchShape(below(base, target, ctx), sessionId, ctx));
  return lexical && isScratchShape(below(realClaude, real, ctx), sessionId, ctx);
}

function defaultGitCommonDir(cwd: string): string | null {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env,
    }).trim();
    return out ? nodePath.resolve(cwd, out) : null;
  } catch { return null; }
}

/** lstat kind of a path, or null when it is missing or unreadable. A link is reported as 'link'. */
function kindOf(p: string): 'file' | 'dir' | 'link' | 'other' | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 'link';
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch { return null; }
}

function realOf(p: string, ctx: Ctx): string | null {
  try { return ctx.realpath(p); } catch { return null; }
}

/** First line of a small plain file, or null. The files read here are a few hundred bytes. */
function readSmall(p: string): string | null {
  if (kindOf(p) !== 'file') return null;
  try {
    if (statSync(p).size > 4096) return null;
    const text = readFileSync(p, 'utf8');
    return text.includes('\0') ? null : text;
  } catch { return null; }
}

/** A `.git` DIRECTORY that looks like a repo and redirects nowhere (no `commondir`, no `gitdir`). */
function isGenuineGitDir(dir: string): boolean {
  return kindOf(dir) === 'dir'
    && kindOf(nodePath.join(dir, 'HEAD')) === 'file'
    && kindOf(nodePath.join(dir, 'objects')) === 'dir'
    && kindOf(nodePath.join(dir, 'refs')) === 'dir'
    && kindOf(nodePath.join(dir, 'commondir')) === null
    && kindOf(nodePath.join(dir, 'gitdir')) === null;
}

/** The single path in a `gitdir: <path>` file, resolved against the folder that holds the file. */
function gitdirTarget(gitFile: string, ctx: Ctx): string | null {
  const text = readSmall(gitFile);
  const m = text === null ? null : /^gitdir:[ \t]*([^\r\n]+?)[ \t]*\r?\n?$/.exec(text);
  return m ? ctx.p.resolve(ctx.p.dirname(gitFile), m[1]) : null;
}

/** The one-line path inside a worktree admin file (`gitdir`, `commondir`), resolved against `adminDir`. */
function adminPath(adminDir: string, name: string, ctx: Ctx): string | null {
  const text = readSmall(ctx.p.join(adminDir, name));
  const line = text === null ? null : /^([^\r\n]+?)[ \t]*\r?\n?$/.exec(text);
  return line ? ctx.p.resolve(adminDir, line[1]) : null;
}

/**
 * The primary `.git` directory proven by a linked worktree's `.git` FILE, or null. The file must
 * name `<P>/.git/worktrees/<name>`, and that admin folder must name this exact file back (`gitdir`)
 * and name `<P>/.git` as its common dir (`commondir`). A planted file has no such backlink.
 */
function primaryGitFromWorktreeFile(gitFile: string, ctx: Ctx): string | null {
  const adminDir = gitdirTarget(gitFile, ctx);
  if (!adminDir) return null;
  const worktrees = ctx.p.dirname(adminDir);
  const primaryGit = ctx.p.dirname(worktrees);
  if (!sameName(ctx.p.basename(worktrees), 'worktrees', ctx) || !sameName(ctx.p.basename(primaryGit), '.git', ctx)) return null;
  if (!isGenuineGitDir(primaryGit) || kindOf(adminDir) !== 'dir') return null;
  const realPrimary = realOf(primaryGit, ctx);
  const realAdmin = realOf(adminDir, ctx);
  if (!realPrimary || !realAdmin) return null;
  // `worktrees` must not be a link out of the primary .git.
  if (!sameName(realAdmin, ctx.p.join(realPrimary, 'worktrees', ctx.p.basename(adminDir)), ctx)) return null;
  const back = adminPath(adminDir, 'gitdir', ctx);
  const common = adminPath(adminDir, 'commondir', ctx);
  const realBack = back ? realOf(back, ctx) : null;
  const realFile = realOf(gitFile, ctx);
  const realCommon = common ? realOf(common, ctx) : null;
  if (!realBack || !realFile || !realCommon) return null;
  if (!sameName(realBack, realFile, ctx) || !sameName(realCommon, realPrimary, ctx)) return null;
  return primaryGit;
}

/**
 * The primary `.git` directory of the repo that owns `cwd`, proven from the files on disk, or null.
 * The nearest `.git` entry above the real cwd decides (as git's own discovery does), so a planted
 * `.git` in a subfolder is never skipped for a real repo further up. A link, an empty or redirecting
 * `.git` directory, a `.git` file without a verified backlink, or no `.git` at all gives null.
 */
function provenGitDir(cwd: string, ctx: Ctx): string | null {
  const real = realOf(cwd, ctx);
  if (!real) return null;
  for (let dir = real; ; dir = ctx.p.dirname(dir)) {
    const dotGit = ctx.p.join(dir, '.git');
    const kind = kindOf(dotGit);
    if (kind === 'dir') return isGenuineGitDir(dotGit) ? dotGit : null;
    if (kind === 'file') return primaryGitFromWorktreeFile(dotGit, ctx);
    if (kind !== null) return null; // a link or something odd named .git
    if (ctx.p.dirname(dir) === dir) return null;
  }
}

/**
 * <primary>/.claude/worktrees for the repo that owns cwd. Two independent witnesses must agree:
 * the on-disk proof above and `git rev-parse --git-common-dir`. Git alone follows a planted
 * `.git` file to another repo, so it is never trusted by itself.
 */
function worktreesRoot(cwd: string | undefined, deps: ScopedCleanupDeps, ctx: Ctx): string | null {
  if (!cwd || !ctx.p.isAbsolute(cwd)) return null;
  // A cwd reached through a junction or symlink (itself or any parent) is the same redirect class:
  // git and the on-disk proof both follow it to the repo it points at. Refuse unless the real path
  // is the lexical path (case-folded on Windows). 8.3 short names and `\\?\` forms also refuse.
  const realCwd = realOf(cwd, ctx);
  if (!realCwd || !sameName(realCwd, ctx.p.resolve(cwd), ctx)) return null;
  const proven = provenGitDir(cwd, ctx);
  if (!proven || !sameName(ctx.p.basename(proven), '.git', ctx)) return null;
  const common = (deps.gitCommonDir ?? defaultGitCommonDir)(cwd);
  if (!common) return null;
  const realProven = realOf(proven, ctx);
  const realCommon = realOf(common, ctx);
  if (!realProven || !realCommon || !sameName(realProven, realCommon, ctx)) return null;
  return ctx.p.join(ctx.p.dirname(proven), '.claude', 'worktrees');
}

/**
 * The root must be exactly <real repo>/.claude/worktrees. If `.claude` or `worktrees` is a junction
 * or symlink, the real root lies elsewhere and is refused: following it would make everything under
 * the junction target deletable.
 */
function inWorktrees(target: string, real: string, wtRoot: string, ctx: Ctx): boolean {
  const realRepo = realResolve(ctx.p.dirname(ctx.p.dirname(wtRoot)), ctx);
  const realRoot = realResolve(wtRoot, ctx);
  if (!realRepo || !realRoot) return false;
  if (!sameName(realRoot, ctx.p.join(realRepo, '.claude', 'worktrees'), ctx)) return false;
  const lexical = [wtRoot, realRoot].some((base) => below(base, target, ctx) !== null);
  return lexical && below(realRoot, real, ctx) !== null;
}

const DEFAULT_MAX_ENTRIES = 2000;

/**
 * True only when `root` and everything below it is a plain file or directory, and the tree has at
 * most `max` entries. A symlink or junction anywhere (a recursive delete may descend into it), an
 * unreadable entry or a tree over the cap returns false. A root that does not exist is clean:
 * there is nothing to delete.
 */
function treeIsPlain(root: string, max: number, ctx: Ctx): boolean {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    let st;
    try { st = lstatSync(dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && dir === root) return true;
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { return false; }
    seen += names.length;
    if (seen > max) return false;
    for (const n of names) stack.push(ctx.p.join(dir, n));
  }
  return true;
}

function rootKind(
  target: string, real: string, tmp: string, input: ScopedCleanupInput, deps: ScopedCleanupDeps, ctx: Ctx,
): ScopedKind | null {
  if (typeof input.session_id === 'string' && inScratchpad(target, real, input.session_id, tmp, ctx)) return 'scratchpad';
  const wtRoot = worktreesRoot(input.cwd, deps, ctx);
  return wtRoot && inWorktrees(target, real, wtRoot, ctx) ? 'worktree' : null;
}

/**
 * Which allowed root the command's single recursive delete lies in, or null (keep today's
 * behaviour). Never throws.
 */
export function scopedCleanupKind(
  command: string,
  input: ScopedCleanupInput,
  deps: ScopedCleanupDeps = {},
): ScopedKind | null {
  try {
    const tool = input.tool_name || input.tool || 'Bash';
    const raw = literalPath(command, tool);
    if (!raw) return null;
    const platform = deps.platform ?? process.platform;
    const ctx: Ctx = {
      platform,
      p: platform === 'win32' ? nodePath.win32 : nodePath.posix,
      realpath: deps.realpath ?? ((p) => realpathSync.native(p)),
    };
    const target = absolute(raw, tool, ctx);
    if (!target) return null;
    const real = realResolve(target, ctx);
    if (!real) return null;
    const tmp = ctx.p.resolve(deps.tmpdir ?? tmpdir());
    const kind = rootKind(target, real, tmp, input, deps, ctx);
    if (!kind) return null;
    return treeIsPlain(real, deps.maxEntries ?? DEFAULT_MAX_ENTRIES, ctx) ? kind : null;
  } catch {
    return null;
  }
}
