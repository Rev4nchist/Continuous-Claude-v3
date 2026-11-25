// Rows of judge(): fail-closed rules F1-F6, F2b, F2c, section 4, and the controls that must allow (coord-guard-shell-parser PR A).
// Port of the RE builder B scratch rows. The module under test is imported, never copied. Push text keeps the split-string form.
// The pwsh rows spawn pwsh; some rows run several, so the timeout is raised for this file.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { judge, type JudgeOpts, type Verdict } from '../shared/shell-judge.js';
import { BASH_KINDS_NOTE, BASH_KINDS_EXTRA, PWSH_KINDS } from '../shared/shell-ast.js';

vi.setConfig({ testTimeout: 60000 });

// Stand-in for a guard's entry test: trigger programs, guarded verbs, and the dynamic-call signs of note 02 section 2.
const ENTRY = (t: string): boolean => /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr|push|review|pulls|iex|Invoke-Expression|Start-Process|cmd|bash|sh|pwsh|powershell)\b|\bpr\s+(create|merge)\b|(^|\s)&\s|-EncodedCommand/i.test(t);
type D = 'bash' | 'pwsh' | 'unknown';
const J = (t: string, d: D = 'bash', o?: JudgeOpts): Promise<Verdict> => judge(t, d, ENTRY, o);
const deny = async (t: string, rule: string, d: D = 'bash', o?: JudgeOpts): Promise<Verdict> => {
  const r = await J(t, d, o);
  assert.equal(r.verdict, 'deny', `${t} -> ${JSON.stringify(r)}`);
  assert.equal(r.rule, rule, `${t} -> ${r.rule} ${r.reason}`);
  return r;
};
const allow = async (t: string, d: D = 'bash', o?: JudgeOpts): Promise<Verdict> => {
  const r = await J(t, d, o);
  assert.equal(r.verdict, 'allow', `${t} -> ${JSON.stringify(r)}`);
  return r;
};
const b64 = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');
const P = 'pu' + 'sh';
const STRICT: JudgeOpts = { f6: 'strict' }; // round 1 reading of F6; the default is the data-only rule of note 02 section 13

// ---- controls that must ALLOW
test('control: git status', async () => { await allow('git status'); });
test('control: cmd /c with no trigger word in its payload', async () => { await allow('cmd /c "npm test -- x"'); });
test('control: a commit message that names git push', async () => { await allow(`git commit -m "fix: git ${P} guard"`); });
test('control: pwsh commit message that names git push', async () => { await allow(`git commit -m "fix: git ${P} guard"`, 'pwsh'); });
test('control: a heredoc body that names cr review', async () => { await allow('cat <<EOF\ncr review\nEOF'); });
test('control: a comment that names the push words', async () => { await allow(`echo hi # git ${P} fork re/x`); });
test('control: a pwsh comment', async () => { await allow(`git status # git ${P} fork re/x`, 'pwsh'); });
test('control: [[ ]] test before git status', async () => { await allow('[[ -f x ]] && git status'); });
test('control: literal push is readable', async () => {
  const r = await allow(`git ${P} fork re/x`);
  assert.equal(r.rule, 'judged');
  assert.equal(r.guarded![0].kind, 'git-push');
  assert.equal(r.guarded![0].remote, 'fork');
  assert.deepEqual(r.guarded![0].refspecs, ['re/x']);
});
test('control: a text with no trigger word is not-entry even when broken', async () => { assert.equal((await allow('echo "')).rule, 'not-entry'); });

