// Rows for the parser-based reader of coderabbit-guard.ts (coord-guard-shell-parser PR A commit 2, group G1).
// The first block repeats the expectations of the old parseInvocation rows (coderabbit-guard-answer-paths.test.ts) over the new reader.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readCommand, invocationOf, resetReadings, quoteSpans, lexedFromReading, classifyCommand, setReaderSeam } from '../coderabbit-guard.js';

vi.setConfig({ testTimeout: 60000 });

async function inv(text: string, ps = false) {
  const r = await readCommand(text, ps);
  expect(r.ok, `${text} did not read: ${r.msg}`).toBe(true);
  // The call list holds a substitution's inner call too (`$(echo cr) review` has `echo cr` and the outer call): read the outermost call.
  const call = [...r.result!.calls].filter((c) => c.words.length > 0).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  return call ? invocationOf(call) : null;
}

describe('invocationOf: the same Invocation as the old parseInvocation rows', () => {
  it('npx and the @version suffix', async () => {
    expect((await inv('npx coderabbit@latest review --agent'))?.exe).toBe('coderabbit');
    expect((await inv('npx -y coderabbit@1.2.3 review --agent'))?.exe).toBe('coderabbit');
  });

  it('a runner option with a folder marks the call as moved; a user option does not', async () => {
    expect(await inv("sudo -D /x bash -c 'cr review --agent'")).toMatchObject({ exe: 'bash', moves: true });
    expect((await inv("sudo -u root bash -c 'cr review --agent'"))?.moves).toBeUndefined();
    expect(await inv('sudo -u root cr review --agent')).toMatchObject({ exe: 'cr' });
    expect(await inv('xargs -n 1 cr review --agent')).toMatchObject({ exe: 'cr' });
    expect((await inv('sudo -u root cr review --agent'))?.moves).toBeUndefined();
    expect(await inv('sudo -D /elsewhere cr review --agent')).toMatchObject({ exe: 'cr', moves: true });
  });

  it('a shell with -c gives the command string; a script path gives none', async () => {
    expect((await inv("bash -ec 'cr review --agent'"))?.nested).toBe('cr review --agent');
    expect((await inv('sh -xc "cr review --agent"'))?.nested).toBe('cr review --agent');
    expect((await inv('bash --noprofile script.sh'))?.nested).toBeUndefined();
  });

  it('a double-quoted payload with an escaped quote is unquoted as the shell does', async () => {
    expect((await inv('sh -c "bash -c \\"cr review --agent\\""'))?.nested).toBe('bash -c "cr review --agent"');
  });

  it('PowerShell Start-Process: a quoted -FilePath with spaces, and -WorkingDirectory moves', async () => {
    expect(await inv('Start-Process -FilePath "C:\\Program Files\\CodeRabbit\\cr.exe" -ArgumentList "review --agent"', true)).toMatchObject({ exe: 'cr' });
    expect(await inv('Start-Process cr -WorkingDirectory x -ArgumentList "review --agent"', true)).toMatchObject({ exe: 'cr', moves: true });
  });

  it('a quoted program word is still the program', async () => {
    expect(await inv('"cr" review --agent')).toMatchObject({ exe: 'cr' });
    expect(await inv('& "C:/x/cr.exe" review --agent', true)).toMatchObject({ exe: 'cr' });
  });

  it('a comment is no part of the call', async () => {
    expect((await inv('cr review --agent # --help'))?.args).toEqual(['review', '--agent']);
  });
});

describe('invocationOf: a program word with no literal value is unreadable (rule U1 reads it)', () => {
  it.each(['$X review --agent', '$(echo cr) review', 'c\\r review'])('Bash %s has no readable exe', async (text) => {
    expect(await inv(text)).toMatchObject({ exe: '', unreadable: true });
  });

  it('PowerShell & $x review has no readable exe', async () => {
    expect(await inv('& $x review --agent', true)).toMatchObject({ exe: '', unreadable: true });
  });
});

