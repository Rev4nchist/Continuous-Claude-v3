import { describe, expect, test } from 'claude-code/testing'
import { PAID_SENT_MAX, SENT_MAX, capSent } from '../hooks/pr-loop/model'

// capSent (card prflow-paid-guard-leftovers, L3, CLI run 2 pr-loop/model.ts 104): the sent-key ledger is bounded per class, also when one key repeats.
// How the unit can fail, and the test that catches it:
//   41 copies of one ordinary key, or 201 of one paid key, stay (the final filter keeps every copy of a kept key)      -> CS1, CS2
//   unique keys lose the newest-first order or the class quota                                                           -> CS3
//   one class pushes the other out                                                                                       -> CS4
//   a repeated key keeps its OLD place instead of its newest one                                                         -> CS5

const ordinary = (n: number): string[] => Array.from({ length: n }, (_, i) => `other ${i}`)
const paid = (n: number): string[] => Array.from({ length: n }, (_, i) => `paid:7:${'a'.repeat(40)}:${i + 1}`)

describe('capSent bounds the ledger when keys repeat', () => {
  test('CS1 41 copies of one ordinary key leave at most 40 entries', () => {
    const out = capSent(Array.from({ length: SENT_MAX + 1 }, () => 'same'))
    expect(out.length).toBeLessThanOrEqual(SENT_MAX)
    expect(out).toContain('same')
  })

  test('CS2 201 copies of one paid key leave at most 200 entries', () => {
    const key = paid(1)[0]!
    const out = capSent(Array.from({ length: PAID_SENT_MAX + 1 }, () => key))
    expect(out.length).toBeLessThanOrEqual(PAID_SENT_MAX)
    expect(out).toContain(key)
  })

  test('CS3 unique keys keep today\'s result: the newest 40 ordinary and the newest 200 paid, in their order', () => {
    const o = ordinary(60)
    const p = paid(250)
    const out = capSent([...o.slice(0, 30), ...p.slice(0, 125), ...o.slice(30), ...p.slice(125)])
    expect(out.filter(key => !key.startsWith('paid:'))).toEqual(o.slice(20))
    expect(out.filter(key => key.startsWith('paid:'))).toEqual(p.slice(50))
  })

  test('CS4 repeated ordinary keys do not push a paid key out, and the other way round', () => {
    const key = paid(1)[0]!
    const out = capSent([key, ...Array.from({ length: 100 }, () => 'same'), ...ordinary(10)])
    expect(out).toContain(key)
    const out2 = capSent(['same', ...Array.from({ length: 300 }, () => key)])
    expect(out2).toContain('same')
    expect(out2.filter(one => one === key).length).toBeLessThanOrEqual(PAID_SENT_MAX)
  })

  test('CS5 a key that repeats is kept once, at its newest place', () => {
    const out = capSent(['a', 'b', 'a', 'c'])
    expect(out.filter(key => key === 'a').length).toBe(1)
    expect(out).toEqual(['b', 'a', 'c'])
  })
})
