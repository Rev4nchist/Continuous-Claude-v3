// Behaviour rows of shared/shell-ast.ts parseCalls: the normalized call list from both dialects (coord-guard-shell-parser PR A).
// Port of the RE builder B scratch rows. The module under test is imported, never copied. The PowerShell rows need pwsh:
// a missing pwsh fails them loudly (a skip would hide a broken walker); CI ubuntu-latest lists PowerShell 7.6 (note 02 section 2).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { parseCalls, PWSH_KINDS, type Call, type ParseResult } from '../shared/shell-ast.js';

// A PowerShell row starts a pwsh child (0.4 to 1 s cold, more under load). The vitest default of 5 s failed one row at 5,009 ms while other sessions ran pre-pr.
vi.setConfig({ testTimeout: 60000 });

const P = 'pu' + 'sh';
const lits = (c: Call): (string | null)[] => c.words.map((w) => w.lit);
const find = (r: ParseResult, first: string): Call => r.calls.find((c) => c.words[0]?.lit === first)!;
const b64 = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');
const PS = (t: string, o?: { timeoutMs?: number }): Promise<ParseResult> => parseCalls(t, 'pwsh', o);
const SH = (t: string): Promise<ParseResult> => parseCalls(t, 'bash');

test('bash: plain call keeps words, place and depth', async () => {
  const r = await SH(`git ${P} fork re/x`);
  assert.equal(r.ok, true);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(lits(r.calls[0]), ['git', P, 'fork', 're/x']);
  assert.deepEqual(r.calls[0].place, { pipe: false, chain: null, background: false });
  assert.equal(r.calls[0].depth, 0);
  assert.equal(r.calls[0].inFunctionBody, false);
  assert.ok(r.kinds.includes('CallExpr'));
});

test('bash: env prefix assigns are recorded on the call', async () => {
  const r = await SH(`x=1 git ${P} fork re/x`);
  assert.deepEqual(r.calls[0].assigns, [{ name: 'x', lit: '1' }]);
});

test('bash: cd chain fills cwdBefore, literal and not', async () => {
  const r = await SH('cd /a && cd "$D" && git status; pushd /b; git log');
  assert.deepEqual(find(r, 'git').cwdBefore, ['/a', null]);
  const last = r.calls.filter((c) => c.words[0].lit === 'git').at(-1)!;
  assert.deepEqual(last.cwdBefore, ['/a', null, '/b']);
});

// KNOWN LIMIT (seat 17:13, coord-guard-shell-parser G5): CD_NAMES in shell-ast.ts is one list for both dialects and lowercases the program name.
// Real Bash has no `CD` and no `chdir`, so for Bash `cwdBefore` over-reports a move. No guard reads cwdBefore: coderabbit-guard keeps its own
// per-shell cd lists (CD_NAME_BASH, CD_NAME_PS). This row pins TODAY's behaviour; a guard that trusts cwdBefore must fix CD_NAMES first.
test('bash: known limit, cwdBefore counts CD and chdir as cd (real Bash has neither)', async () => {
  const r = await SH('CD /a; chdir /b; git status');
  assert.deepEqual(find(r, 'git').cwdBefore, ['/a', '/b']);
});

// CodeRabbit CLI run 1, finding B (seat 18:28): bash applies redirects left to right, so the LAST redirect that feeds stdin is the real stdin.
test('bash: the last here-string is the stdin of the call', async () => {
  const r = await SH("bash <<< 'echo hi' <<< 'cr review --agent'");
  assert.deepEqual(find(r, 'bash').stdin, { lit: 'cr review --agent' });
});

test('bash: a here-string before a heredoc gives the heredoc, a heredoc before a here-string gives the here-string', async () => {
  const a = await SH("bash <<< 'one' <<EOF\ntwo\nEOF");
  assert.equal(find(a, 'bash').stdin?.lit?.trim(), 'two');
  const b = await SH("bash <<EOF <<< 'one'\ntwo\nEOF");
  assert.deepEqual(find(b, 'bash').stdin, { lit: 'one' });
});

test('bash: a later file redirect makes stdin unknown (lit null), and a redirect of another descriptor is no stdin', async () => {
  assert.deepEqual(find(await SH("bash <<< 'cr review' < run.sh"), 'bash').stdin, { lit: null });
  assert.equal(find(await SH('bash 3< run.sh'), 'bash').stdin, null);
});

