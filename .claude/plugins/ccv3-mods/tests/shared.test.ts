import { describe, expect, test } from 'claude-code/testing'

import { advisorCost, cacheSaving, coldCost, estimate, fmtUsd, normalizeModelId, warmCost } from '../hooks/shared/price'
import { PRICES } from '../hooks/shared/prices.generated'
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
// S9 Sonnet 5.5 cache hits are priced at the Sonnet 4.6 rate (0.20), not 0.10
// S10 a 1-hour write is priced at the 5-minute rate
// S11 the part of cache_creation_input_tokens that 5m + 1h leave out is dropped or priced at 1h
// S12 Haiku 5.5 has one rate: a prompt of 100,000 pays low, 100,001 pays high, and cache tokens count in the prompt
// S13 Fable 5 and Mythos 5 are priced like 5.1 (hit 0.25), or Opus 5 like Opus 5.5
// S14 web search requests are not priced, or at the wrong rate
// S15 an advisor iteration is priced at the outer model, or is counted in the main estimate
// S16 fast mode is ignored, or priced at one rate for every Opus
// S17 a provider prefix, a date suffix or [1m] makes a known model unknown
// S18 an unknown id gets a price (a tier guess), or <synthetic> gets null instead of 0
// S19 the US geo multiplier is missing, or hits a model before 4.6
// S20 a cache saving or a cold cost ignores the 1h/5m split or the Haiku tier
// S21 the table loses an id: every id of prices.json prices, retired rows too
// S22 a negative token count lowers a price or a sum, or coldCost/warmCost go negative
// S23 'constructor', '__proto__' or another Object.prototype name prices as a model id

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

const M = 1_000_000
const tokens = (over: Record<string, unknown>) => ({ input_tokens: 0, output_tokens: 0, ...over })

