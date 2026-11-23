/**
 * Card coord-router-lane-segment-skip: a lane.mjs command no longer fires pr-review-loop from its note text.
 * Cause (design-v3 row 1): the pr-review-loop `segment` regexes keep quotes, so `^node\s.*pre-pr\.mjs` matches a
 * `lane.mjs note "... pre-pr.mjs ..."` segment (22 of 342 fires on lane.mjs, measured in the fire log).
 * Seat ruling 2026-11-15: an opt-in manifest key `laneSegment: "skip"`, set on pr-review-loop and coderabbit-cli only,
 * so a rule that someone adds later still fires on a lane segment (fail closed).
 *
 * How the fix can fail, one test each below:
 *   note text fires the rule         the opted-in rules still match a lane.mjs segment with a script name in its note
 *   skip too wide (chained)          the skip swallows the next segment: `lane.mjs say x; node pre-pr.mjs` must still fire both
 *   skip too wide (nested)           the skip swallows a command substitution inside the note
 *   a gate goes quiet                a subagent: "block" rule is skipped, or a chained spend gate stops blocking
 *   a rule goes quiet by default     a rule with no key stops firing on a lane segment (the default must fire)
 *   review-engine goes quiet         `lane.mjs claim re-...` loses its deny-first rule
 *   lane head forms                  a quoted path, node flags and node.exe are not seen as a lane segment
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLaneSegment, matchRules, type Manifest } from '../rule-router.js';

const CLAUDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(CLAUDE, 'rules-ondemand', 'manifest.json'), 'utf8')) as Manifest;
const LANE = 'node C:/Users/dkhay/.claude/scripts/lane.mjs';
const ids = (command: string, m: Manifest = manifest, tool = 'Bash'): string[] =>
  matchRules({ session_id: 's', tool_name: tool, tool_input: { command } }, m).map((r) => r.id);

describe('a lane.mjs note does not fire the rules that match script names', () => {
  it('a note holding pre-pr.mjs fires only lane-board', () => {
    expect(ids(`${LANE} note my-lane "GOAL: run node scripts/github/pre-pr.mjs next"`)).toEqual(['lane-board']);
  });
  it('a say holding ship-ask.mjs and cr-fix.mjs fires only lane-board', () => {
    expect(ids(`${LANE} say "next: node scripts/github/ship-ask.mjs land, then node scripts/github/cr-fix.mjs" --to seat`)).toEqual(['lane-board']);
  });
  it('control: the same script run for real still fires pr-review-loop', () => {
    expect(ids('node scripts/github/pre-pr.mjs --body b.md')).toContain('pr-review-loop');
  });
});

describe('the skip is per segment, never per command', () => {
  it('a chained real pre-pr after a lane say still fires both rules', () => {
    const got = ids(`${LANE} say x; node scripts/github/pre-pr.mjs --body b.md`);
    expect(got).toContain('lane-board');
    expect(got).toContain('pr-review-loop');
  });
  it('a command substitution inside the note still fires pr-review-loop', () => {
    expect(ids(`${LANE} note my-lane "$(node scripts/github/pre-pr.mjs --body b.md)"`)).toContain('pr-review-loop');
  });
  it('a chained spend gate after a lane note still matches kie-spend', () => {
    expect(ids(`${LANE} note my-lane "ok"; node scripts/kie.mjs still --prompt hero`)).toContain('kie-spend');
  });
});

describe('what the skip never touches', () => {
  const synthetic = (extra: Record<string, unknown>): Manifest => ({
    rules: [{ id: 'probe-x', files: ['x.md'], mode: 'inject', segment: ['^node(\\.exe)?\\s.*probe-x\\.mjs'], ...extra }],
  } as Manifest);
  const noteText = `${LANE} note my-lane "see node scripts/probe-x.mjs"`;
  it('default: a rule with no laneSegment key still fires on a lane segment', () => {
    expect(ids(noteText, synthetic({}))).toEqual(['probe-x']);
  });
  it('opt-in: laneSegment "skip" stops the match on a lane segment', () => {
    expect(ids(noteText, synthetic({ laneSegment: 'skip' }))).toEqual([]);
  });
  it('a subagent: "block" rule is never skipped, even with the key', () => {
    expect(ids(noteText, synthetic({ laneSegment: 'skip', mode: 'deny-first', subagent: 'block' }))).toEqual(['probe-x']);
  });
  it('the opt-in rule still fires on a non-lane segment', () => {
    expect(ids('node scripts/probe-x.mjs run', synthetic({ laneSegment: 'skip' }))).toEqual(['probe-x']);
  });
  it('review-engine still fires on lane.mjs claim re-...', () => {
    expect(ids(`${LANE} claim re-live-accrual`)).toContain('review-engine');
  });
  it('lane-board still fires on every lane.mjs command', () => {
    expect(ids(`${LANE} mine`)).toContain('lane-board');
  });
  it('only pr-review-loop and coderabbit-cli opt in (a new opt-in needs a decision)', () => {
    const optIn = (manifest.rules as Array<{ id: string; laneSegment?: string }>).filter((r) => r.laneSegment === 'skip').map((r) => r.id).sort();
    expect(optIn).toEqual(['coderabbit-cli', 'pr-review-loop']);
  });
});

describe('the lane head forms', () => {
  const note = '"GOAL: node scripts/github/pre-pr.mjs"';
  it('a quoted path, node flags and node.exe each count as a lane segment', () => {
    for (const head of ['node "C:/Users/dkhay/.claude/scripts/lane.mjs"', 'node --no-warnings C:/Users/dkhay/.claude/scripts/lane.mjs', 'node.exe C:/x/lane.mjs']) {
      expect(ids(`${head} note my-lane ${note}`), head).not.toContain('pr-review-loop');
    }
  });
  it('a script that only ends in lane.mjs-like text is not a lane segment', () => {
    // Card coord-tighten-segment-triggers: the pr-review-loop segment tests name the script that node runs, so a quoted
    // "pre-pr.mjs" argument of another script no longer fires the rule by itself. The property pinned here stays: a script
    // that only ends in lane.mjs-like text is NOT a lane segment (so the lane skip never swallows it).
    expect(isLaneSegment(`node scripts/not-lane.mjs.bak "pre-pr.mjs"`)).toBe(false);
    expect(ids(`node scripts/not-lane.mjs.bak "x"; node scripts/github/pre-pr.mjs --body b.md`)).toContain('pr-review-loop');
  });
});
