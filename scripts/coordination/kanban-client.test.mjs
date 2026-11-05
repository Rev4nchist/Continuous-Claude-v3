/**
 * kanban-client.test -- runs the real browser half of the Priorities kanban (kanban-client.js) in a vm, against a fake DOM
 * and a fake artifact `db`, and checks what the page WRITES. A headless run has no `window.claude`, so this is the only
 * check of the page-side save before Dave moves a card on a published page.
 *
 * The source is assembled the way render-board.mjs inlines it: the helper functions of kanban-place.mjs as text, then
 * `var KB_BOARD`, then kanban-client.js. (A test in render-board.test.mjs checks that the rendered page inlines the same helpers.)
 * The fake db keeps the documented contract of db.d.ts: `set` replaces the whole doc, `update` merges nested objects and
 * replaces arrays, and `update` on a missing doc rejects `invalid_argument`.
 *
 * How the page save can fail, one test each:
 *   - a page published to the wrong artifact saves over another board's order (guard on load)
 *   - the other board's order arrives live, or between the first read and the first save (guard on snapshot and on the pre-write read)
 *   - a move waiting in the debounce window is written after the page went foreign
 *   - the save replaces the whole doc and drops appliedColumns and syncedAt (kanban-apply then counts every lane as changed)
 *   - the page writes appliedColumns or syncedAt itself
 *   - the first save on a new board is an update (rejected) or the save never stamps `board`
 *   - a stale "no doc" view makes `set` replace a doc another device created
 *   - a stale device drops lanes it does not know, or merges back lanes it does know
 *   - a doc deleted under the page makes the save fail instead of creating it
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as place from './kanban-place.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8');
const HELPERS = [
  place.placeLanes, place.stampMs, place.isPending, place.syncState, place.fnv1a, place.hashFields, place.cardBase, place.cardDiff,
  place.plainPrompt, place.boardMismatch, place.boardWriteKind, place.mergeUnknownColumns,
];
const DOC = 'kanban/board';
const SYNCED = '2026-11-04T10:00:00.000Z';
const APPLIED = { now: [], next: ['a1', 'a2'], later: ['a3'], waiting: [] };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function merge(into, from) {
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  return out;
}

/** The artifact db, as documented in db.d.ts. `log` holds every write the page tried, rejected ones too. */
function fakeDb(initial = {}, { liveDoc = true, getFails = null } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, clone(v)]));
  const listeners = new Map();
  const log = [];
  let cardSubs = 0;
  let cardUnsubs = 0;
  const cardListeners = [];
  let heldGets = null;
  const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)), metadata: { fromCache: false, hasPendingWrites: false } });
  const notify = (p) => { for (const next of listeners.get(p) || []) next(snap(p)); };
  const ref = (p) => ({
    path: p,
    get: () => {
      if (getFails) return Promise.reject(getFails);
      if (heldGets) return new Promise((resolve) => heldGets.push(() => resolve(snap(p))));
      return Promise.resolve(snap(p));
    },
    set(data) {
      log.push({ op: 'set', path: p, data: clone(data) });
      store.set(p, clone(data));
      notify(p);
      return Promise.resolve();
    },
    update(data) {
      if (!store.has(p)) {
        log.push({ op: 'update', path: p, data: clone(data), rejected: true });
        return Promise.reject({ code: 'invalid_argument', message: 'no such document' });
      }
      log.push({ op: 'update', path: p, data: clone(data) });
      store.set(p, merge(store.get(p), clone(data)));
      notify(p);
      return Promise.resolve();
    },
    onSnapshot(next) {
      listeners.set(p, [...(listeners.get(p) || []), next]);
      // liveDoc: false is a page whose realtime stream has not answered yet: the load alone must already refuse a foreign doc.
      if (liveDoc) Promise.resolve().then(() => next(snap(p)));
      return () => {};
    },
  });
  const cardSnap = (docs) => ({ docs: Object.entries(docs).map(([id, data]) => ({ id, data: () => clone(data) })) });
  return {
    api: {
      doc: ref,
      collection: () => ({
        doc: (id) => ref(`cards/${id}`),
        onSnapshot(next) {
          cardSubs += 1;
          const sub = { next, live: true };
          cardListeners.push(sub);
          Promise.resolve().then(() => next({ docs: [] }));
          return () => { if (sub.live) cardUnsubs += 1; sub.live = false; };
        },
      }),
    },
    log,
    /** How many times the page subscribed to the card notes. */
    cardSubs: () => cardSubs,
    /** How many times the page cancelled its card-notes subscription. */
    cardUnsubs: () => cardUnsubs,
    /** The card docs change; only a subscription that was not cancelled hears it. */
    pushCards(docs) { for (const l of cardListeners) if (l.live) l.next(cardSnap(docs)); },
    /** A card snapshot already queued when the subscription was cancelled: it still reaches the page. */
    pushCardsLate(docs) { for (const l of cardListeners) l.next(cardSnap(docs)); },
    /** From now on a read waits until releaseGets(): a lock can then land while the page waits for it. */
    holdGets() { heldGets = []; },
    /** The waiting reads answer with the doc as it is now. */
    releaseGets() { const waiting = heldGets || []; heldGets = null; for (const r of waiting) r(); },
    /** A write by another device that this page has not been told about (no snapshot). */
    seed: (p, data) => store.set(p, clone(data)),
    remove: (p) => store.delete(p),
    /** A write by another device that reaches the page by snapshot. */
    push(p, data) { store.set(p, clone(data)); notify(p); },
    read: (p) => clone(store.get(p)),
    writes: () => log.filter((e) => !e.rejected),
  };
}

