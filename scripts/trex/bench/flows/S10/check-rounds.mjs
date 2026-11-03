import { register } from 'node:module'
await register('./ts-hook.mjs', import.meta.url)
const rs = await import(new URL('../../../../github/review-status.mjs', import.meta.url))
const loop = await import(new URL('../../../../../.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts', import.meta.url))
const die = (m) => { console.error(m); process.exit(1) }
const HEAD = 'a'.repeat(40)
const bot = { login: 'coderabbitai[bot]', type: 'Bot' }
const person = { login: 'dave', type: 'User' }
const pull = { number: 7, draft: false, merged: false, state: 'open', body: '', mergeable_state: 'clean', user: person, labels: [{ name: 'review:coderabbit' }], head: { sha: HEAD, ref: 'fix' } }
const ev = (reviews, comments) => rs.evaluate({ pull, combined: { statuses: [] }, checkRuns: [], threads: [], reviews, comments, commits: [], proofGate: false })
const bought = ev([{ user: bot, commit_id: HEAD, submitted_at: '2026-10-28T10:00:00Z', body: 'Reviewed.' }, { user: bot, commit_id: HEAD, body: '' }], [{ user: person, body: '@coderabbitai review', created_at: '2026-10-28T11:00:00Z' }])
if (bought.coderabbitReviews !== 1 || bought.coderabbitRounds !== 2) die(`count ${bought.coderabbitReviews} ${bought.coderabbitRounds}`)
const req = ev([], [{ user: person, body: '@coderabbitai review', created_at: '2026-10-28T11:00:00Z' }])
if (req.coderabbitReviews !== 0 || req.coderabbitRounds !== 1) die('request counted')
if (ev([{ user: bot, commit_id: HEAD, body: '  ' }], []).coderabbitReviews !== 0) die('blank')
if (rs.coderabbitFinishedOf({ reviews: [{ user: bot, commit_id: HEAD, body: 'a' }, { user: bot, commit_id: HEAD, body: 'b' }] }) !== 1) die('dup')
if (rs.coderabbitFinishedOf({ reviews: [{ user: person, commit_id: HEAD, body: 'a' }] }) !== 0) die('human')
const base = { pr: 7, head: HEAD, headShort: 'aaaaaaa', branch: 'fix', ready: false, mergeable_state: 'blocked', reviewedHead: false, unresolved: 0, rateLimited: false, prState: 'open', merged: false, coderabbitReviewedHead: false, routedReviewed: false, routing: { required: ['coderabbit'], held: null, source: 'labels' } }
const record = { pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', budget: [1, 0], decided_by: 'dave', session: 's' }
const watch = { pr: 7, head: HEAD, state: 'PENDING', since: 1, whenReady: false }
const now = 10_000_000
const lineOf = (status, rec = record) => loop.reportLine(loop.settle(watch, status, now, loop.checkpointOf(rec, status, null)).alert)
const rate = 'CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)'
const limited = { ...base, reasons: [rate], coderabbitLimited: true, coderabbitRateLimited: true, coderabbitRetryMinutes: 40, coderabbitRounds: bought.coderabbitRounds, coderabbitReviews: bought.coderabbitReviews }
const limitedLine = lineOf(limited)
if (!limitedLine.includes('Rounds used 1 of 1+0') || !limitedLine.includes('Dave decides round 2') || /round 3/.test(limitedLine)) die(limitedLine)
const skipped = { ...limited, coderabbitRateLimited: false, coderabbitRetryMinutes: null, reasons: ['CodeRabbit skipped the review of the head (PR-bot review did not run; CLI/plugin output does not count)'] }
const ask = loop.askFor(record, skipped, now, null)
if (ask?.kind !== 'round' || !ask.text.includes('Round 2 of 1+0')) die(ask?.text ?? 'no ask')
const zeroN = ev([], [])
const carry = 'no CodeRabbit PR-bot review of the head commit; the earlier review carries once the PR body has a clean CLI fix review line'
const zeroLine = lineOf({ ...limited, reasons: [rate, carry], coderabbitRounds: zeroN.coderabbitRounds, coderabbitReviews: zeroN.coderabbitReviews })
if (!/opening review/.test(zeroLine) || /cr-fix\.mjs|earlier review|\bcarries\b/.test(zeroLine)) die(zeroLine)
const flight = lineOf({ ...base, reasons: ['1 review thread(s) unresolved'], unresolved: 1, coderabbitReviewedHead: true, routedReviewed: true, coderabbitRounds: 2, coderabbitReviews: 1 }, { ...record, budget: [1, 1] })
if (!flight.includes('Rounds used 2 of 1+1')) die(flight)
const proof = { ...base, reasons: ['PR body proof: GREEN names commit 1111111, not the head aaaaaaa'] }
const palert = loop.settle(watch, proof, now, null).alert
if (!palert || loop.refreshAlert(palert, { ...proof, merged: true, prState: 'closed' }, null) || loop.refreshAlert(palert, { ...proof, head: 'b'.repeat(40) }, null) || loop.refreshAlert(palert, { ...proof, reasons: [] }, null)) die('stale kept')
const heldLine = loop.reportLine(loop.refreshAlert(palert, { ...proof, reasons: ['PR body proof: no "Proof type:" line'] }, null))
if (!heldLine.includes('no "Proof type:" line') || heldLine.includes('1111111')) die(heldLine)
const pending = { ...base, reasons: ['waiting'] }
const stalled = loop.settle({ ...watch, since: now - loop.STALL_MS }, pending, now, null).alert
if (stalled?.state !== 'STALLED' || !loop.refreshAlert(stalled, pending, null) || loop.refreshAlert(stalled, { ...pending, merged: true, prState: 'closed' }, null)) die('stall')
const keyOf = (extra) => loop.alertKey(loop.settle(watch, { ...limited, reasons: [rate, extra] }, now, loop.checkpointOf(record, limited, null)).alert)
if (keyOf('check "build" is in_progress/null') !== keyOf('status "ci" is pending')) die('ci key')
console.log('limited-round-1\nask-round-2\nopening-review\nflight-round-2\nstale-dropped\nstall-held\nci-key-stable')
