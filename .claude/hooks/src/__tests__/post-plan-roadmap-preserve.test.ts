/**
 * APPEND-ONLY INVARIANT for post-plan-roadmap's ROADMAP.md writer.
 *
 * Context (2026-08-05): `bf91c19` made the hook preserve unmanaged content at
 * SECTION granularity -- intro prose, `## Notes`, custom H2s are spliced back
 * verbatim. Nothing ever protected content INSIDE a managed section, because
 * the four managed bodies were regenerated from a lossy structured parse.
 *
 * Five verified loss vectors this file pins:
 *   1. `## Current Focus` multi-bullet collapse -- roadmap-parser.ts:176-182
 *      joins every detail bullet into ONE `description` with "; ", and
 *      post-plan-roadmap.ts:51-53 re-emits it as a single `- ` line.
 *   2. `## Planned` metadata destruction -- the trailing parenthetical is
 *      parsed as `priority` and re-emitted as `(<bucket> priority)`, so
 *      `(H1 from handoff, see SS4)` becomes `(medium priority)`.
 *   3. Silent prose deletion -- a line inside Completed/Planned that misses the
 *      checkbox regex is stored nowhere and vanishes on render.
 *   4. Session sub-block flattening -- `**Files:**` / `**Verification:**` do
 *      not start with `-`, so the parser drops them entirely.
 *   5. Emphasis corruption on the way IN -- extractBullets' unanchored
 *      `.replace(/\*\s+/g, ' ')` eats the closing `*` of any `**bold**`
 *      followed by whitespace. (Covered in extractBullets' own tests; this
 *      file pins the round-trip that made it visible.)
 *
 * The fixture is built FROM the live ROADMAP.md rather than idealised, because
 * every pre-existing test in post-plan-roadmap.test.ts uses a single-line
 * Current Focus -- which is exactly why this class of loss read as "fixed".
 *
 * DEMONSTRATED FAILING FIRST against the pre-fix code: see the commit message
 * for the captured output, plus the live clobber diff at
 * scratchpad/roadmap-clobber-live-repro-2026-08-05.diff (24 insertions /
 * 19 deletions on the real file, net +5 lines).
 *
 * Pure-function test (no fs / no stdin), following the existing convention.
 */

import { describe, it, expect } from 'vitest';
import type { RoadmapDoc, PlanningSession } from '../shared/roadmap-parser.js';
import { parseRoadmap } from '../shared/roadmap-parser.js';
import { applyRoadmapUpdate } from '../post-plan-roadmap.js';

const TODAY = '2026-08-05';

/**
 * Fixture: the shapes that actually occur in the live file.
 * Keep the odd spellings/parentheticals -- they are the point.
 */
const FIXTURE = [
  '# Project Roadmap',
  '',
  '> **! Multiple sessions run on branch `agentic-os`.** Coordination is in the',
  '> database, not in a file: see [`COORDINATION.md`](COORDINATION.md) for the',
  '> command list and the rules code does not enforce.',
  '',
  '## Current Focus',
  '**Harness repair -- hook test suite GREEN and ratcheted (2026-07-29)**',
  '- `npx vitest run` in `.claude/hooks`: **109 files / 2164 pass / 0 fail**, down from 93 failures.',
  '- Entry point: [`docs/harness-strategy/README.md`](docs/harness-strategy/README.md). Handoff: `2026-07-29_suite-green-handoff.yaml`.',
  '- Two live defects the tests were right about, both fixed: the Braintrust tracing **off switch never worked**.',
  '- **Action for Dave, not code: rotate the Braintrust API key.** The old failing test printed a bearer token.',
  '- Next: README SS5.1 (search router on a 143-day-stale index), Step 9 (`paths:` frontmatter, 0 of 46).',
  '- Previous focus (lane-board repair) is complete; see the lane board for that track.',
  '',
  '## Parked -- YouTube plugin (Dave, 2026-08-04)',
  '**Pickup anchors:** repo `claude-youtube-research` (main @ `54b80dd`, tree clean).',
  '- **#1 ON PICKUP: the GitHub-org question.** Must be a FOURTH-owned org.',
  '',
  '## Completed',
  'Newest first. Hook-appended entries land directly under this header.',
  '- [x] docs(harness): both closed -- store lands rows, dead hook archived (2026-07-29) `c573384`',
  '- [x] fix(memory): agent-error-capture stores again after 161 silent days (2026-07-29) `24e47a2`',
  '',
  '## Planned',
  '- [ ] Fix the roadmap-sync clobber (H1 from handoff, see SS4)',
  '- [ ] Archive the Completed log',
  '  - depends on the 231-entry threshold warning firing at session start',
  '- [ ] **Coordination repair -- ST-02 identity + claim hardening** (high priority)',
  '',
  '## Notes',
  '- G4: never parallel-edit the same memory files.',
  '',
  '## Recent Planning Sessions',
  '### 2026-07-27: Lane-board repair + Agentic OS project identity (data layer)',
  '**Key Decisions:**',
  '- Fix: drop `myId` from the params array, renumber `$4` -> `$3`.',
  '- `note` is non-null wherever `project_key` is null.',
  '',
  '**Files:** lane.mjs, apps/agentic-os/scripts/seed-projects.mjs, .claude/project-registry.json',
  '',
  '**Verification:** State plainly in the code comment what this does and does not prove.',
  '',
  '### 2026-07-26: Wrangle: Current State, Coordination Protocol, and Execution Order',
  '**Key Decisions:**',
  '- Mechanism (traced to exact lines): `SessionStart` is registered with **no matcher**.',
  '',
].join('\n');

