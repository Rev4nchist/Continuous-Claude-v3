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
 *
 * How the card buttons (PR-C) can fail, one or two tests each:
 *   - Do next lands anywhere but Next index 0, or stays on at Next index 0 or on a read-only page
 *   - Move to Top or Bottom uses the wrong index (same-column Bottom is off by one), or a value that is no column writes
 *   - the Move select keeps showing a column name, or its 6 options are missing or filled twice
 *   - Top then Bottom does not return to the saved order (a write that changes nothing)
 *   - Done writes more than {status, updatedAt} (an unsaved note), writes the board doc, runs while saving or twice or before the cards loaded
 *   - the Done flag shows only on the device that tapped, or shows after the sync
 *   - Undo writes '' or the lane state read at render, not the status that was pending before Done, or leaves the flag up
 *   - the Status select or Save button fall out of step with the saved doc after Done or Undo
 *   - a Done write that fails looks like it worked
 *   - the band sentence shows when no lane is ahead, or is missing when one is; a stale flag stays after the next move
 *
 * How the Done column (PR-D) and the Scheduled column (PR-F) can fail. The page has six columns; the client moves cards in three (Next, Later, Waiting):
 *   - init throws because the phone collapse list names a column the page lacks (the stub has no Now column), or Done takes the place of In progress
 *   - on the phone Scheduled, Done or In progress starts open
 *   - a card dropped on Scheduled moves, or the saved doc still has a now key, or an old doc with columns.now fails to load or loses lanes
 *   - a card dropped on Done moves (dropTarget accepts a column that is not in COLS) and writes the board doc
 *   - the saved doc grows a done key
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as place from './kanban-place.mjs';
import { stripClientComments } from './kanban-strip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The behaviour tests run the text the page ships (render-board.mjs strips the comments with this same function). RAW is the file itself.
const RAW = fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8');
const CLIENT = stripClientComments(RAW);
/** Every element.focus() the page made, in order. Cleared by openPage. */
const focusLog = [];
const HELPERS = [
  place.placeLanes, place.stampMs, place.isPending, place.syncState, place.fnv1a, place.hashFields, place.cardBase, place.cardDiff,
  place.plainPrompt, place.boardMismatch, place.boardWriteKind, place.mergeUnknownColumns, place.bandAhead, place.doneChip,
];
const DOC = 'kanban/board';
const SYNCED = '2026-11-04T10:00:00.000Z';
const APPLIED = { next: ['a1', 'a2'], later: ['a3'], waiting: [] };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function merge(into, from) {
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  return out;
}

