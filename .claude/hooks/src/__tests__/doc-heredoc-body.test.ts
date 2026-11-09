/**
 * Document heredoc (shared/doc-heredoc.ts, lane guard-heredoc-body-fp). How it can fail, and the test that catches it:
 *   - the body words still trip a guard (the bug)                                          -> WIRED
 *   - it changes the length or the line breaks                                             -> LENGTH
 *   - it blanks a body that may run: a script file, an unquoted marker, a pipe, a command
 *     after the body, an early end of the body, a missing end, a CR line break             -> KEPT
 *   - a real destructive or PR command next to the heredoc is hidden                       -> REAL
 */
import { describe, expect, it } from 'vitest';
import { blankDocHeredocBody } from '../shared/doc-heredoc.js';
import { blankInertQuotes } from '../shared/inert-quotes.js';
import { decide } from '../destructive-command-guard.js';

const BODY = 'Never run git reset --hard or gh pr create or land-pr.ps1 here.';
const DOC = `cat >> notes.md <<'EOF'\n${BODY}\nEOF`;

describe('LENGTH', () => {
  it('keeps the length and every line break', () => {
    const out = blankDocHeredocBody(DOC);
    expect(out).toHaveLength(DOC.length);
    expect(out).toBe(`cat >> notes.md <<'EOF'\n${' '.repeat(BODY.length)}\nEOF`);
  });
});

describe('BLANKED: a document heredoc', () => {
  it.each([
    ['append to .md', DOC],
    ['write .txt, double quotes', `cat > docs/n.txt <<"EOF"\n${BODY}\nEOF`],
    ['marker first, .json', `cat <<'EOF' > out.json\n${BODY}\nEOF`],
    ['<<- with tabs', `cat > n.md <<-'EOF'\n\t${BODY}\n\tEOF`],
    ['a trailing newline', `${DOC}\n`],
    ['a Windows path', `cat > C:/Users/x/notes.md <<'EOF'\n${BODY}\nEOF`],
    ['several body lines', `cat > n.md <<'EOF'\nline one\n${BODY}\nline three\nEOF`],
  ])('%s', (_n, c) => {
    const out = blankDocHeredocBody(c);
    expect(out).not.toMatch(/reset|gh pr|land-pr/);
    expect(out).toHaveLength(c.length);
  });
});

describe('KEPT: the body may run, or the shape is not exact', () => {
  it.each([
    ['a script file', `cat > run.sh <<'EOF'\n${BODY}\nEOF`],
    ['a PowerShell script', `cat > run.ps1 <<'EOF'\n${BODY}\nEOF`],
    ['no extension', `cat > run <<'EOF'\n${BODY}\nEOF`],
    ['a double extension', `cat > n.md.sh <<'EOF'\n${BODY}\nEOF`],
    ['an unquoted marker (the body expands)', `cat > n.md <<EOF\n${BODY}\nEOF`],
    ['a variable in the path', `cat > $F.md <<'EOF'\n${BODY}\nEOF`],
    ['a substitution in the path', `cat > $(x).md <<'EOF'\n${BODY}\nEOF`],
    ['a pipe', `cat <<'EOF' | bash\n${BODY}\nEOF`],
    ['a pipe after the path', `cat > n.md <<'EOF' | bash\n${BODY}\nEOF`],
    ['a command after the marker', `cat > n.md <<'EOF' && bash n.md\n${BODY}\nEOF`],
    ['a command before', `echo x; cat > n.md <<'EOF'\n${BODY}\nEOF`],
    ['a command after the body', `cat > n.md <<'EOF'\n${BODY}\nEOF\nbash n.md`],
    ['an early end, then a command', `cat > n.md <<'EOF'\nx\nEOF\ngit reset --hard\nEOF`],
    ['no end line', `cat > n.md <<'EOF'\n${BODY}`],
    ['an end line with a trailing space', `cat > n.md <<'EOF'\n${BODY}\nEOF `],
    ['an indented end without <<-', `cat > n.md <<'EOF'\n${BODY}\n\tEOF`],
    ['tee', `tee n.md <<'EOF'\n${BODY}\nEOF`],
    ['CRLF line ends', `cat > n.md <<'EOF'\r\n${BODY}\r\nEOF`],
    ['a form feed', `cat > n.md <<'EOF'\n${BODY}\f\nEOF`],
    ['a bash wrapper', `bash <<'EOF'\n${BODY}\nEOF`],
  ])('%s', (_n, c) => {
    expect(blankDocHeredocBody(c)).toBe(c);
  });
});

describe('WIRED: the guards read the blanked text', () => {
  it('blankInertQuotes blanks the body (decision-gate and pre-pr-gate call it)', () => {
    expect(blankInertQuotes(DOC)).not.toMatch(/reset|gh pr|land-pr/);
  });
  it('destructive-command-guard allows a document heredoc that names a hard reset', () => {
    expect(decide(DOC, { tool_name: 'Bash' }, {}).decision).toBe('allow');
  });
});

describe('REAL: a command next to the heredoc, or a script body, is still seen', () => {
  it('destructive-command-guard still asks for a script body', () => {
    expect(decide(`cat > x.sh <<'EOF'\ngit reset --hard\nEOF`, { tool_name: 'Bash' }, {}).decision).toBe('ask');
  });
  it('destructive-command-guard still asks for a command after the body', () => {
    expect(decide(`${DOC}\ngit reset --hard`, { tool_name: 'Bash' }, {}).decision).toBe('ask');
  });
  it('blankInertQuotes keeps a real PR create after the body', () => {
    expect(blankInertQuotes(`${DOC}\ngh pr create --fill`)).toContain('gh pr create --fill');
  });
  it('destructive-command-guard still asks for a plain hard reset', () => {
    expect(decide('git reset --hard HEAD', { tool_name: 'Bash' }, {}).decision).toBe('ask');
  });
});
