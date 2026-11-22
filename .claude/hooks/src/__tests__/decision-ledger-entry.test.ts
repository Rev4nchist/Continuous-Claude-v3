/**
 * decision-ledger entry stamp (card prflow-paid-run-guard, PR 2, step a): the hook stamps the entry point of ITS OWN process and the tap time on
 * every decision it records. A paid post later reads both. Real store (a temp file); nothing is mocked.
 *
 * Failure modes, one test each:
 *   E1 the hook records a decision with no entry stamp, or stamps a value that is not CLAUDE_CODE_ENTRYPOINT of the hook environment
 *   E2 a hook with no CLAUDE_CODE_ENTRYPOINT stamps a default (it must leave the stamp empty: no stamp is no paid yes)
 *   E3 tapAt is missing, or is not the time the decision was recorded
 *   E4 a decision of another step (land) misses the stamp (the stamp is on EVERY decision)
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRowRead, offerWrite } from '../shared/decisions-store.js';
import { handle } from '../decision-ledger.js';

const HEAD = 'a'.repeat(40);
const KEY = 'Rev4nchist/Continuous-Claude-v3#12';
let dir = '';
let savedFile: string | undefined;
let savedEntry: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-ledger-entry-'));
  savedFile = process.env.CCV3_DECISIONS_FILE;
  savedEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (savedFile === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = savedFile;
  if (savedEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntry;
  rmSync(dir, { recursive: true, force: true });
});

const spec = (header: string, yes: string) => ({
  header,
  question: `PR #12: ${header}?`,
  options: [{ label: 'No, keep it free (Recommended)', description: 'Posts nothing.' }, { label: yes, description: 'Pays.' }],
});

function ask(step: 'paid-round' | 'land', yes: string): ReturnType<typeof spec> {
  const s = spec(step === 'paid-round' ? 'Paid round' : 'Land', yes);
  expect(offerWrite({ step, key: KEY, head: HEAD, spec: s }).ok).toBe(true);
  return s;
}

function tap(s: ReturnType<typeof spec>, answer: string): void {
  const questions = [{ question: s.question, header: s.header, multiSelect: false, options: s.options }];
  handle(JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_response: { questions, answers: { [s.question]: answer } } }));
}

describe('decision-ledger entry stamp', () => {
  it('E1 stamps the hook environment entry point and the tap time on a paid-round decision', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const s = ask('paid-round', 'Yes, pay up to $2.50');
    const before = Date.now();
    tap(s, 'Yes, pay up to $2.50');
    const row = decisionRowRead({ step: 'paid-round', key: KEY, head: HEAD });
    expect(row?.entry).toBe('cli');
    expect(row?.label).toBe('Yes, pay up to $2.50');
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    const s2 = ask('paid-round', 'Yes, pay up to $3.00');
    tap(s2, 'Yes, pay up to $3.00');
    expect(decisionRowRead({ step: 'paid-round', key: KEY, head: HEAD })?.entry).toBe('sdk-cli');
    expect(Date.parse(row?.tapAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });

  it('E2 a hook with no CLAUDE_CODE_ENTRYPOINT leaves the stamp empty (null), never a default', () => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    const s = ask('paid-round', 'Yes, pay up to $2.50');
    tap(s, 'Yes, pay up to $2.50');
    const row = decisionRowRead({ step: 'paid-round', key: KEY, head: HEAD });
    expect(row?.label).toBe('Yes, pay up to $2.50');
    expect(row?.entry).toBeNull();
  });

  it('E3 tapAt is the record time: an ISO time equal to the row time', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const s = ask('paid-round', 'Yes, pay up to $2.50');
    tap(s, 'Yes, pay up to $2.50');
    const row = decisionRowRead({ step: 'paid-round', key: KEY, head: HEAD });
    expect(Number.isFinite(Date.parse(row?.tapAt ?? ''))).toBe(true);
    expect(row?.tapAt).toBe(row?.at);
  });

  it('E4 a decision of another step (land) carries the stamp too', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const s = ask('land', 'Land now');
    tap(s, 'Land now');
    const stored = JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8')) as { decisions: Record<string, { entry?: string; tapAt?: string }> };
    const row = Object.values(stored.decisions)[0];
    expect(row.entry).toBe('cli');
    expect(typeof row.tapAt).toBe('string');
  });
});
