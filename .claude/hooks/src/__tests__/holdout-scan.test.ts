// Tests for holdout-scan.ts (card coord-holdout-scan-warn, seat ruling 2026-11-15). Warn only, never deny.
// Every id here is made up: the fake dataset holds PR 4242, comment 7777777 and one fake 40-hex sha.
//
// Failure modes and the change that would break each test:
//   HS1 a fake id in a tool input gives no warning                    -> drop a tool from SCAN_TOOLS or read the wrong field
//   HS2 a bare 4-digit number (a line number) warns                   -> count bare digits instead of countIdsIn
//   HS3 a write into the gold store warns                             -> drop the exempt list
//   HS4 a failed id-list read denies, or passes in silence            -> deny on error, or return nothing
//   HS5 the id or the matched text reaches the warning or the log row -> put the match or a slice in the text
//   HS6 a file over the read limit is reported as fully scanned        -> drop the limit note
//   HS7 a read-only Artifact action or another tool is scanned        -> scan every action or every tool
//   HS8 the off flag does not stop the scan                           -> ignore holdoutScan.off
//   HS9 any output holds a permission decision                        -> deny or ask instead of warn
//   HS10 a short stored sha is missed when the text holds the full sha -> match one direction only (seat R1)
//   HS11 the scan-off warning repeats on every call of a session       -> drop the session marker (seat R2)
//   HS12 the log row does not say whether the cwd is a CCv3 checkout   -> drop the ccv3 field (seat S1)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_READ_LIMIT, SCAN_TOOLS, scanInput } from '../holdout-scan.js';

const FAKE_PR = '4242';
const FAKE_COMMENT = '7777777';
const FAKE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

let home: string;
let logPath: string;

function plantDataset(root: string, ok = true): void {
  const repo = join(root, 'continuous-claude');
  mkdirSync(join(repo, '.claudedocs'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'eval', 'review-eval'), { recursive: true });
  if (ok) {
    const ds = { prs: [{ pr: 4242 }, { pr: 11 }], findings: [{ pr: 4242, comment_id: 7777777, round: FAKE_SHA }] };
    writeFileSync(join(repo, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify(ds));
  }
  writeFileSync(join(repo, 'scripts', 'eval', 'review-eval', 'config.json'), JSON.stringify({ holdoutExclude: [11], reserve: [] }));
}

const run = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}, cwd?: string) =>
  scanInput({ tool_name, tool_input, cwd: cwd ?? home, session_id: 'sess-1' }, { env: { CCV3_USER_HOME: home }, logPath, now: () => '2026-11-15T12:00:00.000Z', ...extra });

