/**
 * decision-ledger and the decision log (card decision-append-log). The store and the log are real files in a temp folder
 * (CCV3_DECISIONS_FILE; the log sits beside it). Nothing is mocked except the audit source, which a test passes in.
 *
 * Failure modes, one test each:
 *   H1  a recorded tap writes no log line, or the line misses the session and lane the hook gathered
 *   H2  a failed log append blocks the tap, or the hook text does not say the audit line is missing
 *   H3  a tap that matched nothing writes a line or gathers the audit (the lane CLI would run for every stray answer)
 *   H4  the audit gatherer spawns the lane CLI in a unit test, or ignores the off switch
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRead, offerWrite } from '../shared/decisions-store.js';
import { auditFacts, handle, laneEnv, pickSessionId } from '../decision-ledger.js';

const HEAD = 'a'.repeat(40);
const KEY = 'Rev4nchist/Continuous-Claude-v3#714';
let dir = '';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-ledger-log-'));
  saved = { f: process.env.CCV3_DECISIONS_FILE, l: process.env.CCV3_DECISION_LOG_FILE };
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
  delete process.env.CCV3_DECISION_LOG_FILE;
});
afterEach(() => {
  for (const [name, v] of [['CCV3_DECISIONS_FILE', saved.f], ['CCV3_DECISION_LOG_FILE', saved.l]] as const) {
    if (v === undefined) delete process.env[name]; else process.env[name] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const spec = {
  header: 'Land',
  question: 'PR #714 is READY at aaaaaaa.\nLand it?',
  options: [{ label: 'Land now (Recommended)', description: 'Runs land-pr.ps1.' }, { label: 'Keep open', description: 'Nothing runs.' }],
};
const payload = (answer: unknown): string => {
  const questions = [{ question: spec.question, header: spec.header, multiSelect: false, options: spec.options }];
  return JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_response: { questions, answers: { [spec.question]: answer } } });
};
const contextOf = (out: string): string => (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
const triple = { step: 'land' as const, key: KEY, head: HEAD };
const logLines = (): Array<Record<string, unknown>> => {
  const file = join(dir, 'decision-log.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

describe('decision-ledger decision log', () => {
  it('H1 a recorded tap appends one log line with the session and lane the hook gathered', () => {
    expect(offerWrite({ ...triple, spec }).ok).toBe(true);
    const out = handle(payload('Land now (Recommended)'), () => ({ session: '72de71 Status band', lane: ['decision-append-log'] }));
    expect(contextOf(out)).toContain('Recorded');
    expect(contextOf(out)).not.toContain('NOT written');
    const [line, ...more] = logLines();
    expect(more).toHaveLength(0);
    expect(line).toMatchObject({ v: 1, kind: 'tap', step: 'land', key: KEY, pr: 714, head: HEAD, label: 'Land now (Recommended)', session: '72de71 Status band', lane: ['decision-append-log'] });
  });

  it('H2 a failed append still records the tap and the hook text says the audit line is missing', () => {
    mkdirSync(join(dir, 'decision-log.jsonl')); // a folder where the log file goes
    expect(offerWrite({ ...triple, spec }).ok).toBe(true);
    const out = handle(payload('Land now (Recommended)'), () => ({ session: null, lane: null }));
    expect(decisionRead(triple)?.label).toBe('Land now (Recommended)');
    expect(contextOf(out)).toContain('Recorded "Land now (Recommended)"');
    expect(contextOf(out)).toContain('The decision log was NOT written');
  });

  it('H3 an answer that matches no option writes no line and never gathers the audit', () => {
    expect(offerWrite({ ...triple, spec }).ok).toBe(true);
    const audit = vi.fn(() => ({ session: 'x', lane: ['y'] }));
    handle(payload('sure, go ahead'), audit);
    expect(audit).not.toHaveBeenCalled();
    expect(logLines()).toHaveLength(0);
    expect(decisionRead(triple)).toBeNull();
  });

  it('H5 the audit gets the session id of the hook payload, not only the environment', () => {
    expect(offerWrite({ ...triple, spec }).ok).toBe(true);
    const seen: string[] = [];
    const raw = JSON.parse(payload('Land now (Recommended)')) as Record<string, unknown>;
    raw.session_id = '0b47ee28-cb51-4654-995b-f0d325980b61';
    handle(JSON.stringify(raw), (id: string) => { seen.push(id); return { session: 's', lane: [] }; });
    expect(seen).toEqual(['0b47ee28-cb51-4654-995b-f0d325980b61']);
  });

  it('H6 pickSessionId prefers the payload, falls back to the environment, and refuses text that is not an id', () => {
    const A = '0b47ee28-cb51-4654-995b-f0d325980b61';
    const B = '9538c0b9-2366-4abc-a81a-a68ef75f4dc4';
    expect(pickSessionId(A, { CLAUDE_CODE_SESSION_ID: B })).toBe(A);
    expect(pickSessionId(undefined, { CLAUDE_CODE_SESSION_ID: B })).toBe(B);
    expect(pickSessionId('s1', { CLAUDE_CODE_SESSION_ID: B })).toBe(B);
    expect(pickSessionId('../x', {})).toBe('');
    expect(pickSessionId(undefined, {})).toBe('');
  });

  it('H7 the lane CLI runs with the payload session id in its environment, whatever the hook environment holds', () => {
    const A = '0b47ee28-cb51-4654-995b-f0d325980b61';
    expect(laneEnv(A, {}).CLAUDE_CODE_SESSION_ID).toBe(A);
    expect(laneEnv(A, { CLAUDE_CODE_SESSION_ID: '9538c0b9-2366-4abc-a81a-a68ef75f4dc4', PATH: 'p' })).toMatchObject({ CLAUDE_CODE_SESSION_ID: A, PATH: 'p' });
  });

  it('H4 auditFacts spawns nothing under vitest or with the off switch, and gives null parts', () => {
    expect(auditFacts({ VITEST: 'true', CLAUDE_CODE_SESSION_ID: '0b47ee28-cb51-4654-995b-f0d325980b61' })).toEqual({ session: null, lane: null });
    expect(auditFacts({ CCV3_DECISION_AUDIT: 'off', CLAUDE_CODE_SESSION_ID: '0b47ee28-cb51-4654-995b-f0d325980b61' })).toEqual({ session: null, lane: null });
  });
});