/** The artifact db, as documented in db.d.ts. `log` holds every write the page tried, rejected ones too. */
function fakeDb(initial = {}, { liveDoc = true, getFails = null, cardsSilent = false } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, clone(v)]));
  const listeners = new Map();
  const log = [];
  let cardSubs = 0;
  let cardUnsubs = 0;
  const cardListeners = [];
  let heldGets = null;
  let writeFails = null;
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
      if (writeFails) { log.push({ op: 'set', path: p, data: clone(data), rejected: true }); return Promise.reject(writeFails); }
      log.push({ op: 'set', path: p, data: clone(data) });
      store.set(p, clone(data));
      notify(p);
      return Promise.resolve();
    },
    update(data) {
      if (writeFails) { log.push({ op: 'update', path: p, data: clone(data), rejected: true }); return Promise.reject(writeFails); }
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
          if (!cardsSilent) Promise.resolve().then(() => next({ docs: [] }));
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
    /** From now on every write rejects with this error (null: writes work again). */
    failWrites(err) { writeFails = err; },
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
    focus() { focusLog.push(this); },
    insertBefore() {},
    appendChild(node) { this.children.push(node); return node; },
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
async function openPage({ board = 'zz-a', doc = null, lanes = LANES, noDb = false, liveDoc = true, getFails = null, cardsSilent = false, raw = false, phone = false, sched = null, schedN = null } = {}) {
  focusLog.length = 0;
  const db = fakeDb(doc ? { [DOC]: doc } : {}, { liveDoc, getFails, cardsSilent });
  const timers = [];
  const parts = new Map();
  /** One element per card and selector, so a test can read what the page painted into a field. */
  const partOf = (id, sel) => {
    const key = id + ' ' + sel;
    if (!parts.has(key)) parts.set(key, stub());
    return parts.get(key);
  };
  /** The flag box of each card: the element the page inserted before the card's controls. */
  const flagBoxes = new Map();
  const cardEls = new Map(lanes.filter((l) => l.state !== 'done').map((l) => [l.id, stub({
    attrs: { 'data-id': l.id, 'data-hash': 'h' },
    querySelector: (sel) => partOf(l.id, sel),
    insertBefore: (node) => { flagBoxes.set(l.id, node); },
  })]));
  const classes = new Map();
  const colEls = ['scheduled', 'next', 'later', 'waiting', 'progress', 'done'].map((name) => stub({
    attrs: name === 'scheduled' && schedN !== null ? { 'data-col': name, 'data-n': String(schedN) } : { 'data-col': name },
    classList: (() => {
      const set = new Set();
      classes.set(name, set);
      return { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) };
    })(),
    querySelector: (sel) => (sel === '.kb-list' ? stub({ children: [] }) : stub()),
  }));
  const els = { 'kb-status': stub(), 'kb-order': stub({ hidden: true }), 'kb-live': stub(), 'kb-data': stub({ textContent: JSON.stringify(lanes) }) };
  // kb-sched: the scheduled lanes (id, state, band), which are not in kb-data. A string is raw text, to test bad JSON.
  if (sched !== null) els['kb-sched'] = stub({ textContent: typeof sched === 'string' ? sched : JSON.stringify(sched) });
  els['kb-board'] = stub({
    querySelectorAll: (sel) => (sel === '.kb-card' ? [...cardEls.values()] : sel === '.kcol' ? colEls : []),
  });
  const document = {
    createElement: (tag) => { const el = stub(); el.tag = tag; return el; },
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    visibilityState: 'visible',
  };
  const claude = { use: (name) => (name === 'db' && !noDb ? Promise.resolve(db.api) : Promise.resolve(null)) };
  const sandbox = {
    document,
    // phone: the (max-width:720px) query matches, as on a phone. Without it the page sees a wide screen.
    window: phone ? { claude, matchMedia: () => ({ matches: true, addEventListener() {} }) } : { claude },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const source = `${HELPERS.map((f) => f.toString()).join('\n')}\nvar KB_BOARD = ${JSON.stringify(board)};\n${raw ? RAW : CLIENT}`;
  vm.runInNewContext(source, sandbox, { filename: 'kanban-client.inlined.js' });
  await settle();
  return {
    db,
    status: () => els['kb-status'].textContent,
    chipHidden: () => els['kb-order'].hidden,
    /** The Move control of a card, like a change event of its select. Any raw option value. Returns the value the page left in the select. */
    async moveRaw(id, value) {
      this.pick(id, value);
      await this.fireChange(id);
      return partOf(id, '.kb-to').value;
    },
    /** The select of a card as an event target: the part stub itself, so a value the page resets or keeps is visible. */
    selectTarget(id) {
      return Object.assign(partOf(id, '.kb-to'), { classList: { contains: (c) => c === 'kb-to' }, closest: () => cardEls.get(id) });
    },
    /** What the browser does to a closed select when an option is chosen: the value changes, nothing else yet. */
    pick(id, value) { partOf(id, '.kb-to').value = value; },
    async fireChange(id) {
      for (const f of els['kb-board'].handlers.change || []) f({ target: this.selectTarget(id) });
      await settle();
    },
    /** A key event on a card's select. Returns whether the page called preventDefault. */
    key(id, type, key) {
      let prevented = false;
      for (const f of els['kb-board'].handlers[type] || []) f({ key, target: this.selectTarget(id), preventDefault() { prevented = true; } });
      return prevented;
    },
    /** The last element the page focused. */
    lastFocus: () => focusLog[focusLog.length - 1] || null,
    focusCount: () => focusLog.length,
    /** A column's collapsed class, as the phone page uses it. */
    collapse(name) { classes.get(name).add('kb-collapsed'); },
    collapsed: (name) => classes.get(name).has('kb-collapsed'),
    /** "Bottom of <col>" in the Move select. */
    move(id, col) { return this.moveRaw(id, 'b:' + col); },
    /** "Top of <col>" in the Move select. */
    moveTop(id, col) { return this.moveRaw(id, 't:' + col); },
    /** A tap on Do next, Done or Undo of a card. No settle: two taps in a row reach the page before any write answers. */
    tap(id, cls) {
      const button = cls === 'kb-undo' ? this.flag(id).undo : partOf(id, '.' + cls);
      const target = { closest: (sel) => (sel === '.' + cls ? Object.assign(button, { closest: () => cardEls.get(id) }) : null) };
      for (const f of els['kb-board'].handlers.click || []) f({ target });
    },
    async clickNext(id) { this.tap(id, 'kb-next'); await settle(); },
    async clickDone(id) { this.tap(id, 'kb-done'); await settle(); },
    async clickUndo(id) { this.tap(id, 'kb-undo'); await settle(); },
    /** The flag line of a card as painted: null until the page made one. */
    flag(id) {
      const box = flagBoxes.get(id);
      if (!box) return null;
      const [text, undo] = box.children;
      return { hidden: box.hidden, text: text.textContent, kind: box.getAttribute('data-k'), undo, undoHidden: undo.hidden };
    },
    /** The screen-reader line the page announces. */
    live: () => els['kb-live'].textContent,
    /** The values of the options the page put in a card's Move select. */
    moveOptions: (id) => partOf(id, '.kb-to').children.map((o) => o.value),
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
    await page.moveAndSave('a2', 'later');
    assert.deepEqual(page.db.log, [], 'a foreign page wrote to the other board\'s doc');
  });
}

test('a board doc that cannot be read: the page cannot verify its board, so it subscribes to no card notes, writes nothing and says so', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-other', syncedAt: SYNCED }), getFails: new Error('boom') });
  assert.match(page.status(), /^Board order not loaded: boom$/);
  assert.equal(page.db.cardSubs(), 0, 'card notes of an artifact whose board could not be verified were subscribed');
  await page.moveAndSave('a2', 'later');
  assert.deepEqual(page.db.log, [], 'an unverified page wrote');
});

test('no db handle (claude.use returned null): read-only, no card notes, no writes', async () => {
  const page = await openPage({ board: 'zz-a', noDb: true });
  assert.match(page.status(), /sign in to save an order/);
  assert.equal(page.db.cardSubs(), 0);
  await page.moveAndSave('a2', 'later');
  assert.deepEqual(page.db.log, []);
});

test('positive control: the same moves on a matching doc do write (so the refusal above is the guard)', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  await page.moveAndSave('a2', 'later');
  assert.equal(page.db.writes().length, 1);
});

test('the other board\'s order arriving live locks the page, and drops a move still in the debounce window', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  await page.move('a2', 'later');
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
  await page.moveAndSave('a2', 'later');
  const writes = page.db.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'update', 'set would replace the whole doc');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['board', 'columns', 'updatedAt']);
  assert.equal(writes[0].data.board, 'continuous-claude');
  assert.deepEqual(writes[0].data.columns, { next: ['a1'], later: ['a3', 'a2'], waiting: [] });
  assertNoSyncFields(writes);
  const saved = page.db.read(DOC);
  assert.equal(saved.syncedAt, SYNCED, 'the save dropped syncedAt');
  assert.deepEqual(saved.appliedColumns, APPLIED, 'the save dropped appliedColumns');
  assert.equal(saved.board, 'continuous-claude');
});

