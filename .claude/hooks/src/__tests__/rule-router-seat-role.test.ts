/**
 * Card coord-seat-role-on-holder: the full seat card reaches a fresh seat by a deny-first router entry.
 * Seat read 2026-11-15: fire on `claim re-program` and on EVERY `adopt` (adopt names no lane id), once per session.
 * The card file is .claude/rules-ondemand/seat-role.md: the router reads only that folder.
 *
 * Ways this can fail (one test each):
 *  P1 a fresh seat that adopts gets no card (no manifest entry, or the entry is inject and the card is not whole)
 *  R2 the card file is missing, or its late line is not there (cut)
 *  R3 the entry fires on a builder claim, or on a note that only names adopt
 *  T6 the card or its short block holds a listed id shape, a sha, or a file name that a guard refuses (seat condition B)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchRules, type Manifest } from '../rule-router.js';
import { readSeatShortCard, seatRoleLines, SEAT_BLOCK_MAX } from '../shared/breakpoint.js';

const CLAUDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(CLAUDE, 'rules-ondemand', 'manifest.json'), 'utf8')) as Manifest;
const LANE = 'node C:/Users/dkhay/.claude/scripts/lane.mjs';
const ids = (command: string): string[] =>
  matchRules({ session_id: 's', tool_name: 'Bash', tool_input: { command } }, manifest).map((r) => r.id);
const CARD = join(CLAUDE, 'rules-ondemand', 'seat-role.md');

describe('P1: a fresh seat gets the full card', () => {
  it('adopt fires seat-role', () => {
    expect(ids(`${LANE} adopt --from 11111111-2222-3333-4444-555555555555`)).toContain('seat-role');
  });
  it('claim re-program fires seat-role (and review-engine)', () => {
    const got = ids(`${LANE} claim re-program`);
    expect(got).toContain('seat-role');
    expect(got).toContain('review-engine');
  });
  it('the entry is deny-first', () => {
    const e = (manifest.rules as Array<{ id: string; mode: string }>).find((r) => r.id === 'seat-role');
    expect(e?.mode).toBe('deny-first');
  });
});

describe('R2: the card file exists whole', () => {
  it('has the short block and the late full-card line', () => {
    expect(existsSync(CARD)).toBe(true);
    const t = readFileSync(CARD, 'utf8');
    expect(t).toContain('<!-- short-card:start -->');
    expect(t).toContain('<!-- short-card:end -->');
    expect(t).toContain('After one 429, publish nothing until 18:00 CST');
  });
});

describe('R3: the entry stays quiet on other commands', () => {
  it.each([
    `${LANE} claim re-live-accrual`,
    `${LANE} claim coord-run-lock-and-go-row`,
    `${LANE} say "please adopt the plan" --to seat`,
    `${LANE} note my-lane "adopt --from x is next"`,
  ])('%s', (cmd) => {
    expect(ids(cmd)).not.toContain('seat-role');
  });
});

describe('T6: card hygiene (seat condition B)', () => {
  const text = existsSync(CARD) ? readFileSync(CARD, 'utf8') : '';
  it('the card file exists to scan', () => expect(text.length).toBeGreaterThan(0));
  it('holds no digit run of 3 or more digits (a PR number or listed id shape), except 429 and a clock time', () => {
    const runs = (text.match(/\d{3,}/g) ?? []).filter((r) => r !== '429' && r !== '1800');
    expect(runs).toEqual([]);
  });
  it('holds no 40-hex sha and no 7-hex-or-longer hex run', () => {
    expect(text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).toEqual([]);
  });
  it('names no script or path that a guard refuses in a command text', () => {
    expect(text).not.toMatch(/land-pr/i);
    expect(text).not.toMatch(/review-engine[\\/]/i);
    expect(text).not.toMatch(/holdout-ids|answer-key/i);
  });
});

describe('seat item 4: the real short block fits its budget whole', () => {
  it('is at most SEAT_BLOCK_MAX bytes and cut() leaves it unchanged', () => {
    const home = join(CLAUDE, '..');
    const block = readSeatShortCard(home);
    expect(block).not.toBeNull();
    expect(Buffer.byteLength(block ?? '')).toBeLessThanOrEqual(SEAT_BLOCK_MAX);
    const lines = seatRoleLines({ boardOk: true, lanes: [{ id: 're-program', title: '', goal: '', next: '', milestone: null }] }, block);
    expect(lines.join('\n')).toContain(block ?? 'x');
  });
});
