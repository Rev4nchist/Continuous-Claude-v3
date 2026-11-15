/**
 * Tests for session-start-continuity's hand-written-notes extractor.
 *
 * extractNotesSections pulls `## Notes`, `## For Next Session`, `## Scratch`
 * blocks out of ROADMAP.md so SessionStart can surface them. Pure-function
 * test (no fs / no stdin).
 *
 * NOTE: importing this module runs its top-level main(); session-start-
 * continuity's readStdin has a 1000ms setTimeout fallback (mirroring
 * git-commit-roadmap.ts) so the import cannot hang the test runner.
 */

import { describe, it, expect } from 'vitest';
import { extractNotesSections, extractGuardedCurrentFocus, compactStatusLine } from '../session-start-continuity.js';

describe('extractNotesSections', () => {
  it('finds both ## Notes and ## For Next Session blocks when present', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Goal**',
      '',
      '## Notes',
      '- remember the rate limiter',
      '- staging creds expire Friday',
      '',
      '## For Next Session',
      '- start with the failing auth test',
      '',
      '## Completed',
      '- [x] Done (2026-01-01)',
      '',
    ].join('\n');

    const blocks = extractNotesSections(roadmap);
    expect(blocks).toHaveLength(2);

    // Order follows the header list: Notes, then For Next Session.
    expect(blocks[0]).toBe(
      ['## Notes', '- remember the rate limiter', '- staging creds expire Friday'].join('\n'),
    );
    expect(blocks[1]).toBe(
      ['## For Next Session', '- start with the failing auth test'].join('\n'),
    );
  });

  it('returns a single block when only ## Scratch exists with a body', () => {
    const roadmap = [
      '## Current Focus',
      '**Goal**',
      '',
      '## Scratch',
      'free-form scratch text',
      '',
    ].join('\n');

    const blocks = extractNotesSections(roadmap);
    expect(blocks).toEqual(['## Scratch\nfree-form scratch text']);
  });

  it('returns [] when no notes sections are present', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Goal**',
      '',
      '## Completed',
      '- [x] Done (2026-01-01)',
      '',
    ].join('\n');

    expect(extractNotesSections(roadmap)).toEqual([]);
  });

  it('skips a notes header that has an empty body', () => {
    const roadmap = ['## Notes', '', '## Completed', '- [x] X'].join('\n');
    expect(extractNotesSections(roadmap)).toEqual([]);
  });
});

// D2F-03: the unified-context Current Focus extraction must run through the
// same cross-project contamination guard, so a foreign focus is not propagated.
// Uses the real continuous-claude registry on disk (the actual project).
describe('extractGuardedCurrentFocus (D2F-03)', () => {
  const CC_DIR = '/home/testuser/continuous-claude';

  it('drops a foreign Salesforce/FastMCP Current Focus (SEED-02 regression)', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Harden the Alpha and Lay a Solid FastMCP v3 Foundation**',
      '- Ship the SOQL COUNT fix first; defer the rate limiter — Salesforce upstream limits suffice.',
      '',
      '## Completed',
      '- [x] X (2026-01-01)',
    ].join('\n');
    expect(extractGuardedCurrentFocus(roadmap, CC_DIR)).toBeNull();
  });

  it('keeps a legitimate continuous-claude Current Focus', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## Current Focus',
      '**Continuous-claude session 9: wire codegraph behind /code-intel**',
      '- Reconcile the hooks and memory subsystems; decide the bus-bias lift.',
      '',
      '## Completed',
      '- [x] X (2026-01-01)',
    ].join('\n');
    const focus = extractGuardedCurrentFocus(roadmap, CC_DIR);
    expect(focus).not.toBeNull();
    expect(focus).toContain('codegraph');
  });

  it('returns null when there is no Current Focus section', () => {
    const roadmap = ['# Project Roadmap', '', '## Completed', '- [x] X'].join('\n');
    expect(extractGuardedCurrentFocus(roadmap, CC_DIR)).toBeNull();
  });
});

// Card compact-status-line-says-breakpoint: the visible line after a compact must say what the model really got.
describe('compactStatusLine', () => {
  const HANDOFF_LINE = '[compact] Loaded from handoff: x.yaml | Goal: g | Focus: f';
  const FILE = [
    '# Session breakpoint',
    'session: abc',
    '## Decisions made',
    '- [23:14Z] Open PR -> Open draft PR',
    '',
  ].join('\n');

  it('says the breakpoint loaded when a breakpoint file replaces the context', () => {
    const line = compactStatusLine('compact', HANDOFF_LINE, FILE);
    expect(line).toContain('[compact]');
    expect(line.toLowerCase()).toContain('breakpoint');
    expect(line).not.toContain('Loaded from handoff');
  });

  it('keeps the handoff line when no breakpoint file exists', () => {
    expect(compactStatusLine('compact', HANDOFF_LINE, null)).toBe(HANDOFF_LINE);
  });

  it('keeps the handoff line when the breakpoint file is only whitespace', () => {
    expect(compactStatusLine('compact', HANDOFF_LINE, '  \n ')).toBe(HANDOFF_LINE);
  });

  it('does not touch startup, resume or clear lines', () => {
    for (const t of ['startup', 'resume', 'clear']) {
      expect(compactStatusLine(t, HANDOFF_LINE, FILE)).toBe(HANDOFF_LINE);
    }
  });

  it('gives the breakpoint line when a compact has no handoff line at all', () => {
    const line = compactStatusLine('compact', '', FILE);
    expect(line.toLowerCase()).toContain('breakpoint');
  });
});
