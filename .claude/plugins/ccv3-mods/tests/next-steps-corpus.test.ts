import { describe, expect, test } from 'claude-code/testing'

import { parseTurnEnd } from '../hooks/agentic-os/brief'
import { CORPUS } from './fixtures/next-steps-corpus'

// Ways the Next steps parser can fail on a known input, one test per row of fixtures/next-steps-corpus.ts:
// a real ask is dropped (the chip leaves waiting-on-dave), a no-ask form becomes an ask (a chip that never clears),
// or the ask text loses the request. Break it: revert 6c91c6bf and R57 and R58 fail; revert 61f94d5 and R59a fails.
// Rows are data, so a new row needs no new test code. The guard test keeps the corpus from going empty or duplicate.

describe('Next steps corpus', () => {
  test('the corpus is not empty and every id is unique', () => {
    expect(CORPUS.length).toBeGreaterThan(0)
    const ids = CORPUS.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const row of CORPUS) {
    test(`corpus ${row.id} ${row.source}`, () => {
      const ask = parseTurnEnd(row.text).ask
      // undefined means the parser found no Next steps block at all: not the same as an empty list.
      expect(ask).toBeDefined()
      expect(ask).toHaveLength(row.asks.length)
      for (const [index, want] of row.asks.entries()) expect(ask?.[index]?.text).toContain(want)
    })
  }
})
