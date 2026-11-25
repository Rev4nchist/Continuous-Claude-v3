import { expect, test } from '@playwright/test';

import { foldOpenQuestions, OPEN_QUESTION_FRESH_MS, parseStepFields, type QuestionSnapshot } from '../src/lib/open-question';

/**
 * Pure checks of the open Question flag (card agentic-os-readers, reader 2).
 * Source: the plugin step in a session state file. The plugin adds a step {id, tool, label, startedAt, questions?}
 * at tool start and removes it at tool end (.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx:1058-1066).
 * A step in the file means running; its absence is the end. The step has no question text.
 * [Speculation] Whether a snapshot is written while the dialog is open is not proven; these specs use fixtures.
 * Pure Node. Each test names the source change that breaks it.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const LABEL_CANARY = 'QUESTION_LABEL_CANARY_91c2';
const SESSION_ID = '0f5ea433-47f0-466d-aaab-5a7406258ff3';

function snap(patch: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    label: 'trex #0f5ea433',
    at: NOW - 10_000,
    endedAt: null,
    chip: null,
    step: { tool: 'AskUserQuestion', startedAt: NOW - 90_000 },
    ...patch,
  };
}

test.describe('foldOpenQuestions', () => {
  test('Q1 an AskUserQuestion step gives one sure flag with the start time and age', () => {
    // Breaks when the tool name test is dropped, or when the age is taken from the snapshot time instead of the step.
    const out = foldOpenQuestions([snap()], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ session: 'trex #0f5ea433', certainty: 'sure', startedAtMs: NOW - 90_000, ageSec: 90 });
  });

  test('Q2 the same session with no step (the tool ended) gives no flag', () => {
    expect(foldOpenQuestions([snap({ step: null })], NOW)).toEqual([]);
  });

  test('Q3 a step of another tool gives no flag', () => {
    expect(foldOpenQuestions([snap({ step: { tool: 'Bash', startedAt: NOW - 5_000 } })], NOW)).toEqual([]);
  });

  test('Q4 the waiting-on-dave chip with no step gives one guessed flag with no start time', () => {
    // The chip is a weaker signal: it also covers ledger questions. Breaks when it is promoted to sure.
    const out = foldOpenQuestions([snap({ step: null, chip: 'waiting-on-dave' })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ certainty: 'guessed', startedAtMs: null });
  });

  test('Q4b a step and the chip together give one sure flag, not two', () => {
    expect(foldOpenQuestions([snap({ chip: 'waiting-on-dave' })], NOW)).toHaveLength(1);
  });

  test('Q5 a snapshot older than the freshness limit drops the flag (a crashed session leaves a step behind)', () => {
    // Breaks when the freshness test moves from `at` to the step start, or the limit constant changes without the spec.
    expect(OPEN_QUESTION_FRESH_MS).toBe(10 * MIN);
    expect(foldOpenQuestions([snap({ at: NOW - OPEN_QUESTION_FRESH_MS + 1_000 })], NOW)).toHaveLength(1);
    expect(foldOpenQuestions([snap({ at: NOW - OPEN_QUESTION_FRESH_MS - 1_000 })], NOW)).toEqual([]);
  });

  test('Q6 an ended session gives no flag, even with a step left in the file', () => {
    expect(foldOpenQuestions([snap({ endedAt: NOW - 1_000 })], NOW)).toEqual([]);
  });

  test('Q7 the flags hold no step label and no full session id', () => {
    // Breaks when a field carries the step label (the app clips it from the tool call) or the raw session id.
    const hostile = snap({
      label: `trex #${SESSION_ID.slice(0, 8)}`,
      ...({ step: { tool: 'AskUserQuestion', startedAt: NOW - 1_000, label: LABEL_CANARY }, sessionId: SESSION_ID } as object),
    });
    const text = JSON.stringify(foldOpenQuestions([hostile], NOW));
    expect(text).not.toContain(LABEL_CANARY);
    expect(text).not.toContain(SESSION_ID);
  });

  test('Q7b two sessions give two flags, the oldest question first', () => {
    const a = snap({ label: 'a #11111111', step: { tool: 'AskUserQuestion', startedAt: NOW - 30_000 } });
    const b = snap({ label: 'b #22222222', step: { tool: 'AskUserQuestion', startedAt: NOW - 300_000 } });
    expect(foldOpenQuestions([a, b], NOW).map((f) => f.session)).toEqual(['b #22222222', 'a #11111111']);
  });

  test('Q7c no sessions gives an empty list', () => {
    expect(foldOpenQuestions([], NOW)).toEqual([]);
  });
});

test.describe('parseStepFields', () => {
  test('Q8 an old file with no id and no questions still parses to the three old fields', () => {
    // Breaks when the new fields become required.
    expect(parseStepFields({ tool: 'Bash', label: 'ls', startedAt: 5 })).toEqual({ tool: 'Bash', label: 'ls', startedAt: 5, id: null, questions: null });
  });

  test('Q8b a new file keeps the id and a question count of 1 to 4 for AskUserQuestion', () => {
    const step = parseStepFields({ id: 'toolu_01', tool: 'AskUserQuestion', label: 'x', startedAt: 7, questions: [{}, {}] });
    expect(step).toMatchObject({ id: 'toolu_01', questions: 2 });
    expect(parseStepFields({ tool: 'AskUserQuestion', label: 'x', startedAt: 7, questions: new Array(9).fill({}) })?.questions).toBe(null);
  });

  test('Q8c a step with no tool or no numeric start is null', () => {
    expect(parseStepFields({ label: 'x', startedAt: 7 })).toBeNull();
    expect(parseStepFields({ tool: 'Bash', label: 'x', startedAt: 'now' })).toBeNull();
    expect(parseStepFields(null)).toBeNull();
    expect(parseStepFields('step')).toBeNull();
  });
});
