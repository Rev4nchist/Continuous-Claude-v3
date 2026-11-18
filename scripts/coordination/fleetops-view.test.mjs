/**
 * fleetops-view.test -- tests for the FleetOps view model (card coord-fleetops-notion). The consumer is the FleetOps HTML embed.
 *
 * Every id, title and number here is MADE UP (fixtures/fleetops-mini). The fake id list is passed straight in: a digit id written "#4242" or
 * "PR 4242" in context, and a 10-char hex sha with letters. No real id list is read.
 *
 * How the view can fail, one test each (the source change that breaks it is in the test name):
 *   1. a listed id survives in a title, id, goal or holder, most of all in a title that is cut at 60 (mask removed, or the cut runs before it)
 *   2. a listed id split by spaces or by a zero-width character survives (mask runs before the whitespace clean)
 *   3. one ask date shows two ages (UTC date instead of the CST calendar day)
 *   4. the pile shows a second figure, or its window is 7 snapshots (6 days) and not 7 calendar days, or a missing day 7 back breaks it
 *   5. "since the peak" has the wrong sign or base
 *   6. asks are not P0 first then oldest first, or the fold groups are not oldest first
 *   7. a text cut breaks a word
 *   8. a wip row has no project, projects with a decision are not first, a state is wrong
 *   9. daily has no column names, or fewer names than numbers
 *  10. the P0 cap is not a number
 *  11. a retired source (tile text, board_url, no_end) reaches the view
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countListed } from './board-mask.mjs';
import { buildView, cstDayDiff, cutWords } from './fleetops-view.mjs';
import { NAME_CLIP } from './session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fleetops-mini');
const KEYS = ['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots'];
const IDS = ['4242', 'abc1234def'];

const files = () => Object.fromEntries(KEYS.map((k) => [k, JSON.parse(readFileSync(join(FIXTURE, `${k}.json`), 'utf8'))]));
const viewOf = (f = files(), ids = IDS) => buildView(f, ids);
const base = (o) => ({
  id: 'x', title: 'x', project: 'alpha', band: null, state: 'ready', created_at: '2026-11-10T15:00:00.000Z', last_work_at: null, dave_ask_at: null,
  held: false, goal: null, holder: null, lease_expires_at: null, ...o,
});
const askAt = (ageDays) => `2026-11-${String(17 - ageDays).padStart(2, '0')}T16:00:00.000Z`;

describe('listed ids', () => {
  it('1. none is left in title, id, goal or holder, also in a title cut at 60 (break: maskListed removed, or the cut runs before it)', () => {
    const f = files();
    const row = f.lanes.rows[0];
    const at = row.title.indexOf('abc1234def');
    assert.ok(at + 7 <= 60 && at + 10 > 60, 'the fixture id must straddle character 60');
    assert.ok(countListed(row.title.slice(0, 60), IDS) > 0, 'a cut before the mask would leak a partial sha');
    const view = viewOf(f);
    assert.equal(countListed(JSON.stringify(view), IDS), 0);
    assert.ok(view.masked > 0);
    const held = view.wip.rows.find((r) => r.id.startsWith('key-'));
    assert.ok(held.id.includes('masked-id') && held.goal.includes('masked-id') && held.holder.includes('masked-id'));
    assert.ok(held.goal.includes('PR masked-id'), 'the context word stays');
  });

  it('2a. an id split by 7 spaces is masked: the mask runs after the whitespace clean (break: mask before clean)', () => {
    const f = files();
    f.lanes.rows[1].title = `see PR${' '.repeat(7)}4242.md now`;
    const view = viewOf(f);
    const ask = view.asks.main.find((r) => r.id === 'timed-reminders');
    assert.equal(ask.title, 'see PR masked-id.md now');
  });

  it('2b. an id split by a zero-width character is masked (break: the zero-width strip removed from clean)', () => {
    const f = files();
    f.lanes.rows[1].title = 'see PR 42\u200b42 now';
    const ask = viewOf(f).asks.main.find((r) => r.id === 'timed-reminders');
    assert.equal(ask.title, 'see PR masked-id now');
  });
});

/** Invisible and bidi characters, written as char codes: a source escape can turn into a raw character in this file. */
const LRM = String.fromCharCode(0x200e);
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const TAG_A = String.fromCodePoint(0xe0041);
const fullwidth = (s) => [...s].map((c) => (c === '#' ? String.fromCharCode(0xff03) : /\d/.test(c) ? String.fromCharCode(0xff10 + Number(c)) : c)).join('');