describe('quoteSpans: quote spans inside one word; any doubt returns null (the word is then unquoted, so a cr word in it counts)', () => {
  it('finds a single-quoted, a double-quoted and an escaped span', () => {
    expect(quoteSpans("a'b c'd", false)).toEqual([{ from: 2, to: 5, kind: 'fill' }]);
    expect(quoteSpans('--body="cr review"', false)).toEqual([{ from: 8, to: 17, kind: 'dq' }]);
    expect(quoteSpans('c\\r', false)).toEqual([{ from: 2, to: 3, kind: 'esc' }]);
  });

  it('doubt: an unclosed single quote is null', () => {
    expect(quoteSpans("a'b", false)).toBeNull();
  });

  it('doubt: an unclosed double quote is null', () => {
    expect(quoteSpans('a"b', false)).toBeNull();
  });

  it('doubt: a dangling escape is null', () => {
    expect(quoteSpans('ab\\', false)).toBeNull();
    expect(quoteSpans('ab`', true)).toBeNull();
  });

  it('doubt: an escaped closing quote inside a double-quoted span does not close it', () => {
    expect(quoteSpans('"a\\"b"', false)).toEqual([{ from: 1, to: 5, kind: 'dq' }]);
    expect(quoteSpans('"a\\"b', false)).toBeNull();
  });

  it('PowerShell: a doubled single quote stays inside the span; a here-string body is data', () => {
    expect(quoteSpans("'it''s'", true)).toEqual([{ from: 1, to: 6, kind: 'fill' }]);
    expect(quoteSpans("@'\nbody\n'@", true)).toEqual([{ from: 2, to: 8, kind: 'fill' }]);
    expect(quoteSpans("@'\nbody", true)).toBeNull();
  });

  it('PowerShell: a backslash is no escape, the backtick is', () => {
    expect(quoteSpans('a\\b', true)).toEqual([]);
    expect(quoteSpans('a`"b', true)).toEqual([{ from: 2, to: 3, kind: 'esc' }]);
  });
});

describe('lexedFromReading: the facts of the old lexer, from the parser', () => {
  const FILL = '\u0000';
  async function lexed(text: string, ps = false) {
    const r = await readCommand(text, ps);
    expect(r.ok, `${text} did not read: ${r.msg}`).toBe(true);
    return lexedFromReading(text, r.result!, ps);
  }
  const masked = (l: { masked: string }, from: number, to: number): boolean => l.masked.slice(from, to) === FILL.repeat(to - from);

  it('a comment is blanked in text and masked; the line break stays', async () => {
    const l = await lexed('cr doctor # cr review\ncr usage');
    expect(l.text).toBe('cr doctor            \ncr usage');
  });

  it('quoted text and an escaped character are data; a separator in quotes is no separator', async () => {
    const l = await lexed('git commit -m "a; cr review" && c\\;x');
    expect(masked(l, 15, 26)).toBe(true);
    expect(l.masked.includes(';')).toBe(false);
  });

  it('a substitution inside double quotes stays readable and is listed in dqSubs', async () => {
    const t = 'echo "x $(cr review) y"';
    const l = await lexed(t);
    expect(l.masked.slice(8, 20)).toBe('$(cr review)');
    expect(l.dqSubs.has(8)).toBe(true);
    expect(l.execs).toEqual([[8, 20]]);
  });

  it('a heredoc body and the line break before it are data; its substitution in an unquoted heredoc stays readable', async () => {
    const t = 'cat <<EOF\nx $(cr review) y\nEOF\necho done';
    const l = await lexed(t);
    expect(l.masked[9]).toBe(FILL);
    expect(l.bodies.has(9)).toBe(false);
    expect(l.bodies.has(10)).toBe(true);
    expect(l.masked.slice(12, 24)).toBe('$(cr review)');
  });

  it('kept quirk: a quoted string inside a substitution inside an unquoted heredoc body stays readable (errs toward counting a call)', async () => {
    const t = 'cat <<EOF\n$(echo "cr review")\nEOF';
    const l = await lexed(t);
    expect(l.masked.slice(10, 29)).toBe('$(echo "cr review")');
  });

  it('PowerShell here-string body is data; its $( ) stays readable only in a double-quoted here-string', async () => {
    const l = await lexed('echo @"\nbody $(cr review)\n"@', true);
    expect(l.masked.includes('$(cr review)')).toBe(true);
    const s = await lexed("echo @'\nbody cr review\n'@", true);
    expect(s.masked.includes('cr review')).toBe(false);
  });

  it('doubled-quote class, PowerShell single quotes: Dave\'\'s stays inside one string, so a cr word after it is data (old lexer: readable)', async () => {
    const t = "echo 'Dave''s cr review' x";
    const l = await lexed(t, true);
    expect(l.masked.includes('cr review')).toBe(false);
  });

  it('doubled-quote class, PowerShell double quotes: a doubled quote inside the string does not end it, so the cr word is data (old lexer: readable)', async () => {
    const t = 'echo "say ""cr review"" now" x';
    const l = await lexed(t, true);
    expect(l.masked.includes('cr review')).toBe(false);
  });
});