function makeSession(title: string, date = TODAY): PlanningSession {
  return {
    date,
    title,
    decisions: ['append-only splice', 'no cap trim'],
  };
}

/**
 * Adapter over the writer under test.
 *
 * Pre-fix, `applyRoadmapUpdate(doc)` derived everything from the mutated doc,
 * exactly as main():589-615 did. Post-fix it takes the ORIGINAL parsed doc
 * (never mutated) plus an explicit `{ session, today, focusTitle }` update,
 * and returns `{ content, ops }`. Keeping the call shape in ONE place means
 * the fix changes this function, not the assertions below.
 */
function runUpdate(
  original: string,
  session: PlanningSession,
  opts: { focusTitle?: string | null } = {},
): string {
  const doc: RoadmapDoc = parseRoadmap(original);

  const { content } = applyRoadmapUpdate(doc, {
    session,
    today: session.date,
    focusTitle: opts.focusTitle ?? null,
  });
  return content;
}

/** Lines present in `before` but absent from `after`, as a multiset. */
function removedLines(before: string, after: string): string[] {
  const counts = new Map<string, number>();
  for (const line of after.split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const removed: string[] = [];
  for (const line of before.split('\n')) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else removed.push(line);
  }
  return removed;
}

/** The original line-slice for a managed section, by the parser's own ranges. */
function sectionSlice(source: string, key: string): string[] {
  const doc = parseRoadmap(source);
  const range = doc.rawSections.get(key);
  if (!range) throw new Error(`fixture is missing a '${key}' section`);
  return source.split('\n').slice(range.start, range.end);
}