describe('shared price, exact model id', () => {
  test('S9 Sonnet 5.5 cache read is 0.10, Sonnet 5 is 0.20', () => {
    expect(near(estimate(tokens({ cache_read_input_tokens: M }), 'claude-sonnet-5-5'), 0.1)).toBe(true)
    expect(near(estimate(tokens({ cache_read_input_tokens: M }), 'claude-sonnet-5'), 0.2)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: M, output_tokens: M }), 'claude-sonnet-5'), 12)).toBe(true)
  })

  test('S10 a 1-hour write costs the 1h rate, a 5-minute write the 5m rate', () => {
    const one = tokens({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } })
    const five = tokens({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } })
    expect(near(estimate(one, 'claude-opus-5-5'), 8)).toBe(true)
    expect(near(estimate(five, 'claude-opus-5-5'), 5)).toBe(true)
    expect(near(estimate(one, 'claude-opus-5'), 10)).toBe(true)
    expect(near(estimate(one, 'claude-fable-5-1'), 20)).toBe(true)
  })

  test('S11 the remainder of the write total is priced at 5m, once', () => {
    // 1M written; 600k is 1h and 0 is 5m, so 400k is the remainder: 400k x 2.50 + 600k x 4 = 3.40 (the old rule gave 2.50).
    const split = tokens({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600_000 } })
    expect(near(estimate(split, 'claude-sonnet-5-5'), 3.4)).toBe(true)
    // No split at all: the whole write is 5m.
    expect(near(estimate(tokens({ cache_creation_input_tokens: M }), 'claude-sonnet-5-5'), 2.5)).toBe(true)
    // A split larger than the total leaves no negative remainder.
    const over = tokens({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } })
    expect(near(estimate(over, 'claude-sonnet-5-5'), 2.5)).toBe(true)
  })

  test('S12 Haiku 5.5: prompt 100,000 is low, 100,001 is high; reads and writes count in the prompt', () => {
    expect(near(estimate(tokens({ input_tokens: 100_000 }), 'claude-haiku-5-5'), 0.01)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: 100_001 }), 'claude-haiku-5-5'), (100_001 * 0.5) / M)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: 50_000, cache_read_input_tokens: 50_000 }), 'claude-haiku-5-5'), 0.005 + 0.0005)).toBe(true)
    // 50,000 uncached + 50,001 read is a prompt of 100,001: the input pays 0.50, the read 0.05.
    expect(near(estimate(tokens({ input_tokens: 50_000, cache_read_input_tokens: 50_001 }), 'claude-haiku-5-5'), 0.025 + (50_001 * 0.05) / M)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: 50_000, cache_creation_input_tokens: 50_001 }), 'claude-haiku-5-5'), 0.025 + (50_001 * 0.625) / M)).toBe(true)
    // Haiku 4.5 has one rate at any size.
    expect(near(estimate(tokens({ input_tokens: 200_000 }), 'claude-haiku-4-5'), 0.2)).toBe(true)
  })

  test('S13 Fable 5 / 5.1, Mythos 5 / 5.1 and Opus 5 / 5.5 are separate rows', () => {
    const hit = (id: string) => estimate(tokens({ cache_read_input_tokens: M }), id)
    expect(near(hit('claude-fable-5-1'), 0.25)).toBe(true)
    expect(near(hit('claude-fable-5'), 1)).toBe(true)
    expect(near(hit('claude-mythos-5-1'), 0.25)).toBe(true)
    expect(near(hit('claude-mythos-5'), 1)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: M, output_tokens: M }), 'claude-opus-5'), 30)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: M, output_tokens: M }), 'claude-opus-5-5'), 24)).toBe(true)
    expect(near(hit('claude-opus-5'), 0.5)).toBe(true)
    expect(near(hit('claude-opus-5-5'), 0.2)).toBe(true)
  })

  test('S14 a web search costs $0.01', () => {
    expect(near(estimate(tokens({ server_tool_use: { web_search_requests: 100 } }), 'claude-haiku-5-5'), 1)).toBe(true)
    expect(near(estimate(tokens({ output_tokens: M, server_tool_use: { web_search_requests: 3 } }), 'claude-sonnet-5-5'), 10.03)).toBe(true)
    expect(near(estimate(tokens({ server_tool_use: null }), 'claude-sonnet-5-5'), 0)).toBe(true)
  })

  test('S15 an advisor iteration is priced at its own model, apart from the main estimate', () => {
    const usage = tokens({
      output_tokens: M,
      iterations: [
        { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 5, output_tokens: M },
        { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: M, output_tokens: M },
      ],
    })
    expect(near(advisorCost(usage), 60)).toBe(true)
    // The main estimate stays the top-level usage: the engine excludes the iterations from it.
    expect(near(estimate(usage, 'claude-sonnet-5-5'), 10)).toBe(true)
    expect(advisorCost(tokens({}))).toBe(0)
    expect(advisorCost(tokens({ iterations: 'junk' }))).toBe(0)
    // An advisor on an id with no price adds nothing and does not throw.
    expect(advisorCost(tokens({ iterations: [{ type: 'advisor_message', model: 'gpt-x', input_tokens: M, output_tokens: M }] }))).toBe(0)
  })

  test('S16 fast mode: Opus 5.5 8/40, Opus 4.8 and Opus 5 10/50; cache multipliers stack on top', () => {
    const io = tokens({ input_tokens: M, output_tokens: M, speed: 'fast' })
    expect(near(estimate(io, 'claude-opus-5-5'), 48)).toBe(true)
    expect(near(estimate(io, 'claude-opus-4-8'), 60)).toBe(true)
    expect(near(estimate(io, 'claude-opus-5'), 60)).toBe(true)
    expect(near(estimate({ ...io, speed: 'standard' }, 'claude-opus-5-5'), 24)).toBe(true)
    // write 8 x 1.25 = 10, read 8 x 0.05 = 0.40
    expect(near(estimate(tokens({ cache_read_input_tokens: M, cache_creation_input_tokens: M, speed: 'fast' }), 'claude-opus-5-5'), 10.4)).toBe(true)
    // A model with no fast rates is priced at standard rates.
    expect(near(estimate(io, 'claude-sonnet-5-5'), 12)).toBe(true)
  })

  test('S17 a provider prefix, a date suffix and [1m] do not make a known id unknown', () => {
    const read = tokens({ cache_read_input_tokens: M })
    expect(near(estimate(read, 'anthropic.claude-sonnet-5-5'), 0.1)).toBe(true)
    expect(near(estimate(read, 'us.anthropic.claude-sonnet-5-5'), 0.1)).toBe(true)
    expect(near(estimate(read, 'vertex_ai/claude-sonnet-5-5'), 0.1)).toBe(true)
    expect(near(estimate(read, 'claude-sonnet-5-5[1m]'), 0.1)).toBe(true)
    expect(near(estimate(read, 'Claude-Opus-4-1-20250805'), 1.5)).toBe(true)
    expect(normalizeModelId('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    // Real cloud ids: Bedrock ends in -vN:M (after the date), Vertex joins the date with @.
    for (const id of ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5@20250929', 'vertex_ai/claude-sonnet-4-5@20250929']) {
      expect(normalizeModelId(id)).toBe('claude-sonnet-4-5')
      expect(near(estimate(read, id), 0.3)).toBe(true)
    }
    expect(normalizeModelId('us.anthropic.claude-opus-5-5-v2:1')).toBe('claude-opus-5-5')
    // A suffix that is not a version or a date still leaves the id unknown.
    expect(estimate(read, 'anthropic.claude-sonnet-4-5-20250929-v1:0-extra')).toBeNull()
    expect(estimate(read, 'claude-sonnet-4-5@latest')).toBeNull()
  })

  test('S18 an unknown id is null, never a guess; <synthetic> is 0', () => {
    const read = tokens({ cache_read_input_tokens: M })
    for (const id of ['gpt-x', 'opus', 'sonnet', 'claude-opus-9-9', 'claude-sonnet-5-5-extra', '']) expect(estimate(read, id)).toBeNull()
    expect(coldCost(1000, 'claude-opus-9-9')).toBeNull()
    expect(warmCost(1000, 'gpt-x')).toBeNull()
    expect(cacheSaving(read, 'gpt-x')).toBeNull()
    expect(estimate(tokens({ input_tokens: 5, output_tokens: 7 }), '<synthetic>')).toBe(0)
    expect(coldCost(1000, '<synthetic>')).toBe(0)
  })

  test('S19 US geo is 1.1x from 4.6 up and 1x before', () => {
    const geo = tokens({ input_tokens: M, output_tokens: M, inference_geo: 'us' })
    expect(near(estimate(geo, 'claude-sonnet-5-5'), 13.2)).toBe(true)
    expect(near(estimate(geo, 'claude-opus-4-6'), 33)).toBe(true)
    expect(near(estimate(geo, 'claude-opus-4-5'), 30)).toBe(true)
    expect(near(estimate({ ...geo, inference_geo: 'global' }, 'claude-sonnet-5-5'), 12)).toBe(true)
    // It stacks on the Haiku over-100K tier.
    expect(near(estimate(tokens({ input_tokens: 200_000, inference_geo: 'us' }), 'claude-haiku-5-5'), (200_000 * 0.5 * 1.1) / M)).toBe(true)
  })

  test('S20 cold cost, warm cost and cache saving follow the TTL split and the Haiku tier', () => {
    expect(near(coldCost(M, 'claude-sonnet-5-5'), 2.5)).toBe(true)
    expect(near(coldCost(M, 'claude-sonnet-5-5', true), 4)).toBe(true)
    expect(near(coldCost(M, 'claude-opus-5'), 6.25)).toBe(true)
    expect(near(warmCost(M, 'claude-sonnet-5-5'), 0.1)).toBe(true)
    expect(near(warmCost(M, 'claude-fable-5'), 1)).toBe(true)
    expect(near(coldCost(100_001, 'claude-haiku-5-5'), (100_001 * 0.625) / M)).toBe(true)
    expect(near(warmCost(100_000, 'claude-haiku-5-5'), 0.001)).toBe(true)
    // A read of 1M saves 4 - 0.20; a 1h write of 1M costs 8 - 4 more than the same tokens uncached.
    const split = tokens({ cache_read_input_tokens: M, cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } })
    expect(near(cacheSaving(split, 'claude-opus-5-5'), 3.8 - 4)).toBe(true)
    // No split: the oneHour flag chooses the write rate, as before.
    const flat = tokens({ cache_read_input_tokens: M, cache_creation_input_tokens: M })
    expect(near(cacheSaving(flat, 'claude-opus-5-5'), 3.8 - 1)).toBe(true)
    expect(near(cacheSaving(flat, 'claude-opus-5-5', true), 3.8 - 4)).toBe(true)
    expect(near(cacheSaving(tokens({ cache_read_input_tokens: M }), 'claude-sonnet-5-5'), 1.9)).toBe(true)
  })

  test('S21 every id of prices.json prices, retired rows too', () => {
    const ids = Object.keys(PRICES.models)
    expect(ids.length).toBe(19)
    const inputOf = PRICES.models as Record<string, { input: number }>
    // 100,000 input tokens is the top of Haiku 5.5's low tier, so every id pays its table input rate.
    for (const id of ids) expect(near(estimate(tokens({ input_tokens: 100_000 }), id), (inputOf[id]?.input ?? -1) / 10)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: M }), 'claude-opus-4-1'), 15)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: M }), 'claude-sonnet-4'), 3)).toBe(true)
  })

  test('S22 a negative token count clamps to 0: it never makes a price negative or lowers a sum', () => {
    const neg = tokens({ input_tokens: -M, output_tokens: M, cache_read_input_tokens: -5, cache_creation_input_tokens: -M, server_tool_use: { web_search_requests: -3 } })
    expect(near(estimate(neg, 'claude-sonnet-5-5'), 10)).toBe(true)
    expect(near(estimate(tokens({ input_tokens: -1 }), 'claude-opus-5-5'), 0)).toBe(true)
    // A negative part of the 5m/1h split is 0 too, so the remainder cannot grow past the real total.
    const split = tokens({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: -M, ephemeral_1h_input_tokens: 0 } })
    expect(near(estimate(split, 'claude-sonnet-5-5'), 2.5)).toBe(true)
    expect(coldCost(-1000, 'claude-opus-5-5')).toBe(0)
    expect(coldCost(-1000, 'claude-opus-5-5', true)).toBe(0)
    expect(warmCost(-1000, 'claude-opus-5-5')).toBe(0)
    expect(near(cacheSaving(tokens({ cache_read_input_tokens: -M }), 'claude-opus-5-5'), 0)).toBe(true)
    const iter = { type: 'advisor_message', model: 'claude-sonnet-5-5', input_tokens: -M, output_tokens: M }
    expect(near(advisorCost(tokens({ iterations: [iter] })), 10)).toBe(true)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(estimate(tokens({ output_tokens: bad }), 'claude-sonnet-5-5')).toBe(0)
      expect(coldCost(bad, 'claude-sonnet-5-5')).toBe(0)
    }
  })

  test('S23 Object.prototype names are not model ids: null, never a crash or a price', () => {
    const read = tokens({ cache_read_input_tokens: M })
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Constructor', 'anthropic.__proto__']) {
      expect(estimate(read, id)).toBeNull()
      expect(coldCost(1000, id)).toBeNull()
      expect(warmCost(1000, id)).toBeNull()
      expect(cacheSaving(read, id)).toBeNull()
      expect(advisorCost(tokens({ iterations: [{ type: 'advisor_message', model: id, input_tokens: M, output_tokens: 0 }] }))).toBe(0)
    }
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