function stub({ attrs: seed = {}, ...extra } = {}) {
  const attrs = { ...seed };
  const handlers = {};
  return {
    attrs,
    handlers,
    children: [],
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    querySelector: () => stub(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    insertBefore() {},
    ...extra,
  };
}

const LANES = [
  { id: 'a1', state: 'ready', priority: 1, title: 'A1' },
  { id: 'a2', state: 'ready', priority: 2, title: 'A2' },
  { id: 'a3', state: 'backlog', priority: 3, title: 'A3' },
  { id: 'a4', state: 'done', priority: 4, title: 'A4' },
];

/** Opens the page and waits until the saved order has loaded (or the page has refused it). */
async function openPage({ board = 'zz-a', doc = null, lanes = LANES, noDb = false, liveDoc = true, getFails = null } = {}) {
  const db = fakeDb(doc ? { [DOC]: doc } : {}, { liveDoc, getFails });
  const timers = [];
  const parts = new Map();
  /** One element per card and selector, so a test can read what the page painted into a field. */
  const partOf = (id, sel) => {
    const key = id + ' ' + sel;
    if (!parts.has(key)) parts.set(key, stub());
    return parts.get(key);
  };
  const cardEls = new Map(lanes.filter((l) => l.state !== 'done').map((l) => [l.id, stub({
    attrs: { 'data-id': l.id, 'data-hash': 'h' },
    querySelector: (sel) => partOf(l.id, sel),
  })]));
  const colEls = ['now', 'next', 'later', 'waiting', 'progress'].map((name) => stub({
    attrs: { 'data-col': name },
    querySelector: (sel) => (sel === '.kb-list' ? stub({ children: [] }) : stub()),
  }));
  const els = { 'kb-status': stub(), 'kb-order': stub({ hidden: true }), 'kb-live': stub(), 'kb-data': stub({ textContent: JSON.stringify(lanes) }) };
  els['kb-board'] = stub({
    querySelectorAll: (sel) => (sel === '.kb-card' ? [...cardEls.values()] : sel === '.kcol' ? colEls : []),
  });
  const document = {
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    visibilityState: 'visible',
  };
  const claude = { use: (name) => (name === 'db' && !noDb ? Promise.resolve(db.api) : Promise.resolve(null)) };
  const sandbox = {
    document,
    window: { claude },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const source = `${HELPERS.map((f) => f.toString()).join('\n')}\nvar KB_BOARD = ${JSON.stringify(board)};\n${CLIENT}`;
  vm.runInNewContext(source, sandbox, { filename: 'kanban-client.inlined.js' });
  await settle();
  return {
    db,
    status: () => els['kb-status'].textContent,
    chipHidden: () => els['kb-order'].hidden,
    /** The Move control of a card, like a change event of its select. */
    async move(id, col) {
      const target = { classList: { contains: (c) => c === 'kb-to' }, closest: () => cardEls.get(id), value: col };
      for (const f of els['kb-board'].handlers.change || []) f({ target });
      await settle();
    },
    /** A card field (.kb-note, .kb-q, .kb-sync, ...) as the page painted it. */
    part: partOf,
    /** The Save button of a card's notes form, like a click on it. */
    async clickSave(id) {
      const target = { closest: (sel) => (sel === '.kb-save' ? { closest: () => cardEls.get(id) } : null) };
      for (const f of els['kb-board'].handlers.click || []) f({ target });
      await settle();
    },
    /** The start of a drag on the grip of a card, like a dragstart event. */
    dragStart(id) {
      const grip = { closest: () => cardEls.get(id) };
      const target = { closest: (sel) => (sel === '.kb-grip' ? grip : null) };
      const dataTransfer = { setData() {}, setDragImage() {} };
      for (const f of els['kb-board'].handlers.dragstart || []) f({ target, dataTransfer, preventDefault() {} });
    },
    /** A drop on a column, like a drop event. */
    async drop(colName) {
      const col = colEls.find((c) => c.attrs['data-col'] === colName);
      const target = { closest: (sel) => (sel === '.kcol' ? col : null) };
      for (const f of els['kb-board'].handlers.drop || []) f({ target, clientY: 0, preventDefault() {} });
      await settle();
    },
    /** Lets the 800 ms save debounce run. */
    async debounce() {
      for (const t of timers.splice(0)) if (t.fn && t.ms === 800) t.fn();
      await settle();
    },
    async moveAndSave(id, col) { await this.move(id, col); await this.debounce(); },
  };
}

const board = (extra = {}) => ({ columns: clone(APPLIED), updatedAt: '2026-11-04T09:00:00.000Z', ...extra });
/** The fields only kanban-sync writes. */
const SYNC_FIELDS = ['appliedColumns', 'syncedAt'];
const assertNoSyncFields = (writes) => {
  for (const w of writes) for (const f of SYNC_FIELDS) assert.ok(!(f in w.data), `the page wrote ${f} (${w.op})`);
};

for (const liveDoc of [true, false]) {
  test(`a doc stamped with another board: the page refuses it, says so, and never writes (realtime stream ${liveDoc ? 'answers' : 'silent'})`, async () => {
    const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-other', syncedAt: SYNCED }), liveDoc });
    assert.match(page.status(), /This page belongs to board zz-a, but the saved order is for board zz-other/);
    await page.moveAndSave('a2', 'now');
    assert.deepEqual(page.db.log, [], 'a foreign page wrote to the other board\'s doc');
  });
}

test('a board doc that cannot be read: the page cannot verify its board, so it subscribes to no card notes, writes nothing and says so', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-other', syncedAt: SYNCED }), getFails: new Error('boom') });
  assert.match(page.status(), /^Board order not loaded: boom$/);
  assert.equal(page.db.cardSubs(), 0, 'card notes of an artifact whose board could not be verified were subscribed');
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log, [], 'an unverified page wrote');
});