describe('invisible, bidi and compatibility characters', () => {
  const titleOf = (title) => viewOf(withTitle(title)).asks.main.find((r) => r.id === 'timed-reminders').title;
  const withTitle = (title) => { const f = files(); f.lanes.rows[1].title = title; return f; };

  it('2c. an id split by a left-to-right mark is masked (break: the Default_Ignorable strip is only the zero-width list)', () => {
    assert.equal(titleOf(`see PR 42${LRM}42 now`), 'see PR masked-id now');
  });

  it('2d. a fullwidth id is masked: NFKC turns it into #4242 (break: normalize removed from clean)', () => {
    assert.equal(fullwidth('#4242'), String.fromCharCode(0xff03, 0xff14, 0xff12, 0xff14, 0xff12));
    assert.equal(titleOf(`see ${fullwidth('#4242')} now`), 'see #masked-id now');
  });

  it('2e. a bidi override leaves the view: the title shows the plain code-point order and holds no control (break: the bidi range removed)', () => {
    const t = titleOf(`see PR ${RLO}2424${PDF} now`);
    assert.equal(t, 'see PR 2424 now');
    assert.ok(![...t].some((c) => [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].includes(c.codePointAt(0))));
  });

  it('2f. a tag character (U+E0000 range) and a variation selector are stripped (break: the \\p{Default_Ignorable_Code_Point} class removed)', () => {
    assert.equal(titleOf(`see PR 42${TAG_A}42 now`), 'see PR masked-id now');
    assert.equal(titleOf(`a${String.fromCharCode(0xfe0f)}b`), 'ab');
  });

  it('2g. band and state are masked too (break: band or state shown without c.mask)', () => {
    const f = files();
    f.lanes.rows[4].band = 'P1 #4242';
    f.lanes.rows[4].state = 'PR 4242';
    const row = viewOf(f).asks.main.find((r) => r.id === 'old-ask-lane');
    assert.deepEqual([row.band, row.state], ['P1 #masked-id', 'PR masked-id']);
  });
});

describe('ages', () => {
  it('3. a 23:30 CST ask is 11 d, a DST change does not move a day (break: UTC date diff)', () => {
    assert.equal(cstDayDiff('2026-11-07T05:30:00.000Z', '2026-11-17T17:30:02.680Z'), 11);
    assert.equal(cstDayDiff('2026-10-31T05:30:00Z', '2026-11-02T05:30:00Z'), 1, 'CST days, not UTC days');
    assert.equal(cstDayDiff('2026-10-31T12:00:00.000Z', '2026-11-02T12:00:00.000Z'), 2);
    const row = viewOf().asks.main.find((r) => r.id === 'timed-reminders');
    assert.equal(row.age, 11);
    assert.equal(row.asked, '6 Nov');
  });
});

describe('pile', () => {
  it('4a. one figure: open now minus open 7 calendar days before (break: 7 snapshots, or a tile text read)', () => {
    const p = viewOf().pile;
    assert.deepEqual([p.from, p.to, p.change, p.span, p.count], [104, 130, 26, 7, 8]);
    assert.ok(!JSON.stringify(viewOf()).includes('7777'), 'the tile text is never read');
  });

  it('4b. a missing day 7 back starts at the next snapshot (break: exact-day lookup)', () => {
    const f = files();
    f.snapshots.rows = f.snapshots.rows.filter((r) => r.day !== '2026-11-10');
    const p = viewOf(f).pile;
    assert.deepEqual([p.from, p.change, p.span, p.count, p.first], [103, 27, 6, 7, '11 Nov']);
  });

  it('4c. fewer than 2 snapshots in the window give null, not a wrong change', () => {
    const f = files();
    f.snapshots.rows = f.snapshots.rows.slice(0, 1);
    assert.equal(viewOf(f).pile, null);
  });

  it('5. sincePeak is the last open count minus the highest in the window; 0 at the peak (break: sign or base)', () => {
    assert.equal(viewOf().pile.sincePeak, 0);
    const f = files();
    f.snapshots.rows.find((r) => r.day === '2026-11-16').open = 135;
    const p = viewOf(f).pile;
    assert.deepEqual([p.max, p.to, p.sincePeak, p.change], [135, 130, -5, 26]);
    f.snapshots.rows.unshift({ ...f.snapshots.rows[0], day: '2026-11-01', open: 400 });
    assert.equal(viewOf(f).pile.sincePeak, -5, 'a peak outside the 7 day window is not counted');
  });
});

