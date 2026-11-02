import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPending, syncState, fnv1a, hashFields, cardDiff, plainPrompt } from './kanban-place.mjs';

// ---- pending / synced decision --------------------------------------------

test('isPending: updatedAt after syncedAt is pending, equal or before is synced', () => {
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:01.000Z', syncedAt: '2026-11-02T10:00:00.000Z' }), true);
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.000Z', syncedAt: '2026-11-02T10:00:00.000Z' }), false);
  assert.equal(isPending({ updatedAt: '2026-11-02T09:59:59.000Z', syncedAt: '2026-11-02T10:00:00.000Z' }), false);
});

test('isPending: a missing syncedAt is pending (never synced)', () => {
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.000Z' }), true);
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.000Z', syncedAt: '' }), true);
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.000Z', syncedAt: 'not a date' }), true);
});

test('isPending: compares instants, not strings (offset and fraction formats differ)', () => {
  // 05:00:01-05:00 is 10:00:01Z, one second AFTER the updatedAt; a string compare says the opposite.
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.000Z', syncedAt: '2026-11-02T05:00:01-05:00' }), false);
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:02Z', syncedAt: '2026-11-02T05:00:01-05:00' }), true);
  assert.equal(isPending({ updatedAt: '2026-11-02T10:00:00.900Z', syncedAt: '2026-11-02T10:00:00Z' }), true);
});

test('isPending: not a document means nothing is pending', () => {
  for (const d of [null, undefined, 'x', 5]) assert.equal(isPending(d), false);
});

test('syncState: none / pending / synced with the sync result text', () => {
  assert.deepEqual(syncState(null), { kind: 'none', at: '', result: '' });
  assert.equal(syncState({ updatedAt: '2026-11-02T10:00:00Z' }).kind, 'pending');
  const s = syncState({ updatedAt: '2026-11-02T10:00:00Z', syncedAt: '2026-11-02T10:05:00Z', syncResult: 'applied' });
  assert.deepEqual(s, { kind: 'synced', at: '2026-11-02T10:05:00Z', result: 'applied' });
  assert.equal(syncState({ syncedAt: '2026-11-02T10:05:00Z', syncResult: 42 }).result, '');
});

test('syncState: an edit made after the last sync flips synced back to pending', () => {
  const d = { updatedAt: '2026-11-02T10:00:00Z', syncedAt: '2026-11-02T10:05:00Z', syncResult: 'applied' };
  assert.equal(syncState(d).kind, 'synced');
  assert.equal(syncState({ ...d, updatedAt: '2026-11-02T10:06:00Z' }).kind, 'pending');
});

// ---- hash ------------------------------------------------------------------

