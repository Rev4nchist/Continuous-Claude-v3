/**
 * Tests for post-plan-roadmap's focus-transition helper.
 *
 * Regression guard: previously, switching the Current Focus to a new plan
 * title stamped the OLD focus as `completed: today` -- mis-recording "I
 * switched focus" as "I finished the prior goal". The fix demotes the old
 * focus back into Planned (the backlog) instead, and the caller reassigns
 * Current Focus separately.
 *
 * Pure-function test (no fs / no stdin), following the git-commit-roadmap
 * pure-helper convention.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
const SEP_BS = String.fromCharCode(92);
import { parseRoadmap } from '../shared/roadmap-parser.js';
import type { PlanningSession } from '../shared/roadmap-parser.js';
import {
  applyRoadmapUpdate,
  renderSessionBlock,
  renderSessionBlockCompact,
  extractBullets,
  extractPlanInfo,
  planPathForRoadmap,
} from '../post-plan-roadmap.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * applyRoadmapUpdate: append-only writer. Current Focus is written ONLY when
 * vacant; an OCCUPIED Current Focus is left completely untouched (no more
 * overwrite-in-place, no more demoteCurrentFocusToPlanned -- see the
 * `roadmap-sync-clobber` plan SS3). Round-trips through the shared parser so
 * rawContent/rawSections come from real parsing.
 */