test('bash: place for pipe, chain, background', async () => {
  const r = await SH('a | b; c && d || e; f &');
  const p = (n: string) => find(r, n).place;
  assert.equal(p('a').pipe, true);
  assert.equal(p('b').pipe, true);
  assert.equal(p('d').chain, '&&');
  assert.equal(p('e').chain, '||');
  assert.equal(p('c').pipe, false);
  assert.equal(p('f').background, true);
  assert.equal(p('c').chain, ';');
});

test('bash: depth and function body', async () => {
  const r = await SH('echo "$(git status)"; f() { git log; }; for i in 1; do git show; done');
  assert.equal(find(r, 'git').depth, 1);
  const log = r.calls.find((c) => c.words[1]?.lit === 'log')!;
  assert.equal(log.inFunctionBody, true);
  assert.equal(log.func, 'f');
  assert.ok(log.depth >= 1);
  assert.ok(r.calls.find((c) => c.words[1]?.lit === 'show')!.depth >= 1);
});

test('bash: word literal rule', async () => {
  const r = await SH(`a 'x y' "p q" c""r 'd'e "C:\\w\\x"`);
  assert.deepEqual(lits(r.calls[0]), ['a', 'x y', 'p q', 'cr', 'de', 'C:\\w\\x']);
});

test('bash: a backslash, ANSI-C quote, brace, glob and expansion make the word dynamic', async () => {
  const r = await SH(`g\\it $'\\x63r' {a,b} *.c "b\\"c" "$(x)" "$V$W"`);
  const top = r.calls.find((c) => c.depth === 0)!;
  for (const w of top.words) assert.equal(w.lit, null, w.raw);
  assert.equal(top.words[5].kind, 'cmdsubst');
});

test('bash: F2c a lone variable takes one literal assignment', async () => {
  const r = await SH(`WT=/w; git -C "$WT" ${P} fork x`);
  const w = find(r, 'git').words[2];
  assert.equal(w.lit, '/w');
  assert.equal(w.kind, 'lit');
  assert.equal(w.viaVar, 'WT');
});

test('bash: F2c refuses a variable with two writes, a nested write, or a compound word', async () => {
  for (const t of [
    `WT=/a; WT=/b; git -C "$WT" ${P} fork x`,
    `WT=/a; if c; then WT=/b; fi; git -C "$WT" ${P} fork x`,
    `WT=/a; for WT in /b; do :; done; git -C "$WT" ${P} fork x`,
    `WT=/a; read WT; git -C "$WT" ${P} fork x`,
    `git -C "$WT" ${P} fork x; WT=/a`,
    `WT=/a; git -C "a$WT" ${P} fork x`,
    `f() { WT=/a; }; git -C "$WT" ${P} fork x`,
    `WT=$(pwd); git -C "$WT" ${P} fork x`,
    `WT=/a; git -C "\${WT:-/b}" ${P} fork x`,
    `WT=/a; git -C "\${WT#/}" ${P} fork x`,
  ]) {
    const r = await SH(t);
    const w = r.calls.find((c) => c.words[0].lit === 'git')!.words[2];
    assert.equal(w.lit, null, t);
  }
});

test('bash: F2c a ${x:=v} write inside a word is a second write, so no literal is carried', async () => {
  // AssignUnset (87) and AssignUnsetOrNull (88) are the named codes; the contract test pins their numbers.
  for (const t of [`WT=/a; echo "\${WT:=/b}"; git -C "$WT" ${P} fork x`, `WT=/a; echo "\${WT=/b}"; git -C "$WT" ${P} fork x`]) {
    const r = await SH(t);
    assert.equal(r.calls.find((c) => c.words[0].lit === 'git')!.words[2].lit, null, t);
  }
});

test('bash: place of a nested payload, F3 bash -c / sh -c / bash -lc', async () => {
  for (const t of [`bash -c 'git ${P} fork re/x'`, `sh -c 'git ${P} fork re/x'`, `bash -lc 'git ${P} fork re/x'`]) {
    const r = await SH(t);
    const inner = r.calls.find((c) => c.words[0].lit === 'git');
    assert.ok(inner, t);
    assert.equal(inner.depth, 1);
    assert.equal(r.calls[0].nested?.status, 'parsed');
    assert.equal(r.calls[0].nested?.dialect, 'bash');
  }
});