test('fnv1a: matches the published FNV-1a 32-bit test vectors', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('hashFields: stable for equal input, different when any one field changes', () => {
  const base = ['Title', 'scope/a', 'ready', 'last note'];
  assert.equal(hashFields(base), hashFields(base.slice()));
  for (let i = 0; i < base.length; i++) {
    const alt = base.slice();
    alt[i] += 'x';
    assert.notEqual(hashFields(alt), hashFields(base), 'field ' + i);
  }
});

test('hashFields: moving text across a field boundary changes the hash', () => {
  assert.notEqual(hashFields(['a|b', 'c', 'd', 'e']), hashFields(['a', 'b|c', 'd', 'e']));
  assert.notEqual(hashFields(['ab', '', 'd', 'e']), hashFields(['a', 'b', 'd', 'e']));
});

test('hashFields: null and undefined fields hash like an empty field, and do not throw', () => {
  assert.equal(hashFields(['t', null, 'ready', undefined]), hashFields(['t', '', 'ready', '']));
});

test('hashFields: non-ASCII text hashes without throwing and stays stable', () => {
  const f = ['Plan — café 🚀', 's', 'ready', 'n'];
  assert.equal(hashFields(f), hashFields(f.slice()));
  assert.match(hashFields(f), /^[0-9a-f]{8}-[0-9a-z]+$/);
});

// ---- card doc diff (what Save writes) ----------------------------------------

test('cardDiff: nothing changed gives an empty object', () => {
  assert.deepEqual(cardDiff(null, { status: 'ready', note: '', question: '' }, 'ready'), {});
  assert.deepEqual(
    cardDiff({ status: 'blocked', note: 'n', question: 'q', updatedAt: 'x' }, { status: 'blocked', note: 'n', question: 'q' }, 'ready'),
    {},
  );
});

test('cardDiff: only the changed fields appear', () => {
  const doc = { status: 'ready', note: 'old', question: 'q' };
  assert.deepEqual(cardDiff(doc, { status: 'ready', note: 'new', question: 'q' }, 'ready'), { note: 'new' });
  assert.deepEqual(cardDiff(doc, { status: 'done', note: 'old', question: 'q' }, 'ready'), { status: 'done' });
  assert.deepEqual(cardDiff(doc, { status: 'ready', note: 'old', question: 'why?' }, 'ready'), { question: 'why?' });
});

test('cardDiff: with no doc, the baseline status is the lane state', () => {
  assert.deepEqual(cardDiff(null, { status: 'backlog', note: '', question: '' }, 'ready'), { status: 'backlog' });
  assert.deepEqual(cardDiff(null, { status: 'ready', note: '', question: '' }, 'ready'), {});
});

test('cardDiff: an empty status ("keep current") is never written', () => {
  assert.deepEqual(cardDiff(null, { status: '', note: 'n', question: '' }, 'review'), { note: 'n' });
  assert.deepEqual(cardDiff({ status: 'ready' }, { status: '', note: '', question: '' }, 'ready'), {});
});

test('cardDiff: "active" and unknown statuses are never written', () => {
  assert.deepEqual(cardDiff(null, { status: 'active', note: '', question: '' }, 'ready'), {});
  assert.deepEqual(cardDiff(null, { status: 'review', note: '', question: '' }, 'ready'), {});
  assert.deepEqual(cardDiff(null, { status: 'nonsense', note: '', question: '' }, 'ready'), {});
});

test('cardDiff: an active lane never gets a status, but still takes a note', () => {
  assert.deepEqual(cardDiff(null, { status: 'done', note: 'n', question: '' }, 'active'), { note: 'n' });
});

test('cardDiff: surrounding whitespace is not a change and is not stored', () => {
  assert.deepEqual(cardDiff({ note: 'n' }, { status: 'ready', note: '  n \n', question: '' }, 'ready'), {});
  assert.deepEqual(cardDiff(null, { status: 'ready', note: '  hello \n', question: '' }, 'ready'), { note: 'hello' });
});

test('cardDiff: clearing a saved note is a change to the empty string', () => {
  assert.deepEqual(cardDiff({ note: 'old' }, { status: 'ready', note: '', question: '' }, 'ready'), { note: '' });
});

test('cardDiff: note and question are cut at 1000 characters', () => {
  const long = 'x'.repeat(1500);
  const d = cardDiff(null, { status: 'ready', note: long, question: long }, 'ready');
  assert.equal(d.note.length, 1000);
  assert.equal(d.question.length, 1000);
});

test('cardDiff: a form missing fields and junk docs do not throw', () => {
  assert.deepEqual(cardDiff('junk', {}, 'ready'), {});
  assert.deepEqual(cardDiff({ note: 7, question: null, status: 3 }, null, 'ready'), {});
});

// ---- Plain English prompt ------------------------------------------------------

const lane = {
  id: 'free-slot-queue', title: 'Queue for free slots', track: 'coordination', state: 'ready',
  priority: 12, holder: 'ab12cd34', scope: 'scripts/coordination/lane.mjs', note: 'Waiting for the apply step.',
};

test('plainPrompt: carries every fact the model needs, because the call is memoryless', () => {
  const p = plainPrompt(lane, ['other-a', 'other-b']);
  for (const v of ['free-slot-queue', 'Queue for free slots', 'coordination', 'ready', '12', 'ab12cd34',
    'scripts/coordination/lane.mjs', 'Waiting for the apply step.', 'other-a', 'other-b', 'Dave']) {
    assert.ok(p.includes(v), 'missing ' + v);
  }
});

test('plainPrompt: asks for the three labelled parts and the 100 word cap', () => {
  const p = plainPrompt(lane, []);
  for (const label of ['What it is', 'Why it matters', 'Related to']) assert.ok(p.includes(label), label);
  assert.match(p, /under 100 words/i);
  assert.match(p, /jargon/i);
});

test('plainPrompt: missing fields read as unknown, never "undefined" or "null"', () => {
  const p = plainPrompt({ id: 'x', state: 'ready' }, []);
  assert.ok(!/undefined|null/.test(p));
  assert.match(p, /none/i);
});

test('plainPrompt: a huge note and a long sibling list are capped', () => {
  const p = plainPrompt({ ...lane, note: 'n'.repeat(5000) }, Array.from({ length: 80 }, (_, i) => 'lane-' + i));
  assert.ok(p.length < 4000, 'length ' + p.length);
  assert.ok(p.includes('lane-0'));
  assert.ok(!p.includes('lane-79'));
  assert.match(p, /and \d+ more/);
});
