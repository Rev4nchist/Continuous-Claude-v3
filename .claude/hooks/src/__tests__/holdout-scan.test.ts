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

  it('HS12: the log row says whether the cwd is inside a CCv3 checkout (true or false, no path)', () => {
    run('Bash', { command: `echo PR #${FAKE_PR}` }, {}, join(home, 'continuous-claude', '.claude', 'worktrees', 'w1'));
    run('Bash', { command: `echo PR #${FAKE_PR}` }, {}, join(home, 'other-repo'));
    expect(logRows().map((r) => r.ccv3)).toEqual([true, false]);
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/other-repo|worktrees/);
  });
});
