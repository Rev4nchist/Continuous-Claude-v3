import { expect, test } from '@playwright/test';

import { safeMessage, scrubPathsInText } from '../src/server/sources/safe-message';

/**
 * Path scrubber invariant grid (Node only: the functions are pure; run with playwright.pure.config.ts).
 *
 * One input shape, many roots, segments, wraps and tails:
 *   see <wrap(root + seg + 'finance.txt')><tail>
 * CodeRabbit found the same bug class three times on #200 (a path with a space, a quoted path with an
 * apostrophe, a link after a path). Each fix covered one shape. This grid covers the product.
 *
 * Ways it can fail, one oracle each:
 *   leak      scrubPathsInText leaves the user name, a segment word or the file name in the text Dave reads
 *             (privacy, Major). Break it: delete PATH_TAIL in safe-message.ts and `leak ... seg=space
 *             wrap=bare` fails; delete QUOTED_PATH and `leak ... seg=apostrophe wrap=dq` fails.
 *   leak-msg  safeMessage (the 503 body, greedy scrub) leaves the same words. Break it: narrow WINDOWS_PATH
 *             to stop at whitespace and `leak-msg ... seg=space` fails.
 *   keep      scrubPathsInText eats the words around the path: "see" or the last word of the tail is
 *             gone (Minor). Break it: let PATH_TAIL absorb a word that holds "://" and `keep ... tail=url`
 *             fails.
 *
 * Every title carries the tags root=, seg=, wrap=, so `--grep` selects a family of cells.
 * A cell the scrubber cannot handle goes in KNOWN_LIMITS with a reason. It then runs as test.fail: when
 * someone fixes the limit, the test turns red and the entry must go. The list cannot rot.
 * Imports only scrubPathsInText and safeMessage: both exist at the commits that fixed #200, so the same
 * spec can run against the commit before each fix (scripts/checks/proofs.json).
 */

type Oracle = 'leak' | 'leak-msg' | 'keep';

/** root tag -> [prefix, separator]. */
const ROOTS: Record<string, [string, string]> = {
  posix: ['/home/alice/', '/'],
  win: ['C:\\Users\\alice\\', '\\'],
  winfwd: ['C:/Users/alice/', '/'],
  unc: ['\\\\srv\\share\\Users\\alice\\', '\\'],
  tilde: ['~/', '/'],
  home: ['$HOME/', '/'],
  userprofile: ['%USERPROFILE%\\', '\\'],
};

/** seg tag -> the path segment, and the words of it that must not survive. */
const SEGS: Record<string, { text: string; words: string[] }> = {
  plain: { text: 'Plans', words: ['Plans'] },
  space: { text: 'Acme Corp', words: ['Acme', 'Corp'] },
  apostrophe: { text: "O'Brien", words: ['Brien'] },
  dquote: { text: 'a"b', words: ['a"b'] },
  tab: { text: 'Tab\tthere', words: ['Tab', 'there'] },
};

const WRAPS: Record<string, (path: string) => string> = {
  bare: (p) => p,
  dq: (p) => `"${p}"`,
  sq: (p) => `'${p}'`,
  bt: (p) => `\`${p}\``,
  paren: (p) => `(${p})`,
};

/** tail tag -> the text after the path, and the token of it that must survive (null: nothing to keep). */
const TAILS: Record<string, { text: string; keep: string | null }> = {
  none: { text: '', keep: null },
  word: { text: ' now?', keep: 'now?' },
  url: { text: ' https://example.com/t/1', keep: 'https://example.com/t/1' },
  mdlink: { text: ' [proof](https://example.com/t/1)', keep: '[proof](https://example.com/t/1)' },
  mark: { text: '.', keep: '.' },
};

type Limit = { root?: string; seg: string; wrap: string; oracle: Oracle; reason: string; source: string };

/**
 * Cells the scrubber cannot handle on purpose. Each entry needs a reason and a source (where the
 * trade-off is written down). Empty root means every root.
 */
const KNOWN_LIMITS: Limit[] = [];

const FILE = 'finance.txt';

const limitFor = (oracle: Oracle, root: string, seg: string, wrap: string): Limit | undefined =>
  KNOWN_LIMITS.find((l) => l.oracle === oracle && l.seg === seg && l.wrap === wrap && (l.root === undefined || l.root === root));

function input(root: string, seg: string, wrap: string, tail: string): string {
  const [prefix, sep] = ROOTS[root];
  const path = `${prefix}${SEGS[seg].text}${sep}${FILE}`;
  return `see ${WRAPS[wrap](path)}${TAILS[tail].text}`;
}

function leaked(output: string, seg: string): string[] {
  return ['alice', ...SEGS[seg].words, FILE].filter((w) => output.includes(w));
}

/**
 * The sentences that e2e/session-detail-review.spec.ts feeds through the page, run here on the function. That
 * spec needs a dev server and a database, so CI cannot run it. Break it: end a quoted path at its first
 * quote (the old QUOTED_PATH) and the two apostrophe rows fail; let PATH_TAIL absorb a link and the link rows fail.
 */