test('the first save on a new board creates the doc with set, stamped with the board, and tries no update first', async () => {
  const page = await openPage({ board: 'zz-a', doc: null });
  assert.match(page.status(), /No saved order yet/);
  await page.moveAndSave('a2', 'later');
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
  await page.moveAndSave('a2', 'later');
  assert.deepEqual(page.db.log.map((e) => e.op), ['update']);
  const saved = page.db.read(DOC);
  assert.equal(saved.syncedAt, SYNCED);
  assert.deepEqual(saved.appliedColumns, APPLIED);
});

test('a doc another device created for ANOTHER board after this page loaded with no doc is not written to', async () => {
  const page = await openPage({ board: 'zz-a', doc: null });
  page.db.seed(DOC, board({ board: 'zz-other', syncedAt: SYNCED }));
  await page.moveAndSave('a2', 'later');
  assert.deepEqual(page.db.log, []);
  assert.match(page.status(), /saved order is for board zz-other/);
});

test('a doc deleted under the page after load: the save creates it with set instead of failing', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.db.remove(DOC);
  await page.moveAndSave('a2', 'later');
  assert.deepEqual(page.db.log.map((e) => `${e.op}${e.rejected ? ':rejected' : ''}`), ['update:rejected', 'set']);
  assert.equal(page.db.read(DOC).board, 'zz-a');
  assert.doesNotMatch(page.status(), /Save failed/);
});

test('ids the page does not know come back in their saved column; ids it knows are placed by the page; done ids are not kept', async () => {
  const doc = board({
    board: 'zz-a',
    columns: { next: ['a1', 'a2'], later: ['a3', 'ghost2'], waiting: ['ghost', 'a4'] },
    appliedColumns: clone(APPLIED),
    syncedAt: SYNCED,
  });
  const page = await openPage({ board: 'zz-a', doc });
  await page.moveAndSave('a2', 'later');
  const [w] = page.db.writes();
  // a2 moved next -> later. ghost and ghost2 are unknown to this page and survive; a4 is a known (done) lane, so it is dropped.
  assert.deepEqual(w.data.columns, { next: ['a1'], later: ['a3', 'a2', 'ghost2'], waiting: ['ghost'] });
  assertNoSyncFields([w]);
});

test('the page never writes appliedColumns or syncedAt, even when the doc it loaded carries them (set and update paths)', async () => {
  const withSync = board({ board: 'zz-a', appliedColumns: clone(APPLIED), syncedAt: SYNCED });
  for (const doc of [null, withSync]) {
    const page = await openPage({ board: 'zz-a', doc });
    await page.moveAndSave('a2', 'later');
    await page.moveAndSave('a1', 'waiting');
    assert.ok(page.db.writes().length >= 2);
    assertNoSyncFields(page.db.writes());
  }
});

test('after a save the order is pending again: the chip shows and syncedAt is still the sync\'s', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED, updatedAt: '2026-11-04T09:00:00.000Z' }) });
  assert.equal(page.chipHidden(), true, 'a synced order shows no chip');
  await page.moveAndSave('a2', 'later');
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
  await page.moveAndSave('a2', 'later');
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
  await page.drop('later');
  assert.equal(page.status(), lockText, 'the drop replaced the lock message');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a locked page wrote after a drop');
});

// ------------------------------------------------------------------ PR-C: Do next, Move to Top or Bottom, Done and Undo

// Past instants, so the real clock of a Done or Undo write is always later than a syncedAt below.
const T0 = '2026-11-03T09:00:00.000Z';
const T1 = '2026-11-03T10:00:00.000Z';
const T2 = '2026-11-03T11:00:00.000Z';
/** Three lanes in Next (P0, P1, P2), two in Later (P2, Unsorted), one in Waiting (P0), one done P0. */
const BLANES = [
  { id: 'n1', state: 'ready', priority: 1, band: 'P0', title: 'N1' },
  { id: 'n2', state: 'ready', priority: 2, band: 'P1', title: 'N2' },
  { id: 'n3', state: 'ready', priority: 3, band: 'P2', title: 'N3' },
  { id: 'l1', state: 'backlog', priority: 4, band: 'P2', title: 'L1' },
  { id: 'l2', state: 'backlog', priority: 5, band: null, title: 'L2' },
  { id: 'w1', state: 'blocked', priority: 6, band: 'P0', title: 'W1' },
  { id: 'd1', state: 'done', priority: 7, band: 'P0', title: 'D1' },
];
const ORDER = { next: ['n1', 'n2', 'n3'], later: ['l1', 'l2'], waiting: ['w1'] };
const open = (extra = {}) => openPage({ board: 'zz-a', lanes: BLANES, doc: board({ board: 'zz-a', syncedAt: SYNCED, columns: clone(ORDER) }), ...extra });
const savedColumns = (page) => page.db.writes().filter((w) => w.path === DOC).at(-1)?.data.columns;
const cardWrites = (page) => page.db.writes().filter((w) => w.path.startsWith('cards/'));

test('Do next puts the card first in Next from Next, Later and Waiting', async () => {
  const page = await open();
  await page.clickNext('l1');
  await page.clickNext('w1');
  await page.moveAndSave('n3', 'waiting');
  await page.clickNext('n3');
  await page.debounce();
  assert.deepEqual(savedColumns(page), { next: ['n3', 'w1', 'l1', 'n1', 'n2'], later: ['l2'], waiting: [] });
});

