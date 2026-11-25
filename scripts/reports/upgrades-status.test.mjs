/**
 * upgrades-status.test -- the page of planned CCv3 upgrades (card ccv3-upgrades-status-page).
 * Every id in this file is MADE UP. The sources come in as arguments: no command runs here.
 *
 * How the page can fail, one test each:
 *   U1 a count on the page differs from the program status it was built from (planned is lanes minus done, in work and blocked)
 *   U2 a lane of the review-engine program (re-*) is counted a second time in the track groups, or a state lands in the wrong column
 *   U3 a source that is missing reads as zero and the page looks current: it must say "not checked" and count the missing source
 *   U4 an EMPTY source (no lanes, no waves, no items) passes as "nothing planned" instead of "not checked"
 *   U5 a ticked roadmap item, or an item outside the Planned section, shows as planned; a title keeps a 3-digit count
 *   U6 a listed id in a roadmap title stays on the page, or the page is made when one is left after the mask
 *   U7 the page shows a count of 100 or more, or a time that did not come from the clock argument, or no refresh command
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpgradesPage, parseRoadmapPlanned } from './upgrades-status.mjs';

const NOW = new Date('2026-11-25T21:10:00Z');
const program = {
  ok: true,
  go: true,
  counts: { lanes: 6, byState: { blocked: 1, backlog: 2, ready: 0, active: 1, review: 0, done: 2, 'no card': 0 } },
  waves: [
    { wave: 0, lanes: 3, done: 2, inWork: 0, blocked: 0 },
    { wave: 1, lanes: 3, done: 0, inWork: 1, blocked: 1 },
  ],
  nextDecisionPoint: { id: 'DP7', open: ['DP7.1', 'DP7.2'] },
};
const lane = (id, track, state) => ({ id, track, state, title: `title of ${id}`, scope: 's' });
const board = {
  lanes: [
    lane('re-x', 'review-engine', 'backlog'),
    lane('aa-1', 'coord', 'ready'),
    lane('aa-2', 'coord', 'backlog'),
    lane('aa-3', 'coord', 'active'),
    lane('aa-4', 'coord', 'blocked'),
    lane('bb-1', 'ops', 'review'),
  ],
};
const roadmap = [
  '# Roadmap', '## Current Focus', '- [ ] **Not planned, in focus** (high priority)',
  '## Planned',
  '- [ ] **Fix the gate with 8170 rows** (high priority). Long text. More text.',
  '- [x] **Ticked item** (low priority)',
  '- [ ] Plain item (medium priority)',
  '- [ ] **A very long title that keeps going and going well past the ninety character limit of the page, dated 2026-10-23, to be cut** (low priority)',
  '## Notes', '- [ ] **Not planned, a note** (low priority)',
].join('\n');
const brief = ['## 6. Build phases', '', '- **Phase 0. Land wave 1.** Exit: merged.', '- **Phase 1. Readers.** Exit: specs.', '', '## 7. Next'].join('\n');
const base = { now: NOW, program, board, roadmap, brief, ids: ['a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'] };
const build = (over = {}) => buildUpgradesPage({ ...base, ...over });

describe('upgrades-status', () => {
  it('U1 program counts equal the status, planned is lanes minus done, in work and blocked', () => {
    const r = build();
    const w1 = r.model.program.waves.find((w) => w.wave === 1);
    assert.deepEqual([w1.done, w1.inWork, w1.blocked, w1.planned], [0, 1, 1, 1]);
    assert.equal(r.model.program.lanes, 6);
    assert.equal(r.model.program.byState.done, 2);
    assert.match(r.pageMd, /review engine/i);
    assert.match(r.html, /<td[^>]*>1<\/td>/);
  });

  it('U2 re- lanes stay out of the track groups; ready and backlog are planned, active and review are in work', () => {
    const g = build().model.tracks;
    assert.equal(g.find((t) => t.track === 'review-engine'), undefined);
    const coord = g.find((t) => t.track === 'coord');
    assert.deepEqual([coord.planned, coord.inWork, coord.blocked], [2, 1, 1]);
    assert.deepEqual([g.find((t) => t.track === 'ops').inWork], [1]);
  });

  it('U3 a missing source is "not checked" and counted, never zero', () => {
    const r = build({ program: null });
    assert.equal(r.model.program, null);
    assert.deepEqual(r.notChecked, ['review engine program']);
    assert.match(r.pageMd, /not checked/i);
    assert.match(r.pageMd, /1 of 4 sources not checked/);
    assert.doesNotMatch(r.pageMd, /all sources checked/i);
  });

  it('U4 an empty source is "not checked", not "nothing planned"', () => {
    const r = build({ board: { lanes: [] }, roadmap: '# no planned section here', program: { ...program, waves: [] } });
    assert.deepEqual(r.notChecked.sort(), ['lane board', 'review engine program', 'roadmap planned items'].sort());
  });

  it('U5 only open Planned items show, titles are short, and a 3-digit count is gone', () => {
    const items = build().model.roadmap;
    assert.deepEqual(items.slice(0, 2).map((i) => i.title), ['Fix the gate with … rows', 'Plain item']);
    assert.deepEqual(items.map((i) => i.priority), ['high', 'medium', 'low']);
    assert.ok(items[2].title.length <= 90 && items[2].title.endsWith('…'));
    assert.match(build({ roadmapDate: '2026-10-23' }).pageMd, /committed copy of 2026-10-23/);
    assert.match(parseRoadmapPlanned('## Planned\n- [ ] **Ranked 2026-07-24 list** (low priority)')[0].title, /2026-07-24/);
  });

  it('U6 a listed id in a title is masked; one left after the mask stops the page', () => {
    const id = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const r = build({ roadmap: `## Planned\n- [ ] **Item for ${id.slice(0, 10)} here** (high priority)\n## Notes` });
    assert.doesNotMatch(r.pageMd + r.html, /a1b2c3d4e5/);
    assert.ok(r.masked > 0);
    assert.throws(() => build({ ids: [id], mask: (t) => ({ text: t, masked: 0 }), roadmap: `## Planned\n- [ ] **Item ${id}** (low priority)\n## Notes` }), /listed id/i);
  });

  it('U7 times come from the clock, no count of 100 or more, a refresh command is named', () => {
    const many = { lanes: Array.from({ length: 140 }, (_, i) => lane(`zz-${i}`, 'big', 'backlog')) };
    const r = build({ board: many });
    assert.equal(r.model.tracks.find((t) => t.track === 'big').planned, 140);
    assert.match(r.pageMd, /100\+/);
    const stripped = r.pageMd.replace(/2026-11-25 \d\d:\d\d CST/g, '').replace(/100\+/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '');
    assert.doesNotMatch(stripped, /\d{3,}/);
    assert.match(r.pageMd, /2026-11-25 15:10 CST/);
    assert.match(r.pageMd, /node scripts\/reports\/upgrades-status\.mjs/);
    assert.match(r.pageMd, /needs a word/i);
  });

  it('U8 program counts of 100 or more show as 100+ in both outputs (CLI finding 1)', () => {
    const big = { ...program, counts: { lanes: 140, byState: { blocked: 0, backlog: 140, ready: 0, active: 0, review: 0, done: 0, 'no card': 0 } }, waves: [{ wave: 0, lanes: 140, done: 0, inWork: 0, blocked: 0 }] };
    const r = build({ program: big });
    assert.equal(r.model.program.lanes, 140);
    assert.doesNotMatch(r.pageMd, /140/);
    assert.doesNotMatch(r.html, /140/);
    assert.match(r.pageMd, /100\+ lanes/);
    assert.match(r.html, /<td class="n">100\+<\/td>/);
  });

  it('U9 the dark-mode rule for a warning comes after the base rule, so it wins (CLI finding 2)', () => {
    const css = build().html.match(/<style>(.*?)<\/style>/s)[1];
    const base = css.indexOf('.nc{color:#8a5a00');
    const dark = css.indexOf('.nc{color:#f0b429');
    assert.ok(base >= 0 && dark >= 0);
    assert.ok(dark > base, 'the dark rule must come after the light rule');
  });
});
