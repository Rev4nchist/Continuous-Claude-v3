// Tests for scripts/github/slot-queue-model.mjs (free-slot queue, pure model). Every test names the source change that breaks it.
// Run: node --test scripts/github/slot-queue-model.test.mjs
// No file, no process, no clock: every function gets `now` as an argument. Plan sec 5 ids (F3...) are in the titles.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULTS, closeDone, configOf, emptyState, expireHolder, moveHead, noteSeenPosts, orderItems, parseState,
  pickNext, promoteOpening, prune, rowsOf, settle, slotFree, tierOf, timers,
} from './slot-queue-model.mjs';

const NOW = Date.UTC(2026, 10, 2, 18, 0, 0);
const MIN = 60_000;
const ago = (m) => NOW - m * MIN;
const sha = (c) => c.repeat(40);
const cfg = configOf({});

const item = (over = {}) => ({
  pr: 1, head: sha('a'), band: 'HIGH', escalated: false, round: 1, state: 'queued',
  queuedAt: ago(5), addedAt: ago(5), posts: 0, pin: false, asked: { paid30: false, timeout60: false },
  session: 's1', ...over,
});
const state = (items = [], over = {}) => ({
  ...emptyState(), items, ...over,
});
const facts = (over = {}) => ({
  pr: 1, open: true, merged: false, head: sha('a'), reviewedHead: false, pending: false, limited: false,
  retryMinutes: null, reviewAts: [], requestAts: [], carryHolds: false, ...over,
});
const holderOf = (pr, minutesAgo, head = sha('a')) => ({ pr, head, at: ago(minutesAgo), session: 's1' });
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
};

// --- config and state file -------------------------------------------------------------------------------------

// Breaks if configOf stops reading matrix.slot, or takes a string, a zero or an unknown key.
test('configOf overlays only known positive numbers from matrix.slot', () => {
  const out = configOf({ matrix: { slot: { spacing_min: 30, timeout_min: '90', holder_max_min: 0, bogus: 5 } } });
  assert.equal(out.spacing_min, 30);
  assert.equal(out.timeout_min, DEFAULTS.timeout_min);
  assert.equal(out.holder_max_min, DEFAULTS.holder_max_min);
  assert.equal('bogus' in out, false);
  assert.deepEqual(configOf(undefined), DEFAULTS);
});

// F15 (model side). Breaks if parseState swallows a parse error or accepts an unknown version.
test('parseState throws on bad JSON, on a wrong version and on a bad item; a missing file is an empty queue', () => {
  assert.throws(() => parseState('{not json'), /slot-queue/);
  assert.throws(() => parseState(JSON.stringify({ version: 2, items: [] })), /version/);
  assert.throws(() => parseState(JSON.stringify({ version: 1, items: [{ pr: 1, band: 'LOW', state: 'queued' }] })), /item/);
  assert.throws(() => parseState(''), /slot-queue/);
  assert.deepEqual(parseState(undefined), emptyState());
  const s = state([item()]);
  assert.deepEqual(parseState(JSON.stringify(s)).items, s.items);
});

// --- order -----------------------------------------------------------------------------------------------------

// F11. Breaks if the tier order changes: pin, CRITICAL, escalated HIGH, static HIGH. Ties go to the oldest queuedAt.
test('F11 order: pinned HIGH, CRITICAL, escalated HIGH, HIGH; ties by oldest queuedAt', () => {
  const items = [
    item({ pr: 4, queuedAt: ago(50) }),
    item({ pr: 3, escalated: true, queuedAt: ago(10) }),
    item({ pr: 2, band: 'CRITICAL', queuedAt: ago(5) }),
    item({ pr: 1, pin: true, queuedAt: ago(1) }),
    item({ pr: 5, queuedAt: ago(60) }),
  ];
  assert.deepEqual(orderItems(items).map((i) => i.pr), [1, 2, 3, 5, 4]);
});

