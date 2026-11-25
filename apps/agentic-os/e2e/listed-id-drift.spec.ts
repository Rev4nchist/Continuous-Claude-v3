import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import * as copy from '../src/lib/listed-id-mask';
import { COMMENT, DS, GOLD_SHA, IDS, IDS_WITH_WORD, KEY, PR, SHA, TEXTS, TREE_KINDS, WORD_ID, makeTree } from './listed-id-fixtures';

/**
 * The drift check of the listed-id mask (card agentic-os-listed-id-mask): the app copy (src/lib/listed-id-mask.ts) must give the same
 * answers as scripts/coordination/board-mask.mjs and scripts/github/lib/holdout-ids.mjs. The app cannot import those files, so THIS SPEC does,
 * read only: the import sits in the spec, never in app source, so the Next build stays inside the app.
 *
 * It compares constants and behaviour: the same made-up ids and texts go through both, and the masked text and the counts must be equal.
 * A changed fold rule, id form or file name in the copy (or in the original) fails here. Made-up ids only; a failure names a case label, never an id.
 */

type Masked = { text: string; masked: number };
type Original = {
  DATASET_REL: string;
  EVAL_CONFIG_REL: string;
  GOLD_DIR_REL: string;
  GOLD_NON_ROW_FILES: readonly string[];
  TOKEN: string;
  maskListed: (text: string, ids: string[]) => Masked;
  countListed: (text: string, ids: string[]) => number;
  maskLaneRows: (rows: { lanes: Record<string, unknown>[] }, ids: string[]) => number;
  readIdList: (root: string, read: (p: string) => string, list: (d: string) => string[]) => string[];
};
type HoldoutIds = {
  holdoutIdsOf: (ds: unknown, cfg: unknown) => string[];
  goldIdsOf: (files: unknown) => string[];
  checkGoldShape: (files: unknown) => string[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
let original: Original;
let holdout: HoldoutIds;

test.beforeAll(async () => {
  original = (await import(pathToFileURL(join(REPO, 'scripts', 'coordination', 'board-mask.mjs')).href)) as Original;
  holdout = (await import(pathToFileURL(join(REPO, 'scripts', 'github', 'lib', 'holdout-ids.mjs')).href)) as HoldoutIds;
});

type MaskApi = {
  maskListed: (text: string, ids: string[]) => Masked;
  countListed: (text: string, ids: string[]) => number;
  maskString: (text: string, ids: string[]) => Masked;
};

/** The original's field rule, as render-board applies it: maskLaneRows on one lane note. */
function originalField(text: string, ids: string[]): Masked {
  const row: Record<string, unknown> = { note: text };
  const n = original.maskLaneRows({ lanes: [row] }, ids);
  return { text: String(row.note), masked: n };
}

const LISTS: { label: string; ids: string[] }[] = [
  { label: 'numbers, key and sha', ids: IDS },
  { label: 'with a word id', ids: IDS_WITH_WORD },
  { label: 'a sha only', ids: [SHA] },
  { label: 'a digit id only', ids: [PR] },
  { label: 'empty list', ids: [] },
];

/** Case labels where `api` and the original differ. Never an id. */
function drifts(api: MaskApi): string[] {
  const out: string[] = [];
  for (const list of LISTS) {
    for (const c of TEXTS) {
      const name = `${list.label} / ${c.label}`;
      if (JSON.stringify(api.maskListed(c.text, list.ids)) !== JSON.stringify(original.maskListed(c.text, list.ids))) out.push(`maskListed: ${name}`);
      if (api.countListed(c.text, list.ids) !== original.countListed(c.text, list.ids)) out.push(`countListed: ${name}`);
      if (JSON.stringify(api.maskString(c.text, list.ids)) !== JSON.stringify(originalField(c.text, list.ids))) out.push(`maskString: ${name}`);
    }
  }
  return out;
}

test.describe('the copy against board-mask.mjs', () => {
  test('D1 the file names, the gold exception and the token are equal', () => {
    // Breaks when one side renames the dataset, the config or the gold folder, or changes the token: the copy would read another list.
    expect(copy.DATASET_REL).toBe(original.DATASET_REL);
    expect(copy.EVAL_CONFIG_REL).toBe(original.EVAL_CONFIG_REL);
    expect(copy.GOLD_DIR_REL).toBe(original.GOLD_DIR_REL);
    expect([...copy.GOLD_NON_ROW_FILES]).toEqual([...original.GOLD_NON_ROW_FILES]);
    expect(copy.TOKEN).toBe(original.TOKEN);
  });

  test('D2 the same texts and lists give the same masked text and counts, for every id form and fold rule', () => {
    // Breaks when a regexp, the sha prefix rule, the digit context rule, the Kelvin fold or the reader view differs between the two.
    expect(drifts(copy)).toEqual([]);
  });

  test('D3 the drift check can fail: a copy that skips one fold rule is caught', () => {
    // Breaks when the comparison stops reading the field rule (a check that cannot fail is no check).
    const mutant: MaskApi = { ...copy, maskString: (text, ids) => (/[０-９]/.test(text) ? { text, masked: 0 } : copy.maskString(text, ids)) };
    const found = drifts(mutant);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.startsWith('maskString'))).toBe(true);
    const countMutant: MaskApi = { ...copy, countListed: (text, ids) => (text.includes(SHA.slice(0, 10)) ? 0 : copy.countListed(text, ids)) };
    expect(drifts(countMutant).some((f) => f.startsWith('countListed'))).toBe(true);
  });
});