const logRows = (): Record<string, unknown>[] => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holdout-scan-'));
  logPath = join(home, 'logs', 'holdout-scan.jsonl');
  plantDataset(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('holdout-scan', () => {
  it('HS1: a fake id in each scanned tool input warns with a count', () => {
    const file = join(home, 'page.html');
    writeFileSync(file, `<p>see PR #${FAKE_PR}</p>`);
    const cases: [string, Record<string, unknown>][] = [
      ['Bash', { command: `echo "PR #${FAKE_PR}"` }],
      ['PowerShell', { command: `Write-Output ${FAKE_COMMENT}` }],
      ['SendMessage', { to: 'peer', message: `the round ${FAKE_SHA.slice(0, 10)} is done` }],
      ['Artifact', { file_path: file }],
      ['Write', { file_path: join(home, 'notes.md'), content: `id ${FAKE_COMMENT}` }],
      ['Edit', { file_path: join(home, 'notes.md'), old_string: 'a', new_string: `pull/${FAKE_PR}` }],
      ['NotebookEdit', { notebook_path: join(home, 'n.ipynb'), new_source: `x = ${FAKE_COMMENT}` }],
    ];
    for (const [tool, input] of cases) {
      const out = run(tool, input).output;
      expect(out, tool).not.toBeNull();
      expect(out?.hookSpecificOutput.additionalContext, tool).toMatch(/holdout-scan: 1 holdout id/);
    }
    expect(new Set(cases.map(([t]) => t))).toEqual(SCAN_TOOLS);
  });

  it('HS2: a bare 4-digit number (a line number) does not warn, but the log row counts it as bare', () => {
    const r = run('Bash', { command: `sed -n ${FAKE_PR},4300p file.ts` });
    expect(r.output).toBeNull();
    expect(logRows()).toEqual([{ ts: '2026-11-15T12:00:00.000Z', tool: 'Bash', count: 0, bare: 1, mode: 'warn', ccv3: false }]);
  });

  it('HS3: a write into the gold store, the review-engine state dir or the dataset does not warn', () => {
    const gold = join(home, 'continuous-claude', 'scripts', 'eval', 'review-eval', 'gold', 'gold-a.json');
    const state = join(home, '.claude', 'state', 'review-engine', 'escapes.jsonl');
    const ds = join(home, 'continuous-claude', '.claudedocs', '2026-11-01-pr-review-dataset.json');
    for (const p of [gold, state, ds]) expect(run('Write', { file_path: p, content: `PR #${FAKE_PR}` }).output, p).toBeNull();
    expect(run('Write', { file_path: join(home, 'elsewhere', 'gold-a.json'), content: `PR #${FAKE_PR}` }).output).not.toBeNull();
  });

  it('HS4: a failed id-list read warns that the scan is off, never denies', () => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    plantDataset(home, false);
    const out = run('Bash', { command: 'echo hi' }).output;
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan off: the holdout id list could not be read/);
    expect(JSON.stringify(out)).not.toMatch(/permissionDecision/);
    expect(logRows()[0]).toMatchObject({ tool: 'Bash', error: 'list' });
  });

  it('HS5: no id, no matched text and no slice of the payload in the warning or the log row', () => {
    const secretish = `context-words-${FAKE_COMMENT}-tail`;
    const out = run('SendMessage', { to: 'peer', message: `PR #${FAKE_PR} and ${FAKE_COMMENT} and ${FAKE_SHA} ${secretish}` }).output;
    const text = JSON.stringify(out) + readFileSync(logPath, 'utf8');
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan: 3 holdout id/);
    for (const s of [FAKE_PR, FAKE_COMMENT, FAKE_SHA, FAKE_SHA.slice(0, 7), 'context-words', 'tail']) expect(text, s).not.toContain(s);
    expect(Object.keys(logRows()[0]).sort()).toEqual(['bare', 'ccv3', 'count', 'mode', 'tool', 'ts']);
  });

  it('HS6: a file larger than the read limit is scanned to the limit and the warning names the unread tail', () => {
    const big = join(home, 'big.html');
    writeFileSync(big, `${'x'.repeat(FILE_READ_LIMIT + 10)} PR #${FAKE_PR}`);
    const out = run('Artifact', { file_path: big }).output;
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan: 0 holdout ids? in the first 1 MiB/);
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/not scanned/);
    expect(FILE_READ_LIMIT).toBe(1024 * 1024);
  });

  it('HS7: a read-only Artifact action and a tool outside the set are not scanned', () => {
    expect(run('Artifact', { action: 'read', url: `https://x/${FAKE_COMMENT}` }).output).toBeNull();
    const asset = join(home, 'logo.svg');
    writeFileSync(asset, `<svg><!-- ${FAKE_COMMENT} --></svg>`);
    expect(run('Artifact', { action: 'publish', asset: true, url: 'https://x/a', file_path: asset }).output, 'an asset upload is not a page').toBeNull();
    expect(run('Artifact', { action: 'list', title: `PR #${FAKE_PR}` }).output, 'a list action sends nothing').toBeNull();
    expect(run('Read', { file_path: `/x/${FAKE_COMMENT}` }).output).toBeNull();
    expect(logRows()).toEqual([]);
  });

  it('HS8: holdoutScan.off true in review-router.config.json stops the scan', () => {
    writeFileSync(join(home, 'review-router.config.json'), JSON.stringify({ holdoutScan: { off: true } }));
    expect(run('Bash', { command: `echo PR #${FAKE_PR}` }).output).toBeNull();
    expect(logRows()).toEqual([]);
  });

  it('HS9: no output ever holds a permission decision', () => {
    for (const cmd of [`PR #${FAKE_PR}`, 'plain']) expect(JSON.stringify(run('Bash', { command: cmd }).output ?? {})).not.toMatch(/permissionDecision/);
  });
  it('HS10: a sha matches in both directions with a floor of 7 hex: a text prefix of a stored full sha, and a stored short sha inside a full text sha', () => {
    expect(run('Bash', { command: `git show ${FAKE_SHA.slice(0, 7)}` }).output?.hookSpecificOutput.additionalContext).toMatch(/1 holdout id/);
    expect(run('Bash', { command: `git show ${FAKE_SHA.slice(0, 6)}` }).output, 'under the 7-hex floor').toBeNull();
    const short = 'fedcba98';
    const full = `${short}76543210fedcba9876543210fedcba98`;
    const repo = join(home, 'continuous-claude');
    writeFileSync(join(repo, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify({ prs: [{ pr: 4242 }], findings: [{ pr: 4242, comment_id: 7777777, round: short }] }));
    expect(run('Bash', { command: `git log ${full}` }).output?.hookSpecificOutput.additionalContext).toMatch(/1 holdout id/);
    expect(run('Bash', { command: `git log ${short.slice(0, 6)}0000` }).output, 'no prefix relation').toBeNull();
  });

  it('HS11: with an unreadable list the scan-off warning comes once per session, and every call is logged', () => {
    rmSync(join(home, 'continuous-claude', '.claudedocs', '2026-11-01-pr-review-dataset.json'));
    const a = run('Bash', { command: 'echo one' }).output;
    const b = run('Write', { file_path: join(home, 'x.md'), content: 'two' }).output;
    expect(a?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan off/);
    expect(b).toBeNull();
    expect(logRows().filter((r) => r.error === 'list')).toHaveLength(2);
    expect(existsSync(join(home, '.claude', 'state', 'holdout-scan'))).toBe(true);
    const other = scanInput({ tool_name: 'Bash', tool_input: { command: 'x' }, cwd: home, session_id: 'sess-2' }, { env: { CCV3_USER_HOME: home }, logPath }).output;
    expect(other?.hookSpecificOutput.additionalContext, 'another session warns once too').toMatch(/holdout-scan off/);
  });

  it('HS13: a primary-root lookup that throws gives the scan-off warning once and never an exception (seat read of 9cda80b1)', () => {
    const boom = () => { throw new Error('no home'); };
    const call = (sid: string) => scanInput({ tool_name: 'Bash', tool_input: { command: 'echo x' }, cwd: home, session_id: sid }, { env: { CCV3_USER_HOME: home }, logPath, repoRoot: boom });
    expect(() => call('sess-9')).not.toThrow();
    expect(call('sess-8').output?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan off/);
    expect(call('sess-8').output, 'once per session').toBeNull();
    expect(() => scanInput({ tool_name: 'Read', tool_input: {}, cwd: home }, { env: {}, logPath, repoRoot: boom })).not.toThrow();
  });

  it('HS12: the log row says whether the cwd is inside a CCv3 checkout (true or false, no path)', () => {
    run('Bash', { command: `echo PR #${FAKE_PR}` }, {}, join(home, 'continuous-claude', '.claude', 'worktrees', 'w1'));
    run('Bash', { command: `echo PR #${FAKE_PR}` }, {}, join(home, 'other-repo'));
    expect(logRows().map((r) => r.ccv3)).toEqual([true, false]);
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/other-repo|worktrees/);
  });
});

