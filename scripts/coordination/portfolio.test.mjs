/**
 * portfolio.test -- the seat rows and the page of portfolio.mjs (coord-portfolio-seat-view).
 *
 * How the page can fail, one test each:
 *   - a board's master card gives no row, or two boards give one row (the page lists one seat per board)
 *   - a seat with 30 minutes of lease in tick hours shows no NO TICK, or a seat with 80 minutes shows it
 *   - a second master card id (not 're-program') never gets the word (the probe id is the caller's list)
 *   - the word shows outside 07:00-21:59 local
 *   - a parked seat (lease more than 91 minutes ahead) shows the word, or has no parkedTo
 *   - a card with no owner shows a holder
 *   - a reclaimable holder (lease ended AND quiet 5 minutes) shows as the seat; a holder with only one of the two does not drop
 *   - a junk lease value throws or gives the word
 *   - quiet is read from the last event age (a seat with a fresh tick and an old event gets the word)
 *   - a board key or lane id with markup reaches the page unescaped
 *   - a lane note, title or event body reaches the page
 *   - a failed board has no "read failed" row
 *   - the in-review count includes a parked lane, a lane of another board or a lane that is not in review
 *   - the column header or the rule line under the table is missing or says something else
 *   - the build time is not at the top
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_TICK } from './tick-marker.mjs';
import { renderHtml, seatRows } from './portfolio.mjs';

const now = new Date(2026, 10, 16, 10, 0, 0);
const at = (h, m = 0) => new Date(2026, 10, 16, h, m, 0);
const iso = (d, minutes) => new Date(d.getTime() + minutes * 60000).toISOString();
const SID_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const SID_B = 'bbbbbbbb-2222-4222-8222-000000000002';

const master = (over = {}) => ({
  project_key: 'board-a', id: 're-program', state: 'active', owner_session_id: SID_A,
  lease_expires_at: iso(now, 80), note: 'NOTE-SECRET-123', title: 'TITLE-SECRET-123', scope: 'SCOPE-SECRET-123', ...over,
});
const awake = (id, d = now) => ({ id, last_alive: iso(d, -1) });
const call = (over = {}) => seatRows({
  lanes: [master()], sessions: [awake(SID_A)], events: [], masterLanes: ['re-program'], now, ...over,
});

describe('seatRows', () => {
  it('gives one row per board with a master card, two boards two seats', () => {
    const rows = call({
      lanes: [master(), master({ project_key: 'board-b', id: 'b-program', owner_session_id: SID_B })],
      sessions: [awake(SID_A), awake(SID_B)], masterLanes: ['re-program', 'b-program'],
    });
    assert.deepEqual(rows.map((r) => [r.board, r.lane]), [['board-a', 're-program'], ['board-b', 'b-program']]);
  });

  it('gives no row for a lane that is not a master card or a master card that is done', () => {
    const rows = call({ lanes: [master({ id: 'other' }), master({ state: 'done' })] });
    assert.deepEqual(rows, []);
  });

  it('shows NO TICK for 30 minutes of lease and no word for 80 minutes, in tick hours', () => {
    const quiet = call({ lanes: [master({ lease_expires_at: iso(now, 30) })] })[0];
    const live = call({ lanes: [master({ lease_expires_at: iso(now, 80) })] })[0];
    assert.equal(quiet.tick, NO_TICK);
    assert.equal(quiet.leaseMinutes, 30);
    assert.equal(live.tick, '');
    assert.equal(live.leaseMinutes, 80);
  });

  it('gives a second master card id the word, not only re-program', () => {
    const rows = call({ lanes: [master({ id: 'zz-program', lease_expires_at: iso(now, 30) })], masterLanes: ['zz-program'] });
    assert.equal(rows[0].tick, NO_TICK);
  });

  it('shows no word outside 07:00-21:59 local', () => {
    const night = at(23, 0);
    const rows = call({ now: night, lanes: [master({ lease_expires_at: iso(night, 30) })], sessions: [awake(SID_A, night)] });
    assert.equal(rows[0].tick, '');
  });

  it('shows parkedTo and no word for a lease more than 91 minutes ahead', () => {
    const lease = iso(now, 600);
    const r = call({ lanes: [master({ lease_expires_at: lease })] })[0];
    assert.equal(r.parkedTo, lease);
    assert.equal(r.tick, '');
    assert.equal(call()[0].parkedTo, null);
  });

  it('gives a null holder for a card with no owner', () => {
    const r = call({ lanes: [master({ owner_session_id: null })] })[0];
    assert.equal(r.holder, null);
    assert.equal(r.tick, '');
  });

  it('gives a null holder when the lease ended AND the holder is quiet 5 minutes', () => {
    const r = call({ lanes: [master({ lease_expires_at: iso(now, -10) })], sessions: [{ id: SID_A, last_alive: iso(now, -20) }] })[0];
    assert.equal(r.holder, null);
    const gone = call({ lanes: [master({ lease_expires_at: iso(now, -10) })], sessions: [] })[0];
    assert.equal(gone.holder, null);
  });

  it('keeps the holder when only one reclaim half holds', () => {
    const lapsedAlive = call({ lanes: [master({ lease_expires_at: iso(now, -10) })], sessions: [awake(SID_A)] })[0];
    const quietInLease = call({ lanes: [master({ lease_expires_at: iso(now, 30) })], sessions: [{ id: SID_A, last_alive: iso(now, -20) }] })[0];
    assert.equal(lapsedAlive.holder, '#aaaaaaaa');
    assert.equal(quietInLease.holder, '#aaaaaaaa');
  });

  it('writes the holder as "name #sid8" when an identity has a name', () => {
    const r = call({ identities: new Map([[SID_A, { name: 'trex' }]]) })[0];
    assert.equal(r.holder, 'trex #aaaaaaaa');
  });

  it('gives no word and no throw for a junk lease', () => {
    const r = call({ lanes: [master({ lease_expires_at: 'not-a-date' })] })[0];
    assert.equal(r.tick, '');
    assert.equal(r.leaseMinutes, null);
    assert.equal(r.parkedTo, null);
  });

  it('reads the word from the lease, never from the last event age', () => {
    const old = { project_key: 'board-a', lane_id: 're-program', occurred_at: iso(now, -300) };
    const r = call({ events: [old] })[0];
    assert.equal(r.tick, '');
    assert.equal(r.lastEventAgeMinutes, 300);
    assert.equal(call()[0].lastEventAgeMinutes, null);
  });

  it('counts review lanes that are not parked, on this board only', () => {
    const review = (id, lease, extra = {}) => ({ project_key: 'board-a', id, state: 'review', owner_session_id: null, lease_expires_at: lease, ...extra });
    const rows = call({
      lanes: [
        master(),
        review('r1', null), review('r2', iso(now, 30)),
        review('r-parked', iso(now, 600)),
        review('r-other-board', null, { project_key: 'board-b' }),
        review('r-ready', null, { state: 'ready' }),
      ],
    });
    assert.equal(rows[0].inReviewNotParked, 2);
  });
});

describe('renderHtml', () => {
  const built = { builtAt: now, failedBoards: [] };
  const html = (rows, opts = {}) => renderHtml(rows, { ...built, ...opts });

  it('escapes a board key, a lane id and a label', () => {
    const rows = [{ board: '<script>alert(1)</script>', lane: 'x"><img onerror=1>', holder: '<b>n</b> #aaaaaaaa', leaseMinutes: 30,
      lastEventAgeMinutes: 5, tick: NO_TICK, parkedTo: null, inReviewNotParked: 0 }];
    const out = html(rows);
    assert.ok(!out.includes('<script'), 'raw script tag');
    assert.ok(!out.includes('<img'), 'raw img tag');
    assert.ok(!out.includes('<b>n'), 'raw label markup');
    assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('never shows a lane note, title, scope or event body', () => {
    const lanes = [master({ body: 'NOTE-SECRET-123' })];
    const events = [{ project_key: 'board-a', lane_id: 're-program', occurred_at: iso(now, -3), body: 'NOTE-SECRET-123' }];
    const out = html(seatRows({ lanes, sessions: [awake(SID_A)], events, masterLanes: ['re-program'], now }));
    assert.ok(!/SECRET-123/.test(out));
  });

  it('shows "read failed" for a failed board', () => {
    const out = html([], { failedBoards: ['zz-broken'] });
    assert.match(out, /zz-broken/);
    assert.match(out, /read failed/);
    assert.ok(!/read failed/.test(html([])));
  });

  it('has the exact column header, the rule line and the build time at the top', () => {
    const out = html(call());
    assert.ok(out.includes('>in review, not parked<'));
    assert.match(out, /not Dave's full queue|not Dave&#39;s full queue/);
    assert.ok(out.indexOf('2026-11-16 10:00') > 0 && out.indexOf('2026-11-16 10:00') < out.indexOf('<table'));
  });

  it('shows the word and the park time on the row', () => {
    const out = html(call({ lanes: [master({ lease_expires_at: iso(now, 30) })] }));
    assert.ok(out.includes(NO_TICK));
    assert.ok(!html(call()).includes(NO_TICK));
    assert.match(html(call({ lanes: [master({ lease_expires_at: iso(now, 600) })] })), /parked to/);
  });
});