// Fail closed (plan 44 section 3, rows E1 to E9): every new error path of the reader has one deny row. A deny applies to a text that holds a cr
// word and later review (read after quotes, backticks and backslashes are removed); any other text with a reader error is allowed and logged.
describe('classifyCommand fails closed when the reader cannot read the text (E1 to E9)', () => {
  afterEach(() => setReaderSeam({}));
  const REVIEW = 'cr review --agent';
  const ENDING = 'no CLI review runs on a diff it cannot check for answer-key';

  const WAY_OUT_TAIL = 'run the review as its own plain command with --base <ref>';

  /** `wayOutForm`: a text that does not parse is the user's to fix, so its deny gives the way-out text and names the cause in brackets. */
  async function denied(text: string, ps: boolean, seam: Parameters<typeof setReaderSeam>[0] = {}, wayOutForm = false) {
    setReaderSeam(seam);
    const c = await classifyCommand(text, ps);
    expect(c.verdict, `${text} is not denied`).toBe('block');
    expect(c.reason).toContain(wayOutForm ? WAY_OUT_TAIL : ENDING);
    expect(c.reason?.endsWith('answer-key')).toBe(true);
    return c.reason ?? '';
  }

  it('E1 the wasm module cannot load', async () => {
    expect(await denied(REVIEW, false, { bashProvider: async () => { throw new Error('ENOENT: wasm file missing'); } })).toContain('the shell parser did not load');
  });

  it('E2 the PowerShell child fails to start', async () => {
    expect(await denied(REVIEW, true, { pwshProvider: () => ({ error: 'spawn pwsh ENOENT' }) })).toContain('the PowerShell reader failed');
  });

  it('E3 the PowerShell child runs over the time limit, and the reason names the elapsed milliseconds', async () => {
    expect(await denied(REVIEW, true, { pwshProvider: () => ({ error: 'pwsh timeout' }) })).toMatch(/the PowerShell reader timed out after \d+ ms/);
  });

  it('E4 the PowerShell child prints bad JSON', async () => {
    expect(await denied(REVIEW, true, { pwshProvider: () => ({ error: 'pwsh bad json' }) })).toContain('the PowerShell reader gave bad output');
  });

  it('E5 sh-syntax throws on the text', async () => {
    expect(await denied(REVIEW, false, { bashProvider: async () => { throw new Error('boom'); } })).toContain('the shell parser failed');
  });

  it('E6 the parser returns no tree', async () => {
    expect(await denied(REVIEW, false, { bashProvider: async () => null })).toContain('the shell parser gave no tree');
  });

  it('E7a an unclosed quote around review fails to parse and is denied', async () => {
    expect(await denied('cr "review --agent', false, {}, true)).toContain('(the command did not parse)');
  });

  it('E7b an escaped cr word plus a stray paren fails to parse and is denied', async () => {
    expect(await denied('c\\r review ) --agent', false, {}, true)).toContain('(the command did not parse)');
  });

  // Probe 53-unknown-kinds-probe.txt: of 35 constructs, only an extended glob gives a node kind that is not on the list (ExtGlob).
  it('E8 a node kind that is not on the list may hide a call: denied (an extended glob gives ExtGlob)', async () => {
    expect(await denied('cr review +(a|b)', false)).toContain('the command holds a construct the reader does not know');
  });

  it('E9 a text with no review call and a reader error is allowed, with the cause for the log line', async () => {
    setReaderSeam({ bashProvider: async () => { throw new Error('boom'); } });
    const c = await classifyCommand('echo review notes "oops', false);
    expect(c.verdict).toBe('ignore');
    expect(c.readerError).toBe('the shell parser failed');
  });

  it('a text with no trigger word is never read, so a broken reader cannot lock it out', async () => {
    setReaderSeam({ bashProvider: async () => { throw new Error('boom'); } });
    expect((await classifyCommand('git status', false)).verdict).toBe('ignore');
  });
});

// Probe 45-g1-continuation-probe.txt. The raw call rule (a cr word, then review) is the backstop for the two texts where the call list hides a review.
describe('the raw call rule still counts a review the call list hides (D1, D2)', () => {
  it('parser divergence D1: sh-syntax 0.8.1 joins a backslash-newline after a comment, real bash does not', async () => {
    // The parser reads `echo hi echo two`-style one call; bash runs the second line as its own command. Only the raw rule counts the review.
    const c = await classifyCommand('echo hi # note \\\ncr review --agent', false);
    expect(c.verdict).toBe('allow');
    expect(c.runs).toBe(1);
  });

  it('old lexer divergence D2: PowerShell backtick plus CRLF inside a word is two statements, so the review on the second line counts', async () => {
    const c = await classifyCommand('echo foo`\r\ncr review --agent', true);
    expect(c.verdict).toBe('allow');
    expect(c.runs).toBe(1);
  });
});

