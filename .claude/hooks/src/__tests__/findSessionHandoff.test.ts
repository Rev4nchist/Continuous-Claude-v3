/**
 * Tests for findSessionHandoff() function
 *
 * Phase 2b TDD: These tests are written BEFORE the implementation.
 * They should FAIL until the function is implemented.
 *
 * Run with: npx vitest run src/__tests__/findSessionHandoff.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import the function under test
import {
  findSessionHandoff,
  buildHandoffDirName,
  parseHandoffDirName,
  findSessionHandoffWithUUID
} from '../session-start-continuity.js';

describe('findSessionHandoff', () => {
  let testDir: string;
  let originalProjectDir: string | undefined;

  beforeEach(() => {
    // Create a temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findSessionHandoff-test-'));

    // Save and override CLAUDE_PROJECT_DIR
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = testDir;
  });

  afterEach(() => {
    // Restore original CLAUDE_PROJECT_DIR
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }

    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null for nonexistent session directory', () => {
    // Don't create any directories - session doesn't exist
    const result = findSessionHandoff('nonexistent-session');

    expect(result, 'Should return null when session directory does not exist').toBe(null);
  });

  it('should return null for empty directory (no .md files)', () => {
    // Create the handoff directory but leave it empty
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'empty-session');
    fs.mkdirSync(handoffDir, { recursive: true });

    const result = findSessionHandoff('empty-session');

    expect(result, 'Should return null when directory has no .md files').toBe(null);
  });

  it('should return null for directory with only non-.md files', () => {
    // Create directory with non-.md files only
    const sessionName = 'non-md-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    // Create some non-.md files
    fs.writeFileSync(path.join(handoffDir, 'notes.txt'), 'some notes');
    fs.writeFileSync(path.join(handoffDir, 'data.json'), '{}');
    fs.writeFileSync(path.join(handoffDir, '.gitkeep'), '');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return null when no .md files exist').toBe(null);
  });

  it('should return the most recent handoff by mtime', async () => {
    const sessionName = 'mtime-test-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    // Create older file first
    const olderFile = path.join(handoffDir, '2025-12-29_handoff.md');
    fs.writeFileSync(olderFile, '# Older handoff');

    // Wait a bit to ensure different mtimes
    await new Promise(resolve => setTimeout(resolve, 50));

    // Create newer file
    const newerFile = path.join(handoffDir, '2025-12-30_handoff.md');
    fs.writeFileSync(newerFile, '# Newer handoff');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return a path').not.toBe(null);
    expect(result, 'Should return the most recent file by mtime').toBe(newerFile);
  });

  it('should return current.md if it is the most recent (by mtime)', async () => {
    const sessionName = 'current-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    // Create an older timestamped file
    const olderFile = path.join(handoffDir, '2025-12-28_old-handoff.md');
    fs.writeFileSync(olderFile, '# Old handoff');

    // Wait to ensure different mtimes
    await new Promise(resolve => setTimeout(resolve, 50));

    // Create current.md as the most recent
    const currentFile = path.join(handoffDir, 'current.md');
    fs.writeFileSync(currentFile, '# Current handoff');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return a path').not.toBe(null);
    expect(result, 'Should return current.md when it is most recent').toBe(currentFile);
  });

  it('should handle single .md file correctly', () => {
    const sessionName = 'single-file-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    const singleFile = path.join(handoffDir, 'only-handoff.md');
    fs.writeFileSync(singleFile, '# The only handoff');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return a path').not.toBe(null);
    expect(result, 'Should return the only .md file').toBe(singleFile);
  });

  it('should ignore non-.md files when selecting most recent', async () => {
    const sessionName = 'mixed-files-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    // Create older .md file
    const mdFile = path.join(handoffDir, 'handoff.md');
    fs.writeFileSync(mdFile, '# Handoff');

    // Wait to ensure different mtimes
    await new Promise(resolve => setTimeout(resolve, 50));

    // Create newer non-.md files (should be ignored)
    fs.writeFileSync(path.join(handoffDir, 'newer-notes.txt'), 'notes');
    fs.writeFileSync(path.join(handoffDir, 'even-newer.json'), '{}');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return a path').not.toBe(null);
    expect(result, 'Should return the .md file, ignoring non-.md files').toBe(mdFile);
  });

  it('should return absolute path to the handoff file', () => {
    const sessionName = 'absolute-path-session';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    const handoffFile = path.join(handoffDir, 'handoff.md');
    fs.writeFileSync(handoffFile, '# Handoff content');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should return a path').not.toBe(null);
    expect(path.isAbsolute(result!), 'Should return an absolute path').toBeTruthy();
    expect(result!.endsWith('.md'), 'Path should end with .md').toBeTruthy();
  });

  it('should handle session name with special characters', () => {
    // Session names might have hyphens, underscores, etc.
    const sessionName = 'my-feature_v2.0';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    const handoffFile = path.join(handoffDir, 'current.md');
    fs.writeFileSync(handoffFile, '# Handoff');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should handle session names with special characters').not.toBe(null);
    expect(result, 'Should return the correct file').toBe(handoffFile);
  });

  it('should use CLAUDE_PROJECT_DIR environment variable', () => {
    // This test verifies the function uses the env var we set up
    const sessionName = 'env-var-test';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
    fs.mkdirSync(handoffDir, { recursive: true });

    const handoffFile = path.join(handoffDir, 'handoff.md');
    fs.writeFileSync(handoffFile, '# Handoff');

    const result = findSessionHandoff(sessionName);

    expect(result, 'Should use CLAUDE_PROJECT_DIR').not.toBe(null);
    expect(result!.startsWith(testDir), 'Result should be within CLAUDE_PROJECT_DIR').toBeTruthy();
  });
});

// ============================================
// UUID ISOLATION TESTS (Phase: session-uuid-isolation)
// ============================================

describe('buildHandoffDirName', () => {
  it('should append 8-char UUID suffix to session name', () => {
    const result = buildHandoffDirName('auth-refactor', '550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBe('auth-refactor-550e8400');
  });

  it('should handle UUID without dashes', () => {
    const result = buildHandoffDirName('my-feature', '550e8400e29b41d4a716446655440000');
    expect(result).toBe('my-feature-550e8400');
  });

  it('should handle short session names', () => {
    const result = buildHandoffDirName('fix', 'abcd1234-0000-0000-0000-000000000000');
    expect(result).toBe('fix-abcd1234');
  });
});

describe('parseHandoffDirName', () => {
  it('should extract session name and UUID from suffixed directory', () => {
    const result = parseHandoffDirName('auth-refactor-550e8400');
    expect(result).toStrictEqual({ sessionName: 'auth-refactor', uuidShort: '550e8400' });
  });

  it('should handle legacy directory without UUID suffix', () => {
    const result = parseHandoffDirName('auth-refactor');
    expect(result).toStrictEqual({ sessionName: 'auth-refactor', uuidShort: null });
  });

  it('should handle session names with multiple hyphens', () => {
    const result = parseHandoffDirName('my-cool-feature-v2-abcd1234');
    expect(result).toStrictEqual({ sessionName: 'my-cool-feature-v2', uuidShort: 'abcd1234' });
  });

  it('should not parse non-hex suffix as UUID', () => {
    // "v2" is not 8 hex chars, so treat as part of session name
    const result = parseHandoffDirName('my-feature-v2');
    expect(result).toStrictEqual({ sessionName: 'my-feature-v2', uuidShort: null });
  });

  it('should require exactly 8 hex chars for UUID', () => {
    // "abc123" is only 6 chars
    const result = parseHandoffDirName('my-feature-abc123');
    expect(result).toStrictEqual({ sessionName: 'my-feature-abc123', uuidShort: null });
  });
});

describe('findSessionHandoffWithUUID', () => {
  let testDir: string;
  let originalProjectDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-handoff-test-'));
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = testDir;
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should find handoff with exact UUID match', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const dirName = 'auth-refactor-550e8400';
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', dirName);
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'current.md'), '# Handoff');

    const result = findSessionHandoffWithUUID('auth-refactor', sessionId);

    expect(result).not.toBe(null);
    expect(result!.includes('auth-refactor-550e8400')).toBeTruthy();
  });

  it('should fall back to legacy path without UUID', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    // Create legacy directory (no UUID suffix)
    const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'auth-refactor');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'current.md'), '# Legacy handoff');

    const result = findSessionHandoffWithUUID('auth-refactor', sessionId);

    expect(result).not.toBe(null);
    expect(result!.includes('auth-refactor')).toBeTruthy();
    expect(!result!.includes('550e8400'), 'Should use legacy path').toBeTruthy();
  });

  it('should prefer UUID-suffixed directory over legacy', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    // Create legacy directory first
    const legacyDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'auth-refactor');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'current.md'), '# Legacy');

    await new Promise(resolve => setTimeout(resolve, 50));

    // Create UUID-suffixed directory
    const uuidDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'auth-refactor-550e8400');
    fs.mkdirSync(uuidDir, { recursive: true });
    fs.writeFileSync(path.join(uuidDir, 'current.md'), '# UUID handoff');

    const result = findSessionHandoffWithUUID('auth-refactor', sessionId);

    expect(result).not.toBe(null);
    expect(result!.includes('550e8400'), 'Should prefer UUID-suffixed directory').toBeTruthy();
  });

  it('should find other sessions UUID dirs when no exact match', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Create a different UUID's directory for same session name
    const otherDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'auth-refactor-11111111');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'current.md'), '# Other session');

    const result = findSessionHandoffWithUUID('auth-refactor', sessionId);

    // Should find the other session's handoff as fallback
    expect(result).not.toBe(null);
    expect(result!.includes('auth-refactor')).toBeTruthy();
  });

  it('should return null when no matching session exists', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    // Create handoffs directory but no matching session
    const handoffsBase = path.join(testDir, 'thoughts', 'shared', 'handoffs');
    fs.mkdirSync(handoffsBase, { recursive: true });

    const result = findSessionHandoffWithUUID('nonexistent', sessionId);

    expect(result).toBe(null);
  });
});
