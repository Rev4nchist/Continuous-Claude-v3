import { describe, expect, test } from 'claude-code/testing'

import { coldCost, estimate, fmtUsd, warmCost } from '../hooks/shared/price'
import { driftOf, parseAgentSpec, tierOf } from '../hooks/shared/tiers'
import { barSvg, ringSvg } from '../hooks/shared/glyphs'
import { diffLines, hunksOf } from '../hooks/shared/diff'

const near = (got: number | null, want: number): boolean => got !== null && Math.abs(got - want) < 1e-9

// Ways the shared helpers can fail, one test each.
// S1 a dated or prefixed model id maps to the wrong tier (or Mythos is not Fable)
// S2 the frontmatter parser misses model/effort, or reads them from the body
// S3 a run that matches its spec is flagged, or a Haiku run is not
// S4 an effort or tier mismatch goes unflagged
// S5 the estimate ignores cache reads/writes or prices an unknown model
// S6 the cold send is priced at the read rate (or the warm one at the write rate)
// S7 an Svg ring/bar is malformed or overflows at 0 and 100 percent
// S8 a patch is read wrong: numbering, added/removed counts, the cut line, or a result with no patch

describe('shared tiers', () => {
  test('S1 model ids map to tiers', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('anthropic.claude-sonnet-5-5')).toBe('sonnet')
    expect(tierOf('claude-mythos-5-1')).toBe('fable')
    expect(tierOf('claude-fable-5-1')).toBe('fable')
    expect(tierOf('claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('gpt-x')).toBe('other')
  })

  test('S2 frontmatter is read only from the header block', () => {
    const md = '---\nname: spark\nmodel: sonnet\neffort: high\n---\n\nmodel: opus in the body\n'
    expect(parseAgentSpec(md)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(parseAgentSpec('no frontmatter\nmodel: opus')).toEqual({})
    expect(parseAgentSpec('---\nmodel: inherit\neffort: high\n---\n')).toEqual({ effort: 'high' })
  })

  test('S3 S4 drift flags mismatches and Haiku, never a match', () => {
    const spec = { model: 'sonnet', effort: 'high' }
    expect(driftOf(spec, { model: 'claude-sonnet-5-5', effort: 'high' })).toBeNull()
    expect(driftOf(spec, { model: 'claude-opus-5-5', effort: 'medium' })).toBe('expected Sonnet · high')
    expect(driftOf(spec, { model: 'claude-sonnet-5-5', effort: 'medium' })).toBe('expected Sonnet · high')
    expect(driftOf({}, { model: 'claude-haiku-5-5' })).toBe('Haiku is banned')
    expect(driftOf({}, { model: 'claude-opus-5-5', effort: 'low' })).toBeNull()
  })
})

describe('shared price', () => {
  test('S5 estimate counts every usage field, null for unknown models', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
    // opus: 4 in + 20 out + 0.20 read + 5 write (1.25 × 4)
    expect(near(estimate(usage, 'claude-opus-5-5'), 29.2)).toBe(true)
    expect(near(estimate({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-sonnet-5-5'), 10)).toBe(true)
    expect(estimate(usage, 'gpt-x')).toBeNull()
  })

  test('S6 cold send prices a cache write, warm send a cache read', () => {
    expect(near(coldCost(330_000, 'claude-opus-5-5'), 1.65)).toBe(true)
    expect(near(coldCost(330_000, 'claude-opus-5-5', true), 2.64)).toBe(true)
    expect(near(warmCost(330_000, 'claude-opus-5-5'), 0.066)).toBe(true)
    expect(near(warmCost(330_000, 'claude-fable-5-1'), 0.0825)).toBe(true)
    expect(fmtUsd(0.0412)).toBe('$0.04')
    expect(fmtUsd(12.4)).toBe('$12.40')
  })
})

describe('shared diff', () => {
  test('S8 diff numbering, counts and the cut line; no patch means null', () => {
    const patch = { structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }] }
    const hunks = hunksOf(patch)
    expect(hunks).not.toBeNull()
    const { lines, added, removed } = diffLines(hunks ?? [], 3)
    expect([added, removed]).toEqual([2, 1])
    expect(lines.map(line => line.number)).toEqual(['10', '11', '11', ''])
    expect(lines.at(-1)?.spans[0]?.text).toBe('… 1 more lines')
    expect(hunksOf({ structuredPatch: [] })).toBeNull()
    expect(hunksOf('no patch')).toBeNull()
  })
})

describe('shared glyphs', () => {
  test('S7 ring and bar are one svg each and clamp their fill', () => {
    for (const pct of [-5, 0, 42, 100, 140]) {
      const ring = ringSvg(pct, '#D97757', '#38352F')
      expect(ring.startsWith('<svg')).toBe(true)
      expect(ring.match(/<svg/g)?.length).toBe(1)
      const bar = barSvg(pct / 100, '#5FB37E', '#38352F')
      expect(bar).toContain(`width="${Math.round(Math.min(1, Math.max(0, pct / 100)) * 56)}"`)
    }
  })
})