const SENTENCES: [string, string][] = [
  ['Move logs from /var/log/app1 to S3 and add tests', 'Move logs from <path> to S3 and add tests'],
  [String.raw`Should I delete C:\Users\free1\cache or keep it?`, 'Should I delete <path> or keep it?'],
  [String.raw`Keep C:\tmp\rec1.txt, then stop.`, 'Keep <path>, then stop.'],
  ['Archive /home/alice1/Acme Corp/layoffs1.csv before Friday', 'Archive <path> before Friday'],
  [String.raw`Open "C:\Users\First Last1\My Docs\plan.txt" now?`, 'Open <path> now?'],
  [String.raw`Use C:\Users\Jo Smith1\Program Files\setup.exe today.`, 'Use <path> today.'],
  [`Archive "/home/alice1/O'Brien/finance1.txt" before Friday`, 'Archive <path> before Friday'],
  [String.raw`Open "C:\Users\Pat1\O'Neil Docs\plan.txt" now?`, 'Open <path> now?'],
  ['Fix the report in /tmp/report1 https://example.com/ticket/1 then stop', 'Fix the report in <path> https://example.com/ticket/1 then stop'],
  ['Fix /tmp/report1 [proof](https://example.com/ticket/1) then stop', 'Fix <path> [proof](https://example.com/ticket/1) then stop'],
  ['Open ~/Documents/Acme1 Corp/plan.txt now', 'Open <path> now'],
  [String.raw`Then %USERPROFILE%\tmp1\f.txt and $HOME/h1/g.txt end`, 'Then <path> and <path> end'],
  // Two quoted paths in one sentence: the first quote that is followed by a space closes the first path.
  [`Compare "/home/alice/a.txt" with '/home/alice/O'Brien/b.txt' today`, 'Compare <path> with <path> today'],
];

test.describe('path scrubber invariant', () => {
  for (const [input, want] of SENTENCES) {
    test(`sentence ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(scrubPathsInText(input)).toBe(want);
    });
  }

  // A quote inside a path continues the path, so a storm of quotes must not cost more than a line scan.
  test('a long run of quotes inside paths scrubs in under 100 ms', () => {
    for (const unit of ['"/tmp/a"b', `'/home/x'y `, '"C:\\a"b"', '/tmp/a"b"b', '"/tmp/x ']) {
      const text = unit.repeat(2000);
      const started = Date.now();
      scrubPathsInText(text);
      safeMessage(new Error(text));
      expect(Date.now() - started, JSON.stringify(unit)).toBeLessThan(100);
    }
  });

  test('every KNOWN_LIMITS entry names a cell of the grid and has a reason', () => {
    for (const l of KNOWN_LIMITS) {
      expect(l.reason.trim(), `limit ${l.seg}/${l.wrap} needs a reason`).not.toBe('');
      expect(l.source.trim(), `limit ${l.seg}/${l.wrap} needs a source`).not.toBe('');
      expect(Object.keys(SEGS), 'seg').toContain(l.seg);
      expect(Object.keys(WRAPS), 'wrap').toContain(l.wrap);
      if (l.root !== undefined) expect(Object.keys(ROOTS), 'root').toContain(l.root);
    }
  });

  for (const root of Object.keys(ROOTS)) {
    for (const seg of Object.keys(SEGS)) {
      for (const wrap of Object.keys(WRAPS)) {
        const cell = `root=${root} seg=${seg} wrap=${wrap}`;

        test(`leak ${cell}`, () => {
          const limit = limitFor('leak', root, seg, wrap);
          test.fail(limit !== undefined, limit?.reason);
          for (const tail of Object.keys(TAILS)) {
            const text = input(root, seg, wrap, tail);
            const out = scrubPathsInText(text);
            expect.soft(leaked(out, seg), `tail=${tail} scrubPathsInText(${JSON.stringify(text)}) = ${JSON.stringify(out)}`).toEqual([]);
          }
        });

        test(`leak-msg ${cell}`, () => {
          const limit = limitFor('leak-msg', root, seg, wrap);
          test.fail(limit !== undefined, limit?.reason);
          for (const tail of Object.keys(TAILS)) {
            const text = input(root, seg, wrap, tail);
            const out = safeMessage(new Error(text));
            expect.soft(leaked(out, seg), `tail=${tail} safeMessage(${JSON.stringify(text)}) = ${JSON.stringify(out)}`).toEqual([]);
          }
        });

        test(`keep ${cell}`, () => {
          const limit = limitFor('keep', root, seg, wrap);
          test.fail(limit !== undefined, limit?.reason);
          for (const tail of Object.keys(TAILS)) {
            const text = input(root, seg, wrap, tail);
            const out = scrubPathsInText(text);
            const why = `tail=${tail} scrubPathsInText(${JSON.stringify(text)}) = ${JSON.stringify(out)}`;
            expect.soft(out.startsWith('see '), why).toBe(true);
            const keep = TAILS[tail].keep;
            if (keep !== null) expect.soft(out.endsWith(keep), why).toBe(true);
          }
        });
      }
    }
  }
});