test('Do next is off at Next index 0 and on a read-only page, and a tap on it writes nothing', async () => {
  const page = await open();
  assert.equal(page.part('n1', '.kb-next').disabled, true, 'first in Next: nothing to do');
  assert.equal(page.part('n2', '.kb-next').disabled, false);
  assert.equal(page.part('l1', '.kb-next').disabled, false);
  await page.clickNext('n1');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a tap on a disabled Do next wrote');
  await page.clickNext('n2');
  assert.equal(page.part('n2', '.kb-next').disabled, true, 'n2 is first in Next now');
  assert.equal(page.part('n1', '.kb-next').disabled, false, 'n1 is second now');
  const ro = await openPage({ board: 'zz-a', lanes: BLANES, noDb: true });
  for (const id of ['n1', 'n2', 'l1']) {
    assert.equal(ro.part(id, '.kb-next').disabled, true, `read-only: Do next of ${id} is on`);
    assert.equal(ro.part(id, '.kb-done').disabled, true, `read-only: Done of ${id} is on`);
    assert.equal(ro.part(id, '.kb-to').disabled, true, `read-only: Move to of ${id} is on`);
  }
  await ro.clickNext('l1');
  await ro.clickDone('l1');
  assert.deepEqual(ro.db.log, []);
});

test('Move to Top and Bottom use index 0 and the last index; Bottom inside the same column is not off by one', async () => {
  const page = await open();
  await page.moveTop('n3', 'later');
  await page.moveTop('w1', 'next');
  await page.move('n1', 'next');
  await page.debounce();
  assert.deepEqual(savedColumns(page), { next: ['w1', 'n2', 'n1'], later: ['n3', 'l1', 'l2'], waiting: [] });
  await page.move('l1', 'later');
  await page.moveTop('l2', 'later');
  await page.debounce();
  assert.deepEqual(savedColumns(page).later, ['l2', 'n3', 'l1']);
});

test('a Move value that names no column writes nothing and still resets the select', async () => {
  const page = await open();
  for (const bad of ['t:bogus', 'b:', 'x:later', 'later', 'now', 't:now', 'b:now', 't:scheduled', 't:__proto__', 't:constructor']) {
    assert.equal(await page.moveRaw('n2', bad), '', `the select kept ${bad}`);
  }
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a value that is no column wrote');
});

test('the Move select shows its placeholder after load and after every move, and holds the 6 options once', async () => {
  const page = await open();
  const want = ['next', 'later', 'waiting'].flatMap((c) => [`t:${c}`, `b:${c}`]);
  for (const id of ['n1', 'l2', 'w1']) {
    assert.equal(page.part(id, '.kb-to').value, '', `${id}: the select shows a column name`);
    assert.deepEqual(page.moveOptions(id), want, `${id}: options`);
  }
  assert.equal(await page.moveTop('l1', 'next'), '');
  assert.equal(await page.move('l1', 'waiting'), '');
  assert.equal(page.part('l1', '.kb-to').value, '');
  await page.clickNext('l2');
  assert.equal(page.part('l2', '.kb-to').value, '');
  assert.deepEqual(page.moveOptions('l1'), want, 'options were added again');
  // A select a browser left on an option: the next paint of the board puts the placeholder back.
  page.part('w1', '.kb-to').value = 't:next';
  await page.clickNext('l1');
  assert.equal(page.part('w1', '.kb-to').value, '', 'a repaint left a column name in the select');
});

test('Top then Bottom, and Do next then Top of its old column, return to the saved order: no write at all', async () => {
  const page = await open();
  await page.moveTop('n3', 'next');
  assert.match(page.status(), /^Saving/, 'setup: Top moved the card');
  await page.move('n3', 'next');
  await page.clickNext('l1');
  assert.match(page.status(), /^Saving/, 'setup: Do next moved the card');
  await page.moveTop('l1', 'later');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'moves that cancel out still wrote');
  assert.match(page.status(), /^Saved/);
});

test('Done writes the card doc with status done and updatedAt only: no note, not the board doc', async () => {
  const page = await open();
  page.part('l1', '.kb-note').value = 'typed but not saved';
  page.part('l1', '.kb-q').value = 'a question not saved';
  await page.clickDone('l1');
  await page.debounce();
  const writes = page.db.writes();
  assert.deepEqual(writes.map((w) => w.path), ['cards/l1'], 'Done wrote more than the card doc');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['status', 'updatedAt']);
  assert.equal(writes[0].data.status, 'done');
  assert.ok(!Number.isNaN(Date.parse(writes[0].data.updatedAt)));
  assert.equal(page.part('l1', '.kb-note').value, 'typed but not saved', 'Done wiped the unsaved note');
});

test('Done is off before the cards loaded, off while its own write runs, and a double tap writes once', async () => {
  const slow = await open({ cardsSilent: true });
  assert.equal(slow.part('n2', '.kb-done').disabled, true, 'cards not loaded: Done is on');
  await slow.clickDone('n2');
  assert.equal(cardWrites(slow).length, 0, 'Done wrote before the cards loaded');

  const page = await open();
  assert.equal(page.part('n2', '.kb-done').disabled, false);
  page.tap('n2', 'kb-done');
  page.tap('n2', 'kb-done');
  assert.equal(page.part('n2', '.kb-done').disabled, true, 'Done is on while its write runs');
  await settle();
  assert.equal(cardWrites(page).length, 1, 'a double tap wrote twice');
  assert.equal(page.part('n2', '.kb-done').disabled, true, 'Done is on again after it worked');
  await page.clickDone('n2');
  assert.equal(cardWrites(page).length, 1, 'a third tap wrote');
});

test('the Done flag comes from the saved card: a second device shows it, and it goes once the sync has applied it', async () => {
  const page = await open();
  assert.equal(page.flag('n2'), null, 'a flag before anything happened');
  page.db.pushCards({ n2: { status: 'done', updatedAt: T1 } });
  const f = page.flag('n2');
  assert.equal(f.hidden, false);
  assert.match(f.text, /^Done, waiting for sync\.$/);
  assert.equal(f.undoHidden, false, 'no Undo on the flag');
  assert.equal(page.part('n2', '.kb-done').disabled, true, 'Done stays on for a card that is already done');
  page.db.pushCards({ n2: { status: 'done', updatedAt: T1, syncedAt: T2 } });
  assert.equal(page.flag('n2').hidden, true, 'the flag stays after the sync');
  assert.equal(page.flag('n2').undoHidden, true);
  assert.equal(page.part('n2', '.kb-done').disabled, false);
});