describe('applyRoadmapUpdate', () => {
  it('leaves an OCCUPIED Current Focus untouched while regenerating nothing else (bf91c19 anchor)', () => {
    const fixture = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Old goal**',
      '- Started: 2026-01-01',
      '',
      '## Notes',
      '- remember to check the rate limiter',
      '- ping Danny about the staging creds',
      '',
      '## Completed',
      '- [x] Initial scaffolding (2025-12-01)',
      '',
      '## Planned',
      '- [ ] Future thing (high priority)',
      '',
    ].join('\n');

    const parsed = parseRoadmap(fixture);
    const session: PlanningSession = { date: '2026-05-30', title: 'New goal', decisions: [] };

    const { content: out } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-05-30',
      focusTitle: 'New goal',
    });

    // The notes block survives verbatim (header + both bullets + trailing blank).
    const notesBlock = [
      '## Notes',
      '- remember to check the rate limiter',
      '- ping Danny about the staging creds',
      '',
    ].join('\n');
    expect(out).toContain(notesBlock);

    // Current Focus is OCCUPIED ("Old goal"), so the vacant-only seed rule
    // leaves it completely untouched -- the new plan title is NOT written
    // there (it is recorded in the new session block and the advisory
    // main() emits, not by overwriting Current Focus).
    expect(out).toContain('## Current Focus\n**Old goal**');
    expect(out).not.toContain('**New goal**');

    // The other managed sections are still present.
    expect(out).toContain('## Completed');
    expect(out).toContain('## Planned');
  });

  it('leaves an OCCUPIED Current Focus untouched with intro prose and a ## Notes ABOVE it', () => {
    const fixture = [
      '# Project Roadmap',
      '',
      'This roadmap is hand-curated. Read the notes before editing.',
      '',
      '## Notes',
      '- top-of-file reminder',
      '',
      '## Current Focus',
      '**Old goal**',
      '',
      '## Completed',
      '- [x] Thing (2025-11-01)',
      '',
    ].join('\n');

    const parsed = parseRoadmap(fixture);
    const session: PlanningSession = { date: '2026-05-30', title: 'Fresh goal', decisions: [] };

    const { content: out } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-05-30',
      focusTitle: 'Fresh goal',
    });

    // Intro prose preserved verbatim.
    expect(out).toContain('This roadmap is hand-curated. Read the notes before editing.');
    // Notes block preserved.
    expect(out).toContain('## Notes\n- top-of-file reminder');
    // Position: Notes appears BEFORE Current Focus in the output.
    expect(out.indexOf('## Notes')).toBeLessThan(out.indexOf('## Current Focus'));
    // Current Focus is OCCUPIED, so it is left untouched -- NOT overwritten.
    expect(out).toContain('## Current Focus\n**Old goal**');
    expect(out).not.toContain('**Fresh goal**');
  });

  it('preserves loose prose that sits between managed sections (separated by an unmanaged header)', () => {
    // The parser extends a managed section's range to the next "## " header, so
    // text demarcated by an unmanaged header is the unit that lands BETWEEN two
    // managed sections in the verbatim-splice path.
    const fixture = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Goal**',
      '',
      '## Scratch',
      'Loose prose sitting between Current Focus and Completed.',
      'A second loose line.',
      '',
      '## Completed',
      '- [x] Done (2025-10-01)',
      '',
    ].join('\n');

    const parsed = parseRoadmap(fixture);
    const session: PlanningSession = { date: '2026-05-30', title: 'Goal', decisions: [] };

    const { content: out } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-05-30',
      focusTitle: 'Goal', // same title as the occupied focus -- still a no-op there
    });

    const looseBlock = [
      '## Scratch',
      'Loose prose sitting between Current Focus and Completed.',
      'A second loose line.',
    ].join('\n');
    expect(out).toContain(looseBlock);
    // The unmanaged block stays between the two managed sections.
    const looseIdx = out.indexOf('Loose prose sitting between');
    expect(looseIdx).toBeGreaterThan(out.indexOf('## Current Focus'));
    expect(looseIdx).toBeLessThan(out.indexOf('## Completed'));
  });

  it('preserves a trailing unmanaged section after the last managed section', () => {
    const fixture = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Goal**',
      '',
      '## Completed',
      '- [x] Done (2025-10-01)',
      '',
      '## Scratch',
      'Trailing free-form prose after the last managed section.',
      'Another trailing line.',
      '',
    ].join('\n');

    const parsed = parseRoadmap(fixture);
    const session: PlanningSession = { date: '2026-05-30', title: 'Goal', decisions: [] };

    const { content: out } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-05-30',
      focusTitle: 'Goal',
    });

    const trailingBlock = [
      '## Scratch',
      'Trailing free-form prose after the last managed section.',
      'Another trailing line.',
    ].join('\n');
    expect(out).toContain(trailingBlock);
    // Trailing block stays after the last managed section.
    expect(out.indexOf('Trailing free-form prose')).toBeGreaterThan(out.indexOf('## Completed'));
  });

  it('falls back to canonical generateRoadmap output for an empty/fresh file', () => {
    const parsed = parseRoadmap('');
    const session: PlanningSession = { date: '2026-05-30', title: 'First goal', decisions: [] };

    const { content: out } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-05-30',
      focusTitle: 'First goal',
    });

    expect(out.startsWith('# Project Roadmap')).toBe(true);
    expect(out).toContain('## Current Focus\n**First goal**');
    expect(out).toContain('## Completed');
    expect(out).toContain('## Planned');
    expect(out).toContain('## Recent Planning Sessions');
  });

  // Regression (2026-09-03, CodeRabbit on PR #35). A brand-new or empty
  // ROADMAP.md takes the generateRoadmap branch, which was still on the
  // verbose renderer -- so a project's VERY FIRST plan approval got the exact
  // shape this change set out to remove, and no `**Plan:**` pointer. Every new
  // project hit it once.
  it('renders the first session of a fresh ROADMAP compact, with the plan pointer', () => {
    const parsed = parseRoadmap('');
    const session: PlanningSession = {
      date: '2026-09-03',
      title: 'Add jitter to the retry backoff',
      summary: 'A summary that must NOT be rendered.',
      decisions: ['a decision that must NOT be rendered'],
      steps: ['a step that must NOT be rendered'],
      files: ['a.ts'],
      verification: ['a check that must NOT be rendered'],
      planPath: '.claude/plans/add-jitter.md',
    };

    const { content } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-09-03',
      focusTitle: 'Add jitter to the retry backoff',
    });

    expect(content).toContain('### 2026-09-03: Add jitter to the retry backoff');
    expect(content).toContain('**Plan:** .claude/plans/add-jitter.md');
    // The retired stanzas, none of which may come back on this path.
    expect(content).not.toContain('**Key Decisions:**');
    expect(content).not.toContain('**Summary:**');
    expect(content).not.toContain('**Implementation:**');
    expect(content).not.toContain('**Files:**');
    expect(content).not.toContain('**Verification:**');
  });

  it('omits the plan line on a fresh ROADMAP when the session has no plan file', () => {
    const parsed = parseRoadmap('');
    const session: PlanningSession = { date: '2026-09-03', title: 'No plan file', decisions: [] };

    const { content } = applyRoadmapUpdate(parsed, {
      session,
      today: '2026-09-03',
      focusTitle: null,
    });

    expect(content).toContain('### 2026-09-03: No plan file');
    expect(content).not.toContain('**Plan:**');
  });
});