// F22. Breaks if tierOf puts SAMPLE above static HIGH, or a pin stops winning over every band.
test('F22 order: pinned SAMPLE, CRITICAL, HIGH, SAMPLE', () => {
  const items = [
    item({ pr: 4, band: 'SAMPLE', queuedAt: ago(90) }),
    item({ pr: 3, band: 'HIGH', queuedAt: ago(5) }),
    item({ pr: 2, band: 'CRITICAL', queuedAt: ago(1) }),
    item({ pr: 1, band: 'SAMPLE', pin: true, queuedAt: ago(1) }),
  ];
  assert.deepEqual(orderItems(items).map((i) => i.pr), [1, 2, 3, 4]);
  assert.ok(tierOf(item({ band: 'SAMPLE' })) > tierOf(item({ band: 'HIGH' })));
});

// Breaks if orderItems sorts the caller's array in place.
test('orderItems leaves its input unchanged', () => {
  const items = deepFreeze([item({ pr: 2, queuedAt: ago(1) }), item({ pr: 1, queuedAt: ago(9) })]);
  assert.deepEqual(orderItems(items).map((i) => i.pr), [1, 2]);
});

// --- slot free -------------------------------------------------------------------------------------------------

// F3. Breaks if slotFree ignores nextAt (the CodeRabbit notice figure).
test('F3 slotFree is false until nextAt has passed', () => {
  const s = state([], { slot: { nextAt: NOW + 5 * MIN, source: 'notice', lastPostAt: 0, lastPostPr: null } });
  assert.equal(slotFree(s, NOW, cfg), false);
  assert.equal(slotFree(s, NOW + 5 * MIN, cfg), true);
});

// F3. Breaks if slotFree ignores lastPostAt + spacing.
test('F3 slotFree is false inside the spacing floor after a post', () => {
  const s = state([], { slot: { nextAt: null, source: 'post', lastPostAt: ago(59), lastPostPr: 1 } });
  assert.equal(slotFree(s, NOW, cfg), false);
  assert.equal(slotFree({ ...s, slot: { ...s.slot, lastPostAt: ago(60) } }, NOW, cfg), true);
});

// Breaks if a live holder no longer blocks the slot.
test('slotFree is false while a holder is set', () => {
  assert.equal(slotFree(state([], { holder: holderOf(1, 1) }), NOW, cfg), false);
  assert.equal(slotFree(state([]), NOW, cfg), true);
});

// F10a. Breaks if slotFree, timers or rowsOf read the real clock instead of `now`.
test('F10a the model answers from its now argument, not from Date.now', () => {
  const real = Date.now;
  Date.now = () => 1; // a wrong clock: if any function reads it, the answers below change
  try {
    const it = item({ queuedAt: ago(61) });
    assert.equal(timers(it, NOW, cfg, null).timedOut, true);
    assert.equal(timers(it, NOW, cfg, null).queuedMin, 61);
    assert.equal(slotFree(state([]), NOW, cfg), true);
    assert.equal(rowsOf(state([it]), NOW, cfg)[0].queuedMin, 61);
    assert.equal(settle(state([it]), { 1: facts() }, NOW, cfg).items[0].state, 'timed-out');
  } finally { Date.now = real; }
});

// --- pickNext ---------------------------------------------------------------------------------------------------

// Breaks if pickNext takes an item in a state that must not post (opening, awaiting-fix, stuck, posted, done, dropped).
test('pickNext takes only queued and timed-out items, in order', () => {
  const items = ['opening', 'awaiting-fix', 'stuck', 'posted', 'done', 'dropped']
    .map((st, i) => item({ pr: 10 + i, state: st }));
  assert.equal(pickNext(state(items), NOW, cfg), null);
  const withTimedOut = [...items, item({ pr: 20, state: 'timed-out', queuedAt: ago(70) }), item({ pr: 21, queuedAt: ago(20) })];
  assert.equal(pickNext(state(withTimedOut), NOW, cfg).pr, 20);
});

// Breaks if pickNext ignores a busy slot or a holder.
test('pickNext returns null while the slot is not free', () => {
  const busy = state([item()], { holder: holderOf(9, 2) });
  assert.equal(pickNext(busy, NOW, cfg), null);
  const spaced = state([item()], { slot: { nextAt: null, source: 'post', lastPostAt: ago(10), lastPostPr: 9 } });
  assert.equal(pickNext(spaced, NOW, cfg), null);
});

