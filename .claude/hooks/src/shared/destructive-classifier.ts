/**
 * Destructive-command classifier (pure, no side effects).
 *
 * Split out of destructive-command-guard.ts on 2026-09-23 so permission-auto-allow can
 * ask the same question ("is this command destructive?") without importing the guard,
 * whose module auto-runs main() on import. The guard re-exports everything here, so
 * existing imports from destructive-command-guard.js keep working.
 */

// Each pattern is HIGH blast radius (irreversible / large scope) and chosen to
// avoid matching the safe everyday form (e.g. recursive rm only, not `rm -f file`;
// force-push only, not plain push; DB drops only inside a DB-CLI invocation).
export interface DPattern { name: string; re: RegExp; }
export const DESTRUCTIVE_PATTERNS: DPattern[] = [
  // filesystem — recursive deletion only (single-file `rm -f x` is allowed).
  // Scans across SPLIT flag tokens so `rm -f -r x` / `rm --force --recursive x`
  // are caught, not just `rm -rf`. The terminal flag must be a SHORT cluster
  // containing r/R (-r, -rf, -fr) OR the long --recursive — NOT any long flag that
  // merely contains the letter r (round-2 FP fix: `rm --force` / `--verbose` /
  // `--interactive` are single-file deletes and must stay allowed).
  { name: 'recursive rm', re: /\brm(?:\s+-{1,2}[^\s]+)*\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive\b)/i },
  { name: 'find -delete', re: /\bfind\b[^&|;]*-delete\b/i },
  { name: 'find -exec(dir) rm', re: /\bfind\b[^&|;]*-exec(?:dir)?\s+rm\b/i },
  // bulk delete via xargs — e.g. `find … | xargs rm`. Catches the non-recursive
  // form too (plain `xargs rm`), which the recursive-rm pattern alone misses.
  { name: 'xargs rm', re: /\bxargs\b[^|&;]*\brm\b/i },
  // rsync --delete removes dest files absent from source; with an empty/sparse source
  // it wipes the destination tree. Only the --delete* variants are gated.
  { name: 'rsync --delete', re: /\brsync\b[^&|;]*--delete(-\w+)?\b/i },
  { name: 'dd to/from device', re: /\bdd\s+[^&|;]*\b(if|of)=/i },
  { name: 'mkfs', re: /\bmkfs(\.\w+)?\b/i },
  // shred/wipefs/blkdiscard are bare verbs — anchor to a command POSITION (start,
  // or after a separator) so the word as an ARGUMENT (`echo shred`, `grep -r shred .`)
  // does NOT false-trigger (round-2 FP fix).
  { name: 'shred', re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?shred\b/i },
  { name: 'wipefs (disk signature wipe)', re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?wipefs\b/i },
  { name: 'blkdiscard (device discard)', re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?blkdiscard\b/i },
  { name: 'truncate to zero', re: /\btruncate\s+-s\s*0\b/i },
  { name: 'write to block device', re: /(?:>|of=)\s*\/dev\/(sd|nvme|disk|hd)/i },
  // Windows cmd recursive/force delete (also reached via the `cmd /c …` wrapper).
  // rmdir /s is the Windows recursive form; POSIX `rmdir foo` (empty-dir only) has
  // no /s and stays allowed.
  { name: 'rd/rmdir /s (recursive)', re: /\b(?:rd|rmdir)\b[^&|;]*\s\/s\b/i },
  { name: 'del /f|/s (force/recursive)', re: /\bdel\b[^&|;]*\s\/[fs]\b/i },
  // git — history rewrite / working-tree or remote destruction
  { name: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git push --force', re: /\bgit\s+push\b[^&|;]*(--force(-with-lease)?|\s-f\b)/i },
  { name: 'git push --delete', re: /\bgit\s+push\b[^&|;]*(--delete|\s-d\b)/i },
  { name: 'git push --mirror', re: /\bgit\s+push\b[^&|;]*--mirror\b/i },
  // colon-refspec remote delete: `git push origin :branch`. The leading SPACE before
  // the colon distinguishes it from `src:dst` (a normal push to a remote branch).
  { name: 'git push :refspec delete', re: /\bgit\s+push\b[^&|;]*\s:[^\s]/i },
  { name: 'git clean -f', re: /\bgit\s+clean(?:\s+-{1,2}[^\s]+)*\s+-{1,2}[^\s]*f[^\s]*/i },
  { name: 'git checkout discard', re: /\bgit\s+checkout\s+(--|\.)/i },
  // git restore discarding the WORKTREE (parity with `git checkout .`/`--`). `--staged`-only
  // (reversible unstage) and single-file `git restore file` are NOT gated (accepted).
  { name: 'git restore discard', re: /\bgit\s+restore\b[^&|;]*(--worktree\b|\s\.(?:\s|$))/i },
  { name: 'git switch --discard-changes', re: /\bgit\s+switch\b[^&|;]*--discard-changes\b/i },
  // case-SENSITIVE on the force letter so `git branch -d` (lowercase, merged-only,
  // safe) is NOT flagged — only `-D` / `-fD` / `--delete --force` (round-2 FP fix).
  { name: 'git branch -D', re: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete|-[a-zA-Z]*D[a-zA-Z]*\s)/ },
  { name: 'git worktree remove --force', re: /\bgit\s+worktree\s+remove\b[^&|;]*(--force|\s-f\b)/i },
  { name: 'git submodule deinit -f', re: /\bgit\s+submodule\s+deinit\b[^&|;]*(--force|\s-f\b)/i },
  // bare `git rebase` rewrites history, but the recovery subcommands UNDO / continue an
  // in-progress rebase and must not be gated (round-2 FP fix).
  { name: 'git rebase', re: /\bgit\s+rebase\b(?!\s+(--abort|--continue|--skip|--quit|--edit-todo|--show-current-patch)\b)/i },
  { name: 'git stash clear/drop', re: /\bgit\s+stash\s+(clear|drop)\b/i },
  // `git stash -u` / `--include-untracked` / `--all` sweeps UNTRACKED files out of the
  // working tree; they come back only if someone finds and pops that stash. On 2026-09-17
  // this emptied a pre-demo FourthBot artifacts folder (45 files), recovered only because the
  // stash survived. Plain `git stash` (tracked changes) and pop/apply/list stay allowed.
  { name: 'git stash -u (sweeps untracked files)', re: /\bgit\s+stash\b(?!\s+(?:list|show|pop|apply|branch|drop|clear|create|store)\b)[^&|;]*\s(?:-u|--include-untracked|-a|--all)\b/i },
  { name: 'git update-ref -d', re: /\bgit\s+update-ref\s+-d\b/i },
  { name: 'git reflog expire', re: /\bgit\s+reflog\s+expire\b/i },
  { name: 'git gc --prune', re: /\bgit\s+gc\b[^&|;]*--prune/i },
  { name: 'git filter-branch/repo', re: /\bgit\s+filter-(branch|repo)\b/i },
  // docker — volume/image/system destruction
  { name: 'docker prune', re: /\bdocker\s+(system|volume|network|container|image)\s+prune\b/i },
  { name: 'docker volume rm', re: /\bdocker\s+volume\s+rm\b/i },
  { name: 'docker force rm', re: /\bdocker\s+(rm|rmi)\s+[^&|;]*(--force|-f\b|-\w*f\b)/i },
];
// PowerShell TOOL only. On the PowerShell tool a recursive delete is the command itself,
// unquoted, so it can be gated without the false-positive problem described below (which is
// about the Bash tool, where `Remove-Item` only ever appears inside a quoted payload). Aliases:
// ri, rm, rmdir, rd, del, erase. -r / -rec / -Recurse all abbreviate -Recurse.
export const POWERSHELL_PATTERNS: DPattern[] = [
  { name: 'PowerShell recursive delete (Remove-Item -Recurse)', re: /(?:^|[;|&({]|\s)(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s-(?:r|rec|recurse)\w*\b/i },
  { name: 'PowerShell recursive delete ([IO.Directory]::Delete $true)', re: /\[(?:System\.)?IO\.Directory\]::Delete\([^)]*,\s*\$true\s*\)/i },
];

// NOTE: DB drops (psql/sqlite3 -c "DROP TABLE …") and, on the BASH tool, PowerShell
// Remove-Item are intentionally NOT gated here. Their payload is inherently inside quotes, which
// stripQuotedStrings() removes, and the same keywords appear constantly in
// migration commit messages — gating them produces more false-positives than
// value. Those destructive paths stay covered by: the settings deny rule
// (neonctl *delete*), the per-tool safety rules (neonctl/kusto/databases skills),
// and the human confirm-first convention. This Bash guard owns UNQUOTED shell ops.

/**
 * Strip quoted-string CONTENTS so destructive keywords that live inside a
 * commit message, echo arg, or other string literal don't false-trigger
 * (e.g. `git commit -m "... git reset --hard ..."`). Best-effort, non-nested:
 * handles "..." and '...' with backslash escapes. Real destructive commands
 * are unquoted (`rm -rf build`, `git push --force`) so they still match.
 * NOTE: this strip is for the TOP-LEVEL scan only. A destructive op WRAPPED in
 * `bash -c "rm -rf /"` or hidden in a command substitution `"$(rm -rf x)"` /
 * `` "`rm -rf x`" `` is NO LONGER a blind spot (Phase 1b): classifyDestructive
 * separately recurses into executable payloads via parseExecutable, so those
 * match too — while quoted MESSAGE text (not at a command position, or in single
 * quotes) still does not false-trigger.
 */
export function stripQuotedStrings(command: string, tool: string = 'Bash'): string {
  if (tool === 'PowerShell') {
    // PowerShell quoting: backslash is NOT an escape (`"C:\repo\"` is a complete string);
    // the escape character is the backtick, and '' is a literal quote inside '...'.
    // Using bash rules here let `"C:\repo\" reset --hard` swallow the rest of the command.
    return command
      .replace(/"(?:[^"`]|`.)*"/g, '""')
      .replace(/'(?:[^']|'')*'/g, "''");
  }
  return command
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Quote-aware parse of a shell command into the pieces bash would actually
 * EXECUTE, so the classifier can recurse into payloads stripQuotedStrings would
 * otherwise hide (the documented blind spot). Returns:
 *   - segments: top-level command segments, split on UNQUOTED ; && || | & and
 *     newlines (quotes preserved). A shell-wrapper (bash -c "...") is treated as
 *     real only when it BEGINS a segment, so "bash -c ..." text inside a
 *     -m "..." message (not at a segment start) is not mistaken for an invocation.
 *   - substitutions: contents of $(...) and `...` that bash WOULD run -- i.e.
 *     those NOT inside single quotes (top-level and double-quoted substitutions
 *     execute; single-quoted are literal). Catches the commit-message backtick
 *     incident class: git commit -m "... `rm -rf x` ...".
 * Best-effort + defensive; callers wrap this and fail OPEN on any error.
 */
export function parseExecutable(command: string): { segments: string[]; substitutions: string[] } {
  const segments: string[] = [];
  const substitutions: string[] = [];
  let seg = '';
  let inSingle = false;
  let inDouble = false;
  const n = command.length;
  let i = 0;
  const pushSeg = () => { const t = seg.trim(); if (t) segments.push(t); seg = ''; };

  while (i < n) {
    const c = command[i];
    const next = command[i + 1];

    if (inSingle) {
      seg += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && next !== undefined) { seg += c + next; i += 2; continue; }
      if (c === '"') { inDouble = false; seg += c; i++; continue; }
      if (c === '$' && next === '(') {
        const { inner, end } = readBalanced(command, i + 2, '(', ')');
        substitutions.push(inner);
        seg += command.slice(i, end); i = end; continue;
      }
      if (c === '`') {
        const { inner, end } = readBacktick(command, i + 1);
        substitutions.push(inner);
        seg += command.slice(i, end); i = end; continue;
      }
      seg += c; i++;
      continue;
    }
    // top level (unquoted)
    if (c === '\\' && next !== undefined) { seg += c + next; i += 2; continue; }
    if (c === "'") { inSingle = true; seg += c; i++; continue; }
    if (c === '"') { inDouble = true; seg += c; i++; continue; }
    if (c === '$' && next === '(') {
      const { inner, end } = readBalanced(command, i + 2, '(', ')');
      substitutions.push(inner);
      seg += command.slice(i, end); i = end; continue;
    }
    if (c === '`') {
      const { inner, end } = readBacktick(command, i + 1);
      substitutions.push(inner);
      seg += command.slice(i, end); i = end; continue;
    }
    if (c === ';' || c === '\n') { pushSeg(); i++; continue; }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) { pushSeg(); i += 2; continue; }
    if (c === '|' || c === '&') { pushSeg(); i++; continue; }
    seg += c; i++;
  }
  pushSeg();
  return { segments, substitutions };
}

