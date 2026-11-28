// RED rows for the 3 CodeRabbit CLI run 1 findings on PR B (card coord-guard-shell-parser, seat word 11:02 CST 11-25, Dave: fix all 3).
//   a  scriptRunnerDenies ignores a parse error: a text that does not parse gets no Ask B deny (decision-gate.ts scriptRunnerDenies)
//   b  withParsed has no time bound on the bash parse: a slow parse can pass the 10 s hook timeout (decision-gate.ts withParsed)
//   c  shopt -u after an alias use hides the alias exposure: -u must never turn the expansion off (shell-judge.ts aliasCall)
// The modules under test are imported, never copied.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { scriptRunnerDenies, withParsed, type Deps } from '../decision-gate.js';
import { judge, defaultEntry } from '../shared/shell-judge.js';

vi.setConfig({ testTimeout: 15000 });
const P = 'pu' + 'sh';
// Card coord-test-log-leak: `env: {}` has no VITEST and no log path, so a late parse (row C1b) wrote to the real
// ~/.claude/logs/guard-decisions.jsonl. The deps env now names a temp log file: the row lands there with source "probe".
const logDir = mkdtempSync(join(tmpdir(), 'shell-parser-b-cli1-'));
const logFile = join(logDir, 'guard.jsonl');
afterAll(() => rmSync(logDir, { recursive: true, force: true }));
const base = { git: () => ({ status: 1, stdout: '' }), readFile: () => null, env: {}, home: '/h' } as unknown as Deps;
const payload = (tool_name: string, command: string) => JSON.stringify({ tool_name, tool_input: { command }, cwd: '/repo' });
const J = (t: string) => judge(t, 'bash', defaultEntry);

// c: the expansion is sticky. Once -s is seen, -u never turns it off (fail closed, the comment at aliasCall says so).
it('C1c: shopt -s, alias, a use, then shopt -u expand_aliases is a DENY (bash expanded the alias while it was on)', async () => {
  const r = await J(`shopt -s expand_aliases; alias ship='git ${P}'; ship fork re/x; shopt -u expand_aliases`);
  expect(r.verdict, JSON.stringify(r)).toBe('deny');
});
it('C1c-b: shopt -s, shopt -u, then the alias line and the use is a DENY (accepted over-deny, fail closed)', async () => {
  const r = await J(`shopt -s expand_aliases; shopt -u expand_aliases; alias ship='git ${P}'; ship fork re/x`);
  expect(r.verdict, JSON.stringify(r)).toBe('deny');
});
it('C1c-control: shopt -u alone, with no -s anywhere, still does not turn the alias check on', async () => {
  const r = await J(`shopt -u expand_aliases; alias ship='git ${P}'; ship fork re/x`);
  expect(r.verdict, JSON.stringify(r)).toBe('allow');
});

// a: a parse error in a dialect, plus a script-runner word and a full guarded call in the raw text, gives the script-runner deny.
it('C1a: a node -e text with a broken quote that names a guarded call is a script-runner DENY', async () => {
  const d = await withParsed(payload('Bash', `node -e "console.log(1); require('child_process').execSync('git ${P} fork re/x')`), base);
  expect(d.parsed, 'the text must be parsed').toBeDefined();
  expect(d.parsed!.byDialect.bash!.errors.length, 'the text must fail to parse').toBeGreaterThan(0);
  expect(scriptRunnerDenies(d.parsed).map((x) => x.pattern)).toEqual(['script-runner']);
});
it('C1a-control: a broken text with a runner word and no guarded call has no script-runner deny', async () => {
  const d = await withParsed(payload('Bash', `node -e "console.log('review`), base);
  expect(d.parsed, 'the text must be parsed').toBeDefined();
  expect(d.parsed!.byDialect.bash!.errors.length).toBeGreaterThan(0);
  expect(scriptRunnerDenies(d.parsed)).toEqual([]);
});
it('C1a-control-b: a broken text with a guarded call and no runner word has no script-runner deny', async () => {
  const d = await withParsed(payload('Bash', `echo "git ${P} fork re/x`), base);
  expect(d.parsed, 'the text must be parsed').toBeDefined();
  expect(d.parsed!.byDialect.bash!.errors.length).toBeGreaterThan(0);
  expect(scriptRunnerDenies(d.parsed)).toEqual([]);
});

// b: a parse that never resolves does not hold the hook. After the budget there is no parsed result and the hand reader decides, as on main.
it('C1b: a bash parse that never resolves ends inside the budget with no parsed result', async () => {
  const hang = { ...base, parseBudgetMs: 100, parseOpts: { bashProvider: () => new Promise(() => {}) } } as unknown as Deps;
  const t0 = Date.now();
  const d = await withParsed(payload('Bash', `git ${P} fork feat/x`), hang);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(d.parsed).toBeUndefined();
  expect(d.git).toBe(base.git);
  // The late-parse row lands in the temp file named by the deps env, marked as a probe (the doctor ignores it). If the override is lost, this fails.
  const rows = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { hook: string; kind: string; message: string; source: string });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ hook: 'decision-gate', kind: 'error', source: 'probe' });
  expect(rows[0].message).toMatch(/parse was late: no answer in 100 ms/);
});
