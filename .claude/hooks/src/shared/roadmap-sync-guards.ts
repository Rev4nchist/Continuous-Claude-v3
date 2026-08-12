/**
 * ROADMAP auto-sync write guards (QW-12 — closes D2d-09, D2d-10, D2d-13).
 *
 * Sibling to shared/project-relevance.ts (the QW-03 cross-project contamination
 * guard, D2d-01/02/03). That guard answers "does this TEXT belong to THIS
 * project vs a sibling?". The two ROADMAP auto-sync hooks need two DIFFERENT
 * axes the content-relevance guard cannot see, so they are factored here:
 *
 *  - isTasksRelatedToGoal  (D2d-09)  feature ↔ goal relatedness, so a 100%
 *    tasks-*.md does not falsely mark an UNRELATED current goal complete.
 *  - isPathInsideProject   (D2d-13)  path.relative containment, so a sibling
 *    dir sharing a name prefix (continuous-claude-x) no longer bypasses the
 *    startsWith() boundary check.
 *  - commitRanInProject    (D2d-10)  effective-cwd verification, so a
 *    `cd <other-repo> && git commit` does not write a foreign repo's commit
 *    into this project's ROADMAP. project-relevance cannot detect this — the
 *    commit message carries no foreign-project token; the signal is the `cd`.
 *
 * Used by:
 *  - prd-roadmap-sync.ts   (isTasksRelatedToGoal, isPathInsideProject)
 *  - git-commit-roadmap.ts (commitRanInProject)
 */

import * as path from 'path';
import { homedir } from 'node:os';

/**
 * Generic tokens that must NEVER, on their own, make a tasks file look related
 * to a ROADMAP goal. Mirrors the IDENTITY_STOPWORDS philosophy from
 * shared/project-relevance.ts: infrastructure-generic words appear in many
 * unrelated feature/goal titles, so they carry no distinctive relatedness
 * signal.
 */
const GOAL_STOPWORDS = new Set<string>([
  'system',
  'app',
  'platform',
  'engine',
  'server',
  'service',
  'module',
  'project',
  'feature',
  'support',
  'the',
  'and',
  'for',
  'with',
  'new',
  'update',
  'fix',
  'add',
]);

/** Distinctive lowercased word tokens (length >= 3, stopwords removed). */
function distinctiveTokens(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !GOAL_STOPWORDS.has(w)),
  );
}

/**
 * D2d-09: Is a tasks file's feature name related to a ROADMAP goal title?
 *
 * The pre-fix hook marked `roadmap.current.title` complete on ANY 100% tasks
 * file, with no relatedness check. This restores a positive-evidence
 * requirement: relatedness needs a shared DISTINCTIVE token (or a direct
 * phrase containment) — a shared generic/stopword token ("service", "system")
 * is not enough. Returns false on empty input (fail-safe: do not complete).
 */
export function isTasksRelatedToGoal(featureName: string, goalTitle: string): boolean {
  const f = (featureName || '').toLowerCase().trim();
  const g = (goalTitle || '').toLowerCase().trim();
  if (!f || !g) return false;

  // Direct phrase containment is always related.
  if (g.includes(f) || f.includes(g)) return true;

  const featureTokens = distinctiveTokens(featureName);
  const goalTokens = distinctiveTokens(goalTitle);
  // No distinctive signal on either side -> cannot establish relatedness.
  if (featureTokens.size === 0 || goalTokens.size === 0) return false;

  for (const t of goalTokens) {
    if (featureTokens.has(t)) return true;
  }
  return false;
}

/**
 * D2d-13: Is targetPath contained within projectDir?
 *
 * Uses path.relative instead of startsWith — a sibling directory sharing a name
 * prefix (e.g. `<root>/continuous-claude-x` vs `<root>/continuous-claude`) is
 * correctly reported as OUTSIDE. A relative path that starts with `..` or is
 * absolute (a different drive on Windows) means the target escapes the project.
 */