test('bash: F3 a dynamic payload and a broken payload', async () => {
  assert.equal((await SH('bash -c "$P"')).calls[0].nested?.status, 'dynamic');
  assert.equal((await SH(`bash -c 'git ${P} "'`)).calls[0].nested?.status, 'error');
  assert.equal((await SH('eval "$X"')).calls[0].nested?.status, 'dynamic');
});

test('bash: F3 eval with a literal string is parsed', async () => {
  const r = await SH(`eval 'git ${P} fork re/x'`);
  assert.ok(r.calls.find((c) => c.words[0].lit === 'git' && c.depth === 1));
});

test('bash: F3 a heredoc fed to a shell is parsed as its payload', async () => {
  const r = await SH(`bash <<'EOF'\ngit ${P} fork re/x\nEOF`);
  assert.ok(r.calls.find((c) => c.words[0].lit === 'git' && c.depth === 1));
});

test('bash: F3 cmd /c is flagged and not parsed', async () => {
  const r = await SH(`cmd /c "git ${P} fork re/x"`);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].nested?.status, 'unparsed');
  assert.equal(r.calls[0].nested?.dialect, 'cmd');
  assert.equal(r.calls[0].nested?.payload, `git ${P} fork re/x`);
});

test('bash: F3 xargs marks the guarded program args unknown', async () => {
  const r = await SH(`xargs -a list.txt git ${P} fork re/x`);
  assert.equal(r.calls.find((c) => c.words[0].lit === 'git')!.argsUnknown, true);
  const r2 = await SH(`echo x | xargs git ${P}`);
  assert.equal(r2.calls.find((c) => c.words[0].lit === 'git')!.argsUnknown, true);
});

test('bash: parse error returns ok false with a line', async () => {
  const r = await SH(`git ${P} fork re/x\nfoo "`);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].line, 2);
  assert.equal(typeof r.errors[0].offset, 'number');
});

test('bash: raw text of a word is cut by bytes, not characters', async () => {
  const r = await SH(`echo é; git ${P} "é"`);
  assert.equal(find(r, 'git').words[2].raw, '"é"');
});

test('bash: heredoc body and comment are returned as free ranges', async () => {
  const t = `cat <<EOF\ncr review\nEOF\necho hi # git ${P}`;
  const r = await SH(t);
  const texts = r.freeRanges.map(([s, e]) => t.slice(s, e));
  assert.ok(texts.some((x) => x.includes('cr review')));
  assert.ok(texts.some((x) => x.includes(`git ${P}`)));
});