// F4. Choice: a pending CodeRabbit status on an item's own head skips that item (a review may be running on it);
// the next item in order may still take the slot. Breaks if the pending hold is removed from pickNext.
test('F4 pickNext skips an item whose head status is pending', () => {
  const s = state([item({ pr: 1, queuedAt: ago(30) }), item({ pr: 2, queuedAt: ago(20) })]);
  assert.equal(pickNext(s, NOW, cfg, { 1: facts({ pr: 1, pending: true }) }).pr, 2);
  assert.equal(pickNext(state([item()]), NOW, cfg, { 1: facts({ pending: true }) }), null);
  assert.equal(pickNext(state([item()]), NOW, cfg, { 1: facts() }).pr, 1);
});

// --- closeDone ---------------------------------------------------------------------------------------------------

// F5. Breaks if settle applies closeDone after pickNext picks, or closeDone ignores reviewedHead.
test('F5 a head that CodeRabbit already reviewed is done, so nothing is posted for it', () => {
  const s = state([item()]);
  const out = settle(s, { 1: facts({ reviewedHead: true }) }, NOW, cfg);
  assert.equal(out.items[0].state, 'done');
  assert.equal(pickNext(out, NOW, cfg), null);
  assert.equal(pickNext(s, NOW, cfg).pr, 1, 'without the facts the same item would post');
});

// F6. Breaks if closeDone drops only closed PRs (a merged PR must drop too) or loses the reason.
test('F6 a closed or merged PR is dropped with its reason', () => {
  const merged = closeDone(item(), facts({ open: false, merged: true }));
  const closed = closeDone(item(), facts({ open: false }));
  assert.deepEqual([merged.state, merged.dropReason], ['dropped', 'merged']);
  assert.deepEqual([closed.state, closed.dropReason], ['dropped', 'closed']);
});

// Breaks if closeDone touches an item that is already done or dropped.
test('closeDone keeps a finished item as it is', () => {
  const was = item({ state: 'dropped', dropReason: 'sample-ttl' });
  assert.deepEqual(closeDone(was, facts({ open: false, merged: true })), was);
  assert.equal(closeDone(item({ state: 'done' }), facts({ open: false })).state, 'done');
});

// F21. Breaks if closeDone closes awaiting-fix on the reviewed head (the head the grant was made on).
test('F21 a grant on a reviewed head stays awaiting-fix and posts nothing', () => {
  const was = item({ state: 'awaiting-fix' });
  const f = facts({ reviewedHead: true });
  assert.equal(closeDone(was, f).state, 'awaiting-fix');
  const out = settle(state([was]), { 1: f }, NOW, cfg);
  assert.equal(out.items[0].state, 'awaiting-fix');
  assert.equal(pickNext(out, NOW, cfg), null);
});

// --- moveHead ---------------------------------------------------------------------------------------------------

// F7. Breaks if the clock is keyed by head (queuedAt changes) or the old holder stays.
test('F7 a moved head keeps queuedAt and clears the holder of the old head', () => {
  const was = item({ state: 'posted', queuedAt: ago(40) });
  const r = moveHead(was, facts({ head: sha('b') }), holderOf(1, 3), NOW);
  assert.equal(r.item.head, sha('b'));
  assert.equal(r.item.queuedAt, ago(40));
  assert.equal(r.item.state, 'queued');
  assert.equal(r.holder, null);
});

// Breaks if moveHead clears a holder that belongs to another PR, or changes an item whose head did not move.
test('moveHead leaves another PR holder and an unmoved head alone', () => {
  const other = holderOf(2, 3);
  const r = moveHead(item({ queuedAt: ago(40) }), facts({ head: sha('b') }), other, NOW);
  assert.deepEqual(r.holder, other);
  const same = item();
  assert.deepEqual(moveHead(same, facts(), other, NOW), { item: same, holder: other });
});

// Breaks if a queued item that is timed-out turns back to queued on a push (the clock must keep running).
test('moveHead keeps a timed-out item timed-out', () => {
  const r = moveHead(item({ state: 'timed-out', queuedAt: ago(90) }), facts({ head: sha('b') }), null, NOW);
  assert.equal(r.item.state, 'timed-out');
  assert.equal(r.item.queuedAt, ago(90));
});

