/**
 * Fleet cost label: how the session detail "agents" line words a run sum.
 *
 * The code is `costLabel` in apps/agentic-os/src/components/fleet/format.ts. That file is pure (no
 * `server-only`), so this runner can load it by URL, as fleet-level1-fields.test.ts does.
 * It follows the ledger pane rule `usdText` (agent-ledger/model.ts), with words in place of the glyphs.
 *
 * The parser path (`hasUnknownModelCost`, `advised` in state-files.ts) imports `server-only`, so only
 * apps/agentic-os/e2e/cost-labels.spec.ts reaches it.
 *
 * Each case names the change that breaks it:
 *   1  a run sum of 0 that reads "$0.00" when every run is unpriced
 *   2  a missing "+ N unpriced" suffix, or the count left out
 *   3  a floor with no "at least" prefix
 *   4  the prefix and the suffix not joined
 *   5  the "unpriced" shortcut applied to a floor: "at least $0.00" must stay visible
 *   6  a change to the plain text of a priced sum
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type CostLabelInput = { usd: number; unpriced: number; floor: boolean };
type CostFormat = {
  costLabel: (input: CostLabelInput) => string;
  formatUsd: (n: number) => string;
};

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const g: CostFormat = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/components/fleet/format.ts')
);

describe('costLabel', () => {
  it('reads "unpriced", never "$0.00", when every run is unpriced', () => {
    expect(g.costLabel({ usd: 0, unpriced: 2, floor: false })).toBe('unpriced');
  });

  it('adds the unpriced count to a partly priced sum', () => {
    expect(g.costLabel({ usd: 1.5, unpriced: 1, floor: false })).toBe('$1.50 + 1 unpriced');
  });

  it('prefixes "at least" on a floor', () => {
    expect(g.costLabel({ usd: 1.5, unpriced: 0, floor: true })).toBe('at least $1.50');
  });

  it('joins the floor prefix and the unpriced suffix', () => {
    expect(g.costLabel({ usd: 1.5, unpriced: 2, floor: true })).toBe('at least $1.50 + 2 unpriced');
  });

  it('floor at $0 reads at least $0.00, not "unpriced"', () => {
    expect(g.costLabel({ usd: 0, unpriced: 1, floor: true })).toBe('at least $0.00 + 1 unpriced');
  });

  it('keeps the old text for a priced sum with no floor', () => {
    expect(g.costLabel({ usd: 1.5, unpriced: 0, floor: false })).toBe('$1.50');
    expect(g.formatUsd(1.5)).toBe('$1.50');
  });
});