export function isPathInsideProject(targetPath: string, projectDir: string): boolean {
  if (!targetPath || !projectDir) return false;
  const rel = path.relative(path.resolve(projectDir), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Translate an MSYS/Git-Bash or Cygwin absolute path into Windows form.
 *
 * THE BUG THIS FIXES (found 2026-08-05 while proving the H2 autocommit):
 * `cd /c/Users/dave/repo && git commit` was silently SKIPPED by
 * commitRanInProject. `path.isAbsolute('/c/Users/...')` is true on Windows, so
 * `path.resolve` kept the leading slash and produced `C:\c\Users\...` — the
 * drive letter became a DIRECTORY name — which of course is not inside the
 * project, so every commit made that way was treated as foreign. `/c/...` is
 * the form the Bash tool produces whenever a command `cd`s first, i.e. the
 * common case, which is why the Completed log looked so sparse.
 *
 * Windows-only by design: on a real POSIX host `/c/x` is a legitimate path and
 * must not be rewritten.
 */
export function normalizeShellPath(p: string): string {
  if (!p || process.platform !== 'win32') return p;
  // /cygdrive/c/x -> C:/x
  let m = p.match(/^\/cygdrive\/([A-Za-z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${m[2] || '/'}`;
  // /c/x -> C:/x  (single-letter first segment only, so /tmp and /usr survive)
  m = p.match(/^\/([A-Za-z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${m[2] || '/'}`;
  return p;
}

/**
 * Git global options that consume a SEPARATE following token as their value.
 * A scanner that does not know these mistakes the value for the subcommand
 * (`git -C /path commit` would read `/path` as the subcommand and miss it).
 */
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
]);

/** Tokens that end one command in a compound line. */
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/** Split a command into tokens, honouring single and double quotes. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

export interface GitCommitInvocation {
  /** Value of `-C <dir>` (or `--work-tree=<dir>`), else null. */
  cTarget: string | null;
  /** True when the invocation carries --amend. */
  hasAmend: boolean;
}

/**
 * Find every `git [global-opts] commit` invocation in a (possibly compound)
 * command, returning the directory-affecting global options for each.
 *
 * Tokenizing rather than substring-matching is what makes `git -C <dir> commit`
 * visible at all — `command.includes('git commit')` is false for it, which is
 * the second half of the 2026-08-05 finding: such commits were invisible to the
 * hook, and `git -C` is the form .claude/rules/windows-platform.md actively
 * recommends for the PowerShell tool.
 */
export function parseGitCommitInvocations(command: string): GitCommitInvocation[] {
  if (!command) return [];
  const tokens = tokenizeCommand(command);
  const found: GitCommitInvocation[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // `git` must be its own token (not `mygit`, not `git-foo`).
    if (tokens[i].toLowerCase() !== 'git' && !/[\\/]git(\.exe)?$/i.test(tokens[i])) continue;

    let cTarget: string | null = null;
    let j = i + 1;
    let subcommand: string | null = null;

    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.startsWith('-')) {
        const eq = tok.indexOf('=');
        if (eq > 0) {
          const name = tok.slice(0, eq);
          if (name === '--work-tree' || name === '--git-dir') cTarget = tok.slice(eq + 1);
          j += 1;
          continue;
        }
        if (GIT_VALUE_OPTS.has(tok)) {
          if (tok === '-C') cTarget = tokens[j + 1] ?? null;
          j += 2; // skip the option AND its value
          continue;
        }
        j += 1; // boolean flag (-P, --no-pager, --bare, ...)
        continue;
      }
      subcommand = tok;
      break;
    }

    if (subcommand?.toLowerCase() !== 'commit') continue;

    // --amend is checked by TOKEN EQUALITY, not against the joined remainder.
    // Joining loses quote boundaries, so `git commit -m "mentions --amend"`
    // read as an amend and the commit went unrecorded. A quoted message arrives
    // as one token, which can never equal '--amend'. (Caught by its own test.)
    let hasAmend = false;
    for (let k = j + 1; k < tokens.length; k++) {
      if (SHELL_SEPARATORS.has(tokens[k])) break; // don't read the NEXT command's flags
      if (tokens[k] === '--amend') { hasAmend = true; break; }
    }

    found.push({ cTarget, hasAmend });
    i = j; // continue scanning after this invocation
  }

  return found;
}

