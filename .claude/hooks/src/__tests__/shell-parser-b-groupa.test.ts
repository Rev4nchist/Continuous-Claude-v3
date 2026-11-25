// RED rows for Group A of CodeRabbit CLI run 2 on PR 718, plus run 1 shell-judge.ts:120 (card coord-guard-shell-parser, PR B, seat ruling 06:45).
// decision-gate is the first guard to read these parser and judge points; the live coderabbit-guard reads the same files.
// Each row names the failure it pins. The modules under test are imported, never copied.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { judge, defaultEntry, type JudgeOpts } from '../shared/shell-judge.js';
import { parseCalls, walkBatch } from '../shared/shell-ast.js';

vi.setConfig({ testTimeout: 60000 });
const P = 'pu' + 'sh';
const J = (t: string, o?: JudgeOpts, d: 'bash' | 'pwsh' = 'bash') => judge(t, d, defaultEntry, o);

// A1 (shell-judge.ts:440-441): a throw inside a triggered check is a deny. Today the promise rejects and the guard decides what that means.
test('A1: a git alias reader that throws gives a deny, not a rejected judge()', async () => {
  const r = await J(`git p fork re/x`, { gitAlias: () => { throw new Error('config read failed'); } }).catch((e: unknown) => ({ threw: String(e) }));
  assert.ok(!('threw' in r), `judge() rejected: ${JSON.stringify(r)}`);
  assert.equal((r as { verdict: string }).verdict, 'deny');
});
test('A1b (control, already green): a bash parser provider that throws on a text that holds a trigger word gives a deny', async () => {
  const r = await J(`git ${P} fork re/x`, { bashProvider: async () => { throw new Error('wasm trap'); } }).catch((e: unknown) => ({ threw: String(e) }));
  assert.ok(!('threw' in r), `judge() rejected: ${JSON.stringify(r)}`);
  assert.equal((r as { verdict: string }).verdict, 'deny');
});
test('A1c (cost): a text with no trigger word never reaches the provider', async () => {
  const r = await J('ls -la', { bashProvider: async () => { throw new Error('must not run'); } });
  assert.equal(r.verdict, 'allow');
});

// A2 (shell-judge.ts:154): the alias is read in the folder that -C chose.
test('A2: git -C /other p fork re/x reads the alias with /other as the last folder', async () => {
  const seen: (string | null)[][] = [];
  await J(`git -C /other p fork re/x`, { gitAlias: (_v, cwd) => { seen.push([...(cwd ?? [])]); return 'push'; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].at(-1), '/other');
});

// run 1 shell-judge.ts:120: every -C keeps its place, in order (git applies each -C relative to the one before).
test('A2b: git -C /a -C b p fork re/x reads the alias with both folders in order', async () => {
  const seen: (string | null)[][] = [];
  await J(`git -C /a -C b p fork re/x`, { gitAlias: (_v, cwd) => { seen.push([...(cwd ?? [])]); return 'push'; } });
  assert.deepEqual(seen[0].slice(-2), ['/a', 'b']);
});

// A3 (shell-judge.ts:257): shopt -u expand_aliases turns the expansion OFF.
test('A3: shopt -u expand_aliases does not turn the alias check on', async () => {
  const r = await J(`shopt -u expand_aliases; alias g='git ${P}'; g fork re/x`);
  assert.equal(r.verdict, 'allow', JSON.stringify(r));
});
test('A3c (control): shopt -s expand_aliases with a guarded alias value is still a deny', async () => {
  const r = await J(`shopt -s expand_aliases; alias g='git ${P}'; g fork re/x`);
  assert.equal(r.verdict, 'deny', JSON.stringify(r));
});

// A4 (shell-ast.ts:440-442): a cd inside a subshell ends with the subshell.
test('A4: ( cd /a; true ); git push has no folder change before the push', async () => {
  const r = await parseCalls(`( cd /a; true ); git ${P} fork re/x`, 'bash');
  const g = r.calls.find((c) => c.words[0]?.lit === 'git');
  assert.ok(g, 'no git call found');
  assert.deepEqual(g!.cwdBefore, []);
});
test('A4c (control): cd /a; git push still has /a before the push', async () => {
  const r = await parseCalls(`cd /a; git ${P} fork re/x`, 'bash');
  assert.deepEqual(r.calls.find((c) => c.words[0]?.lit === 'git')!.cwdBefore, ['/a']);
});

// A5 (shell-ast.ts:368): a pwsh that cannot start is an { error } row, not an unhandled event.
test('A5: walkBatch with no pwsh on PATH resolves with an error row', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    // Breaks when: the spawn 'error' event has no handler, so the promise never settles (today: a hang plus an unhandled ENOENT).
    const rows = await Promise.race([walkBatch(['git status'], 5000), new Promise<'hung'>((res) => setTimeout(() => res('hung'), 3000))]);
    assert.notEqual(rows, 'hung', 'walkBatch never settled after a spawn error');
    assert.equal(rows.length, 1);
    assert.ok((rows[0] as { error?: string }).error, JSON.stringify(rows[0]));
  } finally { process.env.PATH = saved; }
});

// A6 (shell-ast-walk.ps1:28): "$x " is not the variable $x: the trailing space is part of the word.
test('A6: a PowerShell string with spaces around an interpolated variable is not a plain variable word', async () => {
  const r = await parseCalls('Write-Output "$x "', 'pwsh');
  const w = r.calls[0].words[1];
  assert.notEqual(w.kind, 'var', JSON.stringify(w));
});
test('A6c (control): "$x" alone is still a quoted variable word', async () => {
  const r = await parseCalls('Write-Output "$x"', 'pwsh');
  assert.equal(r.calls[0].words[1].kind, 'var');
});

// A7 (shell-ast-walk.ps1:111): a CRLF before the closing '@ is two characters, and neither is body.
test('A7: a CRLF here-string body range does not hold the CR of the closing line break', async () => {
  const text = "Write-Output @'\r\nabc\r\n'@";
  const r = await parseCalls(text, 'pwsh');
  assert.equal(r.bodies.length, 1);
  const body = text.slice(r.bodies[0][0], r.bodies[0][1]);
  assert.ok(body.endsWith('abc'), JSON.stringify(body));
});
