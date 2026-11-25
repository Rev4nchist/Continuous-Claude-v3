import { expect, test } from '@playwright/test';

import { DECISIONS_MAX_BYTES, decisionsOpenCount, parseDecisionsStore } from '../src/lib/decisions-parse';

/**
 * Pure checks of the strict decisions.json reader (card agentic-os-readers, reader 3).
 * The store shape is scripts/github/lib/decisions.mjs:186: {version:1, offers:{}, decisions:{}, misses:{}}.
 * The script reader treats a corrupt file as an empty store (decisions.mjs:193-200). The app must not: a corrupt
 * file is a source error, and only a VALID empty store is the zero state. Pure Node.
 * Each test names the source change that breaks it.
 */

const REPO_CANARY = 'Canary-Org/canary-repo#9001';
const HEAD_CANARY = 'c0ffee'.repeat(6) + 'beef';
const CWD_CANARY = 'C:\\Users\\canary\\repo';

const EMPTY = { version: 1, offers: {}, decisions: {}, misses: {} };
const json = (v: unknown): string => JSON.stringify(v);

function offer(step: string, key: string, head = 'a'.repeat(40)) {
  return { nonce: 'n-' + key, step, key, head, tree: 't'.repeat(40), cwd: CWD_CANARY, spec: { header: 'Land', question: 'Land it?' } };
}

test.describe('parseDecisionsStore: errors are not the zero state', () => {
  test('D1 invalid JSON is unreadable, never zero counts', () => {
    // Breaks when a catch block returns the empty store (the decisions.mjs:196-199 behavior).
    expect(parseDecisionsStore('{not json')).toEqual({ ok: false, reason: 'unreadable' });
    expect(parseDecisionsStore('')).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('D2 a file cut in the middle of an object is unreadable', () => {
    expect(parseDecisionsStore(json(EMPTY).slice(0, 30))).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('D3 a top-level array, string, number or null is not an object', () => {
    for (const text of ['[]', '"x"', '42', 'null']) expect(parseDecisionsStore(text), text).toEqual({ ok: false, reason: 'not-object' });
  });

  test('D4 offers or decisions that are not plain objects, or missing, are a bad shape', () => {
    expect(parseDecisionsStore(json({ ...EMPTY, offers: [] }))).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseDecisionsStore(json({ ...EMPTY, decisions: 'x' }))).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseDecisionsStore(json({ version: 1, misses: {} }))).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseDecisionsStore(json({ ...EMPTY, misses: null }))).toEqual({ ok: false, reason: 'bad-shape' });
  });

  test('D7 an unknown version is an error, not a guess', () => {
    expect(parseDecisionsStore(json({ ...EMPTY, version: 2 }))).toEqual({ ok: false, reason: 'bad-version' });
    expect(parseDecisionsStore(json({ offers: {}, decisions: {}, misses: {} }))).toEqual({ ok: false, reason: 'bad-version' });
  });

  test('D9 a file over 1 MiB is too large', () => {
    expect(DECISIONS_MAX_BYTES).toBe(1024 * 1024);
    expect(parseDecisionsStore(json(EMPTY), DECISIONS_MAX_BYTES + 1)).toEqual({ ok: false, reason: 'too-large' });
    expect(parseDecisionsStore(json(EMPTY), DECISIONS_MAX_BYTES)).toMatchObject({ ok: true });
  });

  test('D9b no file (null text) is missing, a different reason from unreadable', () => {
    expect(parseDecisionsStore(null)).toEqual({ ok: false, reason: 'missing' });
  });
});

test.describe('parseDecisionsStore: valid stores', () => {
  test('D5 a valid empty store is the one real zero state', () => {
    expect(parseDecisionsStore(json(EMPTY))).toEqual({ ok: true, offers: 0, decisions: 0, openByStep: {} });
  });

  test('D6 counts offers and decisions and groups the open offers by step', () => {
    const store = {
      ...EMPTY,
      offers: { 'land\nr#1\nh': offer('land', 'r#1'), 'land\nr#2\nh': offer('land', 'r#2'), 'open-pr\nr#3\nh': offer('open-pr', 'r#3') },
      decisions: { 'land\nr#1\nh': { label: 'Land it', at: '2026-11-25T12:00:00.000Z', tree: 't', nonce: 'n' } },
    };
    expect(parseDecisionsStore(json(store))).toEqual({ ok: true, offers: 3, decisions: 1, openByStep: { land: 2, 'open-pr': 1 } });
  });

  test('D6b extra top-level fields are allowed; an offer with no string step is counted under "other"', () => {
    const store = { ...EMPTY, futureField: 1, offers: { x: { nonce: 'n' } } };
    expect(parseDecisionsStore(json(store))).toEqual({ ok: true, offers: 1, decisions: 0, openByStep: { other: 1 } });
  });

  test('D8 the result holds no repo key, head sha, cwd, nonce or question text', () => {
    // Breaks when a field copies an offer or a decision.
    const store = {
      ...EMPTY,
      offers: { [`land\n${REPO_CANARY}\n${HEAD_CANARY}`]: offer('land', REPO_CANARY, HEAD_CANARY) },
      decisions: { [`land\n${REPO_CANARY}\n${HEAD_CANARY}`]: { label: 'Land it', at: '2026-11-25T12:00:00.000Z', tree: HEAD_CANARY, nonce: 'n-1' } },
    };
    const text = JSON.stringify(parseDecisionsStore(json(store)));
    for (const canary of [REPO_CANARY, HEAD_CANARY, CWD_CANARY.replace(/\\/g, '\\\\'), 'n-' + REPO_CANARY, 'Land it?']) {
      expect(text, canary).not.toContain(canary);
    }
  });
});

test.describe('decisionsOpenCount', () => {
  test('R5a an error view gives null, never 0', () => {
    // Breaks when an error is folded to the zero state: the bug this card exists to prevent.
    expect(decisionsOpenCount(parseDecisionsStore('{not json'))).toBeNull();
    expect(decisionsOpenCount(parseDecisionsStore(null))).toBeNull();
    expect(decisionsOpenCount(parseDecisionsStore(json(EMPTY)))).toBe(0);
    expect(decisionsOpenCount(parseDecisionsStore(json({ ...EMPTY, offers: { a: offer('land', 'r#1') } })))).toBe(1);
  });
});
