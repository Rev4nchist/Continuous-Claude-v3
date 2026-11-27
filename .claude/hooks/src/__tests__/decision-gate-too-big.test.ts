/**
 * decision-gate: a command text too big to judge inside the hook time limit (card coord-gate-timeout-hole; plan
 * .claudedocs/e2e-coord-gate-timeout-hole/05-plan.md, seat GO 11-27 15:48). A hook that the harness kills at 10 s writes no answer and the call runs.
 * On main the gate gives no answer at 10 s for a gated text of about 10000 pipe members (PowerShell), 12000 chars of push, 6000 nested
 * `& { }` or 30 inline pwsh payloads (files 02, 03 and 04 of the card folder).
 * The rule under test: tooBigToJudge(input) reads the RAW text once (no parse, no quote or heredoc reading) and denies it when it names a
 * gated word AND is over one threshold. Thresholds (plan section 2): pipe characters >= 1500, bracket depth >= 100, the words pwsh or
 * powershell >= 20, characters >= 30000.
 *
 * Each row names the source change that turns it red:
 *   T1  a gated text over a threshold is judged as before (no answer in time on the real hook)   -> drop tooBigToJudge from handle
 *   T2  a threshold moves (1499 or 1500, 99 or 100, 19 or 20, 29999 or 30000)                    -> change a constant, or > for >=
 *   T3  a text with no gated word is denied for its size                                          -> drop the gated-word test
 *   T4  the same sizes under a threshold change the verdict of main                               -> a rule that reads size under a threshold
 *   T5  the real maxima of the corpus (383 pipes, depth 21, 10010 chars, 20 pwsh words in prose)   -> a threshold set below the real maxima
 *   T6  the deny is not hard (a tap or a flag turns it into a warning)                            -> return a Deny with a scope that a flag softens
 *   T7  the rule runs after the parse (the built hook still waits for the walker)                 -> call tooBigToJudge after withParsed in main()
 *   T8  the verdict does not name the measure and the remedy                                      -> drop the one reason text
 *   T9  a mixed text just under every threshold at once is denied, or one over a single one is allowed -> a rule on the sum, or an or turned into an and
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle, type Deps } from '../decision-gate.js';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-big-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const deps = (): Deps => ({ git: () => ({ status: 128, stdout: '' }), readFile: () => null, env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') }, home: dir });
type Tool = 'Bash' | 'PowerShell';
const run = (tool: Tool, command: string): { decision: string; reason: string } => {
  const out = handle(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: dir }), deps());
  const h = (JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } }).hookSpecificOutput ?? {};
  return { decision: h.permissionDecision ?? (h.additionalContext ? 'warn' : 'allow'), reason: h.permissionDecisionReason ?? h.additionalContext ?? '' };
};
const BIG = /too big to judge/;

const MERGE = 'gh pr merge 6 --admin';
const PUSH = 'git push fork feat';
const CREATE = 'gh pr create --head feat/x --base main --title t';
const LAND = 'land-pr.ps1 -Pr 5';
const STORE = 'node scripts/github/lib/decisions.mjs record';
const VERBS: [string, string][] = [['merge', MERGE], ['push', PUSH], ['create', CREATE], ['land', LAND], ['store write', STORE]];

/** verb, then N pipe characters (N+1 members). */
const withPipes = (verb: string, n: number): string => `${verb}; ${Array(n + 1).fill(':').join('|')}`;
/** the verb inside `depth` nested brackets: bracket depth is exactly `depth`. */
const withDepth = (verb: string, depth: number): string => '('.repeat(depth) + verb + ')'.repeat(depth);
/** the verb after `n` inline payloads, each naming pwsh once: pwsh words are exactly `n` (the verb names none). */
const withPwsh = (verb: string, n: number): string => `${Array.from({ length: n }, (_, i) => `pwsh -c 'echo ${i}'`).join('; ')}; ${verb}`;
/** the verb in a comment, then filler so the whole text has `total` characters. */
const withChars = (verb: string, total: number): string => { const head = `${verb} # `; return head + 'x'.repeat(total - head.length); };

describe('T1 a gated text over a threshold is denied for its size', () => {
  for (const [name, verb] of VERBS) {
    for (const tool of ['Bash', 'PowerShell'] as Tool[]) {
      it(`${tool} ${name}: 1500 pipes`, () => { const r = run(tool, withPipes(verb, 1500)); expect(r.decision).toBe('deny'); expect(r.reason).toMatch(BIG); });
      it(`${tool} ${name}: depth 100`, () => { const r = run(tool, withDepth(verb, 100)); expect(r.decision).toBe('deny'); expect(r.reason).toMatch(BIG); });
      it(`${tool} ${name}: 20 pwsh payloads`, () => { const r = run(tool, withPwsh(verb, 20)); expect(r.decision).toBe('deny'); expect(r.reason).toMatch(BIG); });
      it(`${tool} ${name}: 30000 chars`, () => { const r = run(tool, withChars(verb, 30000)); expect(r.decision).toBe('deny'); expect(r.reason).toMatch(BIG); });
    }
  }
  // The shapes that main answers too late on the built hook (files 02 to 04): the same texts, in process.
  it('PowerShell merge with 10000 pipe members', () => { expect(run('PowerShell', withPipes(MERGE, 9999)).reason).toMatch(BIG); });
  it('Bash merge with 14000 pipe members', () => { expect(run('Bash', withPipes(MERGE, 13999)).reason).toMatch(BIG); });
  it('PowerShell 6000 nested blocks with a merge', () => { expect(run('PowerShell', '& {'.repeat(6000) + MERGE + '}'.repeat(6000)).reason).toMatch(BIG); });
  it('Bash 20000 nested parentheses with a merge', () => { expect(run('Bash', withDepth(MERGE, 20000)).reason).toMatch(BIG); });
  it('PowerShell push with 6000 pipe members', () => { expect(run('PowerShell', withPipes(PUSH, 5999)).reason).toMatch(BIG); });
  it('Bash push with 8000 pipe members', () => { expect(run('Bash', withPipes(PUSH, 7999)).reason).toMatch(BIG); });
  it('30 inline pwsh payloads with a merge', () => { expect(run('Bash', withPwsh(MERGE, 30)).reason).toMatch(BIG); });
});