// CodeRabbit CLI run 1 on f9d0e551, findings A and B (seat ruling 18:28). Both were real deny-to-allow holes on main (file 62): a review ran and
// the run count never saw it.
describe('CLI findings A and B: a review hidden by eval arguments or by two stdin redirects is counted', () => {
  it('A eval joins every argument with spaces: `eval echo ; cr review` runs the review and counts 1', async () => {
    const c = await classifyCommand("eval 'echo' ';' 'cr review --agent'", false);
    expect(c.verdict).toBe('allow');
    expect(c.runs).toBe(1);
  });

  it('A control: bash -c keeps the first word as the script and the rest are positional, so `cr review` is $0 and counts 0', async () => {
    const c = await classifyCommand("bash -c 'echo' 'cr review'", false);
    expect(c.runs ?? 0).toBe(0);
  });

  it('B the last here-string is the real stdin: `bash <<< echo <<< cr review` counts 1', async () => {
    const c = await classifyCommand("bash <<< 'echo hi' <<< 'cr review --agent'", false);
    expect(c.verdict).toBe('allow');
    expect(c.runs).toBe(1);
  });

  it('B a here-string before a heredoc: the heredoc wins, so the review in the here-string is data and counts 0', async () => {
    const c = await classifyCommand("bash <<< 'cr review --agent' <<EOF\necho hi\nEOF", false);
    expect(c.runs ?? 0).toBe(0);
  });

  it('B a heredoc before a here-string: the here-string wins and counts 1', async () => {
    const c = await classifyCommand("bash <<EOF <<< 'cr review --agent'\necho hi\nEOF", false);
    expect(c.runs).toBe(1);
  });

  it('B an unreadable stdin on a shell, in a text that holds a cr word then review, is denied with the way-out text', async () => {
    const c = await classifyCommand('bash < run.sh; cr review --agent', false);
    expect(c.verdict).toBe('block');
    expect(c.reason).toContain('run the review as its own plain command with --base <ref>');
    expect(c.reason).toContain('the shell reads a script the check cannot see');
  });

  it('B control: an unreadable stdin with no review in the text is not denied', async () => {
    expect((await classifyCommand('bash < run.sh', false)).verdict).toBe('ignore');
  });
});

// Rule U1 (seat 15:30, a-prime 15:50): a program word with no literal value denies when the unit holds a cr word outside quotes or its first
// argument is the literal word review. Corpus: 46-u1-corpus-count.txt (the first form denied 5 real lane commands in 7 days; a-prime denies 0).
describe('rule U1: an unreadable program word next to a review is denied', () => {
  const DENIED = 'the program word is not readable';
  it.each([
    ['U1 variable program', '$X review --agent', false],
    ['U2 substitution program', '$(echo cr) review --agent', false],
    ['U1 escaped program (bash reads c\\r as one word)', 'c\\r review --agent', false],
    ['U1 Bash form of a Windows path: bash reads \\T and \\c as escapes', 'C:\\Tools\\cr.exe review --agent', false],
    ['U1 PowerShell call of a variable', '& $x review --agent', true],
    ['U1 a cr word outside quotes next to an unreadable program', '$X cr --agent', false],
  ])('%s is denied', async (_name, text, ps) => {
    const c = await classifyCommand(text, ps as boolean);
    expect(c.verdict, text).toBe('block');
    expect(c.reason).toContain(DENIED);
  });

  it('the lane form is allowed: a variable program, and CodeRabbit only inside a quoted message', async () => {
    const c = await classifyCommand('$L say "CodeRabbit review round done"', false);
    expect(c.verdict).toBe('ignore');
  });
});

describe('readCommand: one parse per text, and a failed read is told apart from a bad text', () => {
  it('the same text is parsed once until resetReadings', async () => {
    resetReadings();
    const a = readCommand('cr doctor', false);
    const b = readCommand('cr doctor', false);
    expect(a).toBe(b);
    resetReadings();
    expect(readCommand('cr doctor', false)).not.toBe(a);
  });

  it('a syntax error is ok:false with reader false', async () => {
    const r = await readCommand("cr 'review", false);
    expect(r.ok).toBe(false);
    expect(r.reader).toBe(false);
  });

  it('a reader failure is ok:false with reader true and never throws', async () => {
    const r = await readCommand('cr review', false, { bashProvider: async () => { throw new Error('wasm gone'); } });
    expect(r.ok).toBe(false);
    expect(r.reader).toBe(true);
    expect(r.msg).toMatch(/wasm gone/);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