test('no db handle (claude.use returned null): read-only, no card notes, no writes', async () => {
  const page = await openPage({ board: 'zz-a', noDb: true });
  assert.match(page.status(), /sign in to save an order/);
  assert.equal(page.db.cardSubs(), 0);
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log, []);
});

test('positive control: the same moves on a matching doc do write (so the refusal above is the guard)', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  await page.moveAndSave('a2', 'now');
  assert.equal(page.db.writes().length, 1);
});

test('the other board\'s order arriving live locks the page, and drops a move still in the debounce window', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  await page.move('a2', 'now');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await settle();
  assert.match(page.status(), /belongs to board zz-a, but the saved order is for board zz-other/);
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'the pending move was written after the page went foreign');
  await page.moveAndSave('a1', 'later');
  assert.deepEqual(page.db.log, [], 'a locked page accepted another move');
});

test('a doc with no board field is an old doc: allowed, and the first save stamps the board and keeps appliedColumns and syncedAt', async () => {
  const old = board({ appliedColumns: clone(APPLIED), syncedAt: SYNCED });
  const page = await openPage({ board: 'continuous-claude', doc: old });
  assert.doesNotMatch(page.status(), /belongs to board/);
  await page.moveAndSave('a2', 'now');
  const writes = page.db.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'update', 'set would replace the whole doc');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['board', 'columns', 'updatedAt']);
  assert.equal(writes[0].data.board, 'continuous-claude');
  assert.deepEqual(writes[0].data.columns, { now: ['a2'], next: ['a1'], later: ['a3'], waiting: [] });
  assertNoSyncFields(writes);
  const saved = page.db.read(DOC);
  assert.equal(saved.syncedAt, SYNCED, 'the save dropped syncedAt');
  assert.deepEqual(saved.appliedColumns, APPLIED, 'the save dropped appliedColumns');
  assert.equal(saved.board, 'continuous-claude');
});