describe('post-plan-roadmap: append-only invariant', () => {
  // ---------------------------------------------------------------- THE GUARD
  it('removes NOTHING from the original -- no exemptions', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));

    // The single strongest assertion in this file. An append-only writer has
    // no path that drops a line. Deliberate deletions, if any are ever added,
    // must be declared -- never discovered here.
    expect(removedLines(FIXTURE, out)).toEqual([]);
  });

  // ------------------------------------------------------------- VECTOR 1
  it('preserves all six Current Focus bullets byte-identically (vector 1)', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    expect(sectionSlice(out, 'current')).toEqual(sectionSlice(FIXTURE, 'current'));
  });

  it('leaves Current Focus untouched even when the plan title differs', () => {
    // A plan exit is not a focus change. The outgoing title must survive, and
    // must NOT be demoted into Planned as a bare title.
    const out = runUpdate(FIXTURE, makeSession('Some Other Goal'), {
      focusTitle: 'Some Other Goal',
    });

    expect(out).toContain('**Harness repair -- hook test suite GREEN and ratcheted (2026-07-29)**');
    expect(out).not.toContain('- [ ] Harness repair -- hook test suite GREEN and ratcheted (2026-07-29)');
    expect(sectionSlice(out, 'current')).toEqual(sectionSlice(FIXTURE, 'current'));
  });

  // ------------------------------------------------------------- VECTOR 2 & 3
  it('preserves Planned parentheticals, bare items and sub-bullets (vectors 2, 3)', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));

    // The non-priority parenthetical must not be rewritten to "(medium priority)".
    expect(out).toContain('- [ ] Fix the roadmap-sync clobber (H1 from handoff, see SS4)');
    // A bare item must not acquire an invented priority.
    expect(out).toContain('- [ ] Archive the Completed log');
    // A nested sub-bullet is not a checkbox line, so the parser dropped it.
    expect(out).toContain('  - depends on the 231-entry threshold warning firing at session start');

    expect(sectionSlice(out, 'planned')).toEqual(sectionSlice(FIXTURE, 'planned'));
  });

  it('preserves prose inside ## Completed (vector 3)', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    expect(out).toContain('Newest first. Hook-appended entries land directly under this header.');
    expect(sectionSlice(out, 'completed')).toEqual(sectionSlice(FIXTURE, 'completed'));
  });

  // ------------------------------------------------------------- VECTOR 4
  it('preserves existing session sub-blocks (vector 4)', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    expect(out).toContain('**Files:** lane.mjs, apps/agentic-os/scripts/seed-projects.mjs, .claude/project-registry.json');
    expect(out).toContain('**Verification:** State plainly in the code comment what this does and does not prove.');
  });

  // ------------------------------------------- bf91c19 REGRESSION ANCHORS
  it('preserves the blockquote intro, a custom H2 and ## Notes', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    expect(out).toContain('> **! Multiple sessions run on branch `agentic-os`.** Coordination is in the');
    expect(out).toContain('## Parked -- YouTube plugin (Dave, 2026-08-04)');
    expect(out).toContain('- **#1 ON PICKUP: the GitHub-org question.** Must be a FOURTH-owned org.');
    expect(out).toContain('- G4: never parallel-edit the same memory files.');
  });

  // ------------------------------------------------------- THE INTENDED WRITE
  it('inserts the new session block immediately after the sessions header', () => {
    const out = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    const lines = out.split('\n');
    const header = lines.indexOf('## Recent Planning Sessions');
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1]).toBe(`### ${TODAY}: ROADMAP clobber fix`);
  });

  // ------------------------- HOSTILE FIXTURES for the ex-exempt deletion paths
  it('does not rewrite a hand-edited block for today (same title -> skip)', () => {
    // A human annotated today's block between two hook fires. A whole-block
    // replace would silently eat that edit -- in an append-only writer.
    const withToday = runUpdate(FIXTURE, makeSession('ROADMAP clobber fix'));
    const handEdited = withToday.replace(
      `### ${TODAY}: ROADMAP clobber fix`,
      `### ${TODAY}: ROADMAP clobber fix\n**Files:** hand-added by Dave, must survive`,
    );

    const out = runUpdate(handEdited, makeSession('ROADMAP clobber fix'));

    expect(out).toContain('**Files:** hand-added by Dave, must survive');
    expect(removedLines(handEdited, out)).toEqual([]);
    // And no duplicate header for the same day+title.
    expect(out.split(`### ${TODAY}: ROADMAP clobber fix`).length - 1).toBe(1);
  });

  it('never trims old session blocks, however many there are', () => {
    // The 5-entry cap deleted a whole real session block on its first live
    // run (2026-07-21, five decisions on the fork-storm work). There is no cap.
    let doc = FIXTURE;
    for (let i = 1; i <= 9; i++) {
      doc = runUpdate(doc, makeSession(`Session number ${i}`, `2026-08-${String(i).padStart(2, '0')}`));
    }

    // Every one of the nine, plus both original blocks, still present.
    for (let i = 1; i <= 9; i++) {
      expect(doc).toContain(`Session number ${i}`);
    }
    expect(doc).toContain('### 2026-07-27: Lane-board repair + Agentic OS project identity (data layer)');
    expect(doc).toContain('### 2026-07-26: Wrangle: Current State, Coordination Protocol, and Execution Order');
  });

  it('appends a second block for the same day under a different title', () => {
    const first = runUpdate(FIXTURE, makeSession('First goal of the day'));
    const out = runUpdate(first, makeSession('Second goal of the day'));

    expect(out).toContain(`### ${TODAY}: First goal of the day`);
    expect(out).toContain(`### ${TODAY}: Second goal of the day`);
    expect(removedLines(first, out)).toEqual([]);
  });
});
