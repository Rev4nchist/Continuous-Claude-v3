/**
 * kanban-strip -- what render-board.mjs does to kanban-client.js before it puts the file in the page.
 *
 * The page is near its size ratchet (render-board.test.mjs), and about 7 KB of the client is comments, so the page
 * carries the code without them. render-board.mjs and the tests import THIS function: the tests run the text the page ships.
 *
 * A regex cannot tell a comment from a string, so the rule is narrow and the function enforces it:
 *  - A block comment is removed only when it fills whole lines (it starts a line and nothing follows `*` + `/` on that line).
 *  - A line comment is removed only when it is the whole line. A trailing `// note` after code stays.
 *  - An inline block comment (`catch (e) { / * x * / }`) is NOT removed. It would be left in the output, and the output is checked.
 *  - After stripping, the output must hold no block comment marker, no line that ends in a backslash (a string
 *    continued on the next line) and no backtick (a template literal can hold a line that starts with two slashes).
 *    Any of them throws. The function fails closed: it never returns a program that differs from its input.
 */

const WHOLE_LINE_BLOCK = /^[ \t]*\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*(?:\r?\n|$)/gm;
const WHOLE_LINE_COMMENT = /^[ \t]*\/\/.*(?:\r?\n|$)/gm;

const LEFT_OVER = [
  [/\/\*/, 'a block comment marker is left (an inline block comment, or a slash and star inside a string): use a line comment'],
  [/\*\//, 'a block comment end is left (an inline block comment, or a star and slash inside a string or regex)'],
  [/\\[ \t]*\r?$/m, 'a line ends in a backslash (a string continued on the next line)'],
  [/`/, 'a template literal (backtick) is in the file: the client is ES5'],
];

/** The client text without its whole-line comments. Throws when what is left could hide a comment marker inside code. */
export function stripClientComments(src) {
  const out = String(src).replace(WHOLE_LINE_BLOCK, '').replace(WHOLE_LINE_COMMENT, '');
  for (const [re, why] of LEFT_OVER) {
    if (re.test(out)) throw new Error(`kanban-client.js cannot be stripped safely: ${why}`);
  }
  return out;
}