// F21. Breaks if T3 adds `queued` at grant time, or the fix push does not start the clock at that moment.
test('F21 a fix push on an awaiting-fix item queues it with queuedAt = now', () => {
  const was = item({ state: 'awaiting-fix', queuedAt: 0, addedAt: ago(200) });
  const r = moveHead(was, facts({ head: sha('b') }), null, NOW);
  assert.equal(r.item.state, 'queued');
  assert.equal(r.item.queuedAt, NOW);
  assert.equal(r.item.head, sha('b'));
});

// F21. Breaks if the carry check is removed: when the earlier review carries, no post is needed.
test('F21 when the carry holds, the new head does not queue an awaiting-fix item', () => {
  const r = moveHead(item({ state: 'awaiting-fix' }), facts({ head: sha('b'), carryHolds: true }), null, NOW);
  assert.equal(r.item.state, 'awaiting-fix');
  assert.equal(r.item.head, sha('b'));
});

// Breaks if a new head that is already reviewed leaves an awaiting-fix item open.
test('an awaiting-fix item whose new head is reviewed is done', () => {
  const out = settle(state([item({ state: 'awaiting-fix' })]), { 1: facts({ head: sha('b'), reviewedHead: true }) }, NOW, cfg);
  assert.equal(out.items[0].state, 'done');
});

// --- holder expiry ---------------------------------------------------------------------------------------------

// F8. Breaks if the 20-minute expiry or the posts count is removed (#246: a post that made no review).
test('F8 a holder older than 20 minutes counts one post and frees the slot', () => {
  const s = state([item({ state: 'posted' })], { holder: holderOf(1, 21) });
  const out = expireHolder(s, NOW, cfg);
  assert.equal(out.holder, null);
  assert.equal(out.items[0].posts, 1);
  assert.equal(out.items[0].state, 'queued');
  assert.equal(out.slot.nextAt, NOW + 60 * MIN);
  assert.deepEqual(expireHolder(state([item({ state: 'posted' })], { holder: holderOf(1, 19) }), NOW, cfg).holder, holderOf(1, 19));
});

// F8. Breaks if the second empty post no longer ends in stuck.
test('F8 the second empty post makes the item stuck', () => {
  const s = state([item({ state: 'posted', posts: 1 })], { holder: holderOf(1, 25) });
  const out = expireHolder(s, NOW, cfg);
  assert.equal(out.items[0].posts, 2);
  assert.equal(out.items[0].state, 'stuck');
  assert.equal(out.holder, null);
});

// Breaks if a holder whose item is done, dropped or gone counts a post or stays.
test('a holder for a finished or missing item is cleared with no post counted', () => {
  const done = expireHolder(state([item({ state: 'done' })], { holder: holderOf(1, 2) }), NOW, cfg);
  assert.equal(done.holder, null);
  assert.equal(done.items[0].posts, 0);
  assert.equal(expireHolder(state([], { holder: holderOf(7, 2) }), NOW, cfg).holder, null);
});

// --- timers ----------------------------------------------------------------------------------------------------

// F9. Breaks if timers does not check the holder: an item that holds the slot must not time out.
test('F9 no time-out while the item holds the slot', () => {
  const claim = item({ queuedAt: ago(61) });
  assert.equal(timers(claim, NOW, cfg, holderOf(1, 1)).timedOut, false);
  assert.equal(timers(claim, NOW, cfg, holderOf(2, 1)).timedOut, true, 'a holder for another PR does not protect it');
  const posted = settle(state([item({ state: 'posted', queuedAt: ago(61) })], { holder: holderOf(1, 5) }), {}, NOW, cfg);
  assert.equal(posted.items[0].state, 'posted');
});

// Breaks if the time-out threshold moves, or timeoutInMin counts from anything but the stored queuedAt.
test('timers: HIGH times out at 60 minutes and has no paid ask', () => {
  const at59 = timers(item({ queuedAt: ago(59) }), NOW, cfg, null);
  assert.deepEqual([at59.timedOut, at59.askPaid, at59.timeoutInMin, at59.queuedMin], [false, false, 1, 59]);
  const at60 = timers(item({ queuedAt: ago(60) }), NOW, cfg, null);
  assert.deepEqual([at60.timedOut, at60.askPaid, at60.timeoutInMin], [true, false, 0]);
});

