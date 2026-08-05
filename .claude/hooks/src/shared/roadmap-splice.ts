/**
 * Edit-script primitives for ROADMAP.md writers.
 *
 * Context (2026-08-05, `roadmap-sync-clobber` plan SS1): every prior ROADMAP
 * writer regenerated whole managed sections from a lossy structured parse,
 * which is how hand-written content died. This module replaces that with an
 * edit-script model instead: callers BUILD a list of `SpliceOp`s against the
 * ORIGINAL (untouched) line array -- using the parser's own `rawSections`
 * ranges -- and `applySplices` applies them all in one pass, bottom-up, so
 * earlier ranges never shift underneath a later-computed op. Nothing here
 * mutates its input in place.
 *
 * Deliberately NOT implemented: `replaceSubBlock` and `trimSubBlocksBeyondCap`.
 * Both were content-DELETION paths in the pre-fix hook -- the 5-entry session
 * cap deleted a whole real session block on its first live run, and a
 * whole-block replace silently eats any hand edit made between two hook
 * fires. Removing the mechanism (not adding a mitigation) means neither can
 * be called by mistake. See the plan's SS4 for the full rationale. Any new
 * caller that thinks it needs to replace or trim a sub-block should re-read
 * that section before adding one.
 */

/** A half-open line range: `start` inclusive, `end` exclusive. Matches the shape of the parser's `rawSections` values. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * One edit-script operation, built against ORIGINAL line indices.
 *
 * `range.start === range.end` is a pure insert (nothing removed).
 * `lines: []` is a pure delete (the range is removed, nothing put back).
 */
export interface SpliceOp {
  range: LineRange;
  lines: string[];
  label: string;
}

/**
 * Apply a batch of splice ops to `lines`, returning a NEW array. `lines`
 * itself is never mutated.
 *
 * Ops are applied in descending `range.start` order (bottom of the file
 * first), so applying one op never invalidates the still-original indices
 * baked into the ops that haven't been applied yet.
 *
 * Throws if any two ops' ranges overlap -- overlapping ranges mean two
 * callers disagree about what should happen to the same lines, which is
 * exactly the class of bug this model exists to make impossible rather than
 * to silently resolve one way or the other.
 */
export function applySplices(lines: string[], ops: SpliceOp[]): string[] {
  const byStart = [...ops].sort((a, b) => a.range.start - b.range.start);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const cur = byStart[i];
    if (cur.range.start < prev.range.end) {
      throw new Error(
        `applySplices: overlapping ranges -- "${prev.label}" [${prev.range.start}, ${prev.range.end}) ` +
        `and "${cur.label}" [${cur.range.start}, ${cur.range.end})`,
      );
    }
  }

  const result = lines.slice();
  const descending = [...ops].sort((a, b) => b.range.start - a.range.start);
  for (const op of descending) {
    result.splice(op.range.start, op.range.end - op.range.start, ...op.lines);
  }
  return result;
}

/**
 * Build an op that inserts `block` as the first content immediately after a
 * section's header line (`section.start`). Pure insert -- removes nothing.
 */
export function insertAfterHeader(section: LineRange, block: string[], label: string): SpliceOp {
  return {
    range: { start: section.start + 1, end: section.start + 1 },
    lines: block,
    label,
  };
}

/** Build an op that appends `block` at the very end of the file. Pure insert. */
export function insertAtEof(lines: string[], block: string[], label: string): SpliceOp {
  return {
    range: { start: lines.length, end: lines.length },
    lines: block,
    label,
  };
}

/**
 * Find every `###`-level sub-block within `section` (default: a session's
 * `### YYYY-MM-DD: Title` blocks, but the header pattern is overridable for
 * other `###`-delimited sections).
 *
 * Each block runs from its header line to the line immediately before the
 * NEXT matching header inside the section; the last block runs to
 * `section.end`. Headers outside `[section.start, section.end)` are never
 * considered, even if they'd otherwise match `headerRe`.
 */
export function findSubBlocks(
  lines: string[],
  section: LineRange,
  headerRe: RegExp = /^###\s/,
): Array<{ header: string; range: LineRange }> {
  const blocks: Array<{ header: string; range: LineRange }> = [];
  let open: { header: string; start: number } | null = null;

  for (let i = section.start; i < section.end; i++) {
    if (headerRe.test(lines[i])) {
      if (open) {
        blocks.push({ header: open.header, range: { start: open.start, end: i } });
      }
      open = { header: lines[i], start: i };
    }
  }
  if (open) {
    blocks.push({ header: open.header, range: { start: open.start, end: section.end } });
  }

  return blocks;
}