// ---- gold ids (card coord-content-scan-followups, item gold ids; design note .claudedocs/coordination/2026-11-16-coord-gold-ids-design.md) ----
// The warn hook reads the wider list: the holdout ids and the gold ids. Every gold id here is made up.
//   HS14 a gold sha or a 4-digit gold PR number in a tool input gives no warning     -> read loadHoldoutIds instead of loadListedIds
//   HS15 a short gold PR number or a bare number warns                                -> list the 1 to 3 digit gold PR numbers (the false-deny class)
//   HS16 a write into an answer-key path warns, or a write elsewhere does not          -> drop the answer-key matcher, or match any file name
//   HS17 a broken gold folder gives a partial scan                                    -> swallow the gold read error
//   HS18 a gold id reaches the warning or the log row                                 -> put the match in the text
//   HS19 the holdout warning changes when a gold folder exists                        -> change the holdout path
const GOLD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const GOLD_PR_LONG = 8888;
const GOLD_PR_SHORT = 123;

function plantGold(files: Record<string, unknown> = { 'gold-a.json': [{ target: { pr: GOLD_PR_LONG, sha40: GOLD_SHA } }, { target: { pr: GOLD_PR_SHORT } }] }): void {
  const dir = join(home, 'continuous-claude', 'scripts', 'eval', 'review-eval', 'gold');
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}
const warnOf = (tool: string, input: Record<string, unknown>): string | undefined => run(tool, input).output?.hookSpecificOutput.additionalContext;

