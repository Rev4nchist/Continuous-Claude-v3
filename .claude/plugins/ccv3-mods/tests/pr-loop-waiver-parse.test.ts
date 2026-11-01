import { describe, expect, test } from 'claude-code/testing'

import { isWaived } from '../hooks/pr-loop/model'

// isWaived reads what `gh pr view N --json author,comments` prints. It must fail closed: any doubt is "not waived", never a throw.
// P1 the PR author's comment that starts "Review waived by Dave" waives
// P2 a comment from another account does not
// P3 the phrase must start the body (leading blank space allowed); a body that only contains it does not
// P4 logins compare without case (GitHub logins do)
// P5 anything that is not that shape is not a waiver and does not throw: [] , null, no comments, a comment with no author or body
// P6 one waiver among many comments is enough

const comment = (login: string | null, body: unknown) => ({ author: login === null ? null : { login }, body })
const pr = (comments: unknown[], author: unknown = { login: 'Rev4nchist' }) => ({ author, comments })

describe('isWaived', () => {
  test('P1 the author waives', () => {
    expect(isWaived(pr([comment('Rev4nchist', 'Review waived by Dave: small change')]))).toBe(true)
  })
  test('P2 another account does not', () => {
    expect(isWaived(pr([comment('coderabbitai', 'Review waived by Dave')]))).toBe(false)
  })
  test('P3 the phrase starts the body', () => {
    expect(isWaived(pr([comment('Rev4nchist', '\n  Review waived by Dave')]))).toBe(true)
    expect(isWaived(pr([comment('Rev4nchist', 'Was the Review waived by Dave?')]))).toBe(false)
    expect(isWaived(pr([comment('Rev4nchist', 'review waived by dave')]))).toBe(false)
  })
  test('P4 logins compare without case', () => {
    expect(isWaived(pr([comment('rev4nchist', 'Review waived by Dave')]))).toBe(true)
  })
  test('P5 a wrong shape is no waiver and never throws', () => {
    for (const value of [[], null, undefined, 'x', 7, {}, { author: null, comments: [] }, pr([]), pr([null, 5, comment(null, 'Review waived by Dave')]), pr([comment('Rev4nchist', 42)]), pr([comment('Rev4nchist', 'Review waived by Dave')], null), { author: { login: 'Rev4nchist' }, comments: 'x' }]) {
      expect(isWaived(value)).toBe(false)
    }
  })
  test('P6 one waiver among many comments is enough', () => {
    expect(isWaived(pr([comment('Rev4nchist', 'hi'), comment('greptile-apps', 'summary'), comment('Rev4nchist', 'Review waived by Dave')]))).toBe(true)
  })
})