describe('waiting on Dave', () => {
  it('6a. P0 first, then the oldest; a younger P0 goes before an older non-P0 (break: sort)', () => {
    const f = files();
    f.lanes.rows = [
      base({ id: 'a-old', title: 'older', band: 'P1', dave_ask_at: askAt(15) }),
      base({ id: 'b-p0', title: 'p0 young', band: 'P0', dave_ask_at: askAt(1) }),
      base({ id: 'c-p0', title: 'p0 older', band: 'P0', dave_ask_at: askAt(4) }),
      base({ id: 'd-mid', title: 'mid', band: 'P2', dave_ask_at: askAt(9) }),
    ];
    assert.deepEqual(viewOf(f).asks.main.map((r) => r.id), ['c-p0', 'b-p0', 'a-old', 'd-mid']);
  });

  it('6b. a project with 3 recent asks folds, and fold groups are oldest first, not by size (break: fold sort)', () => {
    const f = files();
    const g = [7, 6, 5].map((n, i) => base({ id: `g${i}`, project: 'gamma', dave_ask_at: askAt(n) }));
    const e = [3, 2, 1, 1].map((n, i) => base({ id: `e${i}`, project: 'epsilon', dave_ask_at: askAt(n) }));
    f.lanes.rows = [...e, ...g, base({ id: 'lone', project: 'zeta', dave_ask_at: askAt(2) })];
    const a = viewOf(f).asks;
    assert.deepEqual(a.folds.map((x) => [x.name, x.rows.length, x.oldest]), [['Gamma work', 3, 7], ['epsilon', 4, 3]]);
    assert.deepEqual(a.other.map((r) => r.id), ['lone']);
    assert.equal(a.main.length, 0);
  });

  it('6c. the fixture: P0 11 d first, then the 15 d ask, 2 over a week', () => {
    const a = viewOf().asks;
    assert.deepEqual(a.main.map((r) => r.id), ['timed-reminders', 'old-ask-lane']);
    assert.equal(a.over, 2);
    assert.equal(a.total, 7);
  });
});

describe('cut', () => {
  it('7. a cut never breaks a word and adds an ellipsis (break: a hard slice)', () => {
    const f = files();
    f.lanes.rows[0].holder = 'Agentic OS redesign worker session that holds this lane for long';
    const held = viewOf(f).wip.rows.find((r) => r.id.startsWith('key-'));
    assert.ok(held.holder.endsWith('…') && held.holder.length <= 41);
    const words = held.holder.slice(0, -1).split(' ');
    assert.deepEqual(words, 'Agentic OS redesign worker session that holds this lane for long'.split(' ').slice(0, words.length));
    assert.equal(cutWords('alpha beta gamma', 8), 'alpha…');
    assert.equal(cutWords('averyveryverylongword tail', 5), 'averyveryverylongword…');
  });
});

