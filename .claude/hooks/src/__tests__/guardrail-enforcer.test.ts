/**
 * guardrail-enforcer trigger precision (2026-09-23 Opus 5.5 eval, P22).
 * Real misfires from one session: "review this tweet" -> code-review; a task notification ->
 * systematic-debugging and databases; prose about a markdown table -> databases.
 */
import { describe, it, expect } from 'vitest';
import { matchGuardrails } from '../guardrail-enforcer.js';

describe('matchGuardrails', () => {
  it('still analyzes a long human prompt (length alone is not "machine-generated")', () => {
    const long = 'please review this PR and merge #45 when green. ' + 'context '.repeat(1200);
    expect(long.length).toBeGreaterThan(8000);
    expect(matchGuardrails(long)).toContain('code-review');
  });

  it('does not fire on harness turns', () => {
    expect(matchGuardrails('<task-notification><task-id>x</task-id> workflow failed with an error </task-notification>')).toEqual([]);
    expect(matchGuardrails('<system-reminder>fix the database query</system-reminder>')).toEqual([]);
  });

  it('code-review: fires on PR / code-review asks only', () => {
    for (const p of ['merge 43 and 44', 'review this PR', 'open a pull request', 'merge #40', 'can you code review the diff', 'review the changes on this branch']) {
      expect(matchGuardrails(p)).toContain('code-review');
    }
    for (const p of ['I want you to review this tweet', 'approve deleting the quarantine folder', 'review the lane board', 'Order looks good', 'fix issue #42']) {
      expect(matchGuardrails(p)).not.toContain('code-review');
    }
  });

  it('databases: fires on SQL-shaped asks only', () => {
    for (const p of ['write a postgres migration', 'the SQL is slow', 'drop table users', 'select id from sessions where x']) {
      expect(matchGuardrails(p)).toContain('databases');
    }
    for (const p of ['put it in a markdown table', 'update INDEX.md', 'add a column to the report layout']) {
      expect(matchGuardrails(p)).not.toContain('databases');
    }
  });

  it('systematic-debugging: still fires on bug reports', () => {
    expect(matchGuardrails('the build is failing with an error')).toContain('systematic-debugging');
    expect(matchGuardrails('ship it, no bugs found')).not.toContain('systematic-debugging');
  });
});
