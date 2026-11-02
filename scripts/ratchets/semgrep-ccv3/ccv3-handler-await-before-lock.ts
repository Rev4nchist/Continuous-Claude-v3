// Semgrep test fixture. This code is wrong on purpose: it is the shape that rule
// ccv3-handler-await-before-lock must flag, next to the shape it must accept.
// Each annotation sits on the line above the matched line.
declare const on: any
declare const isOff: (x: any) => Promise<boolean>
declare const shellLock: (x: any, e: any, shell: string) => Promise<{ deny: string } | null>
declare const LOCK_FAILED: string

export const register = () => {
  // Bad: the off switch is read in the handler, outside any try. A throw goes to .catch.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    // ruleid: ccv3-handler-await-before-lock
    if (await isOff($)) return next(e)
    return (await shellLock($, e, 'bash')) ?? next(e)
  }).catch(($: any, e: any, next: any) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  // Good: the handler only calls the lock function; the check is inside its try.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => (await shellLock($, e, 'bash')) ?? next(e)).catch(
    ($: any, e: any, next: any) => (next.called ? next(e) : { deny: LOCK_FAILED }),
  )

  // Good: the await is inside a try that answers the failure.
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    try {
      // ok: ccv3-handler-await-before-lock
      if (await isOff($)) return next(e)
    } catch {
      return { deny: LOCK_FAILED }
    }
    return next(e)
  }).catch(($: any, e: any, next: any) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  // Good: an observer. Its .catch only calls next, so no deny can be dropped.
  on('tool.call', { tool: 'brief_set' }, async ($: any, e: any, next: any) => {
    // ok: ccv3-handler-await-before-lock
    if (await isOff($)) return next(e)
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))
}
