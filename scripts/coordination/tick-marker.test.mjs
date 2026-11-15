/**
 * tick-marker.test -- the "NO TICK" marker on the board row of a program master card (coord-seat-tick-alert).
 *
 * Signal: lease minutes left. The prompt hook renews the lease to now + 90 min on every prompt, a cron-queued tick
 * included (probe 2026-11-15: lease 16:30:24Z -> 16:32:00Z at the 09:02:00 CST tick). A seat on a 30-minute tick, with
 * a scheduler delay of up to 15 minutes, keeps 45 to 90. Under 40 means 50 minutes without a prompt.
 *
 * How the marker can fail, one test each:
 *   - a master holder with a short lease shows no marker (the feature does nothing)
 *   - a healthy lease (60m) or the boundary (40m) shows the marker (false alarm on a working seat)
 *   - a parked master card shows it (a park lease is more than 91 minutes ahead; the tick is stopped on purpose)
 *   - a lapsed lease (0 or less) shows it (the row already prints LAPSED; two words for one fact)
 *   - a lane that is not a master card shows it (builders keep "warm only")
 *   - a lane with no holder or no lease shows it
 *   - it shows at night (the tick runs 07:00 to 21:59 local only)
 *   - the hour edges are off by one (06:59 and 22:00 show it, or 07:00 and 21:59 do not)
 *   - a junk lease value throws instead of giving no marker
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_LANES, NO_TICK, TICK_MIN_LEASE_MINUTES, tickMarker } from './tick-marker.mjs';

const at = (h, m = 0) => new Date(2026, 10, 15, h, m, 0);
const lane = (over = {}) => ({ id: 're-program', owner_session_id: 's1', lease_expires_at: null, ...over });
const leaseIn = (now, minutes) => new Date(now.getTime() + minutes * 60000).toISOString();

describe('tickMarker', () => {
  it('shows NO TICK for a master holder with 38 minutes left at 10:00', () => {
    const now = at(10);
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, 38) }), now), NO_TICK);
    assert.equal(NO_TICK, 'NO TICK');
  });
  it('shows nothing at a healthy lease (60m) and at the boundary (40m)', () => {
    const now = at(10);
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, 60) }), now), '');
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, TICK_MIN_LEASE_MINUTES) }), now), '');
    assert.equal(TICK_MIN_LEASE_MINUTES, 40);
  });
  it('shows nothing for a parked master card (lease more than 91 minutes ahead)', () => {
    const now = at(10);
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, 600) }), now), '');
  });
  it('shows nothing for a lapsed lease: the row already says LAPSED', () => {
    const now = at(10);
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, 0) }), now), '');
    assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, -5) }), now), '');
  });
  it('shows nothing for a lane that is not a master card', () => {
    const now = at(10);
    assert.deepEqual(MASTER_LANES, ['re-program']);
    assert.equal(tickMarker(lane({ id: 'coord-seat-tick-alert', lease_expires_at: leaseIn(now, 10) }), now), '');
  });
  it('shows nothing with no holder or no lease', () => {
    const now = at(10);
    assert.equal(tickMarker(lane({ owner_session_id: null, lease_expires_at: leaseIn(now, 10) }), now), '');
    assert.equal(tickMarker(lane({ lease_expires_at: null }), now), '');
  });
  it('shows nothing at night and is right at the hour edges', () => {
    for (const [h, m, want] of [[3, 0, ''], [6, 59, ''], [7, 0, NO_TICK], [21, 59, NO_TICK], [22, 0, '']]) {
      const now = at(h, m);
      assert.equal(tickMarker(lane({ lease_expires_at: leaseIn(now, 20) }), now), want, `${h}:${m}`);
    }
  });
  it('gives no marker, and does not throw, for a junk lease', () => {
    const now = at(10);
    for (const bad of ['not a date', '', undefined, {}]) {
      assert.equal(tickMarker(lane({ lease_expires_at: bad }), now), '');
    }
  });
});
