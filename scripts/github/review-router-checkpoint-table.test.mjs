// T2: the router's checkpoint as a state x event table (check C5). Run: node --test scripts/github/review-router-checkpoint-table.test.mjs
//
// The checkpoint (review-router.mjs: decide, checkpointOf) saves the pathway and the class (pclass) a person chose with /pathway.
// A class that rises later shows a "Class raised" note until /pathway runs again. Two CodeRabbit Majors on PR 217 were a state and
// an event that no test had paired: #43 (a re-pick of none after a raise did not clear the note) and #45 (a hand "Ready for review"
// click, with no /pathway marker, cleared it). This table lists every pair. A hole fails ST: tableProblems names the cell.
//
// States (what the router comment saved, and what the PR looks like now):
//   ready-raised  saved none/normal, the PR is ready, the class rose to infra after the checkpoint
//   draft-raised  saved none/normal, the class rose to infra while the PR was a draft (a draft run saves nothing)
//   ready-none    saved none/normal, the class is still normal
// Events: opened, reopened, synchronize, and four ways a PR becomes ready:
//   ready+marker        /pathway confirmed this head and the label's pathway
//   ready+consumed-marker  the marker was already used by an earlier ready event (its id is saved as consumed)
//   ready-no-marker     a person clicked "Ready for review": no marker
//   ready+old-marker    the only marker names an older head
//   ready+stranger-marker  the marker comes from an author without write access (author_association NONE)
//
// Break it (the cell that goes red; run the file, read the failing title):
//   #43 checkpointOf ignores the event, so a confirmed ready never saves the new class:     ready-raised + ready+marker,
//       draft-raised + ready+marker
//   #45 checkpointOf resets pclass on any ready_for_review, with no marker check:           ready-raised + ready-no-marker,
//       ready-raised + ready+old-marker
//   a used marker starts a second checkpoint (consumed ignored):                            ready-raised + ready+consumed-marker
//   a marker from any author counts (author_association ignored):                           ready-raised + ready+stranger-marker
//   synchronize, opened or reopened also resets pclass:                                     ready-raised + synchronize (and the two others)
//   a draft run saves a class:                                                              draft-raised + opened
//   the table loses a cell or a kind:                                                       T2 table is complete
//
// Era note: the marker helpers (renderPathwayMarker, confirmedPathways, later confirmedMarkers) do not exist before 75d6d032, and
// decide reads no markers before it. The arrange step takes them from the module namespace when they exist; the expected values
// never change. The consumed and author cells only mean something at a commit that has those rules; the proof rows name other cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as router from './review-router.mjs';
import { tableProblems } from '../checks/state-table.mjs';

const { decide } = router;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'review-router.config.json'), 'utf8'));
const BASE = { ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null } };
const NOW = new Date('2026-10-26T12:00:00Z');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const B = 'builder:claude';
const SAVED = { previousPathway: 'none', previousPclass: 'normal' };
const INFRA_FILES = ['.github/workflows/x.yml'];
const NORMAL_FILES = ['scripts/foo.mjs'];

const marker = (head, over = {}) => ({ id: 90, user: { login: 'Rev4nchist', type: 'User' }, author_association: 'OWNER', body: `${router.renderPathwayMarker?.(head, 'none') ?? ''}\nCheckpoint: none.`, ...over });
// HEAD reads markers with ids (confirmedMarkers); 75d6d032 reads plain pathways (confirmedPathways); before it, decide reads neither.
const confirmedFor = (comments, consumed) => (router.confirmedMarkers ?? router.confirmedPathways)?.(comments, HEAD, consumed) ?? [];

const STATES = {
  'ready-raised': { files: INFRA_FILES, labels: ['review:none', 'risk:infra', B], previousClass: 'infra', draftOnPush: false },
  'draft-raised': { files: INFRA_FILES, labels: ['review:none', B], previousClass: 'normal', draftOnPush: true },
  'ready-none': { files: NORMAL_FILES, labels: ['review:none', B], previousClass: 'normal', draftOnPush: false },
};
const EVENTS = {
  opened: { event: 'opened', comments: [] },
  reopened: { event: 'reopened', comments: [] },
  synchronize: { event: 'synchronize', comments: [] },
  'ready+marker': { event: 'ready_for_review', comments: [marker(HEAD)] },
  'ready+consumed-marker': { event: 'ready_for_review', comments: [marker(HEAD)], consumed: 90 },
  'ready-no-marker': { event: 'ready_for_review', comments: [] },
  'ready+old-marker': { event: 'ready_for_review', comments: [marker(OLD_HEAD)] },
  'ready+stranger-marker': { event: 'ready_for_review', comments: [marker(HEAD, { author_association: 'NONE' })] },
};
const PUSH_EVENTS = new Set(['opened', 'reopened', 'synchronize']);

