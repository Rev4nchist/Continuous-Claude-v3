/**
 * Tests for Phase 2c: main() checks handoffs FIRST for embedded Ledger sections
 *
 * These tests verify that:
 * 1. When handoff has Ledger section, use it (not legacy ledger)
 * 2. When handoff lacks Ledger section, fall back to legacy ledger
 * 3. When no handoff exists, use legacy ledger
 *
 * Run with: npx vitest run src/__tests__/mainHandoffFirst.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('main() handoff-first behavior', () => {
  let testDir: string;
  let originalProjectDir: string | undefined;

  beforeEach(() => {
    // Create a temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mainHandoffFirst-test-'));

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

  /**
   * Helper to run the hook with stdin input and capture output
   */
  function runHook(input: object): { stdout: string; stderr: string } {
    const hookPath = path.resolve(__dirname, '../../dist/session-start-continuity.mjs');

    // No shell. This used to be
    //   execSync(`echo '${json}' | CLAUDE_PROJECT_DIR="${dir}" node "${hook}"`)
    // which is POSIX-only twice over: on Windows execSync runs cmd.exe, where
    // `echo '{...}'` emits the literal single quotes and a `VAR="x" cmd` prefix
    // is not valid syntax at all. The command failed, stdout came back empty,
    // and all 9 tests died on JSON.parse('') -- "Unexpected end of JSON input".
    // spawnSync pipes stdin directly and passes env as a real option, matching
    // session-start-init-check.test.ts.
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      stdout: (result.stdout || '').toString(),
      stderr: (result.stderr || '').toString(),
    };
  }

  describe('when handoff has Ledger section', () => {
    it('should use handoff Ledger section instead of legacy ledger', () => {
      // Create handoff with Ledger section
      const sessionName = 'test-session';
      const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
      fs.mkdirSync(handoffDir, { recursive: true });

      const handoffContent = `# Work Stream: ${sessionName}

## Ledger
**Updated:** 2025-12-30T12:00:00Z
**Goal:** Handoff goal (NEW)
**Branch:** feature/handoff
**Test:** npm test

### Now
[->] Working from handoff Ledger

### Next
- [ ] Next item from handoff

---

## Context
Detailed context from handoff.
`;
      fs.writeFileSync(path.join(handoffDir, 'current.md'), handoffContent);

      // Also create a legacy ledger (should be IGNORED)
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      const legacyLedgerContent = `# Continuity Ledger: ${sessionName}

## Goal
Legacy ledger goal (OLD - should not be used)

## State
- Done: Nothing
- Now: Legacy focus (OLD)
- Next: Legacy next

## Working Set
- branch: main
`;
      fs.writeFileSync(path.join(ledgerDir, `CONTINUITY_CLAUDE-${sessionName}.md`), legacyLedgerContent);

      // Run hook with resume
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      // Should load from handoff, not legacy ledger
      expect(output.result, 'Hook should continue').toBe('continue');

      // The message or additionalContext should reference handoff content
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('Handoff goal') || fullOutput.includes('Working from handoff'), 'Should include content from handoff Ledger, not legacy ledger').toBeTruthy();
      expect(!fullOutput.includes('Legacy ledger goal') && !fullOutput.includes('Legacy focus'), 'Should NOT include content from legacy ledger').toBeTruthy();
    });

    it('should select most recent handoff when multiple sessions have Ledger sections', async () => {
      // Create two session handoffs with Ledger sections
      const session1Dir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'session-old');
      const session2Dir = path.join(testDir, 'thoughts', 'shared', 'handoffs', 'session-new');
      fs.mkdirSync(session1Dir, { recursive: true });
      fs.mkdirSync(session2Dir, { recursive: true });

      // Create older handoff first
      const oldHandoff = `# Work Stream: session-old

## Ledger
**Updated:** 2025-12-29T00:00:00Z
**Goal:** Old session goal
**Branch:** old-branch

### Now
[->] Old session focus

---

## Context
Old context.
`;
      fs.writeFileSync(path.join(session1Dir, 'current.md'), oldHandoff);

      // Wait for different mtime
      await new Promise(resolve => setTimeout(resolve, 50));

      // Create newer handoff
      const newHandoff = `# Work Stream: session-new

## Ledger
**Updated:** 2025-12-30T12:00:00Z
**Goal:** New session goal
**Branch:** new-branch

### Now
[->] New session focus

---

## Context
New context.
`;
      fs.writeFileSync(path.join(session2Dir, 'current.md'), newHandoff);

      // Create legacy ledgers directory (should exist but be fallback)
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Run hook
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      // Should use the more recent handoff
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('New session goal') || fullOutput.includes('New session focus'), 'Should include content from most recent handoff').toBeTruthy();
    });
  });

  describe('when handoff lacks Ledger section', () => {
    it('should fall back to legacy ledger', () => {
      // Create handoff WITHOUT Ledger section
      const sessionName = 'no-ledger-session';
      const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
      fs.mkdirSync(handoffDir, { recursive: true });

      const handoffContent = `# Work Stream: ${sessionName}

## Context
This handoff has no Ledger section (old format).

## What Was Done
- Some work
`;
      fs.writeFileSync(path.join(handoffDir, 'task-1.md'), handoffContent);

      // Create legacy ledger (should be used as fallback)
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      const legacyLedgerContent = `# Continuity Ledger: ${sessionName}

## Goal
Fallback legacy goal

## State
- Done: Nothing
- Now: Legacy fallback focus
- Next: Next item

## Working Set
- branch: main
`;
      fs.writeFileSync(path.join(ledgerDir, `CONTINUITY_CLAUDE-${sessionName}.md`), legacyLedgerContent);

      // Run hook
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      // Should fall back to legacy ledger
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('Fallback legacy goal') || fullOutput.includes('Legacy fallback focus'), 'Should fall back to legacy ledger when handoff has no Ledger section').toBeTruthy();
    });
  });

  describe('when no handoff exists', () => {
    it('should use legacy ledger', () => {
      // No handoff directory at all
      const sessionName = 'legacy-only-session';

      // Create only legacy ledger
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      const legacyLedgerContent = `# Continuity Ledger: ${sessionName}

## Goal
Pure legacy goal

## State
- Done: Nothing
- Now: Pure legacy focus
- Next: Next

## Working Set
- branch: main
`;
      fs.writeFileSync(path.join(ledgerDir, `CONTINUITY_CLAUDE-${sessionName}.md`), legacyLedgerContent);

      // Run hook
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      // Should use legacy ledger
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('Pure legacy goal') || fullOutput.includes('Pure legacy focus'), 'Should use legacy ledger when no handoffs exist').toBeTruthy();
    });

    it('should return continue with no message when no ledger or handoff exists', () => {
      // Empty thoughts directory - no handoffs, no ledgers
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });
      // But no ledger files inside

      // Run hook
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      expect(output.result, 'Should continue even with no state').toBe('continue');
    });
  });

  describe('handoff directory edge cases', () => {
    it('should handle non-existent handoffs directory gracefully', () => {
      // Create ledger dir but not handoffs dir
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      const legacyLedgerContent = `# Continuity Ledger: test

## Goal
Test goal

## State
- Done: Nothing
- Now: Test focus
- Next: Next

## Working Set
- branch: main
`;
      fs.writeFileSync(path.join(ledgerDir, 'CONTINUITY_CLAUDE-test.md'), legacyLedgerContent);

      // Run hook - should not crash, should use legacy ledger
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      expect(output.result, 'Should continue gracefully').toBe('continue');
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('Test goal') || fullOutput.includes('Test focus'), 'Should fall back to legacy ledger').toBeTruthy();
    });

    it('should handle empty handoffs directory', () => {
      // Create empty handoffs directory
      const handoffsDir = path.join(testDir, 'thoughts', 'shared', 'handoffs');
      fs.mkdirSync(handoffsDir, { recursive: true });

      // Create legacy ledger
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });

      const legacyLedgerContent = `# Continuity Ledger: empty-handoffs

## Goal
Empty handoffs test

## State
- Done: Nothing
- Now: Empty handoffs focus
- Next: Next

## Working Set
- branch: main
`;
      fs.writeFileSync(path.join(ledgerDir, 'CONTINUITY_CLAUDE-empty-handoffs.md'), legacyLedgerContent);

      // Run hook
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      expect(output.result, 'Should continue gracefully').toBe('continue');
    });
  });

  describe('startup vs resume behavior', () => {
    it('should show brief notification on startup when handoff Ledger available', () => {
      // Create handoff with Ledger
      const sessionName = 'startup-test';
      const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
      fs.mkdirSync(handoffDir, { recursive: true });

      const handoffContent = `# Work Stream: ${sessionName}

## Ledger
**Updated:** 2025-12-30T12:00:00Z
**Goal:** Startup test goal
**Branch:** main

### Now
[->] Current startup task

---

## Context
Context details.
`;
      fs.writeFileSync(path.join(handoffDir, 'current.md'), handoffContent);

      // Create ledger dir (required for hook to not exit early)
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.writeFileSync(path.join(ledgerDir, `CONTINUITY_CLAUDE-${sessionName}.md`), '# Ledger\n## Goal\nTest');

      // Run hook with startup
      const result = runHook({ source: 'startup', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      expect(output.result, 'Should continue').toBe('continue');
      // Startup should have brief message, not full content
      if (output.message) {
        expect(output.message.length < 500, 'Startup message should be brief').toBeTruthy();
      }
    });

    it('should load full Ledger content on resume/clear/compact', () => {
      // Create handoff with Ledger
      const sessionName = 'resume-test';
      const handoffDir = path.join(testDir, 'thoughts', 'shared', 'handoffs', sessionName);
      fs.mkdirSync(handoffDir, { recursive: true });

      const handoffContent = `# Work Stream: ${sessionName}

## Ledger
**Updated:** 2025-12-30T12:00:00Z
**Goal:** Resume test goal with detailed info
**Branch:** feature/resume

### Now
[->] Working on resume functionality

### This Session
- [x] Completed task 1
- [x] Completed task 2

### Next
- [ ] Priority 1
- [ ] Priority 2

### Decisions
- Important decision: reasoning

---

## Context
Full context that should be available on resume.
`;
      fs.writeFileSync(path.join(handoffDir, 'current.md'), handoffContent);

      // Create ledger dir
      const ledgerDir = path.join(testDir, 'thoughts', 'ledgers');
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.writeFileSync(path.join(ledgerDir, `CONTINUITY_CLAUDE-${sessionName}.md`), '# Ledger\n## Goal\nLegacy');

      // Test resume
      const result = runHook({ source: 'resume', session_id: 'test-123' });
      const output = JSON.parse(result.stdout);

      expect(output.result, 'Should continue').toBe('continue');
      // Resume should have more detailed content
      const fullOutput = JSON.stringify(output);
      expect(fullOutput.includes('Resume test goal') || fullOutput.includes('Working on resume'), 'Resume should include handoff Ledger content').toBeTruthy();
    });
  });
});