test('Done on this device shows the flag, and the card snapshot of its own write keeps it', async () => {
  const page = await open();
  await page.clickDone('l1');
  assert.equal(page.flag('l1').hidden, false);
  assert.match(page.flag('l1').text, /Done, waiting for sync/);
  page.db.pushCards({ l1: page.db.read('cards/l1') });
  assert.equal(page.flag('l1').hidden, false, 'the snapshot of the write dropped the flag');
});

test('Undo writes the status that was pending before Done, and null when none was; never an empty string', async () => {
  const page = await open();
  // A card Dave had set to blocked and not synced: Undo must give blocked back, not the lane state (ready) read at render.
  page.db.pushCards({ n2: { status: 'blocked', updatedAt: T0 } });
  await page.clickDone('n2');
  await page.clickUndo('n2');
  // A card with no doc: nothing to give back.
  await page.clickDone('l1');
  await page.clickUndo('l1');
  // A synced status is history, not a pending choice.
  page.db.pushCards({ n2: page.db.read('cards/n2'), n3: { status: 'ready', updatedAt: T0, syncedAt: T1 } });
  await page.clickDone('n3');
  await page.clickUndo('n3');
  const by = (id) => cardWrites(page).filter((w) => w.path === `cards/${id}`).map((w) => w.data.status);
  assert.deepEqual(by('n2'), ['done', 'blocked']);
  assert.deepEqual(by('l1'), ['done', null]);
  assert.deepEqual(by('n3'), ['done', null]);
  assert.ok(cardWrites(page).every((w) => w.data.status !== ''), 'an empty status was written');
  for (const id of ['n2', 'l1', 'n3']) assert.equal(page.flag(id).hidden, true, `${id}: the flag stays after Undo`);
  assert.equal(page.part('n3', '.kb-done').disabled, false, 'Done stays off after Undo');
});

test('after Done and after Undo the Status select and Save button match the saved card; a note Save sends no status', async () => {
  const page = await open();
  assert.equal(page.part('l1', '.kb-st').value, 'backlog');
  await page.clickDone('l1');
  assert.equal(page.part('l1', '.kb-st').value, 'done');
  assert.equal(page.part('l1', '.kb-save').disabled, true, 'Save is on with nothing to save');
  page.part('l1', '.kb-note').value = 'after done';
  await page.clickSave('l1');
  const last = cardWrites(page).at(-1);
  assert.deepEqual(Object.keys(last.data).sort(), ['note', 'updatedAt'], 'a note Save resent the status');
  await page.clickUndo('l1');
  assert.equal(page.part('l1', '.kb-st').value, 'backlog', 'the select does not show the lane state after Undo');
  assert.equal(page.part('l1', '.kb-save').disabled, true);
  page.db.pushCards({ n2: { status: 'blocked', updatedAt: T0 } });
  assert.equal(page.part('n2', '.kb-st').value, 'blocked');
  await page.clickDone('n2');
  await page.clickUndo('n2');
  assert.equal(page.part('n2', '.kb-st').value, 'blocked', 'Undo lost the pending status in the select');
  assert.equal(page.part('n2', '.kb-save').disabled, true);
});

test('a Done write that fails says so in a red flag, keeps the saved card as it was, and Done works again', async () => {
  const page = await open();
  page.db.failWrites(new Error('boom'));
  await page.clickDone('l1');
  const f = page.flag('l1');
  assert.equal(f.hidden, false);
  assert.equal(f.text, 'Could not mark done: boom. Try again.');
  assert.equal(f.kind, 'crit');
  assert.equal(f.undoHidden, true, 'Undo on a card that was not marked done');
  assert.equal(page.part('l1', '.kb-st').value, 'backlog', 'the select moved to done on a failed write');
  assert.equal(page.part('l1', '.kb-done').disabled, false, 'Done stays off after a failure');
  page.db.failWrites(null);
  await page.clickDone('l1');
  assert.deepEqual(cardWrites(page).map((w) => w.data.status), ['done']);
  assert.match(page.flag('l1').text, /Done, waiting for sync/);
  assert.notEqual(page.flag('l1').kind, 'crit');
});

test('Do next says "First in Next." and counts the open lanes of a higher band; no count when none is ahead', async () => {
  const page = await open();
  // l1 is P2: open P0 n1 and w1 and P1 n2 stay above it. The done P0 lane d1 does not count.
  await page.clickNext('l1');
  assert.equal(page.flag('l1').hidden, false);
  assert.equal(page.flag('l1').text, 'First in Next. By band, 3 lanes of a higher band stay above it.');
  assert.equal(page.live(), 'l1 moved to Next, rank 1 of 4. By band, 3 lanes of a higher band stay above it.');
  // w1 is P0 and comes from Waiting: no band count, but the sync warning.
  await page.clickNext('w1');
  assert.equal(page.flag('w1').text, 'First in Next. Sync may change this lane from blocked to backlog, after your yes.');
  assert.equal(page.live(), 'w1 moved to Next, rank 1 of 5. Sync may change this lane from blocked to backlog, after your yes.');
  await page.clickNext('n2');
  assert.equal(page.flag('n2').text, 'First in Next. By band, 2 lanes of a higher band stay above it.');
  const l2 = await open();
  await l2.clickNext('l2');
  assert.match(l2.flag('l2').text, /By band, 5 lanes/, 'an Unsorted lane sits under every banded open lane');
});