test('the first save on a new board creates the doc with set, stamped with the board, and tries no update first', async () => {
  const page = await openPage({ board: 'zz-a', doc: null });
  assert.match(page.status(), /No saved order yet/);
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log.map((e) => e.op), ['set']);
  const [w] = page.db.writes();
  assert.deepEqual(Object.keys(w.data).sort(), ['board', 'columns', 'updatedAt']);
  assert.equal(w.data.board, 'zz-a');
  assertNoSyncFields([w]);
  // The second save finds the doc and merges into it.
  await page.moveAndSave('a1', 'later');
  assert.deepEqual(page.db.log.map((e) => e.op), ['set', 'update']);
});

test('a doc another device created after this page loaded with no doc is updated, not replaced', async () => {
  const page = await openPage({ board: 'zz-a', doc: null });
  page.db.seed(DOC, board({ board: 'zz-a', appliedColumns: clone(APPLIED), syncedAt: SYNCED }));
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log.map((e) => e.op), ['update']);
  const saved = page.db.read(DOC);
  assert.equal(saved.syncedAt, SYNCED);
  assert.deepEqual(saved.appliedColumns, APPLIED);
});

test('a doc another device created for ANOTHER board after this page loaded with no doc is not written to', async () => {
  const page = await openPage({ board: 'zz-a', doc: null });
  page.db.seed(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log, []);
  assert.match(page.status(), /saved order is for board zz-other/);
});

test('a doc deleted under the page after load: the save creates it with set instead of failing', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.remove(DOC);
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log.map((e) => `${e.op}${e.rejected ? ':rejected' : ''}`), ['update:rejected', 'set']);
  assert.equal(page.db.read(DOC).board, 'zz-a');
  assert.doesNotMatch(page.status(), /Save failed/);
});

test('ids the page does not know come back in their saved column; ids it knows are placed by the page; done ids are not kept', async () => {
  const doc = board({
    board: 'zz-a',
    columns: { now: ['ghost', 'a4'], next: ['a1', 'a2'], later: ['a3', 'ghost2'], waiting: [] },
    appliedColumns: clone(APPLIED),
    syncedAt: SYNCED,
  });
  const page = await openPage({ board: 'zz-a', doc });
  await page.moveAndSave('a2', 'later');
  const [w] = page.db.writes();
  // a2 moved next -> later. ghost and ghost2 are unknown to this page and survive; a4 is a known (done) lane, so it is dropped.
  assert.deepEqual(w.data.columns, { now: ['ghost'], next: ['a1'], later: ['a3', 'a2', 'ghost2'], waiting: [] });
  assertNoSyncFields([w]);
});

test('the page never writes appliedColumns or syncedAt, even when the doc it loaded carries them (set and update paths)', async () => {
  const withSync = board({ board: 'zz-a', appliedColumns: clone(APPLIED), syncedAt: SYNCED });
  for (const doc of [null, withSync]) {
    const page = await openPage({ board: 'zz-a', doc });
    await page.moveAndSave('a2', 'now');
    await page.moveAndSave('a1', 'waiting');
    assert.ok(page.db.writes().length >= 2);
    assertNoSyncFields(page.db.writes());
  }
});

test('after a save the order is pending again: the chip shows and syncedAt is still the sync\'s', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED, updatedAt: '2026-11-04T09:00:00.000Z' }) });
  assert.equal(page.chipHidden(), true, 'a synced order shows no chip');
  await page.moveAndSave('a2', 'now');
  assert.equal(page.chipHidden(), false, 'a saved move is not yet synced');
});

// Card notes after the page locks. Not shown on a foreign board: the lock must also stop what a card snapshot paints.
const CARD = { note: 'note of board A', question: 'q of board A', updatedAt: '2026-11-04T09:30:00.000Z', syncedAt: SYNCED };