/** True when the command contains at least one `git ... commit` (any option form). */
export function containsGitCommit(command: string): boolean {
  return parseGitCommitInvocations(command).length > 0;
}

/**
 * Extract the directory a command `cd`s into BEFORE running `git commit`, or
 * null when the command does not change directory ahead of the commit.
 *
 * Scoped to the text before the first `git ... commit` so a `cd` that appears
 * AFTER the commit (or the literal word "cd" inside the commit message) does
 * not falsely register. Handles bare, single-quoted and double-quoted targets,
 * anchored at the command start or after a shell separator (`;` `&` `|` `&&`).
 */
export function extractCdTarget(command: string): string | null {
  if (!command) return null;
  // Only consider a directory change that happens before the git commit. The
  // inner group must also swallow a value-taking global option's value, or
  // `git -C /path commit` would not match and the whole command would be
  // treated as the scope.
  const commitIdx = command.search(/git\s+(?:-[^\s]+(?:\s+[^\s-]\S*)?\s+)*commit\b/i);
  const scope = commitIdx >= 0 ? command.slice(0, commitIdx) : command;
  const m = scope.match(/(?:^|[;&|]\s*|&&\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}

/** Resolve one path token to an absolute path, expanding `~` and MSYS drives. */
function resolveShellTarget(target: string, base: string): string {
  let resolved = normalizeShellPath(target);
  if (resolved === '~' || resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    resolved = path.join(homedir(), resolved.slice(1));
  }
  return path.isAbsolute(resolved) ? path.resolve(resolved) : path.resolve(base, resolved);
}

/**
 * D2d-10: Did a `git commit` command run inside THIS project?
 *
 * The git-commit-roadmap hook records commits into the session project's
 * ROADMAP, but a `cd <other-repo> && git commit` (routine for ~/.claude quick
 * fixes) ran in a foreign repo. We verify the effective working directory:
 *  - no `cd`, no `-C`             -> ran in cwd == projectDir          -> allow
 *  - `cd` into projectDir/subdir  -> still inside the project          -> allow
 *  - `cd` into another/sibling dir -> foreign repo                     -> block
 *  - `git -C <dir>`               -> that dir wins over cwd            -> checked
 *
 * `-C` coverage added 2026-08-05. It is NOT optional politeness: the sibling fix
 * taught `isGitCommitCommand` to recognise `git -C <dir> commit`, which had been
 * invisible to the hook. Recognising it WITHOUT checking `-C` here would have
 * re-opened D2d-10 through a new door — `git -C ../other-repo commit` writing a
 * foreign commit into this project's ROADMAP. The two changes are a pair.
 *
 * A relative `-C` resolves against the `cd` target when both are present
 * (`cd sub && git -C deeper commit`), matching real shell semantics.
 */
export function commitRanInProject(command: string, projectDir: string): boolean {
  const cdTarget = extractCdTarget(command);
  const cwd = cdTarget ? resolveShellTarget(cdTarget, projectDir) : path.resolve(projectDir);

  if (cdTarget && !isPathInsideProject(cwd, projectDir)) return false;

  // Any -C that escapes the project blocks the write, even if the cwd was fine.
  for (const invocation of parseGitCommitInvocations(command)) {
    if (!invocation.cTarget) continue;
    const effective = resolveShellTarget(invocation.cTarget, cwd);
    if (!isPathInsideProject(effective, projectDir)) return false;
  }

  return true;
}
