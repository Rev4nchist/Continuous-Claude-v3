/**
 * QW-06 Fix A (D3b-01) and memory phase 2 floor pins.
 *
 * History (Fix A): pre-fix, the hook floored on the DECAY-ADJUSTED score: a row whose
 * pre-decay base RRF was 0.0154 (above the then-floor 0.01) was suppressed once freshness
 * decay dropped its effective score to ~0.009. Fix A makes checkDbMemory carry the
 * pre-decay `base_score` into the floor in hybrid mode, so the row survives.
 *
 * Phase 2: the floors are no longer guesses. They come from the recall eval sweep and are
 * recorded in opc/tests/recall_eval_baseline.json (written only by
 * `eval_recall.py --write-baseline`). With RRF k=60 a single-arm hit scores at most
 * 1/61 = 0.01639, so a rank-5 single-arm hit (0.0154) is dropped ON PURPOSE. The measured
 * hybrid floor 0.03275 sits just under 2/61 = 0.03279: the row must be rank 1 in both the
 * text and the vector arm. (2,2) = 2/62 = 0.03226 does not pass.
 *
 * Failure list:
 *   H1  a floor constant drifts from the measured value in the baseline
 *   H2  the straddle at the floor breaks (floor kept, floor - 1e-4 dropped)
 *   H3  text-only goes back to the decayed score
 *
 * In-process import is safe because main()'s on-import auto-run is guarded by
 * `if (!process.env.VITEST)` (QW-06).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { applyFloor, mapDbResults, HYBRID_FLOOR, TEXT_ONLY_FLOOR } from '../memory-awareness.js';
import type { MemoryMatch } from '../memory-awareness.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BASELINE_PATH = resolve(HERE, '../../../../opc/tests/recall_eval_baseline.json');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as {
  floors: { hybrid: number; text: number };
};

/** A single-row MemoryMatch carrying `score` (the value applyFloor gates on). */
function matchWithScore(score: number): MemoryMatch {
  return {
    count: 1,
    results: [
      { id: 'abc12345', type: 'WORKING_SOLUTION', content: 'hybrid recall floor decay note', score },
    ],
    source: 'db',
  };
}

describe('memory phase 2: floors equal the measured baseline', () => {
  it('H1: HYBRID_FLOOR equals floors.hybrid in recall_eval_baseline.json', () => {
    expect(HYBRID_FLOOR).toBe(baseline.floors.hybrid);
  });

  it('H1: TEXT_ONLY_FLOOR equals floors.text in recall_eval_baseline.json', () => {
    expect(TEXT_ONLY_FLOOR).toBe(baseline.floors.text);
  });
});

describe('QW-06 Fix A: hybrid floor on pre-decay base RRF', () => {
  it('H2: KEEPS a row exactly at HYBRID_FLOOR', () => {
    const out = applyFloor(matchWithScore(HYBRID_FLOOR), HYBRID_FLOOR);
    expect(out).not.toBeNull();
    expect(out!.results).toHaveLength(1);
    expect(out!.results[0].score).toBeCloseTo(HYBRID_FLOOR);
  });

  it('H2: DROPS a row just below HYBRID_FLOOR', () => {
    expect(applyFloor(matchWithScore(HYBRID_FLOOR - 1e-4), HYBRID_FLOOR)).toBeNull();
  });

  it('H2: the pair straddles the floor (the original Fix A shape)', () => {
    expect(applyFloor(matchWithScore(HYBRID_FLOOR), HYBRID_FLOOR)).not.toBeNull();
    expect(applyFloor(matchWithScore(HYBRID_FLOOR - 1e-4), HYBRID_FLOOR)).toBeNull();
  });
});

describe('mapDbResults: the floor reads the pre-decay base_score in both modes', () => {
  const raw = [{ id: 'abcdef123456', content: 'x', base_score: 0.03, score: 0.015 }];

  it('H3: text-only mode scores on base_score, not the decayed score', () => {
    expect(mapDbResults(raw, false)[0].score).toBe(0.03);
  });

  it('H3: hybrid mode scores on base_score too', () => {
    expect(mapDbResults(raw, true)[0].score).toBe(0.03);
  });

  it('falls back to score when base_score is absent', () => {
    expect(mapDbResults([{ id: 'abcdef123456', content: 'x', score: 0.07 }], false)[0].score).toBe(0.07);
  });
});