/**
 * renderSessionBlock: byte-neutral lift of the old inline per-session render
 * body out of renderSectionBody('sessions'). Golden-pins the exact line
 * shape, then proves the public write path (applyRoadmapUpdate) emits that
 * exact block verbatim -- i.e. the lift changed nothing observable.
 */
describe('renderSessionBlock', () => {
  it('golden-pins the exact per-session line shape (byte-neutral lift regression anchor)', () => {
    const session: PlanningSession = {
      date: '2026-05-01',
      title: 'Alpha goal',
      summary: 'A short summary.',
      decisions: ['decision one', 'decision two'],
      steps: ['step one'],
      files: ['a.ts', 'b.ts'],
      verification: ['verify one', 'verify two'],
    };

    expect(renderSessionBlock(session)).toEqual([
      '### 2026-05-01: Alpha goal',
      '**Summary:** A short summary.',
      '',
      '**Key Decisions:**',
      '- decision one',
      '- decision two',
      '',
      '**Implementation:**',
      '- step one',
      '',
      '**Files:** a.ts, b.ts',
      '',
      '**Verification:** verify one',
      '',
    ]);
  });

  it('is NOT what applyRoadmapUpdate writes any more -- both paths render compact', () => {
    // This assertion used to run the other way round, and that is exactly how
    // the fresh-file gap survived: it built its fixture from an EMPTY ROADMAP,
    // so it exercised the generateRoadmap branch and pinned the retired shape
    // as if it were the contract. Inverted 2026-09-03 so the fresh-file path
    // can never drift back to the verbose renderer unnoticed.
    const parsed = parseRoadmap('');
    const session: PlanningSession = {
      date: '2026-05-03',
      title: 'Gamma',
      decisions: ['only decision'],
      planPath: 'plans/gamma.md',
    };

    const { content } = applyRoadmapUpdate(parsed, { session, today: '2026-05-03', focusTitle: null });

    expect(content).toContain(renderSessionBlockCompact(session).join('\n'));
    expect(content).not.toContain(renderSessionBlock(session).join('\n'));
  });
});

/**
 * extractBullets, vector 5: the old unanchored, global
 * `.replace(/\*\s+/g, ' ')` ate the closing `*` of any `**bold**` followed by
 * whitespace ("but **not** fix" -> "but **not* fix"). Deleted; this pins the
 * fix.
 */
