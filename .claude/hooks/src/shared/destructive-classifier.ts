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

/**
 * A long option and every prefix of it down to `min` chars, as a regex source: abbrev('force', 3) is
 * `for(?:c(?:e)?)?`. git parse-options accepts any unique prefix (`git clean --fo` is --force, R4).
 * `min` is the shortest prefix no other option of that subcommand shares.
 */
const abbrev = (word: string, min: number): string =>
  word.slice(0, min) + [...word.slice(min)].reduceRight((rest, c) => `(?:${c}${rest})?`, '');
// Each git subcommand has its own `[^;&|\n]*` scan, so the flag may sit anywhere after the subcommand.
const gitFlag = (sub: string, flags: string): RegExp => new RegExp(String.raw`\bgit\s+${sub}\b[^;&|\n]*\s(?:${flags})`, 'i');
// `git checkout` long options git rejects together with a pathspec, so they can only switch or create a
// branch (B2, F2). -b/-B are short options and never reach this list. Every other long option
// (--guess, --recurse-submodules, --overwrite-ignore, --patch ...) is accepted before a path and asks.
const CHECKOUT_SWITCH_OPTIONS = String.raw`(?:track|no-track|detach|orphan)`;

export const DESTRUCTIVE_PATTERNS: DPattern[] = [
  // filesystem — recursive deletion only (single-file `rm -f x` is allowed).
  // The flag may sit ANYWHERE after rm (`rm -f -r x`, `rm build -rf`, F04). It must be a SHORT
  // cluster containing r/R (-r, -rf, -fr) OR the long --recursive — NOT any long flag that
  // merely contains the letter r (round-2 FP fix: `rm --force` / `--verbose` /
  // `--interactive` are single-file deletes and must stay allowed). `(?<![-\w])` keeps
  // `docker run --rm -it` out; `(?=\s)` keeps `$(echo rm) -rf` an accepted gap. One bounded scan:
  // the old `(?:\s+-{1,2}[^\s]+)*` split `--a` two ways and took 4 s on 28 repeats (F16).
  { name: 'recursive rm', re: /(?<![-\w])rm(?=\s)[^;&|\n]*?\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i },
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
  // --hard anywhere after reset (`git reset HEAD~3 --hard`, `git reset -q --hard`, F05).
  // Abbreviations count (`--har`, R4).
  { name: 'git reset --hard', re: gitFlag('reset', String.raw`--${abbrev('hard', 1)}\b`) },
  // Force push: --force, a short cluster with f (-f, -uf, -fu), or a +refspec (`origin +main`, F05).
  // `--for` and longer (R4): --follow-tags shares `--fo`. --force-with-lease matches at the `-` boundary.
  { name: 'git push --force', re: new RegExp(String.raw`\bgit\s+push\b[^&|;]*(?:--${abbrev('force', 3)}\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)`, 'i') },
  { name: 'git push --delete', re: /\bgit\s+push\b[^&|;]*(--delete|\s-d\b)/i },
  { name: 'git push --mirror', re: /\bgit\s+push\b[^&|;]*--mirror\b/i },
  // colon-refspec remote delete: `git push origin :branch`. The leading SPACE before
  // the colon distinguishes it from `src:dst` (a normal push to a remote branch).
  { name: 'git push :refspec delete', re: /\bgit\s+push\b[^&|;]*\s:[^\s]/i },
  // One bounded scan (F16: the old `(?:\s+-{1,2}[^\s]+)*` backtracked exponentially on `--a` runs).
  // `--f` and longer (R4): --force is the only clean option that starts with f.
  { name: 'git clean -f', re: gitFlag('clean', String.raw`--${abbrev('force', 1)}\b|-[a-zA-Z]*f`) },
  // Anywhere after checkout (`git checkout main -- src`, F05): a bare `--`; a path that starts with `.`
  // (`.`, `./src`, `../x`: a ref name cannot start with a dot, R3); -f; and ANY long option outside the
  // branch-switch set (B2: --no-overlay, --quiet, --merge, --conflict=x restore files). This covers every
  // abbreviation too (R4: `--forc`, `--theirs`, `--pathspec-from-file`). An abbreviated switch (`--det`) asks.
  { name: 'git checkout discard', re: gitFlag('checkout', String.raw`--(?=\s|$)|\.|-[a-zA-Z]*f[a-zA-Z]*\b|--(?!${CHECKOUT_SWITCH_OPTIONS}(?=[\s=]|$))\w`) },
  // git restore discarding the WORKTREE (parity with `git checkout .`/`--`). `--staged`-only
  // (reversible unstage) and single-file `git restore file` are NOT gated (accepted).
  { name: 'git restore discard', re: /\bgit\s+restore\b[^&|;]*(--worktree\b|\s\.(?:\s|$))/i },
  { name: 'git switch --discard-changes', re: /\bgit\s+switch\b[^&|;]*--discard-changes\b/i },
  // case-SENSITIVE on the force letter so `git branch -d` (lowercase, merged-only,
  // safe) is NOT flagged — only `-D` / `-fD` / `--delete --force` (round-2 FP fix).
  { name: 'git branch -D', re: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete|-[a-zA-Z]*D[a-zA-Z]*\s)/ },
  // `git branch -f main abc123` moves a branch and drops the commits it pointed at (F05).
  // `--forc` and longer (R4): --format shares `--for`.
  { name: 'git branch -f (force move)', re: gitFlag('branch', String.raw`(?:-[a-zA-Z]*f[a-zA-Z]*|--${abbrev('force', 4)})\b`) },
  // `git checkout -B x main` and `git switch -C x main` reset an existing branch the same way (CR 299).
  // Case-SENSITIVE on the letter: lowercase -b / -c only create a new branch and stay allowed.
  { name: 'git checkout -B / switch -C (force reset a branch)', re: /\bgit\s+(?:checkout\b[^;&|\n]*\s-[a-zA-Z]*B[a-zA-Z]*\b|switch\b[^;&|\n]*\s(?:-[a-zA-Z]*C[a-zA-Z]*\b|--force-c(?:r(?:e(?:a(?:t(?:e)?)?)?)?)?\b))/ },
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
  // `docker compose down -v` deletes the project's named volumes (F05).
  // `down` is a whole word (`-f down.yml` is a file, R5). The lookahead takes the FIRST down and the
  // backreference consumes it atomically, so a failed `-v` scan never retries a later down (two greedy
  // scans around down were cubic on `docker compose down` x500). A -v after any down is after the first.
  { name: 'docker compose down --volumes', re: /\bdocker(?:-compose|\s+compose)\b(?=([^;&|\n]*?\sdown(?=\s|$)))\1[^;&|\n]*\s(?:-v|--volumes)\b/i },
];