test('one lane ahead reads in the singular', async () => {
  const lanes = [{ id: 'x', state: 'ready', priority: 1, band: 'P0' }, { id: 'y', state: 'backlog', priority: 2, band: 'P1' }];
  const page = await openPage({ board: 'zz-a', lanes, doc: board({ board: 'zz-a', syncedAt: SYNCED, columns: { next: ['x'], later: ['y'], waiting: [] } }) });
  await page.clickNext('y');
  assert.equal(page.flag('y').text, 'First in Next. By band, 1 lane of a higher band stays above it.');
});

test('"lanes ahead" counts a scheduled lane of a higher band (it is in kb-sched, not kb-data); bad kb-sched JSON counts none and does not stop the page', async () => {
  const lanes = [{ id: 'x', state: 'ready', priority: 1, band: 'P0' }, { id: 'y', state: 'backlog', priority: 2, band: 'P2' }];
  const doc = board({ board: 'zz-a', syncedAt: SYNCED, columns: { next: ['x'], later: ['y'], waiting: [] } });
  const sched = [{ id: 's1', state: 'ready', band: 'P0' }, { id: 's2', state: 'ready', band: 'P1' }, { id: 's3', state: 'ready', band: 'P2' }];
  const page = await openPage({ board: 'zz-a', lanes, doc, sched });
  await page.clickNext('y');
  assert.equal(page.flag('y').text, 'First in Next. By band, 3 lanes of a higher band stay above it.', 'x, s1 and s2 are ahead of y; s3 is the same band');
  const bad = await openPage({ board: 'zz-a', lanes, doc, sched: '{not json' });
  await bad.clickNext('y');
  assert.equal(bad.flag('y').text, 'First in Next. By band, 1 lane of a higher band stays above it.');
});

test('a move that lands at Next index 0 by Top or by drag is flagged the same way; a landing anywhere else shows no flag', async () => {
  const page = await open();
  await page.moveTop('n3', 'next');
  assert.equal(page.flag('n3').text, 'First in Next. By band, 3 lanes of a higher band stay above it.');
  await page.moveTop('l1', 'later');
  assert.ok(!page.flag('l1') || page.flag('l1').hidden, 'a move to Later got a flag');
  page.dragStart('l2');
  await page.drop('next');
  assert.match(page.flag('l2').text, /^First in Next\./, 'a drop at Next index 0 got no flag');
});

test('a second move clears the flag of the card, and the flag of the card that was first in Next', async () => {
  const page = await open();
  await page.clickNext('l1');
  assert.equal(page.flag('l1').hidden, false);
  await page.move('l1', 'later');
  assert.equal(page.flag('l1').hidden, true, 'the flag stayed after the card moved on');
  await page.clickNext('l1');
  await page.clickNext('l2');
  assert.equal(page.flag('l1').hidden, true, 'l1 is second in Next and still says first');
  assert.equal(page.flag('l2').hidden, false);
});

// ------------------------------------------------------------------ what the page ships: the client without its comments

/** Runs a program in a fresh context and returns its `out` variable as JSON. */
const runOut = (src) => { const ctx = {}; vm.runInNewContext(src, ctx); return JSON.stringify(ctx.out); };

test('the client the page ships has no comment marker left, still compiles, and is much smaller than the file', () => {
  assert.ok(!CLIENT.includes('/*') && !CLIENT.includes('*/'));
  assert.doesNotMatch(CLIENT, /^[ \t]*\/\//m);
  assert.doesNotThrow(() => new vm.Script(CLIENT));
  assert.ok(RAW.length - CLIENT.length > 5000, `stripping saved only ${RAW.length - CLIENT.length} characters`);
});

test('the raw file and the stripped text behave the same: a Do next and a Done write the same docs', async () => {
  const shapes = [];
  for (const raw of [true, false]) {
    const page = await open({ raw });
    await page.clickNext('l1');
    await page.clickDone('n2');
    await page.debounce();
    shapes.push(page.db.writes().map((w) => [w.path, w.op, Object.keys(w.data).sort().join()]));
  }
  assert.deepEqual(shapes[0], shapes[1]);
  assert.equal(shapes[0].length, 2);
});

// A regex cannot tell a comment from a string. Each program either comes out with the same behaviour or the stripper throws; it never returns a different program.
const SAME = {
  'a // inside a string': "var u = 'http://x.test//y';\nvar out = [u, u.length];",
  'a regex literal with slashes': "var r = /[a-z]+\\/x/;\nvar out = [r.test('ab/x'), 'a//b'.split('//')];",
  'whole-line comments that name quotes, slashes and cards/*': "/**\n * 'cards/*' lives in \"docs\" // not a problem\n */\n// see cards/* docs\nvar a = 1; // a trailing comment stays\nvar out = [a, 'x//y'];",
  'a one-line block comment on its own line': "/* head */\nvar out = 2;",
};
const THROWS = {
  'cards/* in a string, and a star-slash in another string (the old stripper deleted the code between them)': "var s = 'cards/*';\nvar t = 'keep me';\nvar u = '*/';\nvar out = [s, t, u];",
  'a slash-star in a string with no star-slash after it': "var s = 'cards/*';\nvar out = s;",
  'an inline block comment': 'var x = 1; /* c */ var out = x;',
  'code after a block comment on the same line': '/* a */ var out = 1;',
  'a string continued over a line that starts with two slashes': "var s = 'a\\\n// not a comment';\nvar out = s;",
  'a template literal with a line that starts with two slashes': 'var s = `a\n// not a comment`;\nvar out = s;',
  'a regex that ends in star slash': "var r = /\\/\\*/;\nvar out = r.test('/*');",
};

test('stripClientComments: strings, URLs, regexes and whole-line comments keep their behaviour', () => {
  for (const [name, src] of Object.entries(SAME)) {
    const out = stripClientComments(src);
    assert.equal(runOut(out), runOut(src), `${name}: the program changed`);
  }
  assert.ok(stripClientComments(SAME['whole-line comments that name quotes, slashes and cards/*']).length < SAME['whole-line comments that name quotes, slashes and cards/*'].length);
  assert.match(stripClientComments(SAME['whole-line comments that name quotes, slashes and cards/*']), /a trailing comment stays/);
});

test('stripClientComments: anything that could hide a comment marker inside code throws, and never returns a changed program', () => {
  for (const [name, src] of Object.entries(THROWS)) {
    assert.throws(() => stripClientComments(src), /cannot be stripped safely/, name);
  }
});

// ------------------------------------------------------------------ the Move select from the keyboard

test('an arrow key on the closed Move select changes its value and fires change: that change moves and writes nothing', async () => {
  const page = await open();
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) {
    page.key('n2', 'keydown', key);
    page.pick('n2', 'b:later');
    await page.fireChange('n2');
    page.key('n2', 'keyup', key);
    assert.equal(page.part('n2', '.kb-to').value, 'b:later', `${key}: the page reset the select under the user's key`);
  }
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'an arrow key saved a move');
  assert.match(page.status(), /^Saved order loaded/, 'an arrow key started a save');
});