describe('T2 each threshold is exact', () => {
  const rows: [string, (verb: string, n: number) => string, number][] = [
    ['pipes', withPipes, 1500], ['depth', withDepth, 100], ['pwsh words', withPwsh, 20], ['chars', withChars, 30000],
  ];
  for (const [name, make, at] of rows) {
    it(`${name}: ${at - 1} is judged as before, ${at} is denied for its size`, () => {
      expect(run('Bash', make(MERGE, at - 1)).reason).not.toMatch(BIG);
      expect(run('Bash', make(MERGE, at)).reason).toMatch(BIG);
    });
  }
  it('spelling: pwsh.exe and PowerShell in mixed case count as pwsh words', () => {
    const t = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? `pwsh.exe -c 'echo ${i}'` : `PowerShell -c 'echo ${i}'`)).join('; ') + `; ${MERGE}`;
    expect(run('Bash', t).reason).toMatch(BIG);
  });
});

describe('T3 a text with no gated word is never denied for its size', () => {
  it('1500 pipes, depth 100, 30000 chars and 40 pwsh payloads with no git or gh word', () => {
    for (const t of [Array(2000).fill(':').join('|'), '('.repeat(200) + 'echo' + ')'.repeat(200), 'echo ' + 'x'.repeat(40000), Array.from({ length: 40 }, (_, i) => `pwsh -c 'echo ${i}'`).join('; ')]) {
      expect(run('Bash', t).reason).not.toMatch(BIG);
    }
  });
});

describe('T4 and T5 texts under every threshold keep the verdict of main', () => {
  it('the five card rows still deny by main\'s own rules, not for their size (BP, W6500, BC, V4, sblock-3000 shapes under the thresholds)', () => {
    for (const t of [withPipes(PUSH, 1499), withPipes(MERGE, 1499), withPipes(CREATE, 1499), withDepth(MERGE, 99)]) {
      const r = run('Bash', t);
      expect(r.reason).not.toMatch(BIG);
    }
  });
  it('the real maxima of 7 days of transcripts: 383 pipes, depth 21, 10010 chars, 20 pwsh words as prose', () => {
    expect(run('PowerShell', withPipes(PUSH, 383)).reason).not.toMatch(BIG);
    expect(run('Bash', withDepth(PUSH, 21)).reason).not.toMatch(BIG);
    expect(run('Bash', withChars(PUSH, 10010)).reason).not.toMatch(BIG);
    expect(run('Bash', `# ${'pwsh '.repeat(19)}\n${PUSH}`).reason).not.toMatch(BIG);
  });
});

describe('T6 and T8 the deny is hard and names the measure and the remedy', () => {
  it('a ship tap and a plain text both get the same deny, with one reason that names the remedy', () => {
    const r = run('Bash', withPipes(MERGE, 1500));
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/Write tool/);
    expect(r.reason).toMatch(/pipe/);
  });
  it('a count of the measure is in the reason (pipes)', () => { expect(run('Bash', withPipes(PUSH, 1600)).reason).toMatch(/1600/); });
});

describe('T9 mixed shapes', () => {
  it('just under every threshold at once is judged as before', () => {
    const t = `${withPwsh(MERGE, 19)}; ${Array(1400).fill(':').join('|')}; ${'('.repeat(90)}${')'.repeat(90)}`;
    expect(t.length).toBeLessThan(30000);
    expect(run('Bash', t).reason).not.toMatch(BIG);
  });
  it('over one threshold only is denied', () => {
    expect(run('Bash', `${withPwsh(MERGE, 5)}; ${Array(1600).fill(':').join('|')}`).reason).toMatch(BIG);
  });
});

describe('T7 the built hook answers a text that main answers too late', () => {
  // The real hook, a real payload on stdin, the kill at 10 s of the harness: a gated PowerShell text of 10000 pipe members.
  const HOOK = fileURLToPath(new URL('../../dist/decision-gate.mjs', import.meta.url));
  it('PowerShell merge + 10000 pipe members: a deny that names the size, inside 5 s', () => {
    const t = Date.now();
    const r = spawnSync('node', [HOOK], { input: JSON.stringify({ session_id: 'big-row', hook_event_name: 'PreToolUse', tool_name: 'PowerShell', cwd: dir, tool_input: { command: withPipes(MERGE, 9999) } }), encoding: 'utf8', timeout: 12000, env: { ...process.env, VITEST: '', CCV3_DECISIONS_FILE: join(dir, 'decisions.json') } });
    const ms = Date.now() - t;
    const h = (JSON.parse((r.stdout || '{}').trim() || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput ?? {};
    expect(h.permissionDecision).toBe('deny');
    expect(h.permissionDecisionReason ?? '').toMatch(BIG);
    expect(ms).toBeLessThan(5000);
  }, 30000);
});
