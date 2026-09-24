/**
 * QW-07 (intent-pollution filter) — tests for the two helpers added to
 * shared/intent-extractor.ts:
 *
 *   1. isMachineGeneratedPrompt(p) — drops Claude Code synthetic prompts
 *      (<task-notification> blobs etc., 24.6% of recall queries) UPSTREAM of
 *      recall/intent extraction. (findings D2c-01 / D3b-05 / D3c-04)
 *   2. expandGitQuery(p) — moved out of memory-awareness.ts, with the 'pr'
 *      substring collision fixed via WHOLE-WORD token matching so that
 *      "improve"/"approach"/"represent" no longer false-match 'pr'.
 *
 * These live in shared/intent-extractor.ts (a pure module with no auto-run)
 * because memory-awareness.ts runs main().catch(...) at module load and
 * therefore cannot be imported into a unit test.
 */

import { describe, it, expect } from 'vitest';
import { isMachineGeneratedPrompt, isHarnessWrappedPrompt, expandGitQuery } from '../shared/intent-extractor.js';

describe('isHarnessWrappedPrompt (explicit wrappers only)', () => {
  it('flags task notifications and subagent hand-backs', () => {
    expect(isHarnessWrappedPrompt('<task-notification><task-id>x</task-id> done </task-notification>')).toBe(true);
    expect(isHarnessWrappedPrompt('<agent-message from="a1"> yes, works </agent-message>')).toBe(true);
  });
  it('does NOT flag a long human prompt or one that pastes XML (unlike isMachineGeneratedPrompt)', () => {
    const long = 'yes that works, thanks. ' + 'x'.repeat(9000);
    expect(isMachineGeneratedPrompt(long)).toBe(true);
    expect(isHarnessWrappedPrompt(long)).toBe(false);
    const xml = 'confirmed, it works: <a>1</a><b>2</b><c>3</c>';
    expect(isMachineGeneratedPrompt(xml)).toBe(true);
    expect(isHarnessWrappedPrompt(xml)).toBe(false);
  });
});

describe('isMachineGeneratedPrompt', () => {
  describe('returns TRUE for machine-generated content', () => {
    it('flags a string starting with <task-notification>', () => {
      expect(isMachineGeneratedPrompt('<task-notification>do the thing</task-notification>')).toBe(true);
    });

    it('flags <system-reminder> wrappers', () => {
      expect(isMachineGeneratedPrompt('<system-reminder>context here</system-reminder>')).toBe(true);
    });

    it('flags <local-command-stdout> wrappers', () => {
      expect(isMachineGeneratedPrompt('<local-command-stdout>some output</local-command-stdout>')).toBe(true);
    });

    it('flags <command-name>/foo</command-name> wrappers', () => {
      expect(isMachineGeneratedPrompt('<command-name>/foo</command-name>')).toBe(true);
    });

    it('flags <user-prompt-submit-hook> wrappers', () => {
      expect(isMachineGeneratedPrompt('<user-prompt-submit-hook>fired</user-prompt-submit-hook>')).toBe(true);
    });

    it('flags a generic <something-hook> wrapper', () => {
      expect(isMachineGeneratedPrompt('<something-hook>payload</something-hook>')).toBe(true);
    });

    it('flags a subagent hand-back (<agent-message from=...>) that says "yes, done"', () => {
      // The exact shape that was stored as a "User confirmed" memory (P29).
      expect(
        isMachineGeneratedPrompt('<agent-message from="a2cee616b50556208"> [Subagent hand-back] yes, that works, done </agent-message>'),
      ).toBe(true);
    });

    it('flags a peer <teammate-message> wrapper', () => {
      expect(isMachineGeneratedPrompt('<teammate-message teammate_id="x">looks good</teammate-message>')).toBe(true);
    });

    it('flags a string CONTAINING <task-notification not at the very start', () => {
      expect(isMachineGeneratedPrompt('here is a blob: <task-notification>foo</task-notification>')).toBe(true);
    });

    it('flags a blob with >= 3 distinct xml-ish tag names', () => {
      expect(isMachineGeneratedPrompt('<a></a><b></b><c></c>')).toBe(true);
    });

    it('flags a string longer than 8000 chars', () => {
      expect(isMachineGeneratedPrompt('x'.repeat(8001))).toBe(true);
    });
  });

  describe('returns FALSE for normal interactive asks', () => {
    it('does not flag a normal git workflow question', () => {
      expect(isMachineGeneratedPrompt('how do I push to fork remote in this workflow')).toBe(false);
    });

    it('does not flag a normal code-improvement ask', () => {
      expect(isMachineGeneratedPrompt('improve the error handling in the recall path')).toBe(false);
    });

    it("does not trip on substrings 'pr'/'process'/'approve'", () => {
      expect(isMachineGeneratedPrompt('approach this differently and process the approval')).toBe(false);
    });

    it('does not flag a normal refactor ask', () => {
      expect(isMachineGeneratedPrompt("let's refactor the bus writer")).toBe(false);
    });

    it('does not flag a 2-distinct-tag code paste', () => {
      expect(isMachineGeneratedPrompt('use <div><span>x</span></div> here')).toBe(false);
    });
  });
});

describe('expandGitQuery', () => {
  describe("'pr' substring collision is fixed (whole-word matching)", () => {
    it('returns null for "improve the error handling" (was swallowed by includes(\'pr\'))', () => {
      expect(expandGitQuery('improve the error handling')).toBeNull();
    });

    it('returns null for "approach this carefully"', () => {
      expect(expandGitQuery('approach this carefully')).toBeNull();
    });

    it('returns null for "represent the data"', () => {
      expect(expandGitQuery('represent the data')).toBeNull();
    });
  });

  describe('genuine git prompts still expand', () => {
    it('expands "how do I create a pull request and link it to Linear"', () => {
      const out = expandGitQuery('how do I create a pull request and link it to Linear');
      expect(out).not.toBeNull();
      expect(out).toContain('pull request');
    });

    it('expands "push to fork" to the remote-workflow expansion', () => {
      expect(expandGitQuery('push to fork')).toBe('git push remote fork origin upstream');
    });

    it('expands "what is the commit workflow here" (commit as a whole word)', () => {
      const out = expandGitQuery('what is the commit workflow here');
      expect(out).not.toBeNull();
      expect(out).toContain('commit');
    });
  });

  it('does NOT swallow a <task-notification> blob via a spurious \'pr\' match', () => {
    const blob = '<task-notification>please process the approval and approve it now</task-notification>';
    expect(expandGitQuery(blob)).toBeNull();
  });
});