async function lockedAfterLoad() {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.pushCards({ a1: CARD });
  assert.equal(page.part('a1', '.kb-note').value, CARD.note, 'setup: the matching board paints its card notes');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await settle();
  assert.match(page.status(), /belongs to board zz-a, but the saved order is for board zz-other/, 'setup: the page locked');
  return page;
}

test('positive control: on a matching board a card note edit saves to the card doc', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.pushCards({ a1: CARD });
  page.part('a1', '.kb-note').value = 'edited';
  await page.clickSave('a1');
  assert.deepEqual(page.db.writes().map((e) => e.path), ['cards/a1']);
});

test('the lock clears the card notes already shown, the sync chip and the card state', async () => {
  const page = await lockedAfterLoad();
  assert.equal(page.part('a1', '.kb-note').value, '', 'a foreign page still shows the note');
  assert.equal(page.part('a1', '.kb-q').value, '', 'a foreign page still shows the question');
  assert.equal(page.part('a1', '.kb-sync').hidden, true, 'a foreign page still shows the sync chip');
});

test('after the lock a card snapshot paints nothing: not the notes, not the sync chip', async () => {
  const page = await lockedAfterLoad();
  page.db.pushCardsLate({ a1: { ...CARD, note: 'late note' }, a2: { note: 'a2 note', syncedAt: SYNCED } });
  await settle();
  assert.equal(page.part('a1', '.kb-note').value, '', 'a card snapshot painted a note after the lock');
  assert.equal(page.part('a2', '.kb-note').value, '');
  assert.equal(page.part('a1', '.kb-sync').hidden, true, 'a card snapshot painted the sync chip after the lock');
});

test('the lock cancels the card-notes subscription', async () => {
  const page = await lockedAfterLoad();
  assert.equal(page.db.cardUnsubs(), 1, 'the page kept listening to the card notes of another board');
  page.db.pushCards({ a1: { ...CARD, note: 'live note' } });
  await settle();
  assert.equal(page.part('a1', '.kb-note').value, '');
});

test('after the lock the card fields are off and a card save writes nothing', async () => {
  const page = await lockedAfterLoad();
  assert.equal(page.part('a1', '.kb-note').disabled, true, 'the note field is still editable');
  assert.equal(page.part('a1', '.kb-q').disabled, true, 'the question field is still editable');
  assert.equal(page.part('a1', '.kb-save').disabled, true, 'the Save button is still on');
  page.part('a1', '.kb-note').value = 'typed after the lock';
  await page.clickSave('a1');
  await page.moveAndSave('a2', 'now');
  assert.deepEqual(page.db.log, [], 'a locked page wrote');
});

test('a card save in flight when the page locks does not bring the card state back', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.pushCards({ a1: CARD });
  page.part('a1', '.kb-note').value = 'edited';
  const saving = page.clickSave('a1');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await saving;
  await settle();
  assert.equal(page.part('a1', '.kb-sync').hidden, true, 'the finished save repainted the sync chip of a locked page');
});

test('a card note whose read is still waiting when the page locks is not written to the other board', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.part('a1', '.kb-note').value = 'note for a card with no doc';
  page.db.holdGets();
  await page.clickSave('a1');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await settle();
  const lockText = page.status();
  assert.match(lockText, /saved order is for board zz-other/, 'setup: the page locked');
  page.db.releaseGets();
  await settle();
  assert.deepEqual(page.db.writes().filter((w) => w.path.startsWith('cards/')), [], 'a locked page wrote a card note into the other board');
  assert.equal(page.status(), lockText, 'the lock message changed');
});

test('a card note rejected as invalid_argument, then read while the page locks, is not written either', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.pushCards({ a1: CARD });
  page.part('a1', '.kb-note').value = 'edited';
  page.db.holdGets();
  await page.clickSave('a1');
  assert.equal(page.db.log.filter((w) => w.rejected).length, 1, 'setup: the update was rejected and the read is waiting');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await settle();
  page.db.releaseGets();
  await settle();
  assert.deepEqual(page.db.writes().filter((w) => w.path.startsWith('cards/')), [], 'a locked page wrote a card note into the other board');
});

test('a drop that arrives after the lock moves nothing and keeps the lock message', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.dragStart('a2');
  page.db.push(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await settle();
  const lockText = page.status();
  assert.match(lockText, /saved order is for board zz-other/, 'setup: the page locked');
  await page.drop('now');
  assert.equal(page.status(), lockText, 'the drop replaced the lock message');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a locked page wrote after a drop');
});