// Fabric guards (skill-intake-fabric Phase 1). Suspend, resume, resize or delete of a capacity stops,
// bills or removes every workload on it; a bulk PUT to dataAccessRoles replaces ALL OneLake roles.
// REST calls carry the URL in QUOTES, which stripQuotedStrings() blanks, so these patterns run on the
// raw command SEGMENTS (quotes kept, split on ; & | and newlines). Each must START with the command, after
// zero or more lead-ins, so an echo, a commit message or a grep that only names the URL never matches.
// Lead-ins: VAR=x, `$x =`, `[void]`, `(`, `{`, `try {`, `if (...) {`, `ForEach-Object {`, `&`, sudo.
// A VAR=x value runs to the next whitespace: if it could stop early, `x=/nohup` also split into `x=/` and
// the `nohup` item, and a run of those took exponential time (found in the round-2 C1 audit).
const LEAD_ITEM = String.raw`(?:[A-Za-z_]\w*=\S*(?=\s|$)|\$\w+\s*=|\[\w+\]|\(|\{|\)|&|\.|sudo|time|nohup|call|(?:try|else|finally|do|ForEach-Object|ForEach|Where-Object|%)\s*\{|(?:if|elseif|foreach|while|switch)\s*\((?:[^()]|\([^()]*\))*\)\s*\{)`;
const SEG_START = String.raw`^\s*(?:${LEAD_ITEM}\s*)*`;
const HTTP_CLIENT = String.raw`(?:az(?:\.cmd|\.exe)?\s+rest|fab(?:\.exe)?\s+api|curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|Invoke-AzRestMethod|irm|iwr)\b`;
// The HTTP method, any spelling: --method x, --request x, -X x, -m x, -Method x, -Method:x, -CustomMethod x, -Meth x.
const methodIs = (verbs: string): string =>
  String.raw`(?=.*(?:(?:--method|--request|-(?:Custom)?Meth\w*)[\s=:]+["']?(?:${verbs})\b|\s-[Xm]\s*["']?(?:${verbs})\b))`;