describe('holdout-scan with gold ids', () => {
  beforeEach(() => plantGold());

  it('HS14: a gold sha and a 4-digit gold PR number after a context word warn with a count, in each outgoing tool input', () => {
    for (const [tool, input] of [
      ['Bash', { command: `echo ${GOLD_SHA.slice(0, 12)}` }],
      ['SendMessage', { to: 'peer', message: `the fix is PR #${GOLD_PR_LONG}` }],
      ['Write', { file_path: join(home, 'notes.md'), content: `sha ${GOLD_SHA}` }],
    ] as [string, Record<string, unknown>][]) expect(warnOf(tool, input), tool).toMatch(/holdout-scan: 1 holdout id/);
  });

  it('HS15: a 3-digit gold PR number and a bare 4-digit number do not warn (short numbers stay out of the list)', () => {
    expect(warnOf('Bash', { command: `echo "PR #${GOLD_PR_SHORT} and pull/${GOLD_PR_SHORT}"` })).toBeUndefined();
    expect(run('Bash', { command: `sed -n ${GOLD_PR_LONG},9000p file.ts` }).output).toBeNull();
  });

  it('HS16: a write into an answer-key path (the gold store, rubrics, seeds, the link labels) does not warn; a write elsewhere does', () => {
    const repo = join(home, 'continuous-claude');
    const key = ['scripts/eval/review-eval/gold/gold-a.json', 'scripts/eval/review-eval/rubrics/x.md', 'scripts/eval/review-eval/seeds/s.json', 'scripts/eval/review-eval/linktype-labels.json'];
    for (const p of key) expect(run('Write', { file_path: join(repo, p), content: `sha ${GOLD_SHA}` }).output, p).toBeNull();
    // A worktree copy of the same path, in a backslash spelling, is the same answer-key path.
    expect(run('Edit', { file_path: join(repo, '.claude', 'worktrees', 'w1', 'scripts', 'eval', 'review-eval', 'gold', 'gold-b.json').replace(/\//g, '\\'), old_string: 'a', new_string: `sha ${GOLD_SHA}` }).output).toBeNull();
    for (const p of ['scripts/eval/review-eval/score.mjs', 'docs/gold/gold-a.json', 'notes.md']) expect(warnOf('Write', { file_path: join(repo, p), content: `sha ${GOLD_SHA}` }), p).toMatch(/holdout-scan: 1 holdout id/);
  });

  it('HS17: a gold folder that cannot be read gives the scan-off warning, never a partial scan', () => {
    plantGold({ 'gold-a.json': '{ not json' });
    const out = run('Bash', { command: `echo PR #4242 ${GOLD_SHA}` }).output;
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan off: the holdout id list could not be read/);
    expect(JSON.stringify(out)).not.toMatch(/permissionDecision/);
    expect(logRows()[0]).toMatchObject({ tool: 'Bash', error: 'list' });
  });

  it('HS18: no gold id and no slice of one in the warning or the log row', () => {
    const out = run('SendMessage', { to: 'peer', message: `${GOLD_SHA} and PR #${GOLD_PR_LONG} and more words` }).output;
    const text = JSON.stringify(out) + readFileSync(logPath, 'utf8');
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/holdout-scan: 2 holdout id/);
    for (const s of [GOLD_SHA, GOLD_SHA.slice(0, 7), String(GOLD_PR_LONG), 'more words']) expect(text, s).not.toContain(s);
  });

  it('HS19: a holdout id warns as before, and a text with a holdout id and a gold id counts both', () => {
    expect(warnOf('Bash', { command: `echo PR #${FAKE_PR}` })).toMatch(/holdout-scan: 1 holdout id/);
    expect(warnOf('Bash', { command: `echo PR #${FAKE_PR} and ${GOLD_SHA}` })).toMatch(/holdout-scan: 2 holdout ids/);
  });
});