test.describe('the id list against holdout-ids.mjs and readIdList', () => {
  const cfgs = [{}, { holdoutExclude: [Number(PR)] }, { reserve: [{ pr: Number(PR) }] }];
  const goldFiles = [[{ target: { pr: 6161 }, head: GOLD_SHA, range: `${SHA}..${GOLD_SHA}` }], [{ target: { pr: 12 }, other: { x: [SHA] } }]];

  test('D4 holdoutIdsOf and goldIdsOf give the same ids', () => {
    // Breaks when the holdout rule (reserve, holdoutExclude), the key form or the gold walk differs.
    for (const cfg of cfgs) expect(copy.holdoutIdsOf(DS, cfg), JSON.stringify(Object.keys(cfg))).toEqual(holdout.holdoutIdsOf(DS, cfg));
    for (const files of goldFiles) expect(copy.goldIdsOf(files)).toEqual(holdout.goldIdsOf(files));
    expect(copy.holdoutIdsOf({ findings: [{ pr: 1, comment_id: WORD_ID }] }, {})).toEqual(holdout.holdoutIdsOf({ findings: [{ pr: 1, comment_id: WORD_ID }] }, {}));
  });

  test('D5 checkGoldShape gives the same ids or the same refusal', () => {
    // Breaks when the shape check of one side accepts a gold file the other refuses.
    const outcome = (fn: (f: unknown) => string[], files: unknown) => {
      try {
        return { ok: true, ids: fn(files) };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    };
    for (const files of [...goldFiles, [], [[]], 'x', [{ a: 1 }], [[{ target: { pr: 6161 } }]]]) {
      expect(outcome(copy.checkGoldShape, files)).toEqual(outcome(holdout.checkGoldShape, files));
    }
  });

  test('D6 loadListedIds and readIdList give the same ids, or the same failure kind, on every fake tree', () => {
    // Breaks when the copy reads another file, treats a missing gold folder differently or turns an unreadable list into an empty one.
    const rel = { dataset: original.DATASET_REL, config: original.EVAL_CONFIG_REL, goldDir: original.GOLD_DIR_REL };
    for (const kind of TREE_KINDS) {
      const t = makeTree(kind, rel);
      let expected: { ok: true; ids: string[] } | { ok: false; reason: string };
      try {
        expected = { ok: true, ids: original.readIdList(t.root, t.read, t.list) };
      } catch (error) {
        expected = { ok: false, reason: String((error as { kind?: string }).kind) };
      }
      expect(copy.loadListedIds(t.root, t.read, t.list), kind).toEqual(expected);
    }
  });

  test('D7 the made-up key and sha are in the list both sides build', () => {
    expect(copy.holdoutIdsOf(DS, {})).toEqual(expect.arrayContaining([KEY, SHA, COMMENT]));
  });
});
