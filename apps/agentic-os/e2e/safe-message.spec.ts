import { expect, test } from '@playwright/test';

import { safeMessage, stripControl } from '../src/server/sources/safe-message';

/**
 * Text that reaches the page or an API body (Node only: the functions are pure).
 * Ways it can fail, one test each:
 *   S1 control, bidi and zero-width characters survive into text Dave reads (a U+202E flips the line)
 *   S2 stripControl eats the characters a line needs: tab, line break, accents, emoji
 *   S3 the 503 body of /api/mission-control carries a path or an unclipped query. The route calls
 *      safeMessage(error). The route cannot be made to fail in an e2e run without breaking the
 *      database, so this pins the function the route uses, not the wiring.
 */

/** Built from code points so the source file holds no bidi or control character. */
const chars = (...points: number[]): string => String.fromCharCode(...points);

test.describe('stripControl', () => {
  test('S1 removes C0 controls, bidi overrides and isolates, zero-width characters and the BOM', () => {
    const noise = chars(0x00, 0x08, 0x0e, 0x1f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff);
    expect(stripControl(`a${noise}b`)).toBe('ab');
    expect(stripControl(`gnp.exe${chars(0x202e)}txt`)).toBe('gnp.exetxt');
  });

  test('S2 keeps tab, line breaks, accents, CJK and emoji', () => {
    const text = 'tab\there\nline\r\ncaf\u00e9 \u4e2d\u6587 \ud83d\ude00';
    expect(stripControl(text)).toBe(text);
  });
});

test.describe('safeMessage for the 503 body', () => {
  test('S3 a path, a secret and a long query come out without the path, the secret or the tail', () => {
    const query = `Failed query: select "id", "project" from "sessions" where "id" in (${'$1, '.repeat(80)}$2)`;
    const message = `${query} at C:\Users\dave\continuous-claude\apps\agentic-os\.env.local password=hunter2hunter2`;
    const body = safeMessage(new Error(message));
    expect(body).not.toContain('C:\Users');
    expect(body).not.toContain('hunter2hunter2');
    expect(body.length).toBeLessThanOrEqual(160);
    expect(safeMessage(new Error('open /home/dave/.claude/state/x.json failed'))).not.toContain('/home/dave');
  });
});
