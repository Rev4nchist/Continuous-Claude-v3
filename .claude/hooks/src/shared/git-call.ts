/**
 * The regexes that find `git <verb>` at a command position, shared by commit-preflight (verb commit) and decision-gate (verb push).
 * They run on a quote-masked view of the command (shared/mask-quotes.ts: same length, quoted text blanked), so text inside a commit
 * message or an `echo` is never a call. The caller checks the raw token (isGitToken, isSafeToken), because the masked view hides a
 * quoted executable path.
 *
 * Four contiguous groups cover the whole match: 1 the lead-in, 2 the executable token, 3 git's global options, 4 the verb.
 * Offsets in the masked view are offsets in the raw command.
 */

// A quoted value (kept as-is in the masked view: only the inside is blanked) or a bare word.
export const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
/** git's global options that may sit between `git` and the verb. `extra` is more alternatives (regex source, each ending in `|`). */
const globalOpt = (extra: string = ''): string =>
  String.raw`(?:\s+(?:${extra}-C\s+${VAL}|-c\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VAL}|--no-pager|--no-replace-objects|--bare|-P))*`;
export const GLOBAL_OPT = globalOpt();
// A command position: the start, after `; & | ( { newline`, or after then/do/else. An env prefix
// (`GIT_X=y`), a PowerShell `&` and a wrapper (`time`, `sudo`) may come first.
export const CALL_START = String.raw`(?:^\s*|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:&\s+)?(?:\w+=\S*\s+)*(?:(?:time|sudo|command|exec|nohup)\s+)*`;
export const PATH_PREFIX = String.raw`(?:[^\s;&|()]*[\\/])?`;
// `pwsh -NoProfile -File <script>` in front of a wrapper script such as git-safe.ps1.
export const PWSH_PREFIX = String.raw`(?:(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*?\s+-File\s+)?`;

/** `git <verb>` itself. `verb` is regex source, with no whitespace in it. */
export function gitCallRe(verb: string): RegExp {
  return new RegExp(String.raw`(${CALL_START})(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+${verb})(?=\s|$)`, 'g');
}

/**
 * `<wrapper>.ps1 <verb>`. `wrappers` is regex source for the script name without `.ps1` (default git-safe).
 * `extraOpts` is more options that may sit before the verb (regex source, each alternative ending in `|`), for a wrapper with its own
 * parameters (git-for.ps1: -Path, -Remote, -WhichAccount, -UseGitSafe). `flags` are the RegExp flags (PowerShell parameter names ignore case).
 */
export function safeCallRe(verb: string, wrappers: string = 'git-safe', extraOpts: string = '', flags: string = 'g'): RegExp {
  return new RegExp(String.raw`(${CALL_START})(${PWSH_PREFIX}(?:${PATH_PREFIX}(?:${wrappers})\.ps1|"\s*"|'\s*'))(${globalOpt(extraOpts)})(\s+${verb})(?=\s|$)`, flags);
}

// The masked view hides a quoted executable path, so the raw token is checked.
export const isGitToken = (raw: string): boolean => /(?:^|[\\/"'])git(?:\.exe)?["']?$/i.test(raw);
export const isSafeToken = (raw: string, wrappers: string = 'git-safe'): boolean => new RegExp(`(?:${wrappers})\\.ps1`, 'i').test(raw);