// Breaks if the paid ask fires for HIGH, fires twice (asked.paid30), fires too early, or fires for a timed-out item.
test('timers: the 30-minute paid ask is for CRITICAL once', () => {
  const crit = (m, over = {}) => item({ band: 'CRITICAL', queuedAt: ago(m), ...over });
  assert.equal(timers(crit(29), NOW, cfg, null).askPaid, false);
  assert.equal(timers(crit(31), NOW, cfg, null).askPaid, true);
  assert.equal(timers(crit(31, { asked: { paid30: true, timeout60: false } }), NOW, cfg, null).askPaid, false);
  assert.equal(timers(item({ queuedAt: ago(31) }), NOW, cfg, null).askPaid, false);
  assert.equal(timers(crit(61), NOW, cfg, null).askPaid, false);
});

// F26. Breaks if timers treats SAMPLE as HIGH.
test('F26 a SAMPLE gets no paid ask and no time-out', () => {
  const t = timers(item({ band: 'SAMPLE', queuedAt: ago(70) }), NOW, cfg, null);
  assert.deepEqual([t.askPaid, t.timedOut, t.timeoutInMin], [false, false, null]);
  assert.equal(settle(state([item({ band: 'SAMPLE', queuedAt: ago(70) })]), {}, NOW, cfg).items[0].state, 'queued');
});

// F10 (model side). Breaks if the time-out depends on anything that is not stored in the item.
test('settle times out a queued item from its stored queuedAt alone', () => {
  const out = settle(state([item({ queuedAt: ago(61) })]), {}, NOW, cfg);
  assert.equal(out.items[0].state, 'timed-out');
  assert.equal(pickNext(out, NOW, cfg).pr, 1, 'a timed-out item still takes a free slot');
});

// --- seen posts and notices --------------------------------------------------------------------------------------

// F25. Breaks if noteSeenPosts ignores reviews: a review that started 10 minutes ago on another item blocks a post.
test('F25 a CodeRabbit review seen on another PR blocks a post inside the spacing floor', () => {
  const s = state([item({ pr: 1 }), item({ pr: 2, queuedAt: ago(1) })]);
  const out = noteSeenPosts(s, { 2: facts({ pr: 2, reviewAts: [ago(10)] }) });
  assert.equal(out.slot.lastPostAt, ago(10));
  assert.equal(out.slot.source, 'seen');
  assert.equal(pickNext(out, NOW, cfg), null);
});

// F24 (model side). Breaks if noteSeenPosts ignores request comments (a human or model post is a holder, Q2).
test('F24 a request comment seen 5 minutes ago moves lastPostAt and blocks the post', () => {
  const out = noteSeenPosts(state([item()]), { 1: facts({ requestAts: [ago(40), ago(5)] }) });
  assert.equal(out.slot.lastPostAt, ago(5));
  assert.equal(pickNext(out, NOW, cfg), null);
});

// Breaks if noteSeenPosts moves lastPostAt backwards, or writes when nothing newer was seen.
test('noteSeenPosts never lowers lastPostAt', () => {
  const s = state([item()], { slot: { nextAt: null, source: 'post', lastPostAt: ago(2), lastPostPr: 1 } });
  const out = noteSeenPosts(s, { 1: facts({ reviewAts: [ago(50)], requestAts: [ago(30)] }) });
  assert.deepEqual(out.slot, s.slot);
});

// m11. Breaks if nextAt does not come from now + retryMinutes (review-status gives the minutes LEFT at now), if a stale noticeAt
// field is read again, or if a smaller later figure lowers it.
test('a limit notice sets nextAt to now plus the minutes left it names', () => {
  const f = { 1: facts({ limited: true, retryMinutes: 25, noticeAt: ago(10) }) };
  const out = settle(state([item()]), f, NOW, cfg);
  assert.equal(out.slot.nextAt, NOW + 25 * MIN);
  assert.equal(out.slot.source, 'notice');
  assert.equal(slotFree(out, NOW, cfg), false);
  const lower = settle(out, { 1: facts({ limited: true, retryMinutes: 5 }) }, NOW, cfg);
  assert.equal(lower.slot.nextAt, out.slot.nextAt);
});

