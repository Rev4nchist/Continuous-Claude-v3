import { describe, expect, test } from 'claude-code/testing'
import { readFileSync } from 'node:fs'
import { isDocAppend } from '../hooks/pr-checkpoint/model'

// The queue guard's copy of the DOC APPEND test (lane coord-guard-text-false-refusal, seat ruling 2026-11-23 12:48 CST, condition 5).
// The hook copy (shared/inert-quotes.ts in .claude/hooks) reads the same row table in src/__tests__/doc-append-drift.test.ts.
// A row where this copy differs from the table fails here; a row where the hook copy differs fails there.
const ROWS = JSON.parse(readFileSync(new URL('./fixtures/doc-append-rows.json', import.meta.url), 'utf8')) as Array<{ want: boolean; segment: string }>

describe('DOC APPEND: the queue copy gives the verdict of the shared row table', () => {
  test('the row table is not empty and holds both verdicts', () => {
    expect(ROWS.length).toBeGreaterThan(40)
    expect(ROWS.some(r => r.want)).toBe(true)
    expect(ROWS.some(r => !r.want)).toBe(true)
  })
  test('every row gets its verdict', () => {
    const wrong = ROWS.filter(r => isDocAppend(r.segment) !== r.want).map(r => `${r.want ? 'should accept' : 'should refuse'}: ${r.segment}`)
    expect(wrong).toEqual([])
  })
})
