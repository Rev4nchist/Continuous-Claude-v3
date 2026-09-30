/**
 * WS-2 Phase B.3b -- emit REACHABILITY guard (mitigation #1; the dynamic second
 * layer beside scripts/audit-braintrust-emits.sh).
 *
 * memory-awareness.ts is the historical emit-regression victim: the `await` on
 * emitBraintrustScore has been silently dropped by whole-file regens before. The
 * bash audit asserts the awaited call-site EXISTS; this vitest asserts its
 * POSITION -- exactly one awaited emit, it sits AFTER the recall, and all four
 * early guards are positioned BEFORE it (so a guard's early return is exempt:
 * "every path that performs a recall emits exactly once").
 *
 * These are SOURCE-STRUCTURE assertions (no main() execution). Driving main()
 * in-process would require exporting it + guarding the on-import auto-run +
 * mocking the python-spawning recall internals -- a refactor of the delicate file
 * riskier than the regression it guards (the same Q-B1 calculus the plan used to
 * reject the finally-refactor). This static check + the bash guard + the surgical/
 * solo edit discipline are the defense-in-depth for the emit invariant.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'memory-awareness.ts');
const src = readFileSync(SRC, 'utf-8');

describe('memory-awareness emit reachability (mitigation #1)', () => {
  it('has EXACTLY ONE awaited emitBraintrustScore call (no drop, no duplicate)', () => {
    const matches = src.match(/await emitBraintrustScore\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('emits AFTER the recall result is computed, not before', () => {
    const recallIdx = src.indexOf('const match = applyFloor(');
    const emitIdx = src.indexOf('await emitBraintrustScore(');
    expect(recallIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(recallIdx);
  });

  it('positions all four early guards BEFORE the emit (guards return -> exempt)', () => {
    const emitIdx = src.indexOf('await emitBraintrustScore(');
    expect(emitIdx).toBeGreaterThan(-1);
    for (const guard of [
      'process.env.CLAUDE_AGENT_ID',
      'input.prompt.length < 15',
      "input.prompt.trim().startsWith('/')",
      'intent.length < 3',
    ]) {
      const idx = src.indexOf(guard);
      expect(idx, `guard "${guard}" must exist`).toBeGreaterThan(-1);
      expect(idx, `guard "${guard}" must be before the emit`).toBeLessThan(emitIdx);
    }
  });

  it('keeps the emit fail-open (wrapped in a nearby try/catch)', () => {
    const emitIdx = src.indexOf('await emitBraintrustScore(');
    const tryIdx = src.lastIndexOf('try {', emitIdx); // closest try BEFORE the emit
    const catchIdx = src.indexOf('catch', emitIdx); // first catch AFTER the emit
    expect(tryIdx).toBeGreaterThan(-1);
    // The try opens just above the emit (a few lines), not somewhere unrelated.
    expect(emitIdx - tryIdx).toBeLessThan(300);
    // ...and a catch closes it shortly after the emit -> the POST is fail-open.
    expect(catchIdx).toBeGreaterThan(emitIdx);
    expect(catchIdx - emitIdx).toBeLessThan(1000);
  });
});
