/**
 * Drift test (RED step, lane coord-guard-text-false-refusal, seat ruling 2026-11-23 12:48 CST, condition 5).
 * The DOC APPEND test has two copies: `isDocAppend` in shared/inert-quotes.ts (decision-gate, tested here) and in the plugin module
 * .claude/plugins/ccv3-mods/hooks/pr-checkpoint/model.ts (the free-slot queue guard, tested in the plugin's tests/doc-append.test.ts).
 * The plugin is a separate package whose tsconfig extends a file the engine writes at load time, so neither test imports the other copy.
 * Both read ONE row table, .claude/plugins/ccv3-mods/tests/fixtures/doc-append-rows.json. A row where a copy differs fails in its own test file.
 *
 * isDocAppend(segment): ONE command segment (no ; & | or newline in it). True only for Add-Content or Set-Content (full names),
 * ONE literal -LiteralPath or -Path (or a first positional path) ending .md .txt or .log, a value of single-quoted strings only,
 * no other parameter, no redirect, no variable, paren, brace, backtick or here-string.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDocAppend } from '../shared/inert-quotes.js';

const ROWS = JSON.parse(readFileSync(new URL('../../../plugins/ccv3-mods/tests/fixtures/doc-append-rows.json', import.meta.url), 'utf8')) as Array<{ want: boolean; segment: string }>;

describe('DOC APPEND: the hook copy gives the verdict of the shared row table', () => {
  it('the row table is not empty and holds both verdicts', () => {
    expect(ROWS.length).toBeGreaterThan(40);
    expect(ROWS.some((r) => r.want)).toBe(true);
    expect(ROWS.some((r) => !r.want)).toBe(true);
  });
  for (const { want, segment } of ROWS) {
    it(`${want ? 'accepts' : 'refuses'} ${JSON.stringify(segment)}`, () => {
      expect(isDocAppend(segment)).toBe(want);
    });
  }
});