test('pwsh: plain call, ok and words', async () => {
  const r = await PS(`git ${P} fork re/x`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(lits(r.calls[0]), ['git', P, 'fork', 're/x']);
  assert.ok(r.kinds.includes('CommandAst'));
});

test('pwsh: cd forms fill cwdBefore and chain ;', async () => {
  const r = await PS('Set-Location -LiteralPath C:\\a; sl $d; git status');
  assert.equal(r.ok, true);
  assert.deepEqual(find(r, 'git').cwdBefore, ['C:\\a', null]);
  assert.equal(find(r, 'git').place.chain, ';');
});

test('pwsh: invocation operator and a variable program name', async () => {
  const r = await PS(`& $g ${P} fork re/x`);
  assert.equal(r.calls[0].op, '&');
  assert.equal(r.calls[0].words[0].kind, 'var');
  assert.equal(r.calls[0].words[0].lit, null);
});

test('pwsh: F2c with a bare variable and an interpolated lone variable', async () => {
  const r = await PS(`$WT = 'C:\\w'; git -C $WT ${P} fork x; git -C "$WT" ${P} fork y`);
  assert.equal(r.ok, true);
  const gits = r.calls.filter((c) => c.words[0].lit === 'git');
  assert.equal(gits[0].words[2].lit, 'C:\\w');
  assert.equal(gits[1].words[2].lit, 'C:\\w');
  const r2 = await PS(`$WT = 'C:\\w'; $WT = $x; git -C $WT ${P} fork x`);
  assert.equal(r2.calls.find((c) => c.words[0].lit === 'git')!.words[2].lit, null);
});

test('pwsh: a colon parameter gives name and value words', async () => {
  const r = await PS('& .\\land-pr.ps1 -Pr:5');
  assert.deepEqual(lits(r.calls[0]), ['.\\land-pr.ps1', '-Pr', '5']);
  assert.equal(r.calls[0].words[2].colon, true);
});

test('pwsh: pipe, chain, background and function body', async () => {
  const r = await PS('a | b; c && d; function f { git log }');
  assert.equal(find(r, 'b').place.pipe, true);
  assert.equal(find(r, 'd').place.chain, '&&');
  assert.equal(r.calls.find((c) => c.words[0].lit === 'git')!.inFunctionBody, true);
  const bg = await PS('a &');
  assert.equal(bg.ok, true, JSON.stringify(bg.errors));
  assert.equal(bg.calls[0].place.background, true);
});

test('pwsh: depth in a subexpression and a script block', async () => {
  const r = await PS('echo $(git status); & { git log }');
  assert.equal(r.ok, true);
  for (const c of r.calls.filter((c) => c.words[0].lit === 'git')) assert.ok(c.depth >= 1);
});

test('pwsh: F3 -Command, -EncodedCommand, iex literal and dynamic, cmd /c, bash -c', async () => {
  const a = await PS(`pwsh -NoProfile -Command "git ${P} fork re/x"`);
  assert.ok(a.calls.find((c) => c.words[0].lit === 'git' && c.depth >= 1), 'command');
  const e = await PS(`powershell -EncodedCommand ${b64(`git ${P} fork re/x`)}`);
  assert.ok(e.calls.find((c) => c.words[0].lit === 'git'), 'encoded');
  const i = await PS(`iex 'git ${P} fork re/x'`);
  assert.ok(i.calls.find((c) => c.words[0].lit === 'git'), 'iex');
  const d = await PS('Invoke-Expression $x');
  assert.equal(d.calls[0].nested?.status, 'dynamic');
  const m = await PS(`cmd /c "git ${P} fork re/x"`);
  assert.equal(m.calls[0].nested?.status, 'unparsed');
  const s = await PS(`bash -c 'git ${P} fork re/x'`);
  assert.ok(s.calls.find((c) => c.words[0].lit === 'git'), 'bash from pwsh');
});

test('pwsh: parse error gives ok false and an offset', async () => {
  const r = await PS('git status\nWrite-Host "abc');
  assert.equal(r.ok, false);
  assert.equal(typeof r.errors[0].offset, 'number');
  assert.ok(r.errors[0].offset >= 'git status\n'.length);
});

test('pwsh: a timeout is a parse error', async () => {
  const r = await PS('git status', { timeoutMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].msg, /timeout|exit|spawn/i);
});

test('pwsh: comments are free ranges and kinds list names the node types', async () => {
  const t = `git status # git ${P}`;
  const r = await PS(t);
  assert.ok(r.freeRanges.some(([s, e]) => t.slice(s, e).includes(`git ${P}`)));
  const c = await PS('class A { }');
  assert.ok(c.kinds.includes('TypeDefinitionAst'));
});

test('pwsh: assignments with a constant right side propagate, others do not', async () => {
  const r = await PS("$a = 'git'; & $a status; $b = (Get-X); & $b status");
  const [x, y] = r.calls.filter((c) => c.op === '&');
  assert.equal(x.words[0].lit, 'git');
  assert.equal(y.words[0].lit, null);
});

// Q3: the 7 PowerShell kinds on PWSH_KINDS that the 7-day corpus never shows: one hand-made row each.
// Each row checks that the walker really produces the kind and that the F5 allowlist names it.
const KIND_ROWS: [string, string][] = [
  ['DoUntilStatementAst', 'do { git status } until ($true)'],
  ['TrapStatementAst', 'trap { git status }'],
  ['AttributeAst', 'function f { [CmdletBinding()] param($a) git status }'],
  ['NamedAttributeArgumentAst', 'function f { [Parameter(Mandatory = $true)] param($a) git status }'],
  ['UsingExpressionAst', 'Start-Job { git status $using:x }'],
  ['AttributedExpressionAst', "[ValidateNotNull()]$x = 'a'; git status"],
  ['DataStatementAst', "data { 'a' }; git status"],
];
for (const [kind, text] of KIND_ROWS) {
  test(`Q3: ${kind} is produced by the walker and named in PWSH_KINDS`, async () => {
    const r = await parseCalls(text, 'pwsh');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.kinds.includes(kind), `${kind} not in ${r.kinds.join(',')}`);
    assert.ok(PWSH_KINDS.includes(kind));
  });
}

