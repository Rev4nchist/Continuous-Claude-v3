// Tests for the gold part of shared/holdout-ids.ts (card coord-content-scan-followups, item gold ids; design note
// .claudedocs/coordination/2026-11-16-coord-gold-ids-design.md, option 2: warn and mask, NO new deny). Every id here is made up.
//
// Failure modes and the change that would break each test:
//   L1 a gold file is not read, or the non-row file is                      -> hard-code the file names, or drop the escape-baseline skip
//   L2 a missing gold folder breaks the holdout list                        -> throw on ENOENT
//   L3 a broken gold file gives a short list or an error with file text     -> swallow the error, or put text in the message
//   L4 the deny list (push gate, commit-preflight) gets gold ids            -> add gold ids to loadHoldoutIds
//   L5 the deny callers are wired to the wider list, or the warn hook is not -> name loadListedIds in decision-gate.ts or commit-preflight.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as gold from '../shared/gold-ids.js';
import * as lib from '../shared/holdout-ids.js';

const HOLDOUT_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const GOLD_SHA_A = 'fedcba9876543210fedcba9876543210fedcba98';
const GOLD_SHA_B = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const GOLD_PR = '8888';
const HERE = dirname(fileURLToPath(import.meta.url));

let root: string;
const goldDir = () => join(root, 'scripts', 'eval', 'review-eval', 'gold');

function plantBase(): void {
  mkdirSync(join(root, '.claudedocs'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
  writeFileSync(join(root, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify({ prs: [{ pr: 4242 }], findings: [{ pr: 4242, comment_id: 7777777, round: HOLDOUT_SHA }] }));
  writeFileSync(join(root, 'scripts', 'eval', 'review-eval', 'config.json'), JSON.stringify({ holdoutExclude: [], reserve: [] }));
}
function plantGold(files: Record<string, unknown>): void {
  mkdirSync(goldDir(), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(goldDir(), name), typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'holdout-ids-gold-')); plantBase(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gold ids in the list of the warn and mask guards', () => {
  it('L1: every json file of the gold folder is read except the non-row file; clean controls count', () => {
    plantGold({
      'gold-a.json': [{ target: { pr: Number(GOLD_PR), sha40: GOLD_SHA_A } }],
      'clean-controls.json': [{ target: { pr: 12, sha40: GOLD_SHA_B } }],
      'escape-baseline.json': [{ band: 'x', note: HOLDOUT_SHA.replace(/a/g, 'c') }],
      'adjudicated-cr.state': 'not json',
    });
    expect(gold.loadGoldIds(root)).toEqual([GOLD_SHA_B, GOLD_SHA_A, GOLD_PR].sort());
  });

  it('L2: a missing gold folder gives no gold id and leaves the holdout list as it was', () => {
    expect(gold.loadGoldIds(root)).toEqual([]);
    expect(gold.loadListedIds(root).sort()).toEqual(lib.loadHoldoutIds(root).sort());
  });

  it('L3: a gold file that is broken, of the wrong shape or not a folder throws one fixed text and never a short list', () => {
    const text = 'the gold id list could not be read';
    const secret = 'zebra-quartz-secret';
    for (const files of [{ 'gold-a.json': `{ not json ${secret}` }, { 'gold-a.json': [{ target: { pr: 4444 } }] }, { 'gold-a.json': { rows: secret } }]) {
      rmSync(goldDir(), { recursive: true, force: true });
      plantGold(files);
      expect(() => gold.loadGoldIds(root)).toThrow(text);
      expect(() => gold.loadListedIds(root)).toThrow(text);
      try { gold.loadGoldIds(root); } catch (e) { expect(String((e as Error).message)).not.toContain(secret); }
    }
    rmSync(goldDir(), { recursive: true, force: true });
    writeFileSync(goldDir(), 'this is a file, not a folder');
    expect(() => gold.loadGoldIds(root)).toThrow(text);
  });

  it('L4: the deny list keeps the holdout ids only; the wider list holds both once', () => {
    plantGold({ 'gold-a.json': [{ target: { pr: Number(GOLD_PR), sha40: GOLD_SHA_A }, provenance: { fixSha: HOLDOUT_SHA } }] });
    const holdout = lib.loadHoldoutIds(root);
    expect(holdout).toContain(HOLDOUT_SHA);
    expect(holdout).not.toContain(GOLD_SHA_A);
    expect(holdout).not.toContain(GOLD_PR);
    const wide = gold.loadListedIds(root);
    for (const id of [HOLDOUT_SHA, GOLD_SHA_A, GOLD_PR, '4242', '7777777']) expect(wide, id).toContain(id);
    expect(wide.filter((x: string) => x === HOLDOUT_SHA)).toHaveLength(1); // in both lists: counted once
    expect(new Set(wide).size).toBe(wide.length);
  });

  it('L5: guard: the push gate and commit-preflight still read the holdout list only; the warn hook reads the wider one', () => {
    const src = (f: string) => readFileSync(join(HERE, '..', f), 'utf8');
    for (const f of ['decision-gate.ts', 'commit-preflight.ts']) {
      expect(src(f), f).toContain('loadHoldoutIds');
      expect(src(f), f).not.toMatch(/gold-ids|loadListedIds|loadGoldIds|goldIdsOf/);
    }
    expect(src('holdout-scan.ts')).toContain('loadListedIds');
    expect(src('shared/holdout-ids.ts'), 'the shared wrapper of the deny hooks has no gold code').not.toMatch(/gold/i);
  });

  it('L6: guard: the built bundles of the push gate and commit-preflight hold no gold code', () => {
    const dist = (f: string) => readFileSync(join(HERE, '..', '..', 'dist', f), 'utf8');
    for (const f of ['decision-gate.mjs', 'commit-preflight.mjs']) expect(dist(f), f).not.toMatch(/goldIdsOf|loadGoldIds|loadListedIds|MIN_GOLD_PR_DIGITS|checkGoldShape/);
    expect(dist('holdout-scan.mjs'), 'the warn hook is built with the gold list').toMatch(/loadListedIds/);
  });
});
