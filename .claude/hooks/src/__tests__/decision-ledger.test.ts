/**
 * decision-ledger: PostToolUse on AskUserQuestion. It turns Dave's tap into a decision in the store.
 * These tests run the real store (a temp file through CCV3_DECISIONS_FILE). Nothing is mocked.
 *
 * Failure modes, one test each:
 *   L1  an exact label of the open offer does not record, or records for the wrong triple
 *   L2  free text records a decision, or the re-ask count is wrong (1 of 2, 2 of 2, then stop)
 *   L3  a subagent answer records
 *   L4  two open offers share header and labels (land, two PRs): the answer goes to the wrong PR
 *   L5  an AskUserQuestion that is not an offer breaks, or gets context
 *   L6  an engine-owned offer (review) is bumped by the hook: one bad answer would cost two re-asks
 *   L7  a hook-owned offer (land) is never bumped: the model re-asks for ever
 *   L8  another tool is read
 *   L9  the text form of the tool result is not read
 *   L10 a multi-select array or an empty answer records
 *   L11 a question with the offer's header but other options (a forged spec) records
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRead, missBump, missCount, offerWrite, type Step } from '../shared/decisions-store.js';
import { handle, parseAnswers } from '../decision-ledger.js';

const HEAD = 'a'.repeat(40);
const REPO = 'Rev4nchist/Continuous-Claude-v3';
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-ledger-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const landSpec = (pr: number) => ({
  header: 'Land',
  question: `PR #${pr} is READY at aaaaaaa.\nLand it?`,
  options: [
    { label: 'Land now (Recommended)', description: 'Runs land-pr.ps1.' },
    { label: 'Keep open', description: 'Nothing runs.' },
    { label: 'Return to draft', description: 'Runs gh pr ready --undo.' },
  ],
});

function offer(step: Step, key: string, spec: ReturnType<typeof landSpec>, head = HEAD) {
  const r = offerWrite({ step, key, head, spec });
  expect(r.ok).toBe(true);
}

/** A PostToolUse payload as Claude Code sends it: the questions asked, and a result with answers keyed by question text. */
function payload(spec: ReturnType<typeof landSpec>, answer: unknown, extra: Record<string, unknown> = {}): string {
  const questions = [{ question: spec.question, header: spec.header, multiSelect: false, options: spec.options }];
  return JSON.stringify({
    session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion',
    tool_input: { questions },
    tool_response: { questions, answers: { [spec.question]: answer } },
    ...extra,
  });
}

