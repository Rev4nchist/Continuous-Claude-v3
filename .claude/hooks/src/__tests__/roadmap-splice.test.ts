import { describe, it, expect } from 'vitest';
import {
  applySplices,
  insertAfterHeader,
  insertAtEof,
  findSubBlocks,
  findSessionBlock,
  replaceLine,
  insertUnderSection,
  type LineRange,
  type SpliceOp,
} from '../shared/roadmap-splice.js';

/**
 * Verbatim reference copy of git-commit-roadmap.ts's private `appendToCompleted`
 * (lines 159-198), kept ONLY so this file can assert byte-for-byte parity
 * against `insertUnderSection` -- the function is not exported from
 * git-commit-roadmap.ts, so this is the only way to compare "before" and
 * "after" without modifying that file (out of scope for this task).
 */
function referenceAppendToCompleted(content: string, entry: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let insertedEntry = false;
  let inCompleted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().toLowerCase();

    if (stripped.startsWith('## completed')) {
      inCompleted = true;
      result.push(line);
      result.push(entry);
      insertedEntry = true;
      continue;
    }

    if (stripped.startsWith('## ') && inCompleted) {
      inCompleted = false;
    }

    result.push(line);
  }

  if (!insertedEntry) {
    const completedIndex = result.findIndex((l) =>
      l.trim().toLowerCase().startsWith('## planned') ||
      l.trim().toLowerCase().startsWith('## recent'),
    );

    if (completedIndex > 0) {
      result.splice(completedIndex, 0, '', '## Completed', entry, '');
    } else {
      result.push('', '## Completed', entry);
    }
  }

  return result.join('\n');
}

describe('applySplices', () => {
  it('applies two non-adjacent ops with correct final indices', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const ops: SpliceOp[] = [
      { range: { start: 1, end: 2 }, lines: ['B1', 'B2'], label: 'replace-b' },
      { range: { start: 3, end: 4 }, lines: ['D1'], label: 'replace-d' },
    ];
    const out = applySplices(lines, ops);
    expect(out).toEqual(['a', 'B1', 'B2', 'c', 'D1', 'e']);
  });

  it('throws on overlapping ops', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const ops: SpliceOp[] = [
      { range: { start: 1, end: 4 }, lines: ['X'], label: 'first' },
      { range: { start: 3, end: 5 }, lines: ['Y'], label: 'second' },
    ];
    expect(() => applySplices(lines, ops)).toThrow(/overlapping/i);
  });

  it('does not mutate the input array', () => {
    const lines = ['a', 'b', 'c'];
    const original = [...lines];
    applySplices(lines, [{ range: { start: 1, end: 2 }, lines: ['B'], label: 'replace-b' }]);
    expect(lines).toEqual(original);
  });

  it('a pure insert (start === end) inserts without removing anything', () => {
    const lines = ['a', 'b', 'c'];
    const op: SpliceOp = { range: { start: 1, end: 1 }, lines: ['NEW'], label: 'insert' };
    const out = applySplices(lines, [op]);
    expect(out).toEqual(['a', 'NEW', 'b', 'c']);
  });

  it('a delete op (lines: []) removes exactly its range', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const op: SpliceOp = { range: { start: 1, end: 3 }, lines: [], label: 'delete-b-c' };
    const out = applySplices(lines, [op]);
    expect(out).toEqual(['a', 'd']);
  });

  it('adjacent (non-overlapping) ranges are allowed', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const ops: SpliceOp[] = [
      { range: { start: 1, end: 2 }, lines: ['B'], label: 'first' },
      { range: { start: 2, end: 3 }, lines: ['C'], label: 'second' },
    ];
    const out = applySplices(lines, ops);
    expect(out).toEqual(['a', 'B', 'C', 'd']);
  });
});

describe('insertAfterHeader', () => {
  it('builds an insert op immediately after the section header line', () => {
    const section: LineRange = { start: 10, end: 20 };
    const op = insertAfterHeader(section, ['### 2026-08-05: X', 'body'], 'session-insert');
    expect(op).toEqual({
      range: { start: 11, end: 11 },
      lines: ['### 2026-08-05: X', 'body'],
      label: 'session-insert',
    });
  });

  it('applied to real lines, inserts right after the header without disturbing anything else', () => {
    const lines = ['## Recent Planning Sessions', '### 2026-07-27: Old', 'decision'];
    const section: LineRange = { start: 0, end: 3 };
    const op = insertAfterHeader(section, ['### 2026-08-05: New', 'new decision'], 'session-insert');
    const out = applySplices(lines, [op]);
    expect(out).toEqual([
      '## Recent Planning Sessions',
      '### 2026-08-05: New',
      'new decision',
      '### 2026-07-27: Old',
      'decision',
    ]);
  });
});