describe('holder clipped by the export', () => {
  const holderOf = (name) => {
    const f = files();
    f.lanes.rows[0].holder = name;
    return viewOf(f).wip.rows.find((r) => r.id.startsWith('key-')).holder;
  };

  it('7b. a holder at the export clip length (16) with a space is cut back to its last whole word (break: the clip rule removed)', () => {
    assert.equal('Agentic OS redes'.length, NAME_CLIP);
    assert.equal(holderOf('Agentic OS redes'), 'Agentic OS…');
    assert.equal(holderOf('Review engine ab'), 'Review engine…', 'a full name of exactly 16 characters is cut too: the export gives no way to tell');
  });

  it('7c. shorter names, one long token and a clip that ended on a space stay whole', () => {
    assert.equal(holderOf('Agentic OS red'), 'Agentic OS red');
    assert.equal(holderOf('Agentic OS redesign'), 'Agentic OS redesign');
    assert.equal(holderOf('abcdefghijklmnop'), 'abcdefghijklmnop');
    assert.equal(holderOf('trex'), 'trex');
  });
});

describe('wip and projects', () => {
  it('8a. a wip row names its project (break: project missing from the wip row)', () => {
    const rows = viewOf().wip.rows;
    assert.equal(rows.find((r) => r.id === 'phone-page').project, 'Alpha board');
    assert.equal(rows.find((r) => r.id === 'lapsed-guard').project, 'Beta flow');
    assert.equal(rows.find((r) => r.id === 'lapsed-guard').lapsed, true);
  });

  it('8b. projects with a decision come first; Ongoing; an empty Unassigned is dropped (break: sort or the state map)', () => {
    const p = viewOf().projects;
    assert.equal(p[0].name, 'Beta flow');
    assert.equal(p[0].decision, true);
    assert.equal(p[0].state, 'Done · 2 open');
    assert.deepEqual(p.slice(1).map((x) => x.name), ['Alpha board', 'Gamma work', 'Delta tools']);
    assert.equal(p.find((x) => x.name === 'Gamma work').state, 'Ongoing');
  });

  it('8c. never started counts lanes with no work, a claimed lane included (break: counted by claim)', () => {
    const n = viewOf().never;
    assert.deepEqual([n.total, n.open, n.old], [7, 10, 3]);
  });
});

describe('daily and cap', () => {
  it('9. daily has a column name for each of its 10 numbers (break: columns missing)', () => {
    const d = viewOf().daily;
    assert.equal(d.columns.length, 10);
    assert.equal(d.columns[0], 'Day');
    assert.equal(d.columns[9], 'Never started');
    assert.ok(d.rows.every((r) => r.length === d.columns.length));
    assert.equal(d.rows.length, 9);
  });

  it('10. the P0 cap is a number or null, never a string from the file (break: the raw value copied)', () => {
    const f = files();
    f.targets.rows[0].value = '5';
    assert.equal(viewOf(f).p0.cap, 5);
    f.targets.rows[0].value = '</script><img src=x>';
    assert.equal(viewOf(f).p0.cap, null);
  });

  it('10b. the P0 cap is an integer 1..100 or null: null, blank, text, negative, zero, over 100, 1e9, hex, exponent text, true and a fraction give null (break: Number.isFinite back)', () => {
    const f = files();
    for (const bad of [null, '', '   ', 'abc', -1, 0, 101, 1e9, '0x10', '1e1', '5.0', 5.5, true, [], {}, '-3', '101']) {
      f.targets.rows[0].value = bad;
      assert.equal(viewOf(f).p0.cap, null, `value ${JSON.stringify(bad)}`);
    }
    for (const [good, want] of [[5, 5], ['5', 5], [1, 1], [100, 100], ['100', 100], [' 7 ', 7]]) {
      f.targets.rows[0].value = good;
      assert.equal(viewOf(f).p0.cap, want, `value ${JSON.stringify(good)}`);
    }
  });

  it('10c. no p0_cap row gives a null cap', () => {
    const f = files();
    f.targets.rows = f.targets.rows.filter((t) => t.key !== 'p0_cap');
    assert.equal(viewOf(f).p0.cap, null);
  });
});

describe('retired sources', () => {
  it('11. no board_url, no_end or artifact url reaches the view (break: the view reads meta.board_url or the raw status)', () => {
    const text = JSON.stringify(viewOf());
    for (const bad of ['board_url', 'no_end', 'FAKE-ARTIFACT', 'claude.ai/artifact']) assert.ok(!text.includes(bad), bad);
  });
});
