import { expect, test } from '@playwright/test';

import { chipWord } from '../src/components/fleet/format';

/**
 * The glossary words for the chip codes (.claudedocs/2026-10-29-os-pane-glossary.md). The raw
 * code stays the data (`data-chip`, the API); only the label changes.
 */

test.describe('chipWord', () => {
  test('a code the map does not know comes back as it is', () => {
    expect(chipWord('paused')).toBe('paused');
    expect(chipWord('')).toBe('');
  });

  test('a code that names an inherited object member is not looked up on the prototype', () => {
    expect(chipWord('toString')).toBe('toString');
    expect(chipWord('constructor')).toBe('constructor');
  });
});