describe('insertAtEof', () => {
  it('builds an insert op at the end of the file', () => {
    const lines = ['a', 'b', 'c'];
    const op = insertAtEof(lines, ['d', 'e'], 'eof-insert');
    expect(op).toEqual({ range: { start: 3, end: 3 }, lines: ['d', 'e'], label: 'eof-insert' });

    const out = applySplices(lines, [op]);
    expect(out).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('works on an empty file', () => {
    const lines: string[] = [];
    const op = insertAtEof(lines, ['only line'], 'eof-insert');
    expect(applySplices(lines, [op])).toEqual(['only line']);
  });
});

describe('replaceLine', () => {
  it('builds an op that replaces exactly one line', () => {
    const op = replaceLine(2, 'REPLACED', 'placeholder-seed');
    expect(op).toEqual({ range: { start: 2, end: 3 }, lines: ['REPLACED'], label: 'placeholder-seed' });
  });

  it('applied, replaces only the targeted line', () => {
    const lines = ['a', 'b', 'No current focus set.', 'd'];
    const op = replaceLine(2, '**New Goal**', 'placeholder-seed');
    const out = applySplices(lines, [op]);
    expect(out).toEqual(['a', 'b', '**New Goal**', 'd']);
  });
});

describe('findSubBlocks', () => {
  const SECTION_LINES = [
    '## Recent Planning Sessions',      // 0 (section header, not part of range under test below)
    '### 2026-08-03: Third',            // 1
    'decision C1',                      // 2
    '### 2026-08-02: Second',           // 3
    'decision B1',                      // 4
    'decision B2',                      // 5
    '### 2026-08-01: First',            // 6
    'decision A1',                      // 7
    '## Notes',                         // 8 (outside the section)
    '### not a session, just a coincidental heading', // 9
  ];
  const SECTION: LineRange = { start: 1, end: 8 };

  it('returns 3 ranges for 3 blocks, the last ending exactly at section.end', () => {
    const blocks = findSubBlocks(SECTION_LINES, SECTION);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ header: '### 2026-08-03: Third', range: { start: 1, end: 3 } });
    expect(blocks[1]).toEqual({ header: '### 2026-08-02: Second', range: { start: 3, end: 6 } });
    expect(blocks[2]).toEqual({ header: '### 2026-08-01: First', range: { start: 6, end: 8 } });
    expect(blocks[2].range.end).toBe(SECTION.end);
  });

  it('ignores a ### header outside the given section range', () => {
    const blocks = findSubBlocks(SECTION_LINES, SECTION);
    const headers = blocks.map((b) => b.header);
    expect(headers).not.toContain('### not a session, just a coincidental heading');
  });

  it('honors a custom header regex', () => {
    const lines = ['#### Sub A', 'x', '#### Sub B', 'y'];
    const blocks = findSubBlocks(lines, { start: 0, end: 4 }, /^####\s/);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].range).toEqual({ start: 0, end: 2 });
    expect(blocks[1].range).toEqual({ start: 2, end: 4 });
  });

  it('returns an empty array when there are no matching headers in the section', () => {
    const lines = ['## Notes', 'just prose', 'more prose'];
    expect(findSubBlocks(lines, { start: 0, end: 3 })).toEqual([]);
  });
});

describe('findSessionBlock', () => {
  const LINES = [
    '## Recent Planning Sessions', // 0
    '### 2026-08-03: Third',       // 1
    'decision C1',                 // 2
    '### 2026-08-01: First',       // 3
    'decision A1',                 // 4
    '## Notes',                    // 5
    '### 2026-08-01: Outside the section, must not match', // 6
  ];
  const SECTION: LineRange = { start: 1, end: 5 };

  it('finds a block by date', () => {
    const block = findSessionBlock(LINES, SECTION, '2026-08-03');
    expect(block).toEqual({ header: '### 2026-08-03: Third', range: { start: 1, end: 3 } });
  });

  it('returns null when the date is absent from the section', () => {
    expect(findSessionBlock(LINES, SECTION, '2026-08-02')).toBeNull();
  });

  it('does not match a ### <date> block outside the section range', () => {
    // '2026-08-01' DOES exist inside the full SECTION (line 3), so this also
    // exercises that the in-range one is what's found, not the out-of-range
    // decoy at line 6.
    const block = findSessionBlock(LINES, SECTION, '2026-08-01');
    expect(block).toEqual({ header: '### 2026-08-01: First', range: { start: 3, end: 5 } });

    // Narrow the section to exclude BOTH the in-range block (line 3) and the
    // out-of-range decoy (line 6). The only candidate for '2026-08-01' left
    // is the decoy, which must NOT be found because it's outside the range.
    const narrowedExcludingBoth: LineRange = { start: 1, end: 3 };
    expect(findSessionBlock(LINES, narrowedExcludingBoth, '2026-08-01')).toBeNull();
  });
});

describe('insertUnderSection parity with the pre-move appendToCompleted', () => {
  const ENTRY = '- [x] feat(memory): add embedding daemon (2026-08-05) `abc1234`';

  it('fixture 1: existing "## Completed" section -- entry lands right under the header', () => {
    const content = [
      '# Project Roadmap',
      '',
      '## Completed',
      '- [x] older entry (2026-08-01)',
      '',
      '## Planned',
      '- [ ] something',
    ].join('\n');

    const expected = referenceAppendToCompleted(content, ENTRY);
    const actual = insertUnderSection(content, '## completed', ENTRY);
    expect(actual).toEqual(expected);
    expect(actual).toContain('## Completed\n' + ENTRY);
  });

  it('fixture 2: no "## Completed" section, but "## Planned" exists -- creates one before Planned', () => {
    const content = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Some goal**',
      '',
      '## Planned',
      '- [ ] something',
    ].join('\n');

    const expected = referenceAppendToCompleted(content, ENTRY);
    const actual = insertUnderSection(content, '## completed', ENTRY);
    expect(actual).toEqual(expected);
    expect(actual).toContain('## Completed');
  });

  it('fixture 3: no "## Completed", no "## Planned"/"## Recent" -- falls back to a trailing append', () => {
    const content = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Some goal**',
    ].join('\n');

    const expected = referenceAppendToCompleted(content, ENTRY);
    const actual = insertUnderSection(content, '## completed', ENTRY);
    expect(actual).toEqual(expected);
    expect(actual.endsWith(`\n\n## Completed\n${ENTRY}`)).toBe(true);
  });
});
