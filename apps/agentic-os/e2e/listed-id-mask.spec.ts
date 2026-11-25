import { expect, test } from '@playwright/test';

import {
  DATASET_REL,
  EVAL_CONFIG_REL,
  GOLD_DIR_REL,
  TOKEN,
  countListed,
  holdoutIdsOf,
  listedIdRoot,
  loadListedIds,
  maskListed,
  maskString,
} from '../src/lib/listed-id-mask';
import { COMMENT, DS, GOLD_PR, GOLD_SHA, IDS, IDS_WITH_WORD, KEY, PR, SHA, TEXTS, TREE_KINDS, makeTree, type TreeKind } from './listed-id-fixtures';

/**
 * The app copy of the listed-id mask (card agentic-os-listed-id-mask). Pure Node, made-up ids only (listed-id-fixtures.ts).
 * Each test names the source change that breaks it. The twin of scripts/coordination/board-mask.mjs: listed-id-drift.spec.ts ties the two.
 */

const REL = { dataset: DATASET_REL, config: EVAL_CONFIG_REL, goldDir: GOLD_DIR_REL };

test.describe('maskListed and maskString: each form of a listed id', () => {
  test('M1 the made-up list holds the PR, the comment id, the key and the sha', () => {
    // Breaks when holdoutIdsOf drops a form: every later test would then pass on a short list.
    const ids = holdoutIdsOf(DS, {});
    for (const id of [PR, COMMENT, KEY, SHA]) expect(ids, 'a made-up id is missing from the list').toContain(id);
  });

  for (const c of TEXTS) {
    test(`M2 ${c.label}: ${c.masks ? 'masked' : 'left alone'}`, () => {
      // Breaks when a form is dropped from the copy (a regexp, the sha prefix rule, the digit context rule, the reader view).
      const field = maskString(c.text, IDS_WITH_WORD);
      if (c.masks) {
        expect(field.masked, 'the field mask must change this text').toBeGreaterThan(0);
        expect(field.text).toContain(TOKEN);
        expect(countListed(field.text, IDS_WITH_WORD), 'a listed id is left after the mask').toBe(0);
      } else {
        expect(field).toEqual({ text: c.text, masked: 0 });
      }
    });
  }

  test('M3 maskListed on the raw text leaves the reader-view forms for maskString (the same split as board-mask)', () => {
    // Breaks when maskListed starts to fold the text itself: the drift spec compares both functions with the original.
    const raw = maskListed(`see PR ${PR} now`, IDS);
    expect(raw).toEqual({ text: `see PR ${TOKEN} now`, masked: 1 });
    expect(maskListed('', IDS)).toEqual({ text: '', masked: 0 });
    expect(maskListed(`PR ${PR}`, [])).toEqual({ text: `PR ${PR}`, masked: 0 });
  });

  test('M4 two forms in one text: the raw pass and the reader-view pass each find one id, and both are masked (CLI run 1, finding 1)', () => {
    // Breaks when maskString picks the pass with more hits: on equal counts it kept the raw text and left the fullwidth PR visible.
    const fullwidth = [...PR].map((d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).join('');
    const text = `comment ${COMMENT}​4; PR ${fullwidth}`; // the zero-width mark makes the comment id unlisted in the reader view
    const field = maskString(text, IDS);
    expect(field.masked).toBe(2);
    expect(field.text).not.toContain(fullwidth);
    expect(field.text).not.toContain(PR);
    expect(field.text).not.toContain(COMMENT);
  });

  const fw = (s: string) => [...s].map((c) => (/[0-9a-f]/i.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join('');

  test('M5 a fullwidth sha glued to a masked id is masked too (CLI run 2, finding 1)', () => {
    // Breaks when the reader-view pass sees the token itself: it ends in the hex letter "d", so a folded sha next to it makes one 33 character run.
    const ids = [...IDS, GOLD_SHA];
    const field = maskString(`${SHA}${fw(GOLD_SHA)}; ${fw(SHA)}`, ids);
    expect(field.masked).toBe(3);
    expect(countListed(field.text, ids), 'a listed id is left after the mask').toBe(0);
    expect(field.text).not.toContain(GOLD_SHA);
  });

  test('M6 a private-use character that already stands in the text comes back unchanged (CLI run 2, finding 1)', () => {
    // Breaks when the swap character is a fixed one: the text own character would turn into the token on the way back.
    const text = `note  comment ${COMMENT}​4; PR ${[...PR].map((d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).join('')} `;
    const field = maskString(text, IDS);
    expect(field.masked).toBe(2);
    expect(field.text.split('')).toHaveLength(2);
    expect(field.text.split('')).toHaveLength(2);
    expect(countListed(field.text, IDS)).toBe(0);
  });
});

test.describe('loadListedIds: an unreadable or empty list is never "all clear"', () => {
  const load = (kind: TreeKind) => {
    const t = makeTree(kind, REL);
    return loadListedIds(t.root, t.read, t.list);
  };

  test('L1 a good tree gives the holdout ids and the gold ids', () => {
    const r = load('good');
    expect(r.ok).toBe(true);
    if (r.ok) for (const id of [PR, COMMENT, KEY, SHA, GOLD_SHA, String(GOLD_PR)]) expect(r.ids).toContain(id);
  });

  test('L2 no dataset file is "absent", a bad file or a missing config is "bad", no ids is "empty"', () => {
    // Breaks when a missing or broken file reads as an empty list that passes everything.
    expect(load('absent')).toEqual({ ok: false, reason: 'absent' });
    expect(load('bad-json')).toEqual({ ok: false, reason: 'bad' });
    expect(load('no-config')).toEqual({ ok: false, reason: 'bad' });
    expect(load('empty')).toEqual({ ok: false, reason: 'empty' });
    expect(load('excluded-all')).toEqual({ ok: false, reason: 'empty' });
  });

  test('L3 a missing gold folder adds no id; a broken or wrongly shaped gold file is "bad"', () => {
    const missing = load('gold-missing');
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.ids).not.toContain(GOLD_SHA);
    expect(load('gold-broken')).toEqual({ ok: false, reason: 'bad' });
    expect(load('gold-wrong-shape')).toEqual({ ok: false, reason: 'bad' });
  });

  test('L4 in no tree does an ok result hold an empty list', () => {
    // The seat condition: an empty or missing list must never read as "0 ids, all clear".
    for (const kind of TREE_KINDS) {
      const r = load(kind);
      expect(r.ok === false || r.ids.length > 0, kind).toBe(true);
    }
  });

  test('L5 a root with no list files (a worktree, a moved app) is "absent", not an empty list', () => {
    const t = makeTree('absent', REL, 'SOME-OTHER-ROOT');
    expect(loadListedIds(t.root, t.read, t.list)).toEqual({ ok: false, reason: 'absent' });
  });
});

test.describe('listedIdRoot', () => {
  test('R1 AGENTIC_OS_LISTED_ID_ROOT wins; a blank value falls back to two folders above the app', () => {
    // Breaks when the env is ignored, or a blank value is taken as a root.
    expect(listedIdRoot({ AGENTIC_OS_LISTED_ID_ROOT: '/primary' }, '/x/apps/agentic-os')).toBe('/primary');
    expect(listedIdRoot({ AGENTIC_OS_LISTED_ID_ROOT: '   ' }, '/x/apps/agentic-os').replace(/\\/g, '/')).toMatch(/\/x$/);
    expect(listedIdRoot({}, '/x/apps/agentic-os').replace(/\\/g, '/')).toMatch(/\/x$/);
  });
});