/** Read until the matching close of a $(...) group (quote- and nesting-aware). */
function readBalanced(s: string, start: number, open: string, close: string): { inner: string; end: number } {
  let depth = 1;
  let i = start;
  let inS = false;
  let inD = false;
  while (i < s.length) {
    const c = s[i];
    if (inS) { if (c === "'") inS = false; i++; continue; }
    if (inD) { if (c === '\\') { i += 2; continue; } if (c === '"') inD = false; i++; continue; }
    if (c === "'") { inS = true; i++; continue; }
    if (c === '"') { inD = true; i++; continue; }
    if (c === '$' && s[i + 1] === open) { depth++; i += 2; continue; }
    if (c === open) { depth++; i++; continue; }
    if (c === close) { depth--; if (depth === 0) return { inner: s.slice(start, i), end: i + 1 }; i++; continue; }
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}

/** Read until the matching closing backtick. */
function readBacktick(s: string, start: number): { inner: string; end: number } {
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') return { inner: s.slice(start, i), end: i + 1 };
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}

// A shell-wrapper at a COMMAND POSITION: a segment that, after optional
// sudo/env/VAR= prefixes, begins with a shell interpreter invoked with an exec
// flag whose flag-cluster ends in the exec letter (-c / -lc / -Command / /c).
// The payload is the following quoted string (or rest-of-segment). [^'"]*? skips
// intermediate flags but stops before the payload's opening quote.
const WRAPPER_RES: RegExp[] = [
  // POSIX shells: bash|sh|zsh|dash|ksh|ash ... -c|-...c "<payload>". The launcher
  // prefix allows flags (env -i, sudo -E) before the interpreter (round-2 fix).
  /^(?:(?:sudo|env|nohup|time)(?:\s+-\S+)*\s+|[^\s=]+=\S+\s+)*(?:bash|sh|zsh|dash|ksh|ash)\b[^'"]*?\s-[a-z]*c\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i,
  // PowerShell: powershell|pwsh ... -c|-Command "<payload>"
  /^(?:(?:sudo|env)\s+)?(?:powershell|pwsh)(?:\.exe)?\b[^'"]*?\s-c(?:ommand)?\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i,
  // cmd: cmd[.exe] /c|/k "<payload>"
  /^(?:(?:sudo|env)\s+)?cmd(?:\.exe)?\b[^'"]*?\s\/[ck]\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i,
];

function unwrapPayload(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\(["'`$\\])/g, '$1');
}

function wrapperPayloadsFromSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    for (const re of WRAPPER_RES) {
      const m = seg.match(re);
      if (m && m[1]) { out.push(unwrapPayload(m[1])); break; }
    }
  }
  return out;
}

/**
 * Payloads of shell-wrapper invocations (bash -c "...", powershell -Command
 * "...", cmd /c "...") found at a command position. These are commands the
 * wrapper will execute, so classifyDestructive recurses into them.
 */
export function extractShellWrapperPayloads(command: string): string[] {
  try { return wrapperPayloadsFromSegments(parseExecutable(command).segments); }
  catch { return []; }
}

/**
 * Pure classifier -- returns the first matching destructive pattern name, or null.
 * Scans the quote-stripped top-level command, then RECURSES into executable
 * payloads it would otherwise miss: shell-wrapper bodies (bash -c "...") and
 * command substitutions ($()/backticks bash executes). Depth-bounded; fail-open.
 */
/**
 * Drop git's GLOBAL options (`-C <path>`, `-c k=v`, `--git-dir`, `--work-tree`, `--no-pager`,
 * `-P`) so `git -C repo reset --hard` reads as `git reset --hard`. Every git pattern above
 * expects the subcommand right after `git`, so the `git -C` form -- the normal form on this
 * machine -- passed ungated (found 2026-09-23 while adding the PowerShell tool, P42).
 */
export function normalizeGitGlobalOptions(scan: string): string {
  return scan.replace(
    /\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--no-pager|--no-replace-objects|--bare|-P))+)(?=\s)/gi,
    'git',
  );
}

export function classifyDestructive(command: string, depth = 0, tool: string = 'Bash'): string | null {
  if (!command || typeof command !== 'string') return null;
  const scan = normalizeGitGlobalOptions(stripQuotedStrings(command, tool));
  const patterns = tool === 'PowerShell' ? [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS] : DESTRUCTIVE_PATTERNS;
  for (const p of patterns) {
    if (p.re.test(scan)) return p.name;
  }
  if (depth < 4) {
    try {
      // parseExecutable follows bash rules, where a backtick starts a command substitution.
      // In PowerShell the backtick is only the escape character, so drop `x escapes first,
      // or an escaped quote in a message ("say `"git reset --hard`"") parses as a command.
      const parseInput = tool === 'PowerShell' ? command.replace(/`./g, '') : command;
      const { segments, substitutions } = parseExecutable(parseInput);
      const payloads = [...wrapperPayloadsFromSegments(segments), ...substitutions];
      for (const payload of payloads) {
        const inner = classifyDestructive(payload, depth + 1, tool);
        if (inner) return inner;
      }
    } catch {
      // fail-open: a parser hiccup must never brick the guard
    }
  }
  return null;
}