const contextOf = (out: string): string => (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
const landKey = (pr: number) => `${REPO}#${pr}`;
const landTriple = (pr: number) => ({ step: 'land' as const, key: landKey(pr), head: HEAD });

describe('decision-ledger', () => {
  it('L1 records an exact label for the open offer, bound to its step, key and head', () => {
    offer('land', landKey(12), landSpec(12));
    const out = handle(payload(landSpec(12), 'Land now (Recommended)'));
    expect(decisionRead(landTriple(12))?.label).toBe('Land now (Recommended)');
    expect(decisionRead({ ...landTriple(12), head: 'b'.repeat(40) })).toBeNull();
    expect(contextOf(out)).toContain('Recorded');
  });

  it('L1b records a label that ends the question, such as Keep open (the reader decides what it means)', () => {
    offer('land', landKey(12), landSpec(12));
    handle(payload(landSpec(12), 'Keep open'));
    expect(decisionRead(landTriple(12))?.label).toBe('Keep open');
  });

  it('L2 free text records nothing; the re-ask count is 1 of 2, 2 of 2, then stop', () => {
    offer('land', landKey(12), landSpec(12));
    const first = contextOf(handle(payload(landSpec(12), 'sure, go ahead')));
    expect(first).toMatch(/1 of 2/);
    expect(contextOf(handle(payload(landSpec(12), 'yes')))).toMatch(/2 of 2/);
    const third = contextOf(handle(payload(landSpec(12), 'do it')));
    expect(third).toMatch(/^Stop\./m);
    expect(third).not.toMatch(/of 2/);
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L2b a label with other case or spaces is free text', () => {
    offer('land', landKey(12), landSpec(12));
    handle(payload(landSpec(12), 'land now (recommended)'));
    handle(payload(landSpec(12), ' Land now (Recommended)'));
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L3 a subagent answer records nothing and adds no context', () => {
    offer('land', landKey(12), landSpec(12));
    const out = handle(payload(landSpec(12), 'Land now (Recommended)', { agent_id: 'agent-1' }));
    expect(out).toBe('{}');
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L4 two open offers with the same header and labels: the question text picks the PR', () => {
    offer('land', landKey(12), landSpec(12));
    offer('land', landKey(13), landSpec(13), 'c'.repeat(40));
    handle(payload(landSpec(13), 'Land now (Recommended)'));
    expect(decisionRead(landTriple(12))).toBeNull();
    expect(decisionRead({ step: 'land', key: landKey(13), head: 'c'.repeat(40) })?.label).toBe('Land now (Recommended)');
  });

  it('L4b two offers with identical question text records nothing (fail closed)', () => {
    offer('land', landKey(12), landSpec(12));
    offer('land', landKey(14), landSpec(12), 'd'.repeat(40));
    handle(payload(landSpec(12), 'Land now (Recommended)'));
    expect(decisionRead(landTriple(12))).toBeNull();
    expect(decisionRead({ step: 'land', key: landKey(14), head: 'd'.repeat(40) })).toBeNull();
  });

  it('L5 a question that is not an offer gets no context', () => {
    const other = { header: 'Other', question: 'Pick a colour?', options: [{ label: 'Red' }, { label: 'Blue' }] };
    expect(handle(payload(other as ReturnType<typeof landSpec>, 'Red'))).toBe('{}');
    offer('land', landKey(12), landSpec(12));
    expect(handle(payload(other as ReturnType<typeof landSpec>, 'Red'))).toBe('{}');
  });

  it('L6 a review offer is not bumped by the hook (the engine bumps on its re-call)', () => {
    const spec = { ...landSpec(12), header: 'PR #12' };
    offer('review', landKey(12), spec);
    const t = { step: 'review' as const, key: landKey(12), head: HEAD };
    const text = contextOf(handle(payload(spec, 'nope')));
    expect(text).toMatch(/1 of 2/);
    expect(text).toContain('pr_checkpoint');
    expect(missCount(t)).toBe(0);
  });

  it('L6b a review offer with the engine count at 2 stops', () => {
    const spec = { ...landSpec(12), header: 'PR #12' };
    offer('review', landKey(12), spec);
    const t = { step: 'review' as const, key: landKey(12), head: HEAD };
    // The engine bumps once for each re-call: two re-asks are used up.
    missBump(t); missBump(t);
    expect(contextOf(handle(payload(spec, 'nope')))).toMatch(/^Stop./m);
  });

  it('L7 a land offer is bumped by the hook, so the count moves', () => {
    offer('land', landKey(12), landSpec(12));
    handle(payload(landSpec(12), 'nope'));
    expect(missCount(landTriple(12))).toBe(1);
  });

  it('L8 another tool is ignored', () => {
    offer('land', landKey(12), landSpec(12));
    const raw = JSON.parse(payload(landSpec(12), 'Land now (Recommended)')) as Record<string, unknown>;
    raw.tool_name = 'Bash';
    expect(handle(JSON.stringify(raw))).toBe('{}');
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L9 the text form of the tool result is read', () => {
    offer('land', landKey(12), landSpec(12));
    const spec = landSpec(12);
    const raw = JSON.parse(payload(spec, 'x')) as Record<string, unknown>;
    raw.tool_response = `Your questions have been answered: "${spec.question}"="Keep open". You can now continue with these answers in mind.`;
    handle(JSON.stringify(raw));
    expect(decisionRead(landTriple(12))?.label).toBe('Keep open');
  });

  it('L9b a text-form free answer that starts like a label is free text', () => {
    offer('land', landKey(12), landSpec(12));
    const spec = landSpec(12);
    const raw = JSON.parse(payload(spec, 'x')) as Record<string, unknown>;
    raw.tool_response = `Your questions have been answered: "${spec.question}"="Keep openly please". You can now continue with these answers in mind.`;
    handle(JSON.stringify(raw));
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L10 an array answer or an empty answer records nothing', () => {
    offer('land', landKey(12), landSpec(12));
    handle(payload(landSpec(12), ['Land now (Recommended)', 'Keep open']));
    handle(payload(landSpec(12), ''));
    expect(decisionRead(landTriple(12))).toBeNull();
  });

  it('L11 a question with the offer header but other options records nothing and says so', () => {
    offer('land', landKey(12), landSpec(12));
    const forged = { ...landSpec(12), options: [{ label: 'Land now (Recommended)', description: '' }, { label: 'Merge it', description: '' }] };
    const out = handle(payload(forged, 'Land now (Recommended)'));
    expect(decisionRead(landTriple(12))).toBeNull();
    expect(contextOf(out)).toMatch(/does not match/);
  });

  it('parseAnswers reads the object form and ignores junk', () => {
    expect(parseAnswers({ answers: { q: 'a' } }, [])).toEqual({ q: 'a' });
    expect(parseAnswers(null, [])).toEqual({});
    expect(parseAnswers({ answers: { q: 5 } }, [])).toEqual({});
  });

  it('unreadable input is {}', () => {
    expect(handle('not json')).toBe('{}');
    expect(handle('')).toBe('{}');
  });
});