test('leaving the select after arrow keys, with no Enter, puts the placeholder back and writes nothing', async () => {
  const page = await open();
  page.key('n2', 'keydown', 'ArrowDown');
  page.pick('n2', 't:later');
  await page.fireChange('n2');
  page.key('n2', 'keyup', 'ArrowDown');
  assert.equal(page.part('n2', '.kb-to').value, 't:later', 'the arrow choice must stay while the select has focus');
  page.key('n2', 'focusout', '');
  assert.equal(page.part('n2', '.kb-to').value, '', 'a column name stayed on a select that did nothing');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'leaving the select saved a move');
});

test('a change with no key before it (a mouse, a touch or a phone picker) moves; so does one after the key was released', async () => {
  const page = await open();
  assert.equal(await page.moveRaw('l1', 't:waiting'), '');
  page.key('l2', 'keydown', 'ArrowDown');
  page.key('l2', 'keyup', 'ArrowDown');
  assert.equal(await page.moveRaw('l2', 't:waiting'), '', 'a change after the key was released was ignored');
  page.key('n2', 'keydown', 'a');
  assert.equal(await page.moveRaw('n2', 't:waiting'), '', 'a letter key blocked the next change');
  await page.debounce();
  assert.deepEqual(savedColumns(page).waiting, ['n2', 'l2', 'l1', 'w1']);
});

test('Enter on the select applies the option the arrows chose, once, and puts the placeholder back', async () => {
  const page = await open();
  page.key('l1', 'keydown', 'ArrowDown');
  page.pick('l1', 't:next');
  await page.fireChange('l1');
  page.key('l1', 'keyup', 'ArrowDown');
  assert.deepEqual(page.db.log, []);
  const before = page.focusCount();
  assert.equal(page.key('l1', 'keydown', 'Enter'), true, 'Enter was not handled');
  await settle();
  assert.equal(page.part('l1', '.kb-to').value, '');
  assert.equal(page.focusCount(), before + 1, 'focus did not return to the select');
  // A popup that was open sends its own change after Enter: the select is back on the placeholder, so nothing moves twice.
  await page.fireChange('l1');
  await page.debounce();
  assert.deepEqual(savedColumns(page), { next: ['l1', 'n1', 'n2', 'n3'], later: ['l2'], waiting: ['w1'] });
  assert.equal(page.db.writes().length, 1);
});

test('Enter on the placeholder does nothing and is left to the browser', async () => {
  const page = await open();
  assert.equal(page.key('n2', 'keydown', 'Enter'), false);
  await page.debounce();
  assert.deepEqual(page.db.log, []);
});

// ------------------------------------------------------------------ a column the move lands in opens

test('Do next opens the Next column and Move to opens its target column; no other column opens', async () => {
  const page = await open();
  for (const c of ['next', 'later', 'waiting']) page.collapse(c);
  await page.clickNext('l1');
  assert.equal(page.collapsed('next'), false, 'Do next left Next collapsed');
  assert.equal(page.collapsed('later'), true, 'Do next opened the column it left');
  await page.moveTop('n3', 'waiting');
  assert.equal(page.collapsed('waiting'), false, 'Move to left its target collapsed');
  assert.equal(page.collapsed('later'), true, 'Move to opened another column');
});

// ------------------------------------------------------------------ the sync's Waiting rule

const WLANES = [
  { id: 'a', state: 'ready', priority: 1, band: 'P0' },
  { id: 'x', state: 'ready', priority: 2, band: 'P1' },
  { id: 'bk', state: 'blocked', priority: 3, band: 'P1' },
  { id: 'y', state: 'backlog', priority: 4, band: 'P2' },
];
const openW = () => openPage({ board: 'zz-a', lanes: WLANES, doc: board({ board: 'zz-a', syncedAt: SYNCED, columns: { next: ['a'], later: ['bk', 'y'], waiting: ['x'] } }) });
const OUT_OF_WAITING = 'Sync may change this lane from blocked to backlog, after your yes.';
const INTO_WAITING = 'Sync may set this lane to blocked, after your yes.';

test('any move of a blocked lane out of Waiting says the sync may make it backlog; a lane that is not blocked says nothing', async () => {
  const page = await open();
  await page.move('w1', 'later');
  assert.equal(page.flag('w1').text, OUT_OF_WAITING);
  assert.equal(page.live(), `w1 moved to Later, rank 3 of 3. ${OUT_OF_WAITING}`);
  const w = await openW();
  await w.move('x', 'later');
  assert.ok(!w.flag('x') || w.flag('x').hidden, 'a ready lane out of Waiting got the blocked warning');
});

