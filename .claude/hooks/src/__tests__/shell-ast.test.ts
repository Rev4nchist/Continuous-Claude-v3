// Behaviour rows of shared/shell-ast.ts parseCalls: the normalized call list from both dialects (coord-guard-shell-parser PR A).
// Port of the RE builder B scratch rows. The module under test is imported, never copied. The PowerShell rows need pwsh:
// a missing pwsh fails them loudly (a skip would hide a broken walker); CI ubuntu-latest lists PowerShell 7.6 (note 02 section 2).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseCalls, PWSH_KINDS, type Call, type ParseResult } from '../shared/shell-ast.js';

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
