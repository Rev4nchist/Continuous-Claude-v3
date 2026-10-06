/**
 * Blank out quoted strings WITHOUT changing the length, so an index found in the masked view is
 * the same index in the raw command. (`stripQuotedStrings` in destructive-classifier.ts collapses
 * each string to `""`, which moves every later offset.)
 *
 * Used to find a command at a command position: text inside a commit message or an `echo` never
 * counts as a call. One left-to-right pass, so a `"` inside a single-quoted string cannot pair with
 * a later `"`. An unterminated quote is left as it is.
 *
 * Bash: a backslash escapes inside "..."; '...' has no escape. PowerShell: the backtick escapes
 * inside "..."; a doubled quote is a literal quote inside '...'.
 */
const BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
const PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;

const blank = (s: string): string => s[0] + ' '.repeat(s.length - 2) + s[s.length - 1];

export function maskQuoted(command: string, tool: string = 'Bash'): string {
  return command.replace(tool === 'PowerShell' ? PWSH_STRING : BASH_STRING, blank);
}