// ---- reader failure versus syntax error (coord-guard-shell-parser commit 2, seat change E1 to E7) ----
test('E7: a syntax error of the text is ok:false with reader unset', async () => {
  const r = await parseCalls("cr 'review", 'bash');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.notEqual(r.errors[0].reader, true);
});

test('E1: a wasm load failure (a throw with no position) is ok:false with reader true', async () => {
  const r = await parseCalls('cr review', 'bash', { bashProvider: async () => { throw new Error('ENOENT sh-syntax.wasm'); } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reader, true);
});

test('E5: the parser throwing a non-syntax error is ok:false with reader true', async () => {
  const r = await parseCalls('cr review', 'bash', { bashProvider: async () => { throw new TypeError('wasm trap'); } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reader, true);
});

test('E6: the parser returning no tree is ok:false with reader true', async () => {
  const r = await parseCalls('cr review', 'bash', { bashProvider: async () => null });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reader, true);
  assert.match(r.errors[0].msg, /no tree/);
});

test('E2/E4: a pwsh provider error or empty result is ok:false with reader true', async () => {
  const a = await parseCalls('cr review', 'pwsh', { pwshProvider: () => ({ error: 'pwsh exit 1' }) });
  const b = await parseCalls('cr review', 'pwsh', { pwshProvider: () => ({ error: 'pwsh bad json' }) });
  for (const r of [a, b]) {
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].reader, true);
  }
});

// ---- line continuations: the parser-level rows that replace the joinContinuations rows (plan 44, section 4.1) ----
const words = async (t: string, d: 'bash' | 'pwsh' = 'bash'): Promise<(string | null)[][]> => (await parseCalls(t, d)).calls.map((c) => c.words.map((w) => w.lit));

test('continuation: Bash removes a backslash-newline outside quotes and inside double quotes', async () => {
  assert.deepEqual(await words('echo foo\\\nbar'), [['echo', 'foobar']]);
  assert.deepEqual(await words('echo "a\\\nb"'), [['echo', 'ab']]);
});
test('continuation: Bash removes a backslash CRLF pair', async () => {
  assert.deepEqual(await words('echo foo\\\r\nbar'), [['echo', 'foobar']]);
});
test('continuation: Bash keeps a backslash-newline inside single quotes', async () => {
  assert.deepEqual(await words("echo 'a\\\nb'"), [['echo', 'a\\\nb']]);
});
test('continuation: an escaped backslash before a newline is not a continuation (two calls)', async () => {
  const w = await words('echo \\\\\nnext');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], ['next']);
});
test('continuation: a # that follows a removed continuation joins its word and is not a comment', async () => {
  assert.deepEqual(await words('echo foo\\\n# note'), [['echo', 'foo#', 'note']]);
});
test('continuation: PowerShell removes a backtick-newline between tokens, keeps it inside single quotes', async () => {
  assert.deepEqual(await words('echo foo`\nbar', 'pwsh'), [['echo', 'foo\nbar']]);
  assert.deepEqual(await words("echo 'a`\nb'", 'pwsh'), [['echo', 'a`\nb']]);
});
test('continuation: PowerShell treats a backslash-newline as no continuation', async () => {
  assert.equal((await words('echo foo\\\nbar', 'pwsh')).length, 2);
});
test('lexShell row: an escaped # is not a comment; the escaped word reads as null and --version stays its own word', async () => {
  assert.deepEqual(await words('echo \\# --version'), [['echo', null, '--version']]);
});

test('noNested: a bash -c payload is neither parsed nor added to the list, so the caller reads it once', async () => {
  const on = await parseCalls("bash -c 'cr review --agent'", 'bash', { noNested: true });
  assert.equal(on.calls.length, 1);
  assert.equal(on.calls[0].nested, undefined);
  const off = await parseCalls("bash -c 'cr review --agent'", 'bash');
  assert.equal(off.calls.length, 2);
  assert.equal(off.calls[1].viaPayload, 'bash-c');
});

// ---- range lists read from parser node positions: quoted, substs, bodies (coord-guard-shell-parser commit 2, seat ruling 16:02) ----
const cut = (t: string, ranges: [number, number][]): string[] => ranges.map(([a, b]) => t.slice(a, b));