// An ARM capacity resource itself (not a subpath such as /skus), with or without a host, trailing slash allowed.
const CAPACITY_RESOURCE = String.raw`.*(?:Microsoft\.(?:Fabric|PowerBIDedicated)/|management\.azure\.com\S*/)capacities/[^/\s"'?#]+/?(?:[?#"'\s]|$)`;
const seg = (rest: string): RegExp => new RegExp(SEG_START + rest, 'i');
export const SEGMENT_PATTERNS: DPattern[] = [
  { name: 'Fabric capacity suspend/resume/resize/delete', re: seg(String.raw`az(?:\.cmd|\.exe)?\s+fabric\s+capacity\s+(?:suspend|resume|update|delete)\b`) },
  { name: 'Az.Fabric capacity cmdlet (suspend/resume/update/remove)', re: seg(String.raw`(?:Suspend|Resume|Update|Remove)-AzFabricCapacity\b`) },
  // az resource on a capacity: delete, update (--set sku...), create (PUT), invoke-action suspend|resume.
  { name: 'az resource change of a Fabric capacity', re: seg(String.raw`az(?:\.cmd|\.exe)?\s+resource\s+(?:delete|update|create|invoke-action)\b.*Microsoft\.(?:Fabric|PowerBIDedicated)/capacities`) },
  // Fabric CLI verbs that act on a capacity path (.capacities/<name>.Capacity). Case-sensitive on purpose.
  { name: 'Fabric CLI capacity stop/start/set/rm/create', re: new RegExp(SEG_START + String.raw`fab(?:\.exe)?\s+(?:stop|start|set|rm|create)\b.*(?:\.capacities[\\/]|\.Capacity(?:["'\s]|$))`) },
  { name: 'Fabric capacity suspend/resume via REST', re: seg(HTTP_CLIENT + String.raw`.*/capacities/[^/\s"'?#]+/(?:suspend|resume)\b`) },
  // ARM PATCH, PUT or DELETE on the capacity resource itself changes its SKU or removes it. GET and subpaths stay allowed.
  { name: 'Fabric capacity SKU change or delete via REST (PATCH/PUT/DELETE)', re: seg(HTTP_CLIENT + methodIs('patch|put|delete') + CAPACITY_RESOURCE) },
  // PUT .../dataAccessRoles replaces EVERY OneLake role (DefaultReader too). A named role
  // (.../dataAccessRoles/<name>) and POST are not the bulk replace.
  { name: 'OneLake bulk PUT dataAccessRoles (replaces ALL roles)', re: seg(HTTP_CLIENT + methodIs('put') + String.raw`.*/dataAccessRoles/?(?:[?#"'\s]|$)`) },
];
// PowerShell TOOL only. On the PowerShell tool a recursive delete is the command itself,
// unquoted, so it can be gated without the false-positive problem described below (which is
// about the Bash tool, where `Remove-Item` only ever appears inside a quoted payload). Aliases:
// ri, rm, rmdir, rd, del, erase. -r / -rec / -Recurse all abbreviate -Recurse.
export const POWERSHELL_PATTERNS: DPattern[] = [
  { name: 'PowerShell recursive delete (Remove-Item -Recurse)', re: /(?:^|[;|&({]|\s)(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s-(?:r|rec|recurse)\w*\b/i },
  { name: 'PowerShell recursive delete ([IO.Directory]::Delete $true)', re: /\[(?:System\.)?IO\.Directory\]::Delete\([^)]*,\s*\$true\s*\)/i },
  // F06. A second argument that is not literally $false ($r, 1, (1 -eq 1)) can be true.
  { name: 'PowerShell [IO.Directory]::Delete with a recurse argument', re: /\[(?:System\.)?IO\.Directory\]::Delete\((?:[^(),;\n]|\([^()\n]*\))*,\s*(?!\$false\s*\))[^\s)]/i },
  // F06. A splat (`Remove-Item @p`) hides -Recurse inside a hashtable; the guard cannot see it.
  { name: 'PowerShell splatted delete (Remove-Item @args)', re: /(?<![\w-])(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s@\w/i },
  // F06. A pipe into a delete removes every item the left side yields (parity with `xargs rm`).
  { name: 'PowerShell pipe into delete (| Remove-Item)', re: /\|\s*(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b/i },
];

// NOTE: DB drops (psql/sqlite3 -c "DROP TABLE …") and, on the BASH tool, PowerShell
// Remove-Item TEXT are intentionally NOT gated here. A real `powershell -Command "..."` call on the
// Bash tool is: its payload is classified as PowerShell (2026-11-04). Their payload is inherently inside quotes, which
// stripQuotedStrings() removes, and the same keywords appear constantly in
// migration commit messages — gating them produces more false-positives than
// value. Those destructive paths stay covered by: the settings deny rule
// (neonctl *delete*), the per-tool safety rules (neonctl/kusto/databases skills),
// and the human confirm-first convention. This Bash guard owns UNQUOTED shell ops.

/**
 * Strip quoted-string CONTENTS so destructive keywords that live inside a
 * commit message, echo arg, or other string literal don't false-trigger
 * (e.g. `git commit -m "... git reset --hard ..."`). Best-effort, non-nested:
 * ONE pass over both quote styles, so a quote char inside the other style (`'"'`) is plain text
 * (F01: two passes let `echo '"'; rm -rf x; echo '"'` hide the rm). Bash: backslash escapes
 * inside "...", none inside '...'. Real destructive commands
 * are unquoted (`rm -rf build`, `git push --force`) so they still match.
 * NOTE: this strip is for the TOP-LEVEL scan only. A destructive op WRAPPED in
 * `bash -c "rm -rf /"` or hidden in a command substitution `"$(rm -rf x)"` /
 * `` "`rm -rf x`" `` is NO LONGER a blind spot (Phase 1b): classifyDestructive
 * separately recurses into executable payloads via parseExecutable, so those
 * match too — while quoted MESSAGE text (not at a command position, or in single
 * quotes) still does not false-trigger.
 */
// PowerShell quoting: backslash is NOT an escape (`"C:\repo\"` is a complete string);
// the escape character is the backtick, and '' is a literal quote inside '...'.
// Using bash rules here let `"C:\repo\" reset --hard` swallow the rest of the command.
// The first alternative is a TOP-LEVEL escape (`\'` in Bash, `` `' `` in PowerShell): it is kept as
// is, so an escaped quote never opens a string (H1: `echo \'; rm -rf x; echo \'` hid the rm).
const PS_QUOTED = /`.|"(?:[^"`]|`.)*"|'(?:[^']|'')*'/g;
const BASH_QUOTED = /\\.|"(?:[^"\\]|\\.)*"|'[^']*'/g;
const ESCAPE_CHARS = '\\`';

export function stripQuotedStrings(command: string, tool: string = 'Bash'): string {
  return command.replace(tool === 'PowerShell' ? PS_QUOTED : BASH_QUOTED, (m) => (ESCAPE_CHARS.includes(m[0]) ? m : m[0] + m[0]));
}

/** True when `text` leaves a quote open after the one-pass strip (a lone `"` or `'`). */
function hasOpenQuote(text: string, tool: string): boolean {
  return /["']/.test(text.replace(tool === 'PowerShell' ? PS_QUOTED : BASH_QUOTED, ''));
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

// A shell-wrapper at a COMMAND POSITION: a segment that, after optional launchers and
// VAR= prefixes, begins with a shell interpreter invoked with an exec
// flag whose flag-cluster ends in the exec letter (-c / -lc / -Command / /c).
// The payload is the following quoted string (trailing args after it allowed, `sh -c '...' _ x`),
// or the rest of the segment. The option area skips flags and their QUOTED values
// (`pwsh -wd "C:/zz" -c ...`, `bash --rcfile "/a b" -c ...`). Every name may carry a path
// prefix (`/bin/bash`, `C:\Windows\System32\cmd.exe`, F03). Each launcher takes optional flags;
// sudo -u/-g, env -u and timeout take one value (timeout: the duration).
// The alternatives under each `*` are DISJOINT (C1): a value form takes `-u`/`-g` and a value that is not
// a flag; the flag form excludes a bare `-u`/`-g`; the timeout duration is not a flag. Overlapping
// alternatives (`-u` matched both) split `-u -u -u ...` every way and hung on 38 repeats.
// A launcher's path prefix has no `=`, so `x=/nohup` is only ever a VAR=x item, never also a path.
const PATH_PREFIX = String.raw`(?:\S*[\\/])?`;
const LAUNCHER_PATH = String.raw`(?:[^\s=]*[\\/])?`;
const valueFlags = (letters: string): string => String.raw`(?:\s+-[${letters}]\s+(?!-)\S+|\s+-(?![${letters}](?:\s|$))\S+)*`;
// time/nohup flags (`time -p`, `nohup --`, B3) hold no `=`, `/` or `\`, so a flag is never also a VAR=x item
// or a path-prefixed launcher (`-x/time`): the alternatives stay disjoint (C1).
const SIMPLE_FLAGS = String.raw`(?:\s+-[^\s=\\/]*)*`;
const LAUNCHER = String.raw`(?:${LAUNCHER_PATH}(?:sudo${valueFlags('ug')}|env${valueFlags('u')}|nohup${SIMPLE_FLAGS}|time${SIMPLE_FLAGS}|exec|command|nice(?:\s+-\S+)*|wsl(?:\s+-\S+)*|xargs(?:\s+-\S+)*|timeout(?:\s+-\S+)*\s+(?!-)\S+)\s+|[^\s=]+=\S+\s+)*`;
const OPTION_AREA = String.raw`(?:[^'"]|"[^"]*"|'[^']*')*?`;
// R1: the tail is `[\s\S]*`, not `.*`. JS `.` stops at `\r`, so `\S.*)(?:\s.*)?$` failed on a mid-line CR
// and the engine retried every exec-flag position and every tail split (cubic: 10.6 s on 10 KB). Now, once
// the exec flag has a non-space after it, the payload cannot fail, and the bare form has no second tail.
// Groups: 1 a quoted payload, 2 the trailing args after it, 3 the bare rest of the segment.
const PAYLOAD = String.raw`\s*(?:("(?:[^"\\]|\\[\s\S])*"|'[^']*')(?=\s|$)(?:\s([\s\S]*))?|(\S[\s\S]*))$`;
const wrapper = (interp: string, flag: string): RegExp =>
  new RegExp(`^${LAUNCHER}${PATH_PREFIX}${interp}\\b${OPTION_AREA}${flag}${PAYLOAD}`, 'i');

// Exec flags. POSIX: `c` anywhere in a short flag cluster (`-c`, `-lc`, `-cx`, `-ce`). PowerShell: any
// prefix of -Command (`-c`, `-com`, `-comm`, ...) and -CommandWithArgs / -cwa (pwsh 7.4).
const POSIX_EXEC_FLAG = String.raw`\s-[a-z]{0,5}c[a-z]{0,5}\b`;
const PWSH_EXEC_FLAG = String.raw`\s-(?:c(?:o(?:m(?:m(?:a(?:n(?:d(?:withargs)?)?)?)?)?)?)?|cwa)\b`;

type WrapperShell = 'posix' | 'powershell' | 'cmd';
const WRAPPER_RES: Array<{ shell: WrapperShell; re: RegExp }> = [
  { shell: 'posix', re: wrapper('(?:bash|sh|zsh|dash|ksh|ash)(?:\\.exe)?', POSIX_EXEC_FLAG) },
  { shell: 'powershell', re: wrapper('(?:powershell|pwsh)(?:\\.exe)?', PWSH_EXEC_FLAG) },
  { shell: 'cmd', re: wrapper('cmd(?:\\.exe)?', String.raw`\s\/[ck]\b`) },
];

function unwrapPayload(raw: string): string {
  const s = raw.trim();
  // Inside "...", a backslash is removed only before " ` $ \ ; a \' stays \' (an escaped quote to the inner shell).
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["`$\\])/g, '$1');
  // Inside '...', a backslash is literal. A bare payload has no quotes to remove.
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

const dropQuotes = (s: string): string => s.replace(/["']/g, '');

/**
 * The payload of a segment that is a shell-wrapper invocation, tagged with its interpreter; else null.
 * The trailing args after a quoted payload are part of it, for every shell. pwsh, powershell and cmd join
 * EVERY argument into the command they run (B1). A POSIX payload can run its args too (`bash -c 'eval "$1"'
 * _ 'rm -rf x'`, F1). Their quote characters are deleted, not parsed (fail closed; no reading of $1 or eval).
 * Accepted false positive: `bash -c "echo" "; rm -rf x"` asks, though there the second string is only $0.
 * The bare form keeps its quotes: `pwsh -File x.ps1 -C C:\repo commit -m "..."` reads `-C` as -Command (H2)
 * and must stay allowed.
 */
function matchWrapper(seg: string): { payload: string; shell: WrapperShell } | null {
  for (const { shell, re } of WRAPPER_RES) {
    const m = seg.match(re);
    if (!m || !(m[1] || m[3])) continue;
    // A bare payload that starts with a quote is a quoted payload glued to more text (`"rm -rf x">f`,
    // `'...'x`): its quotes would blank the command, so delete them (fail closed; CR 299). A bare payload
    // that starts with a word keeps its quotes (H2: `pwsh -File x.ps1 -C C:\repo commit -m "..."`).
    if (!m[1]) return { payload: /^["']/.test(m[3]) ? dropQuotes(m[3]) : unwrapPayload(m[3]), shell };
    if (!m[2]?.trim()) return { payload: unwrapPayload(m[1]), shell };
    // pwsh and cmd join their args into one command. A POSIX tail is $0, $1, ...: it runs only through
    // the payload ($1, eval), so it is scanned as its own command after a `;`, never as an argument of
    // the payload's last word (`bash -c 'git rebase' '--abort'` runs a bare rebase; CR 299).
    const join = shell === 'posix' ? ' ; ' : ' ';
    return { payload: unwrapPayload(m[1]) + join + dropQuotes(m[2]), shell };
  }
  return null;
}

/** Wrapper payloads tagged with the interpreter that runs them. */
function taggedWrapperPayloads(segments: string[]): Array<{ payload: string; shell: WrapperShell }> {
  return segments.map(matchWrapper).filter((w): w is { payload: string; shell: WrapperShell } => w !== null);
}

export function wrapperPayloadsFromSegments(segments: string[]): string[] {
  return taggedWrapperPayloads(segments).map((w) => w.payload);
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

/**
 * The `$(...)` and (Bash) backtick substitutions of a text block that EXPANDS, i.e. an unquoted heredoc
 * or a PowerShell `@"` here-string: the shell runs those. A backslash (Bash) or backtick (PowerShell)
 * before the `$` makes it literal. Quotes inside the prose are plain text, so this scans by hand.
 */
function bodySubstitutions(body: string, tool: string): string[] {
  const out: string[] = [];
  const esc = tool === 'PowerShell' ? '`' : '\\';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === esc) { i += 2; continue; }
    if (c === '$' && body[i + 1] === '(') {
      const { inner, end } = readBalanced(body, i + 2, '(', ')');
      out.push(inner); i = end; continue;
    }
    if (c === '`' && tool !== 'PowerShell') {
      const { inner, end } = readBacktick(body, i + 1);
      out.push(inner); i = end; continue;
    }
    i++;
  }
  return out;
}

/**
 * What the shell would EXECUTE, with text blocks reduced. A block that only WRITES TEXT is not a call,
 * so a doc that quotes a Fabric command stays allowed. A literal block (`<<'EOF'`, `<<"EOF"`, `@'...'@`)
 * is dropped. An expanding block (`<<EOF`, `@"..."@`) is replaced by its `$(...)` substitutions, which
 * run. Bash: only `cat|tee ... <<EOF` with nothing after the marker but an optional redirect counts (no
 * pipe, `;` or `&`, so `cat <<EOF | bash` and `bash <<EOF` keep their body: those lines run).
 * PowerShell: `$x = @'` / `$x = @"` assignments (accepted gap: `iex $x` can still run one).
 * An unterminated block ends at the end of the command. Anything unrecognised is left alone.
 * A Bash opener inside an open quote (`echo "x` on an earlier line) is text, not an opener, so the
 * lines after it stay in the view (F14).
 */
export function executableView(command: string, tool: string): string {
  const out: string[] = [];
  const seen: string[] = []; // command lines outside any block, to test for an open quote
  let end: RegExp | null = null;
  let expands = false;
  let body: string[] = [];
  const flush = (): void => {
    if (expands) for (const s of bodySubstitutions(body.join('\n'), tool)) out.push(`$(${s})`);
    end = null; body = [];
  };
  for (const line of command.split('\n')) {
    if (end) { if (end.test(line)) flush(); else body.push(line); continue; }
    if (tool === 'PowerShell') {
      // The opener (`$x = @'`) goes too: its lone quote would swallow the lines after the block.
      const h = line.match(/^\s*\$\w+\s*=\s*@(['"])\s*$/);
      if (h) { end = new RegExp(`^\\s*${h[1]}@`); expands = h[1] === '"'; continue; }
      out.push(line);
      continue;
    }
    out.push(line);
    const m = line.match(/^\s*(?:cat|tee)\b[^|;&<]*<<-?\s*(['"]?)([A-Za-z_]\w*)\1\s*(?:>>?\s*\S+)?\s*$/);
    const before = m ? [...seen, line.slice(0, line.indexOf('<<'))].join('\n') : '';
    seen.push(line);
    if (m && !hasOpenQuote(before, tool)) { end = new RegExp(`^\\s*${m[2]}\\s*$`); expands = m[1] === ''; }
  }
  if (end) flush();
  return out.join('\n');
}

/**
 * Join line continuations and resolve escapes, so a pattern sees the command the shell sees.
 * Bash: a backslash before a newline continues the line. PowerShell: a backtick does, and a backtick
 * before a letter or digit is only an escape (`` del`ete `` runs as delete), so the character stays.
 * Any other backtick pair (an escaped quote, `$`, space) is dropped whole: that keeps an escaped quote
 * from opening a string. A backslash before a newline in PowerShell is a path, not a continuation:
 * a space after it stops parseExecutable (bash rules) from swallowing the newline.
 */
export function normalizeEscapes(s: string, tool: string): string {
  if (tool !== 'PowerShell') return s.replace(/\\\r?\n/g, ' ');
  return s.replace(/`\r?\n/g, ' ').replace(/`([A-Za-z0-9])/g, '$1').replace(/`./g, '').replace(/\\(\r?\n)/g, '\\ $1');
}

/**
 * Test SEGMENT_PATTERNS against each top-level command segment (quotes kept). Joining continuations
 * first matters: otherwise a multi-line Invoke-RestMethod splits into segments no pattern can see whole.
 */
function classifySegments(view: string, tool: string): string | null {
  try {
    for (const seg of parseExecutable(normalizeEscapes(view, tool)).segments) {
      for (const p of SEGMENT_PATTERNS) if (p.re.test(seg)) return p.name;
    }
  } catch {
    // fail-open
  }
  return null;
}

// Layer 2, fail-closed: an interpreter word (any path prefix, optional .exe) with an exec flag later in
// the segment. The wrapper regexes above miss launchers and option shapes they do not list; this
// does not try to parse them. It deletes every quote char from the raw segment and tests the patterns.
// It runs only on segments the wrapper regexes did NOT match: a matched wrapper's payload is classified
// already. Each interpreter has its own exec flag (H2): POSIX `-c` is lowercase only (git's `-C` is a
// folder), and `/c` `/k` count only for cmd and only before whitespace or a quote (not `/c/Users/...`).
const INTERPRETERS: Array<{ word: RegExp; flag: RegExp }> = [
  { word: /(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash)(?:\.exe)?\b/i, flag: new RegExp(POSIX_EXEC_FLAG) },
  { word: /(?<![\w.-])(?:pwsh|powershell)(?:\.exe)?\b/i, flag: new RegExp(PWSH_EXEC_FLAG, 'i') },
  { word: /(?<![\w.-])cmd(?:\.exe)?\b/i, flag: /\s\/[ck](?=\s|["']|$)/i },
];

function runsInterpreter(stripped: string): boolean {
  // Any later word of the same family sits after the first one, so testing from the first is enough.
  return INTERPRETERS.some(({ word, flag }) => {
    const at = stripped.search(word);
    return at >= 0 && flag.test(stripped.slice(at));
  });
}

/** The text after the first interpreter's exec flag, or null. SEGMENT_PATTERNS anchor at a command start. */
function afterExecFlag(text: string): string | null {
  for (const { word, flag } of INTERPRETERS) {
    const at = text.search(word);
    const m = at >= 0 ? flag.exec(text.slice(at)) : null;
    if (m) return text.slice(at + m.index + m[0].length);
  }
  return null;
}

function classifyInterpreterSegments(segments: string[], tool: string): string | null {
  for (const seg of segments) {
    if (!runsInterpreter(stripQuotedStrings(seg, tool))) continue;
    const dequoted = normalizeGitGlobalOptions(dropQuotes(seg));
    for (const p of [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS]) if (p.re.test(dequoted)) return p.name;
    // B3: a Fabric call after the exec flag (`nice -n 5 bash -c "az fabric capacity suspend ..."`).
    const payload = afterExecFlag(dequoted);
    if (payload !== null) for (const p of SEGMENT_PATTERNS) if (p.re.test(payload)) return p.name;
  }
  return null;
}

export function classifyDestructive(command: string, depth = 0, tool: string = 'Bash'): string | null {
  if (!command || typeof command !== 'string') return null;
  // R2: the top-level scan reads the RAW command, heredoc bodies included, as on fork/main. A body that
  // `cat > x.sh` writes can run on the next line (`bash x.sh`), so prose that names a destructive command asks.
  let scan = normalizeGitGlobalOptions(stripQuotedStrings(command, tool));
  // PowerShell: `` res`et `` runs as reset. Quotes are already stripped, so the escaped letter can go.
  if (tool === 'PowerShell') scan = scan.replace(/`([A-Za-z0-9])/g, '$1');
  const patterns = tool === 'PowerShell' ? [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS] : DESTRUCTIVE_PATTERNS;
  for (const p of patterns) {
    if (p.re.test(scan)) return p.name;
  }
  const view = executableView(command, tool);
  const segHit = classifySegments(view, tool);
  if (segHit) return segHit;
  if (depth < 4) {
    try {
      // parseExecutable follows bash rules, where a backtick starts a command substitution.
      // In PowerShell the backtick is only the escape character, so resolve escapes first
      // (normalizeEscapes), or an escaped quote in a message ("say `"git reset --hard`"")
      // parses as a command.
      const { segments, substitutions } = parseExecutable(normalizeEscapes(view, tool));
      const wrapped = segments.map(matchWrapper);
      const interpHit = classifyInterpreterSegments(segments.filter((_, i) => wrapped[i] === null), tool);
      if (interpHit) return interpHit;
      // A powershell/pwsh payload runs as PowerShell, whichever tool launched it.
      const payloads = [
        ...wrapped.flatMap((w) => (w ? [{ text: w.payload, tool: w.shell === 'powershell' ? 'PowerShell' : tool }] : [])),
        ...substitutions.map((s) => ({ text: s, tool })),
      ];
      for (const payload of payloads) {
        const inner = classifyDestructive(payload.text, depth + 1, payload.tool);
        if (inner) return inner;
      }
    } catch {
      // fail-open: a parser hiccup must never brick the guard
    }
  }
  return null;
}