/**
 * Find the sub-block for a given `### YYYY-MM-DD: Title` date within
 * `section`, if one exists.
 *
 * This exists ONLY to let a caller DETECT whether today's block is already
 * present (so it can skip re-inserting, or append a second same-day block
 * under a different title) -- never to replace or rewrite the block it
 * finds. See the module doc comment for why replace/trim primitives were not
 * built at all.
 */
export function findSessionBlock(
  lines: string[],
  section: LineRange,
  date: string,
): { header: string; range: LineRange } | null {
  const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dateRe = new RegExp(`^###\\s*${escapedDate}:`);
  const blocks = findSubBlocks(lines, section);
  return blocks.find((b) => dateRe.test(b.header)) ?? null;
}

/**
 * Build an op that replaces exactly one line. Reserved for the ONE declared
 * deletion in the whole system: seeding the Current Focus placeholder
 * (`No current focus set.`) when the section is vacant. Any other caller
 * removing a line via this primitive must have that removal declared in the
 * write guard's `allowedDeletions` -- it is not a general-purpose tool for
 * discarding content.
 */
export function replaceLine(index: number, line: string, label: string): SpliceOp {
  return { range: { start: index, end: index + 1 }, lines: [line], label };
}

/**
 * @legacy -- first-prefix-match, do not use for new callers; new code uses
 * `rawSections` line ranges instead, which are unambiguous.
 *
 * Verbatim behavioural promotion of `git-commit-roadmap.ts`'s
 * `appendToCompleted` (lines 159-198 as of the pre-move version), generalized
 * only so the target section header is a parameter instead of a hardcoded
 * `'## completed'` literal. Zero behaviour change for the one existing
 * caller, which passes `sectionPrefix = '## completed'` -- this is a
 * relocation, not a rewrite, because it is the only battle-tested splice in
 * the repo and existing tests pin its exact output.
 *
 * Two pre-existing quirks are preserved on purpose, NOT fixed here:
 *
 *   1. The `inSection` flag (mirrors the original `inCompleted`) is set on
 *      entering the section and cleared on the next unrelated `## ` header,
 *      but its value is never read anywhere -- dead logic, carried over
 *      verbatim rather than removed, since removing it is a behaviour-shape
 *      change this promotion is explicitly not making.
 *   2. Section lookup matches the FIRST header whose lowercased, trimmed
 *      text starts with `sectionPrefix`. A file containing, say,
 *      `## Completed (archived)` ABOVE a real `## Completed` section would
 *      insert into the archived one instead of the intended target. New
 *      callers should resolve their target section via `rawSections` (exact,
 *      unambiguous line ranges) rather than this prefix scan.
 *
 * The create-if-missing fallback also keeps the original's hardcoded
 * `'## Completed'` header text (rather than deriving it from `sectionPrefix`)
 * -- there is still only the one caller, and generalizing a path nobody
 * exercises yet would be speculative rather than a verified-safe lift.
 */
export function insertUnderSection(content: string, sectionPrefix: string, entry: string): string {
  const prefixLower = sectionPrefix.trim().toLowerCase();
  const lines = content.split('\n');
  const result: string[] = [];
  let insertedEntry = false;
  let inSection = false; // dead flag, preserved verbatim -- never read after being set.

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().toLowerCase();

    if (stripped.startsWith(prefixLower)) {
      inSection = true;
      result.push(line);
      result.push(entry);
      insertedEntry = true;
      continue;
    }

    if (stripped.startsWith('## ') && inSection) {
      inSection = false;
    }

    result.push(line);
  }

  if (!insertedEntry) {
    const sectionIndex = result.findIndex((l) =>
      l.trim().toLowerCase().startsWith('## planned') ||
      l.trim().toLowerCase().startsWith('## recent'),
    );

    if (sectionIndex > 0) {
      result.splice(sectionIndex, 0, '', '## Completed', entry, '');
    } else {
      result.push('', '## Completed', entry);
    }
  }

  return result.join('\n');
}