test('ranges bash: quoted lists the content of each single, double and $-quoted string', async () => {
  const t = 'echo "a b" \'c d\' $\'e f\'';
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(cut(t, r.quoted), ['a b', 'c d', 'e f']);
});

test('ranges bash: quotes outside words (an assignment value, a redirect target) are listed too', async () => {
  const t = 'X="a;b" cr review 2>"out;file"';
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(cut(t, r.quoted), ['a;b', 'out;file']);
});

test('ranges bash: a substitution inside a double-quoted string is one span with its delimiters and dq true', async () => {
  const t = 'echo "$f $(tr -cd x < $f | wc -c)" `date`';
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(r.substs.map((s) => [t.slice(s.from, s.to), s.dq]), [['$(tr -cd x < $f | wc -c)', true], ['`date`', false]]);
});

test('ranges bash: a heredoc body holds its delimiter line; the delimiter word of a quoted heredoc is no quoted string', async () => {
  const t = "cat <<'EOF'\nbody\nEOF";
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(cut(t, r.bodies), ['body\nEOF']);
  assert.deepEqual(cut(t, r.quoted), []);
});

test('ranges bash: an empty heredoc has no body and its quoted delimiter is no quoted string', async () => {
  const t = "cat <<'EOF'\nEOF\necho ok";
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(r.bodies, []);
  assert.deepEqual(cut(t, r.quoted), []);
});

test('ranges bash: an arithmetic expansion is listed with the substitutions', async () => {
  const t = 'echo "n=$((1+2))"';
  const r = await parseCalls(t, 'bash', { noNested: true });
  assert.deepEqual(r.substs.map((s) => [t.slice(s.from, s.to), s.dq]), [['$((1+2))', true]]);
});

test('ranges pwsh: quoted lists the content of single and double quoted strings', async () => {
  const t = 'echo "a b" \'c d\'';
  const r = await parseCalls(t, 'pwsh', { noNested: true });
  assert.deepEqual(cut(t, r.quoted), ['a b', 'c d']);
});

test('ranges pwsh: $( ) spans with the dq flag, inside and outside a double-quoted string', async () => {
  const t = 'echo "x $(Get-Date) y" $(cr review)';
  const r = await parseCalls(t, 'pwsh', { noNested: true });
  assert.deepEqual(r.substs.map((s) => [t.slice(s.from, s.to), s.dq]), [['$(Get-Date)', true], ['$(cr review)', false]]);
});

test('ranges pwsh: a here-string body is in quoted and bodies, from its first line break to the one before the closing @', async () => {
  const t = "echo @'\nbody\n'@";
  const r = await parseCalls(t, 'pwsh', { noNested: true });
  assert.deepEqual(cut(t, r.bodies), ['\nbody']);
  assert.deepEqual(cut(t, r.quoted), ['\nbody']);
});

test('ranges pwsh: a double-quoted here-string keeps its $( ) span, flagged dq', async () => {
  const t = 'echo @"\nbody $(cr review)\n"@';
  const r = await parseCalls(t, 'pwsh', { noNested: true });
  assert.deepEqual(r.substs.map((s) => [t.slice(s.from, s.to), s.dq]), [['$(cr review)', true]]);
  assert.deepEqual(cut(t, r.bodies), ['\nbody $(cr review)']);
});

test('ranges pwsh: a doubled quote inside a quoted string stays inside one range (the PowerShell AST rule)', async () => {
  const t = "echo 'Dave''s tap' cr";
  const r = await parseCalls(t, 'pwsh', { noNested: true });
  assert.deepEqual(cut(t, r.quoted), ["Dave''s tap"]);
});

// ---- known divergences, kept visible so nobody removes the raw call rule as dead code ----
test('parser divergence D1: sh-syntax 0.8.1 joins a backslash-newline after a comment, bash does not (probe 45)', async () => {
  // Real bash (WSL) runs `echo two` as a second command. The package reads one call. The guard covers it with the raw cr-then-review rule.
  assert.deepEqual(await words('echo hi # note \\\necho two'), [['echo', 'hi', 'echo', 'two']]);
});
test('old lexer divergence D2: PowerShell mid-word backtick CRLF is two statements, as real PowerShell reads it', async () => {
  const w = await words('echo foo`\r\nbar', 'pwsh');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], ['bar']);
});