test('a move into Waiting says the sync may set the lane to blocked, except for a lane that is blocked already or a move inside Waiting', async () => {
  const w = await openW();
  await w.moveTop('y', 'waiting');
  assert.equal(w.flag('y').text, INTO_WAITING);
  await w.move('bk', 'waiting');
  assert.ok(!w.flag('bk') || w.flag('bk').hidden, 'a blocked lane got the into-Waiting warning');
  await w.moveTop('x', 'waiting');
  assert.ok(!w.flag('x') || w.flag('x').hidden, 'a move inside Waiting got a warning');
});

test('Do next from Waiting joins the Next line and the sync line, and only for a blocked lane', async () => {
  const w = await openW();
  await w.clickNext('x');
  assert.equal(w.flag('x').text, 'First in Next. By band, 1 lane of a higher band stays above it.');
  const page = await open();
  await page.clickNext('w1');
  assert.equal(page.flag('w1').text, `First in Next. ${OUT_OF_WAITING}`);
});

// ------------------------------------------------------------------ announcements and focus after Done and Undo

test('Done announces itself and moves focus to Undo; a failed Done does neither', async () => {
  const page = await open();
  await page.clickDone('l1');
  assert.equal(page.live(), 'l1 marked done, waiting for sync');
  assert.equal(page.lastFocus(), page.flag('l1').undo, 'focus did not move to Undo');
  const failing = await open();
  failing.db.failWrites(new Error('boom'));
  const before = failing.focusCount();
  await failing.clickDone('l1');
  assert.equal(failing.live(), '', 'a failed Done announced success');
  assert.equal(failing.focusCount(), before, 'a failed Done moved focus');
});

test('Undo announces itself and moves focus back to Done', async () => {
  const page = await open();
  await page.clickDone('l1');
  await page.clickUndo('l1');
  assert.equal(page.live(), 'l1 is no longer marked done');
  assert.equal(page.lastFocus(), page.part('l1', '.kb-done'), 'focus did not return to Done');
  assert.equal(page.part('l1', '.kb-done').disabled, false);
});

// ------------------------------------------------------------------ PR-D: the read-only Done column

test('a page with a Done column starts without throwing, and the board is still editable', async () => {
  // The phone path names the Done column in the collapse list; a column the page lacks would throw there.
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }), phone: true });
  assert.doesNotMatch(page.status(), /not loaded|belongs to board/);
  await page.moveAndSave('a2', 'later');
  assert.equal(page.db.writes().length, 1, 'the client died at init: the move wrote nothing');
});

test('on the phone Scheduled, Done and In progress start collapsed with Next, Later and Waiting', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }), phone: true });
  for (const c of ['scheduled', 'next', 'later', 'waiting', 'progress', 'done']) assert.equal(page.collapsed(c), true, `${c} starts open on the phone`);
});

test('on the phone a Scheduled column with cards starts open, so a DUE reminder is not hidden; the other columns stay collapsed', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }), phone: true, schedN: 2 });
  assert.equal(page.collapsed('scheduled'), false, 'a Scheduled column with 2 cards started collapsed');
  for (const c of ['next', 'later', 'waiting', 'progress', 'done']) assert.equal(page.collapsed(c), true, `${c} starts open on the phone`);
  const empty = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }), phone: true, schedN: 0 });
  assert.equal(empty.collapsed('scheduled'), true, 'an empty Scheduled column started open');
});

test('on a wide screen no column starts collapsed, Done included', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  for (const c of ['scheduled', 'next', 'later', 'waiting', 'progress', 'done']) assert.equal(page.collapsed(c), false, `${c} starts collapsed on a wide screen`);
});

test('a card dropped on the Done column moves nothing and writes nothing', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.dragStart('a2');
  await page.drop('done');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a drop on Done wrote to the db');
  assert.match(page.status(), /^(?!Saving)/, 'a drop on Done started a save');
});

test('after a move the saved doc has exactly the three order columns: Scheduled and Done are never saved', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }), phone: true });
  await page.moveAndSave('a2', 'later');
  const [w] = page.db.writes();
  assert.deepEqual(Object.keys(w.data.columns).sort(), ['later', 'next', 'waiting']);
  assert.deepEqual(Object.keys(page.db.read(DOC).columns).sort(), ['later', 'next', 'waiting']);
});

// ------------------------------------------------------------------ PR-F: the Now column is retired; Scheduled and reminders is read-only

test('a card dropped on the Scheduled column moves nothing and writes nothing', async () => {
  const page = await openPage({ board: 'zz-a', doc: board({ board: 'zz-a', syncedAt: SYNCED }) });
  page.dragStart('a2');
  await page.drop('scheduled');
  await page.debounce();
  assert.deepEqual(page.db.log, [], 'a drop on Scheduled wrote to the db');
  assert.match(page.status(), /^(?!Saving)/, 'a drop on Scheduled started a save');
});

test('an old doc with columns.now loads, its ids go to their default column, and the next save no longer writes now', async () => {
  const old = board({ board: 'zz-a', syncedAt: SYNCED, columns: { now: ['a3'], next: ['a1', 'a2'], later: [], waiting: [] }, appliedColumns: { now: ['a3'], next: ['a1', 'a2'], later: [], waiting: [] } });
  const page = await openPage({ board: 'zz-a', doc: old });
  assert.doesNotMatch(page.status(), /not loaded|belongs to board|Save failed/);
  await page.moveAndSave('a2', 'later');
  const [w] = page.db.writes();
  assert.deepEqual(w.data.columns, { next: ['a1'], later: ['a3', 'a2'], waiting: [] }, 'a3 sat in the retired column: it returns to its default column');
  assertNoSyncFields([w]);
  assert.deepEqual(page.db.read(DOC).appliedColumns.now, ['a3'], 'the sync\'s copy is not touched by the page');
});
