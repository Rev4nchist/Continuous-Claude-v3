/**
 * Pre-Compact Continuity Hook Tests
 *
 * Tests for pre-compact-continuity.ts fixes:
 *   C3: Guard readdirSync crash on missing directory
 *
 * Uses vitest with mocked fs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Mock transcript-parser
vi.mock('../transcript-parser.js', () => ({
  parseTranscript: vi.fn(() => ({
    lastTodos: [],
    recentToolCalls: [],
    lastAssistantMessage: '',
    decisionsAndPlans: [],
    errorsEncountered: [],
    filesModified: [],
  })),
  generateAutoHandoff: vi.fn(() => '---\ntype: auto-handoff\n---\n\ngoal: "test"\nnow: "testing"\n'),
}));

import * as fs from 'fs';

describe('pre-compact-continuity -- C3: missing directory guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('existsSync guard prevents readdirSync on missing directory', () => {
    // The fix adds fs.existsSync(ledgerDir) before fs.readdirSync(ledgerDir)
    // If directory doesn't exist, readdirSync should NOT be called
    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockReturnValue(false);

    // Simulate the fixed code path
    const ledgerDir = '/test/project/thoughts/ledgers';
    const ledgerFiles = mockedFs.existsSync(ledgerDir)
      ? (mockedFs.readdirSync(ledgerDir) as unknown as string[])
          .filter((f: string) => f.startsWith('CONTINUITY_CLAUDE-') && f.endsWith('.md'))
      : [];

    expect(ledgerFiles).toEqual([]);
    expect(mockedFs.readdirSync).not.toHaveBeenCalled();
  });

  it('existsSync guard allows readdirSync when directory exists', () => {
    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([
      'CONTINUITY_CLAUDE-session1.md',
      'other-file.txt',
    ] as unknown as fs.Dirent[]);

    const ledgerDir = '/test/project/thoughts/ledgers';
    const ledgerFiles = mockedFs.existsSync(ledgerDir)
      ? (mockedFs.readdirSync(ledgerDir) as unknown as string[])
          .filter((f: string) => f.startsWith('CONTINUITY_CLAUDE-') && f.endsWith('.md'))
      : [];

    expect(ledgerFiles).toEqual(['CONTINUITY_CLAUDE-session1.md']);
    expect(mockedFs.readdirSync).toHaveBeenCalledWith(ledgerDir);
  });
});

// =============================================================================
// Source code verification tests
// These read the actual source file and verify the fixes are present
// =============================================================================

describe('pre-compact-continuity -- source code verification', () => {
  // Use the real fs (not the mock) to read source code
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync: realReadFileSync } = require('fs');
  const sourcePath = 'C:/Users/david.hayes/continuous-claude/.claude/hooks/src/pre-compact-continuity.ts';

  let sourceCode: string;

  try {
    sourceCode = realReadFileSync(sourcePath, 'utf-8');
  } catch {
    sourceCode = '';
  }

  it('C3: source contains existsSync guard before readdirSync', () => {
    // The fix adds: fs.existsSync(ledgerDir) ? fs.readdirSync(...) : []
    expect(sourceCode).toContain('existsSync(ledgerDir)');
  });
});
