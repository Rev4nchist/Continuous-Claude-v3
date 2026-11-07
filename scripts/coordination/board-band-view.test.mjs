/**
 * board-band-view.test -- the pure helpers behind the By band view of the phone page.
 *
 * How they can fail, one test each:
 *   - a done lane shows in By band (even one that still carries a band)
 *   - the groups are not P0, P1, P2, Unsorted, or a group orders rows by anything but the shared key
 *   - a NULL, undefined or junk band is not Unsorted
 *   - the P0 cap text or flag is wrong at 0, 5 and 6
 *   - a band chip prints a value that is not on the whitelist (a band string must never reach the markup raw)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BAND_GROUPS, bandChipHtml, bandKey, capState, groupByBand } from './board-band-view.mjs';

const lane = (id, band, extra = {}) => ({ id, band, state: 'ready', priority: 50, due_at: null, ...extra });

describe('bandKey', () => {
  it('maps P0, P1, P2 to themselves and NULL, undefined and junk to none', () => {
    assert.deepEqual([lane('a', 'P0'), lane('b', 'P1'), lane('c', 'P2')].map(bandKey), ['P0', 'P1', 'P2']);
    for (const junk of [null, undefined, '', 'p0', 'P3', '<b>', 0]) assert.equal(bandKey({ band: junk }), 'none', String(junk));
    assert.equal(bandKey({}), 'none');
  });
});

describe('groupByBand', () => {
  it('returns the four groups in the order P0, P1, P2, Unsorted, always, even when empty', () => {
    const g = groupByBand([]);
    assert.deepEqual(g.map((x) => x.key), ['P0', 'P1', 'P2', 'none']);
    assert.deepEqual(g.map((x) => x.label), BAND_GROUPS.map((x) => x[1]));
    assert.deepEqual(g.map((x) => x.n), [0, 0, 0, 0]);
  });

  it('leaves out done lanes, even a done lane with band P0', () => {
    const g = groupByBand([lane('a', 'P0'), lane('d', 'P0', { state: 'done' }), lane('e', null, { state: 'done' })]);
    assert.deepEqual(g[0].rows.map((l) => l.id), ['a']);
    assert.equal(g.reduce((s, x) => s + x.n, 0), 1);
  });

  it('orders a group by due_at (NULL last), then priority, then id', () => {
    const g = groupByBand([
      lane('z-late', 'P1', { priority: 1, due_at: '2026-12-01T00:00:00Z' }),
      lane('c-none', 'P1', { priority: 1 }),
      lane('b-pri9', 'P1', { priority: 9, due_at: '2026-11-10T00:00:00Z' }),
      lane('a-pri5', 'P1', { priority: 5, due_at: '2026-11-10T00:00:00Z' }),
      lane('d-none-pri0', 'P1', { priority: 0 }),
    ]);
    assert.deepEqual(g[1].rows.map((l) => l.id), ['a-pri5', 'b-pri9', 'z-late', 'd-none-pri0', 'c-none']);
  });

  it('puts NULL and junk bands in Unsorted and counts them', () => {
    const g = groupByBand([lane('a', null), lane('b', undefined), lane('c', 'junk'), lane('d', 'P2')]);
    assert.equal(g[3].n, 3);
    assert.equal(g[2].n, 1);
  });

  it('does not change the input array', () => {
    const rows = [lane('b', 'P1'), lane('a', 'P0')];
    groupByBand(rows);
    assert.deepEqual(rows.map((l) => l.id), ['b', 'a']);
  });
});

describe('capState', () => {
  it('shows n/5, and flags only a count above the cap', () => {
    assert.deepEqual(capState(0), { text: '0/5', over: false });
    assert.deepEqual(capState(5), { text: '5/5', over: false });
    assert.deepEqual(capState(6), { text: '6/5', over: true });
  });
});

describe('bandChipHtml', () => {
  it('prints P0, P1, P2 or -- with the band in data-band', () => {
    assert.match(bandChipHtml(lane('a', 'P0')), /^<span class="bchip" data-band="P0"[^>]*>P0</);
    assert.match(bandChipHtml(lane('a', 'P2')), /data-band="P2"[^>]*>P2</);
    assert.match(bandChipHtml(lane('a', null)), /data-band="none"[^>]*>--</);
  });

  it('never echoes a band string that is not on the whitelist', () => {
    const html = bandChipHtml(lane('a', '"><script>x</script>'));
    assert.ok(!html.includes('<script>') && !html.includes('x</script>'), html);
    assert.match(html, /data-band="none"/);
  });

  it('takes the CSS class of the card chip when asked', () => {
    assert.match(bandChipHtml(lane('a', 'P1'), 'kb-band'), /^<span class="kb-band" data-band="P1"/);
  });
});
