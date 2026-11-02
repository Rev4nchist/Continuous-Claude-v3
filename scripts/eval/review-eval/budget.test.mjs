// Failure modes (P0 F9, F10, F13; main spec 13.4).
//  F9  eval budget of 40 used            -> compare with `>` instead of `>=`
//  F10 global headroom used (240 of 300) -> drop cursorHeadroom from the cap
//  F13 damaged ledger line               -> JSON.parse with no try (budgetFromFile uses the real readLedger)
//  eval rows count all time, global rows only 7 days -> one window for both
//  an end row is not a second run       -> count lines instead of distinct ids
//  shadow replays stop at dailyMax per Chicago day -> drop the day filter
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { budgetFromFile, cursorBudget } from './budget.mjs';

const cfg = { cursorEvalBudget: 40, cursorHeadroom: 60, shadow: { dailyMax: 6, retroMax: 40 } };
const NOW = Date.parse('2026-11-02T18:00:00Z');
const start = (id, sessionId, ts = NOW - 1000) => ({ ts: new Date(ts).toISOString(), phase: 'start', id, ref: `r-${id}`, sessionId });
const many = (n, sessionId, ts, p = 's') => Array.from({ length: n }, (_, i) => start(`${p}${sessionId}-${i}`, sessionId, ts));

test('F9 refuses at 40 eval runs, allows 39', () => {
  // Breaks when: the eval check uses `>` (40 > 40 is false, so a 41st run would start).
  assert.deepEqual(cursorBudget(many(39, 'review-eval'), cfg, { now: NOW }).ok, true);
  const r = cursorBudget(many(40, 'review-eval'), cfg, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'eval-budget');
  assert.equal(r.evalUsed, 40);
});

test('F10 refuses at 240 global runs (300 minus headroom 60), allows 239', () => {
  // Breaks when: cursorHeadroom is dropped (the cap becomes 300) or the check uses `>`.
  assert.equal(cursorBudget(many(239, 'live'), cfg, { now: NOW }).ok, true);
  const r = cursorBudget(many(240, 'live'), cfg, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'headroom');
  assert.equal(r.globalUsed, 240);
});

test('eval runs count all time; global runs count the last 7 days only', () => {
  // Breaks when: the eval count uses the 7-day window, or the global count uses all time.
  const old = NOW - 30 * 86_400_000;
  const entries = [...many(40, 'review-eval', old, 'old')];
  const r = cursorBudget(entries, cfg, { now: NOW });
  assert.equal(r.reason, 'eval-budget');
  assert.equal(r.evalUsed, 40);
  assert.equal(r.globalUsed, 0);
});

test('an end row does not count as a second run', () => {
  // Breaks when: the eval count counts lines instead of distinct run ids.
  const entries = [...many(20, 'review-eval'), ...Array.from({ length: 20 }, (_, i) => ({ ts: new Date(NOW).toISOString(), phase: 'end', id: `sreview-eval-${i}`, sessionId: 'review-eval' }))];
  const r = cursorBudget(entries, cfg, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.evalUsed, 20);
});

test('shadow replays stop at dailyMax per Chicago day', () => {
  // Breaks when: the shadow count has no day filter, or dailyMax is ignored.
  const today = NOW - 60_000;
  const yesterday = NOW - 2 * 86_400_000;
  const mk = (n, ts, p) => many(n, 'review-shadow', ts, p);
  assert.equal(cursorBudget([...mk(5, today, 'a'), ...mk(9, yesterday, 'b')], cfg, { now: NOW, kind: 'shadow' }).ok, true);
  const r = cursorBudget(mk(6, today, 'a'), cfg, { now: NOW, kind: 'shadow' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'shadow-daily');
});

test('F13 budgetFromFile skips a damaged line and counts the rest', () => {
  // Breaks when: budgetFromFile parses the file itself with no try/catch instead of the shared readLedger.
  const dir = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'budget-'));
  const file = path.join(dir, 'ledger.jsonl');
  const lines = many(40, 'review-eval').map((e) => JSON.stringify(e));
  lines.splice(5, 0, '{broken');
  writeFileSync(file, `${lines.join('\n')}\n`);
  const r = budgetFromFile(file, cfg, { now: NOW });
  assert.equal(r.evalUsed, 40);
  assert.equal(r.reason, 'eval-budget');
});

test('a missing ledger is an empty budget', () => {
  // Breaks when: budgetFromFile throws on ENOENT.
  const r = budgetFromFile(path.join(os.tmpdir(), 'no-such-dir-xyz', 'l.jsonl'), cfg, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.evalUsed, 0);
});