// ---- F1
test('F1: a guarded call on line 1 and a broken line 2 is judged from the prefix', async () => {
  const r = await allow(`git ${P} fork re/x\nfoo "`);
  assert.equal(r.rule, 'judged');
  assert.equal(r.prefix, true);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('F1: a dynamic guarded call in the prefix still denies by its own rule', async () => { await deny(`$G ${P} fork re/x\nfoo "`, 'F2b'); });
test('F1: a backslash in the program name of a broken text denies', async () => {
  await deny(`g\\it ${P} fork re/x "`, 'F1');
  await deny('g\\it status "', 'F1'); // the entry test sees git only after the backslash is removed
});
test('F1: a prefix that does not parse either denies', async () => { await deny('if true; then\n git status\n"x', 'F1'); });
test('F1: a broken first line with a trigger word denies', async () => { await deny('git status "', 'F1'); });
test('F1: pwsh broken line 2 is judged from the prefix', async () => {
  const r = await allow(`git ${P} fork re/x\nWrite-Host "abc`, 'pwsh');
  assert.equal(r.prefix, true);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('F1: pwsh broken line 1 denies', async () => { await deny(`git ${P} "`, 'F1', 'pwsh'); });
test('F1: a pwsh timeout denies', async () => { await deny('git status', 'F1', 'pwsh', { timeoutMs: 1 }); });
test('F1: a broken nested payload denies', async () => { await deny(`bash -c 'git ${P} "'`, 'F1'); });

// ---- F2
test('F2: a command substitution in the git -C dir', async () => { await deny(`git -C "$(pwd)" ${P} fork re/x`, 'F2'); });
test('F2: a variable remote', async () => { await deny(`git ${P} "$R" re/x`, 'F2'); });
test('F2: a variable refspec', async () => { await deny(`git ${P} fork "$B"`, 'F2'); });
test('F2: a variable git subcommand', async () => { await deny('git "$S" fork re/x', 'F2'); });
test('F2: a dynamic cd target before a guarded call', async () => { await deny(`cd "$D" && git ${P} fork re/x`, 'F2'); });
test('F2: a literal cd target is readable', async () => {
  const r = await allow(`cd /w && git ${P} fork re/x`);
  assert.deepEqual(r.guarded![0].cwd, ['/w']);
});
test('F2: a command substitution in a pipe consumer', async () => { await deny(`echo x | git ${P} fork $(cat b)`, 'F2'); });
test('F2: -c alias hides a guarded verb', async () => { await deny(`git -c alias.x=${P} x fork re/x`, 'S4'); });
test('F2: a -c alias with no guarded verb is fine', async () => { await allow('git -c alias.x=status x'); });
test('F2: a backslash program name in a parsed text', async () => { await deny(`g\\it ${P} fork re/x`, 'F2b'); });
test('F2: ANSI-C program name with a guarded verb', async () => { await deny(`git status; $'\\x63r' review`, 'F2b'); });
test('F2: gh pr merge with a variable number', async () => { await deny('gh pr merge "$N"', 'F2'); });
test('F2: gh pr merge literal', async () => { const r = await allow('gh pr merge 12 --squash'); assert.equal(r.guarded![0].kind, 'gh-pr'); });
test('F2: gh pr create with a variable head', async () => { await deny('gh pr create --head "$B" --title t', 'F2'); });
test('F2: gh pr create free title may be dynamic', async () => { await allow('gh pr create --title "$T" --head re/x --base main'); });
test('F2: gh pr create -R variable', async () => { await deny('gh pr create -R "$R" --head re/x', 'F2'); });
test('F2: gh api pulls with a variable head field', async () => { await deny('gh api repos/o/r/pulls -X POST -f head="$B" -f base=main', 'F2'); });
test('F2: gh api pulls free title and body', async () => {
  const r = await allow('gh api repos/o/r/pulls -X POST -f head=re/x -f base=main -f title="$T" -F body="$B"');
  assert.equal(r.guarded![0].kind, 'gh-api-pulls');
});
test('F2: gh api pulls with a variable method', async () => { await deny('gh api repos/o/r/pulls/5/merge -X "$M" -f merge_method=squash', 'F2'); });
test('F2: gh api with a variable endpoint', async () => { await deny('gh api "$EP"', 'F2'); });
test('F2: gh api merge endpoint literal', async () => { await allow('gh api repos/o/r/pulls/5/merge -X PUT -f merge_method=squash'); });
test('F2: gh api input from stdin hides the fields', async () => { await deny('echo x | gh api repos/o/r/pulls --input -', 'F2'); });
test('F2: gh api non-pulls with variables is not guarded', async () => { await allow('gh api repos/o/r/issues -f title="$T"'); });
test('F2: wrapper with a variable word', async () => { await deny(`pwsh -File scripts/git-safe.ps1 -C "$d" ${P} fork x`, 'F2'); });
test('F2: wrapper free -m value', async () => {
  const r = await allow('pwsh -File scripts/git-safe.ps1 commit -m "$M"');
  assert.equal(r.guarded![0].kind, 'wrapper');
});
test('F2: wrapper variable refspec', async () => { await deny(`pwsh -File scripts/git-for.ps1 ${P} fork "$B"`, 'F2'); });
test('F2: land script variable -Pr', async () => { await deny('pwsh -File scripts/github/land-pr.ps1 -Pr "$N"', 'F2'); });
test('F2: land script literal -Pr', async () => { const r = await allow('pwsh -File scripts/github/land-pr.ps1 -Pr 5'); assert.equal(r.guarded![0].kind, 'land'); });
test('F2: cr option variable', async () => { await deny('cr review --agent "$x"', 'F2'); });
test('F2: cr literal', async () => { const r = await allow('cr --agent'); assert.equal(r.guarded![0].kind, 'cr'); });
test('F2: coderabbit literal', async () => { await allow('coderabbit review --plain'); });
test('F2: pwsh variable refspec', async () => { await deny(`git ${P} fork $b`, 'F2', 'pwsh'); });
test('F2: pwsh -Pr:var', async () => { await deny('& .\\scripts\\github\\land-pr.ps1 -Pr:$n', 'F2', 'pwsh'); });
test('F2: pwsh -Pr literal', async () => { await allow('& .\\scripts\\github\\land-pr.ps1 -Pr 7', 'pwsh'); });
test('F2: env --chdir is a folder change', async () => {
  const r = await allow(`env --chdir=/x git ${P} fork re/x`);
  assert.deepEqual(r.guarded![0].cwd, ['/x']);
  await deny(`env -S "git ${P}" fork`, 'F2');
});
test('F2: pwsh Start-Process with literal arguments', async () => {
  const r = await allow(`Start-Process git -ArgumentList 'push fork re/x'`, 'pwsh');
  assert.equal(r.guarded![0].kind, 'git-push');
  await deny(`Start-Process git -ArgumentList $a`, 'F2', 'pwsh');
});

// ---- F2b
test('F2b: a variable program with a guarded verb', async () => { await deny(`$G ${P} fork re/x`, 'F2b'); });
test('F2b: a variable set by a literal resolves and is judged', async () => {
  const r = await allow(`x=git; $x ${P} fork re/x`);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('F2b: rule 2, a source that holds a trigger word', async () => {
  await deny('x=$(echo cr); $x review', 'F2b');
  await deny('x=$(echo cr); $x --agent', 'F2b'); // no guarded verb: only the source test can deny
});
test('F2b: rule 4, a source with no trigger word is allowed (equal to main)', async () => {
  const r = await allow(`x=$(printf '\\x63r'); $x --agent`);
  assert.ok(r.rule === 'not-entry' || r.rule === 'F2b-residual' || r.rule === 'clean', r.rule);
});
test('F2b: rule 4 inside an entry text', async () => {
  const r = await allow(`git status; x=$(printf '\\x63r'); $x --agent`);
  assert.equal(r.rule, 'F2b-residual');
});
test('F2b: rule 3 for gh and cr verbs', async () => {
  await deny('$X pr merge 5', 'F2b');
  await deny('$X review', 'F2b');
  await deny('$X api repos/o/r/pulls', 'F2b');
});
test('F2b: pwsh variable program', async () => { await deny(`& $g ${P} fork re/x`, 'F2b', 'pwsh'); });
test('F2b: pwsh variable set by a literal', async () => {
  const r = await allow(`$g = 'git'; & $g ${P} fork re/x`, 'pwsh');
  assert.equal(r.guarded![0].kind, 'git-push');
});

// ---- F2c
test('F2c: -C with a literal variable is readable', async () => {
  const r = await allow(`WT=/w; git -C "$WT" ${P} fork re/x`);
  assert.equal(r.guarded![0].kind, 'git-push');
  assert.equal(r.guarded![0].dir, '/w');
});
test('F2c: a second write in an if denies', async () => { await deny(`WT=/a; if c; then WT=/b; fi; git -C "$WT" ${P} fork re/x`, 'F2'); });
test('F2c: two top-level writes deny', async () => { await deny(`WT=/a; WT=/b; git -C "$WT" ${P} fork re/x`, 'F2'); });
test('F2c: pwsh literal -C variable', async () => { await allow(`$WT = 'C:\\w'; git -C $WT ${P} fork x`, 'pwsh'); });

// ---- F3
test('F3: bash -c literal is judged from its payload', async () => {
  const r = await allow(`bash -c 'git ${P} fork re/x'`);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('F3: bash -c with a variable refspec inside', async () => { await deny(`bash -c 'git ${P} fork "$B"'`, 'F2'); });
test('F3: sh -c and bash -lc', async () => {
  await deny(`sh -c 'git ${P} fork "$B"'`, 'F2');
  await deny(`bash -lc 'git ${P} fork "$B"'`, 'F2');
});
test('F3: a dynamic bash -c payload', async () => { await deny('x=git; bash -c "$x status"', 'F3'); });
test('F3: pwsh -Command from bash', async () => { await deny(`pwsh -Command 'git ${P} fork $b'`, 'F2'); });
test('F3: pwsh -c from bash', async () => { await deny(`powershell -c 'git ${P} fork $b'`, 'F2'); });
test('F3: -EncodedCommand', async () => { await deny(`pwsh -EncodedCommand ${b64(`git ${P} fork $b`)}`, 'F2'); });
test('F3: -EncodedCommand in pwsh', async () => { await deny(`powershell -enc ${b64(`git ${P} fork $b`)}`, 'F2', 'pwsh'); });
test('F3: eval with a literal string', async () => { await deny(`eval 'git ${P} fork "$B"'`, 'F2'); });
test('F3: eval with a variable', async () => { await deny('git status; eval "$X"', 'F3'); });
test('F3: iex literal and dynamic', async () => {
  await deny(`iex 'git ${P} fork $b'`, 'F2', 'pwsh');
  await deny('Invoke-Expression $c', 'F3', 'pwsh');
  await allow(`iex 'git status'`, 'pwsh');
});
test('F3: cmd /c with a guarded payload denies', async () => { await deny(`cmd /c "git ${P} fork re/x"`, 'F3'); });
test('F3: cmd /c from pwsh denies', async () => { await deny(`cmd.exe /c "gh pr merge 5"`, 'F3', 'pwsh'); });
test('F3: xargs in front of a guarded program', async () => {
  await deny(`xargs -a list.txt git ${P} fork re/x`, 'F3');
  await deny(`echo a | xargs git ${P}`, 'F3');
  await deny(`xargs --arg-file=l cr review`, 'F3');
});
test('F3: a heredoc to bash that holds a variable refspec', async () => { await deny(`bash <<'EOF'\ngit ${P} fork "$B"\nEOF`, 'F2'); });
test('F3: a here-string to bash that is literal is readable', async () => { await allow(`bash <<< 'git ${P} fork re/x'`); });

// ---- F4
test('F4: unknown shell, literal text is readable', async () => { await allow(`git ${P} fork re/x`, 'unknown'); });
test('F4: unknown shell, dynamic text denies', async () => { await deny(`git ${P} fork "$B"`, 'F2', 'unknown'); });
test('F4: both parses fail and the entry test passes is F1', async () => { await deny(`git ${P} "`, 'F1', 'unknown'); });
test('F4: bash fails, pwsh parses: the pwsh verdict decides', async () => { await deny(`git status; if ($x) { git ${P} fork $y }`, 'F2', 'unknown'); });
test('F4: strictest of two parses', async () => { await deny(`$G ${P} fork re/x`, 'F2b', 'unknown'); });
test('F4: bash reads {re/x} as a literal, pwsh as a script block; the strict parse decides', async () => {
  await allow(`git ${P} fork {re/x}`, 'bash');
  await deny(`git ${P} fork {re/x}`, 'F2', 'unknown');
});

// ---- F5
test('F5: dropping a kind from the list denies a text that uses it', async () => {
  const kinds = [...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS].filter((k) => k !== 'Subshell');
  await deny('(git status)', 'F5', 'bash', { allowedKinds: kinds });
  await allow('(git status)');
});
test('F5: the note list as written lacks the test kinds', async () => {
  const note = [...BASH_KINDS_NOTE, ...PWSH_KINDS];
  await deny('[[ -f x ]] && git status', 'F5', 'bash', { allowedKinds: note });
  for (const k of ['BinaryTest', 'UnaryTest', 'ArithmCmd', 'LetClause']) assert.ok(BASH_KINDS_EXTRA.includes(k), k);
  for (const k of ['CallExpr', 'FuncDecl', 'TestClause', 'Comment']) assert.ok(BASH_KINDS_NOTE.includes(k), k);
});
test('F5: a pwsh kind that is not on the list denies', async () => { await deny('class A { }; git status', 'F5', 'pwsh'); });
test('F5: an off-list kind in a text without a trigger word is allowed', async () => { await allow('class A { }', 'pwsh'); });
test('F5: the pwsh list holds the walker kinds', async () => {
  for (const k of ['CommandAst', 'PipelineAst', 'PipelineChainAst', 'ScriptBlockExpressionAst', 'HashtableAst']) assert.ok(PWSH_KINDS.includes(k), k);
});

// ---- F6
test('F6 strict: the push words as plain arguments of another program deny', async () => { await deny(`echo git ${P}`, 'F6', 'bash', STRICT); });
test('F6 strict: quoted words as an argument of an unguarded program deny', async () => { await deny(`grep "git ${P}" f`, 'F6', 'bash', STRICT); });
test('F6 strict: the backstop removes quotes and backslashes before it matches', async () => { await deny(`echo git pu"sh"`, 'F6', 'bash', STRICT); });
test('F6 strict: pwsh Write-Output names push words', async () => { await deny(`Write-Output "git ${P}"`, 'F6', 'pwsh', STRICT); });
test('F6 strict: a heredoc piped to a shell runs its body', async () => { await deny(`cat <<EOF | sh\ngit ${P} fork re/x\nEOF`, 'F6', 'bash', STRICT); });
test('F6: a heredoc fed to bash is its payload, judged and not free', async () => {
  const r = await allow(`bash <<'EOF'\ngit ${P} fork re/x\nEOF`);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('F6: a guarded program with a verb in a free -m value only', async () => { await allow(`git-safe.ps1 commit -m "run git ${P} later"`); });
test('F6: a quoted heredoc fed to cat, free', async () => { await allow(`cat <<'EOF'\ngh pr merge 5\nEOF`); });

// ---- section 4
test('S4: bash alias to git with expand_aliases', async () => { await deny(`shopt -s expand_aliases; alias g=git; g ${P} fork re/x`, 'S4'); });
test('S4: bash alias without expand_aliases does not run', async () => { await allow(`alias g='git ${P}'; g fork re/x`); });
test('S4: pwsh Set-Alias, sal, New-Alias, nal', async () => {
  for (const c of ['Set-Alias g git', 'sal g git', 'New-Alias g git', 'nal g git', 'Set-Alias -Name g -Value git']) await deny(`${c}; g ${P} fork re/x`, 'S4', 'pwsh');
  await allow('Set-Alias g Get-Date', 'pwsh');
});
test('S4: a function that wraps a guarded call after a cd', async () => {
  await deny(`f() { git ${P} fork re/x; }; cd /b; f`, 'S4');
  await deny(`cd /a; f() { git ${P} fork re/x; }; f`, 'S4');
  const r = await allow(`f() { git ${P} fork re/x; }; f`);
  assert.equal(r.guarded![0].kind, 'git-push');
});
test('S4: a pwsh function that wraps a guarded call after a cd', async () => {
  await deny(`function f { git ${P} fork re/x }; cd C:\\x; f`, 'S4', 'pwsh');
});
test('S4: gh alias set with a guarded value', async () => {
  await deny(`gh alias set co 'pr merge'`, 'S4');
  await allow('gh alias set co "pr checkout"');
});
test('S4: a configured git alias is read through the resolver', async () => {
  const r = await allow(`git p fork re/x`, 'bash', { gitAlias: () => 'push' });
  assert.equal(r.guarded![0].kind, 'git-push');
  await deny('git p fork "$B"', 'F2', 'bash', { gitAlias: () => 'push' });
  await deny('git p fork re/x', 'S4', 'bash', { gitAlias: () => '!git ' + P + ' fork re/x' });
  await allow('git p fork re/x', 'bash', { gitAlias: () => null });
});
