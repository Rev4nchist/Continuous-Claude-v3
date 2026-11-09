/**
 * A quoted-delimiter heredoc that writes a document names a command, it does not run one:
 *   cat >> notes.md <<'EOF'
 *   Never run git reset --hard or gh pr create here.
 *   EOF
 * The guards that read a command for a destructive or PR word call blankDocHeredocBody first, so those words in such a body no longer count.
 *
 * Fail closed. The command is left as it is unless ALL of these hold. The tests are regexes and a line scan. There is no shell lexer.
 *   1. The first line is exactly `cat >|>> PATH <<[-]'D'` or `cat <<[-]'D' >|>> PATH`. D is a plain word in single or double quotes
 *      (a quoted delimiter: the body is literal, nothing in it expands). PATH is one plain word that ends in .md or .txt
 *      (no $, backtick, quote, space or separator). A script name (.sh, .ps1, none), a config file (.json: package.json, settings.json,
 *      .mcp.json hold commands a later tool runs) or any other command keeps the body: it may run later.
 *   2. A later line is exactly D (for <<- also with leading tabs). That is where the shell ends the body. Nothing but blank lines follows it,
 *      so no command comes after the body, and a body line that is D cannot hide a command behind an early end.
 *   3. No CR, NUL, vertical tab, form feed or Unicode line break anywhere: a shell may read those as a line end or as part of D.
 *   4. Bash only. The callers apply this for the Bash tool and the Bash reading. PowerShell and cmd have no heredoc, and a desktop-commander
 *      REPL may run each body line, so there the body lines are commands.
 * Same length, same line breaks: only the characters of the body lines become spaces. Dave chose this scope 11-09 (lane guard-heredoc-body-fp),
 * and dropped .json after the critic review of PR 471.
 * Accepted risk: the code trusts the word `cat`. A shell function or PATH change left by an earlier call would make the body run.
 */

const PATH = String.raw`(?<path>[\w./\\:~-]+\.(?:md|txt))`;
const DELIM = String.raw`(?<dash>-?)(?<q>['"])(?<d>[A-Za-z_]\w*)\k<q>`;
// The path comes first: `cat > notes.md <<'EOF'`.
const HEAD_FILE_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]+>>?[ \t]*${PATH}[ \t]*<<${DELIM}[ \t]*$`);
// The marker comes first: `cat <<'EOF' > notes.md`.
const HEAD_MARKER_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]*<<${DELIM}[ \t]*>>?[ \t]*${PATH}[ \t]*$`);
const ODD_BREAK = /[\r\0\v\f\x85\u2028\u2029]/;

/** The command with the body lines of a document heredoc replaced by spaces, or the command itself when it is not that exact shape. */
export function blankDocHeredocBody(command: string): string {
  if (!command.includes('<<') || ODD_BREAK.test(command)) return command;
  const lines = command.split('\n');
  const head = HEAD_FILE_FIRST.exec(lines[0]) ?? HEAD_MARKER_FIRST.exec(lines[0]);
  if (!head || !head.groups) return command;
  const { dash, d } = head.groups;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = dash ? lines[i].replace(/^\t+/, '') : lines[i];
    if (line === d) { close = i; break; }
  }
  if (close < 1) return command;
  if (lines.slice(close + 1).some((l) => l.trim() !== '')) return command;
  return lines.map((l, i) => (i >= 1 && i < close ? ' '.repeat(l.length) : l)).join('\n');
}