describe('extractBullets (vector 5: emphasis-corruption fix)', () => {
  it('does not corrode a closing ** followed by whitespace', () => {
    expect(extractBullets('- but **not** fix')).toEqual(['but **not** fix']);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 (2026-09-02): the appended block invented "Key Decisions".
//
// extractPlanInfo fell back to keyword-scraping the WHOLE plan document when a
// plan had no Decisions/Key Decisions/Approach section. CAPTURE_KEYWORDS
// includes 'note', 'why', 'reason', 'change', 'add', 'update', 'fix' -- so
// ordinary Context prose was lifted out and rendered under a "**Key
// Decisions:**" heading in ROADMAP.md, and stored to archival memory as
// decisions. Neither is true: a plan with no decisions section recorded no
// decisions.
// ---------------------------------------------------------------------------
describe('extractPlanInfo -- context bullets are not decisions', () => {
  const planWithOnlyContext = [
    '# Plan: Tidy the widget loader',
    '',
    '## Context',
    '- The loader has a note about why the retry count is 3.',
    '- We should update the docstring and fix the stale path reference.',
    '- Root cause: the config is read before the environment is applied.',
    '',
    '## Implementation',
    '- Move the config read below the environment apply.',
    '',
  ].join('\n');

  it('does not turn Context bullets into Key Decisions', () => {
    const info = extractPlanInfo(planWithOnlyContext, 'plans/tidy-widget-loader.md');
    expect(info.decisions).toEqual([]);
  });

  it('renders no Key Decisions heading for such a plan', () => {
    const info = extractPlanInfo(planWithOnlyContext, 'plans/tidy-widget-loader.md');
    const block = renderSessionBlock({
      date: '2026-09-02',
      title: info.title,
      summary: info.summary || undefined,
      decisions: info.decisions,
    }).join('\n');
    expect(block).not.toContain('Key Decisions');
  });

  it('still reads decisions from a real Decisions section', () => {
    const planWithDecisions = [
      '# Plan: Real one',
      '',
      '## Context',
      '- Some background note about why this matters.',
      '',
      '## Decisions',
      '- Use the bounded launcher instead of a bare pipe.',
      '- Keep the pre-image outside the project tree.',
      '',
    ].join('\n');
    const info = extractPlanInfo(planWithDecisions, 'plans/real-one.md');
    expect(info.decisions).toHaveLength(2);
    expect(info.decisions[0]).toContain('bounded launcher');
  });
});

// ---------------------------------------------------------------------------
// Defect 2c (2026-09-02): the appended block is one line of body, not five
// generated stanzas.
//
// DEVIATION from the handoff's literal "one line: date, plan title, plan file
// path": the `### YYYY-MM-DD: Title` header line is kept intact and the plan
// path goes on its own `**Plan:**` line beneath it. Appending the path to the
// header would be captured by findSessionBlock's title regex
// (/^###\s*\d{4}-\d{2}-\d{2}:\s*(.+)$/), so same-day-different-title detection
// would start comparing "Title -- path" against "Title" and re-append a block
// it already wrote. Two lines that keep that contract beat one that breaks it.
// ---------------------------------------------------------------------------
describe('applyRoadmapUpdate -- appended session block is compact', () => {
  const ROADMAP = [
    '# ROADMAP',
    '',
    '## Current Focus',
    '**Something already active**',
    '',
    '## Recent Planning Sessions',
    '',
  ].join('\n');

  const session: PlanningSession = {
    date: '2026-09-02',
    title: 'Tidy the widget loader',
    planPath: 'plans/tidy-widget-loader.md',
    summary: 'A summary that must NOT be emitted into the ROADMAP any more.',
    decisions: ['Use the bounded launcher', 'Keep the pre-image out of the tree'],
    steps: ['Step one', 'Step two'],
    verification: ['Run the suite'],
    files: ['a.ts', 'b.ts', 'a.ts'],
  };

  it('emits the header plus exactly one body line naming the plan file', () => {
    const { content } = applyRoadmapUpdate(parseRoadmap(ROADMAP), {
      session, today: '2026-09-02', focusTitle: session.title,
    });

    expect(content).toContain('### 2026-09-02: Tidy the widget loader');
    expect(content).toContain('**Plan:** plans/tidy-widget-loader.md');
  });

  it('emits none of the generated stanzas that humans kept deleting', () => {
    const { content } = applyRoadmapUpdate(parseRoadmap(ROADMAP), {
      session, today: '2026-09-02', focusTitle: session.title,
    });

    expect(content).not.toContain('**Key Decisions:**');
    expect(content).not.toContain('**Implementation:**');
    expect(content).not.toContain('**Verification:**');
    expect(content).not.toContain('**Files:**');
    expect(content).not.toContain('**Summary:**');
  });

  it('omits the Plan line entirely when there is no plan path', () => {
    const { content } = applyRoadmapUpdate(parseRoadmap(ROADMAP), {
      session: { ...session, planPath: undefined },
      today: '2026-09-02', focusTitle: session.title,
    });

    expect(content).toContain('### 2026-09-02: Tidy the widget loader');
    expect(content).not.toContain('**Plan:**');
  });

  it('adds at most 3 lines to the document', () => {
    const before = ROADMAP.split('\n').length;
    const { content } = applyRoadmapUpdate(parseRoadmap(ROADMAP), {
      session, today: '2026-09-02', focusTitle: session.title,
    });
    expect(content.split('\n').length - before).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Regression (2026-09-02): the **Plan:** path must be project-relative.
//
// Found by the live ExitPlanMode run, NOT by the unit suite -- the earlier
// tests handed `planPath` to the renderer directly and so never exercised the
// projectDir comparison. The shipped bug compared a forward-slash
// CLAUDE_PROJECT_DIR against a backslash path.join result with startsWith, so
// it never matched and a full absolute path landed in ROADMAP.md.
// ---------------------------------------------------------------------------
describe('planPathForRoadmap -- separator-agnostic', () => {
  it('relativises a plan inside the project even when separators differ', () => {
    const out = planPathForRoadmap(
      'C:/repos/widget',
      ['C:', 'repos', 'widget', '.claude', 'plans', 'add-jitter.md'].join(SEP_BS),
    );
    expect(out).toBe('.claude/plans/add-jitter.md');
  });

  it('relativises when both sides already agree', () => {
    expect(planPathForRoadmap('C:/repos/widget', 'C:/repos/widget/plans/p.md'))
      .toBe('plans/p.md');
  });

  it('keeps an absolute path when the plan is outside the project', () => {
    const out = planPathForRoadmap('C:/repos/widget', 'C:/Users/dave/.claude/plans/p.md');
    expect(out!.split(SEP_BS).join('/')).toBe('C:/Users/dave/.claude/plans/p.md');
  });

  it('never emits a Windows drive letter for an in-project plan', () => {
    const out = planPathForRoadmap(
      'C:/repos/widget',
      ['C:', 'repos', 'widget', '.claude', 'plans', 'add-jitter.md'].join(SEP_BS),
    );
    expect(out).not.toMatch(/^[A-Za-z]:/);
    expect(out).not.toContain(SEP_BS);
  });

  it('returns undefined when there is no plan file', () => {
    expect(planPathForRoadmap('C:/repos/widget', undefined)).toBeUndefined();
  });
});

/**
 * Block-aware capture. The generator used to read only the FIRST PHYSICAL LINE
 * of a list item, so every hard-wrapped bullet in a plan lost everything after
 * its first line -- the ~90-char cut in the committed entries is the wrap
 * column of the SOURCE, not a budget in the code. Verified against two real
 * plans (`picking-up-from-a-dynamic-bentley.md:41-42` and
 * `we-are-picking-up-lovely-crab.md:79-81`), whose output was byte-identical
 * to line 1 of each item.
 *
 * Capture rule pinned here: an item captures its FIRST PARAGRAPH. A blank
 * line, a code fence, a header, a table row, or the next list item ends it.
 */
describe('extractBullets: block-aware capture', () => {
  it('D1: joins a hard-wrapped item instead of keeping only its first line', () => {
    const src = [
      '1. **Re-check mergeability immediately before merging.** A peer session (`8896640d`) is active on',
      '   this branch; state can move between now and the merge.',
    ].join('\n');

    expect(extractBullets(src)).toEqual([
      'Re-check mergeability immediately before merging: A peer session (`8896640d`) is active on this branch; state can move between now and the merge.',
    ]);
  });

  it('D1: a blank line ends the item -- the following paragraph is not absorbed', () => {
    const src = [
      '- **First item.** Its wrapped continuation line belongs to it.',
      '  still the same paragraph here.',
      '',
      'Loose prose that is NOT part of the bullet and must not be appended.',
    ].join('\n');

    expect(extractBullets(src)).toEqual([
      'First item: Its wrapped continuation line belongs to it. still the same paragraph here.',
    ]);
  });

  it('D2: never emits a line from inside a fenced code block', () => {
    const src = [
      '1. **Check the pull request.** Run the command below before merging.',
      '   ```',
      '   gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/29 `',
      '     --jq \'"mergeable=\\(.mergeable) state=\\(.mergeable_state)"\'',
      '   ```',
    ].join('\n');

    const out = extractBullets(src);
    expect(out).toEqual([
      'Check the pull request: Run the command below before merging.',
    ]);
    // The exact fragment that reached ROADMAP.md in a71e13e.
    expect(out.join(' ')).not.toContain('-jq');
  });

  it('D2: a fence ends the item -- prose after the fence is not absorbed', () => {
    const src = [
      '1. **Run it.** This sentence is the captured body of the item.',
      '   ```',
      '   some --command here',
      '   ```',
      '   Trailing commentary after the fence is deliberately not captured.',
    ].join('\n');

    expect(extractBullets(src)).toEqual([
      'Run it: This sentence is the captured body of the item.',
    ]);
  });

  it('D4: a colon inside the bold label does not produce a doubled colon', () => {
    // The exact shape that produced "...with a merge commit::" in a71e13e.
    expect(extractBullets('- **PR closed as merged, with a merge commit:**'))
      .toEqual(['PR closed as merged, with a merge commit']);
  });

  it('D4: a sentence-ending period in the bold label does not produce ".:"', () => {
    expect(extractBullets('- **Advance local main without a checkout.** It is checked out nowhere.'))
      .toEqual(['Advance local main without a checkout: It is checked out nowhere.']);
  });

  it('a table row does not continue an item', () => {
    const src = [
      '- **Item with a table after it.** Body sentence for the item.',
      '| a | b |',
    ].join('\n');

    expect(extractBullets(src)).toEqual([
      'Item with a table after it: Body sentence for the item.',
    ]);
  });
});

/**
 * D3: Key Decisions and Implementation used to overlap because a plan with no
 * `## Decisions` header sent `decisions` down a WHOLE-DOCUMENT keyword scan
 * that re-collected the very `## Steps` items already in `steps` (and pulled
 * `## Verification` items too). Confirmed against a71e13e, whose Key Decisions
 * held "The SHAs the docs cite..." and "The original symptom is gone" -- text
 * that exists only under `## Verification` in the source plan.
 */
describe('extractPlanInfo: disjoint decision / step / verification sources', () => {
  const plan = fs.readFileSync(path.join(FIXTURE_DIR, 'plan-hardwrapped-2026-08-12.md'), 'utf-8');

  it('D3: no bullet appears in both Key Decisions and Implementation', () => {
    const info = extractPlanInfo(plan);
    const overlap = info.decisions.filter(d => info.steps.includes(d));
    expect(overlap).toEqual([]);
  });

  it('D3: no bullet appears in both Key Decisions and Verification', () => {
    const info = extractPlanInfo(plan);
    const overlap = info.decisions.filter(d => info.verification.includes(d));
    expect(overlap).toEqual([]);
  });

  it('parses a CRLF plan the same as its LF form', () => {
    const lf = plan.replace(/\r\n/g, '\n');
    expect(extractPlanInfo(lf.replace(/\n/g, '\r\n'))).toEqual(extractPlanInfo(lf));
    expect(extractPlanInfo(lf.replace(/\n/g, '\r\n')).steps).toHaveLength(3);
  });

  it('an explicit ## Decisions section stays authoritative and is not filtered', () => {
    const explicit = [
      '# A plan',
      '',
      '## Decisions',
      '',
      '- **Ship the fix now.** It is a one-file change with a verified root cause.',
      '',
      '## Steps',
      '',
      '- **Ship the fix now.** It is a one-file change with a verified root cause.',
      '',
    ].join('\n');

    const info = extractPlanInfo(explicit);
    expect(info.decisions).toEqual(['Ship the fix now: It is a one-file change with a verified root cause.']);
  });
});

/**
 * End-to-end golden: the real 2026-08-12 plan shape through extractPlanInfo ->
 * renderSessionBlock, asserting the block a71e13e SHOULD have been.
 */
describe('golden: the 2026-08-12 plan renders a clean session block', () => {
  const plan = fs.readFileSync(path.join(FIXTURE_DIR, 'plan-hardwrapped-2026-08-12.md'), 'utf-8');

  it('produces a block with no truncation, no code fragment and no doubled colon', () => {
    const info = extractPlanInfo(plan);
    const session: PlanningSession = {
      date: '2026-08-12',
      title: info.title,
      decisions: info.decisions.slice(0, 5),
      steps: info.steps.length > 0 ? info.steps.slice(0, 5) : undefined,
      verification: info.verification.length > 0 ? info.verification.slice(0, 3) : undefined,
    };
    const block = renderSessionBlock(session).join('\n');

    // D1: the continuation line survives.
    expect(block).toContain('state can move between now and the merge.');
    // D2: nothing from inside a fence.
    expect(block).not.toContain('-jq');
    expect(block).not.toContain('gh api repos');
    // D4: no doubled colon anywhere in the block.
    expect(block).not.toMatch(/::/);
    // The header is still the plan title.
    expect(block.split('\n')[0]).toBe('### 2026-08-12: Land `agentic-os` on `main`');
  });
});