/** Run decide for one (state, event). A PR that is still a draft when a push event arrives stops as a draft. */
function act(stateId, eventId) {
  const s = STATES[stateId];
  const e = EVENTS[eventId];
  const draft = s.draftOnPush && PUSH_EVENTS.has(eventId);
  const pr = { number: 7, head: HEAD, draft, state: 'open', paths: s.files };
  return decide(e.event, pr, s.labels, s.previousClass, BASE, { now: NOW, ...SAVED, previousConsumed: e.consumed ?? null, confirmed: confirmedFor(e.comments, e.consumed ?? null) });
}

// expect: pclass = what the run saves (null: it saves nothing); note = whether the "Class raised" note is shown.
const KEEP = { pclass: 'normal', note: true };
const REDONE = { pclass: 'infra', note: false };
const CALM = { pclass: 'normal', note: false };
const DRAFT = { pclass: null, note: false };

const cell = (state, event, expect) => ({ state, event, expect: `pclass ${expect.pclass ?? 'unsaved'}, note ${expect.note ? 'shown' : 'gone'}`, want: expect });
const states = Object.keys(STATES);
const events = Object.keys(EVENTS);
const cells = [
  cell('ready-raised', 'opened', KEEP),
  cell('ready-raised', 'reopened', KEEP),
  cell('ready-raised', 'synchronize', KEEP),
  cell('ready-raised', 'ready+marker', REDONE),
  cell('ready-raised', 'ready+consumed-marker', KEEP),
  cell('ready-raised', 'ready-no-marker', KEEP),
  cell('ready-raised', 'ready+old-marker', KEEP),
  cell('ready-raised', 'ready+stranger-marker', KEEP),
  cell('draft-raised', 'opened', DRAFT),
  cell('draft-raised', 'reopened', DRAFT),
  cell('draft-raised', 'synchronize', DRAFT),
  cell('draft-raised', 'ready+marker', REDONE),
  cell('draft-raised', 'ready+consumed-marker', KEEP),
  cell('draft-raised', 'ready-no-marker', KEEP),
  cell('draft-raised', 'ready+old-marker', KEEP),
  cell('draft-raised', 'ready+stranger-marker', KEEP),
  ...events.map((event) => cell('ready-none', event, CALM)),
];

// Each kind of state bug and the events that cover it. A router has no timer, so that kind is na.
const kinds = {
  'stale-read': ['ready+old-marker'],
  duplicate: ['ready+consumed-marker'],
  'second-entry': ['ready-no-marker', 'ready+stranger-marker'],
  'timer-overlap': { na: 'the router answers one webhook event at a time and keeps no timer or background read' },
  'retained-flag': ['ready+marker'],
};

test('T2 table is complete', () => {
  assert.deepEqual(tableProblems({ states, events, cells, kinds }), []);
});

test('T2 the marker helpers exist at this commit, so no cell runs on the empty fallback', () => {
  // The era fallback in confirmedFor() only serves old commits. A rename at HEAD would turn every marker cell into a no-marker run.
  assert.equal(typeof (router.confirmedMarkers ?? router.confirmedPathways), 'function');
  assert.equal(typeof router.renderPathwayMarker, 'function');
});

for (const c of cells) {
  test(`T2 ${c.state} + ${c.event} -> ${c.expect}`, () => {
    const d = act(c.state, c.event);
    const note = /Class raised/.test(d.comment ?? '');
    assert.equal(d.pclass, c.want.pclass, `${c.state} + ${c.event}: the saved pclass (reason ${d.reason})`);
    assert.equal(note, c.want.note, `${c.state} + ${c.event}: the Class raised note (reason ${d.reason}, comment ${JSON.stringify(d.comment)})`);
  });
}
