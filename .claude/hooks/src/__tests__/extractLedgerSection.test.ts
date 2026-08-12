/**
 * Tests for extractLedgerSection() function
 *
 * Phase 2a TDD: These tests are written BEFORE the implementation.
 * They should FAIL until the function is implemented.
 *
 * Run with: npx vitest run src/__tests__/extractLedgerSection.test.ts
 */

import { describe, it, expect } from 'vitest';

// Import the function under test
import { extractLedgerSection } from '../session-start-continuity.js';

describe('extractLedgerSection', () => {
  it('should return correct Ledger section from valid handoff', () => {
    const handoffContent = `# Work Stream: test-session

## Ledger
**Updated:** 2025-12-30T00:00:00Z
**Goal:** Test the new format
**Branch:** main
**Test:** npm test

### Now
[->] Testing new format

### This Session
- [x] Completed item 1
- [x] Completed item 2

### Next
- [ ] Priority 1
- [ ] Priority 2

### Decisions
- Decision 1: Rationale

---

## Context
Detailed context here that should NOT be included.
More context lines.
`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should not return null for valid handoff with Ledger section').not.toBe(null);
    expect(result!.startsWith('## Ledger'), 'Result should start with "## Ledger"').toBeTruthy();
    expect(result!.includes('**Goal:** Test the new format'), 'Should include Goal field').toBeTruthy();
    expect(result!.includes('### Now'), 'Should include Now section').toBeTruthy();
    expect(result!.includes('[->] Testing new format'), 'Should include current focus').toBeTruthy();
    expect(result!.includes('### Decisions'), 'Should include Decisions section').toBeTruthy();
    expect(!result!.includes('## Context'), 'Should NOT include Context section').toBeTruthy();
    expect(!result!.includes('Detailed context here'), 'Should NOT include context content').toBeTruthy();
  });

  it('should return null for handoff without Ledger section', () => {
    const handoffContent = `# Work Stream: test-session

## Context
This handoff has no Ledger section.
Just context directly.

## What Was Done
- Some work
`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should return null when no Ledger section exists').toBe(null);
  });

  it('should return null for empty file', () => {
    const handoffContent = '';

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should return null for empty content').toBe(null);
  });

  it('should handle Ledger section at end of file (no --- separator)', () => {
    const handoffContent = `# Work Stream: test-session

## Ledger
**Updated:** 2025-12-30T00:00:00Z
**Goal:** Test edge case
**Branch:** feature/test

### Now
[->] Current task

### Next
- [ ] Future task`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should not return null when Ledger is at end of file').not.toBe(null);
    expect(result!.startsWith('## Ledger'), 'Result should start with "## Ledger"').toBeTruthy();
    expect(result!.includes('**Goal:** Test edge case'), 'Should include Goal field').toBeTruthy();
    expect(result!.includes('### Now'), 'Should include Now section').toBeTruthy();
    expect(result!.includes('### Next'), 'Should include Next section').toBeTruthy();
    expect(result!.includes('Future task'), 'Should include the last item').toBeTruthy();
  });

  it('should handle multiple ## headings after Ledger - stops at first ---', () => {
    const handoffContent = `# Work Stream: test-session

## Ledger
**Updated:** 2025-12-30T00:00:00Z
**Goal:** Multiple headings test
**Branch:** main

### Now
[->] Current focus

### Decisions
- Key decision

---

## Context
Context section.

## What Was Done
Work section.

## Blockers
Blockers section.
`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should not return null').not.toBe(null);
    expect(result!.startsWith('## Ledger'), 'Result should start with "## Ledger"').toBeTruthy();
    expect(result!.includes('### Decisions'), 'Should include Decisions (before separator)').toBeTruthy();
    expect(!result!.includes('## Context'), 'Should NOT include Context (after separator)').toBeTruthy();
    expect(!result!.includes('## What Was Done'), 'Should NOT include What Was Done').toBeTruthy();
    expect(!result!.includes('## Blockers'), 'Should NOT include Blockers').toBeTruthy();
  });

  it('should handle Ledger with no --- but next ## heading', () => {
    // Edge case: No --- separator, but there's a ## heading that ends the Ledger
    const handoffContent = `# Work Stream: test-session

## Ledger
**Updated:** 2025-12-30T00:00:00Z
**Goal:** No separator test

### Now
[->] Working

## Context
This is after Ledger, should not be included.
`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should not return null').not.toBe(null);
    expect(result!.includes('**Goal:** No separator test'), 'Should include Goal').toBeTruthy();
    expect(result!.includes('### Now'), 'Should include Now').toBeTruthy();
    expect(!result!.includes('## Context'), 'Should stop at ## Context heading').toBeTruthy();
  });

  it('should trim whitespace from extracted content', () => {
    const handoffContent = `# Work Stream: test-session

## Ledger

**Updated:** 2025-12-30T00:00:00Z


### Now
[->] Task


---

## Context
`;

    const result = extractLedgerSection(handoffContent);

    expect(result, 'Should not return null').not.toBe(null);
    // The result should be trimmed (no leading/trailing whitespace in content)
    expect(!result!.endsWith('\n\n\n'), 'Should not end with multiple newlines').toBeTruthy();
  });
});