// --- opening ----------------------------------------------------------------------------------------------------

// T2. Breaks if a limit notice no longer queues an opening item, or queuedAt is not set to now.
test('promoteOpening: a limit notice queues the item at once', () => {
  const was = item({ state: 'opening', queuedAt: 0, addedAt: ago(5) });
  const out = promoteOpening(was, facts({ limited: true, retryMinutes: 12 }), NOW, cfg);
  assert.equal(out.state, 'queued');
  assert.equal(out.queuedAt, NOW);
});

// T2. Breaks if the 30-minute rule moves, or fires while CodeRabbit shows a running review (pending).
test('promoteOpening: 30 minutes with no review start queues the item; a pending review holds it', () => {
  const at = (m) => item({ state: 'opening', queuedAt: 0, addedAt: ago(m) });
  assert.equal(promoteOpening(at(29), facts(), NOW, cfg).state, 'opening');
  assert.equal(promoteOpening(at(31), facts(), NOW, cfg).state, 'queued');
  assert.equal(promoteOpening(at(31), facts({ pending: true }), NOW, cfg).state, 'opening');
  assert.equal(promoteOpening(item({ state: 'queued' }), facts({ limited: true }), NOW, cfg).state, 'queued');
});

// --- prune and rows ----------------------------------------------------------------------------------------------

// Breaks if the 7-day stale rule moves, or a holder outlives its pruned item.
test('prune removes items older than 7 days and the holder of a removed item', () => {
  const old = item({ pr: 1, addedAt: NOW - 8 * 24 * 60 * MIN, queuedAt: NOW - 8 * 24 * 60 * MIN, state: 'done' });
  const fresh = item({ pr: 2, addedAt: NOW - 6 * 24 * 60 * MIN, queuedAt: NOW - 6 * 24 * 60 * MIN });
  const out = prune(state([old, fresh], { holder: holderOf(1, 1) }), NOW, cfg);
  assert.deepEqual(out.items.map((i) => i.pr), [2]);
  assert.equal(out.holder, null);
});

// Breaks if a Row key is renamed or dropped: W2 fixtures and the W3 parser read these exact keys (plan 3.2).
test('rowsOf gives the plan Row keys, positions and the next slot', () => {
  const s = state([
    item({ pr: 1, queuedAt: ago(10) }),
    item({ pr: 2, band: 'CRITICAL', queuedAt: ago(4), asked: { paid30: true, timeout60: false } }),
    item({ pr: 3, state: 'dropped', dropReason: 'sample-ttl' }),
  ], { slot: { nextAt: null, source: 'post', lastPostAt: ago(40), lastPostPr: 9 } });
  const rows = rowsOf(s, NOW, cfg);
  const keys = ['asked', 'band', 'head7', 'nextSlotInMin', 'position', 'posts', 'pr', 'queuedMin', 'state', 'timeoutInMin', 'total'];
  assert.deepEqual(Object.keys(rows[0]).sort(), keys);
  assert.deepEqual(rows.map((r) => [r.pr, r.position, r.total]), [[2, 1, 2], [1, 2, 2], [3, null, 2]]);
  assert.deepEqual([rows[0].head7, rows[0].queuedMin, rows[0].timeoutInMin, rows[0].nextSlotInMin], [sha('a').slice(0, 7), 4, 56, 20]);
  assert.equal(rows[2].dropReason, 'sample-ttl');
  assert.equal(rows[0].asked.paid30, true);
});

// --- purity --------------------------------------------------------------------------------------------------------

// Breaks if any step mutates its input (the file is written only from the returned state).
test('settle works on frozen input and returns new objects', () => {
  const s = deepFreeze(state([item({ queuedAt: ago(61) }), item({ pr: 2, state: 'posted' })], { holder: holderOf(2, 30, sha('a')) }));
  const out = settle(s, deepFreeze({ 1: facts(), 2: facts({ pr: 2, head: sha('c') }) }), NOW, cfg);
  assert.notEqual(out, s);
  assert.equal(s.items[0].state, 'queued');
  assert.equal(out.items[0].state, 'timed-out');
});
