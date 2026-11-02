import { redact } from './redact';

/**
 * An exception message that is safe to put in a DTO.
 *
 * Order matters: strip invisible characters, redact secrets, replace absolute paths, then clip. Clipping first
 * could cut a token or a path in half so a pattern no longer matches the remainder.
 *
 * A path is replaced up to the next quote or line end, even when it holds spaces: a Windows
 * home folder can be "C:\Users\First Last". Losing a little message text is better than
 * leaking a user name.
 */

const MAX_MESSAGE = 160;

/** What may follow a quote that closes a quoted path or ends a path token. Any other next character means the quote is part of the path. */
const QUOTE_CLOSES = String.raw`[\s.,;:!?)\]}'"\x60<>|]`;
/**
 * A quote inside a path: O'Brien, a"b. It belongs to the path when a path character follows it. A quote
 * followed by white space, a sentence mark, a closing bracket, another quote, `<>|` or the end of the text
 * ends the path instead. Before this rule "/home/alice/O'Brien/finance.txt" left "Brien/finance.txt".
 */
const PATH_QUOTE = String.raw`['"\x60](?!${QUOTE_CLOSES}|$)`;
/** One character of a path that runs to the line end (error messages), and of a path that ends at white space (free text). */
const LINE_CHAR = String.raw`(?:[^'"\x60<>|\r\n]|${PATH_QUOTE})*`;
const TOKEN_CHAR = String.raw`(?:[^\s'"\x60<>|]|${PATH_QUOTE})*`;

const WINDOWS_PATH = new RegExp(String.raw`(?:\b[A-Za-z]:[\\/]|\\\\)${LINE_CHAR}`, 'g');
const POSIX_HOME_PATH = new RegExp(
  String.raw`(?<![\w:/.])\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b${LINE_CHAR}`,
  'g',
);
/** Home-relative forms in error messages: ~/x, $HOME/x, %USERPROFILE%\x. They carry file names even with no user name. */
const HOME_REL_PATH = new RegExp(String.raw`(?<![\w:/.~])(?:~|\$HOME|%USERPROFILE%)[\\/]${LINE_CHAR}`, 'g');
const POSIX_DEEP_PATH = /(?<![\w:/.])(?:\/[\w.@~+-]+){2,}\/?/g;

/**
 * Words right after a scrubbed path that still hold a path separator ("Corp/layoffs.csv",
 * "Last\My") are the rest of a path with spaces: absorb them. A plain word (or, to, today) has no
 * separator, so the sentence around the path survives. A word that holds a link (scheme://, also
 * inside a Markdown link) is not a path tail.
 *
 * A path that ends at a quote followed by white space ("/home/alice/Clients' Reports/x.txt") leaves
 * `<path>'`: one optional quote between `<path>` and the white space is part of the match, so
 * "Reports/x.txt" is absorbed as well. Over-scrubbing is on purpose: losing a word beats leaking a path.
 */
const PATH_TAIL = /<path>['"`]?((?:[ \t]+(?![^\s]*(?::\/\/|\]\())[^\s'"`<>|]*[\\/][^\s'"`<>|]*)+)/g;
const TRAILING_MARKS = /[.,;:!?)\]}]+$/;

function absorbPathTail(text: string): string {
  return text.replace(PATH_TAIL, (_all, tail: string) => `<path>${TRAILING_MARKS.exec(tail)?.[0] ?? ''}`);
}

/** Replace every absolute path in already redacted text with `<path>`. For error messages: greedy to the line end. */
export function scrubPaths(text: string): string {
  return absorbPathTail(
    text
      .replace(WINDOWS_PATH, '<path>')
      .replace(POSIX_HOME_PATH, '<path>')
      .replace(HOME_REL_PATH, '<path>')
      .replace(POSIX_DEEP_PATH, '<path>'),
  );
}

/**
 * Same patterns, but a path ends at the next whitespace, so the words around it survive:
 * "Should I delete C:\tmp\cache or keep it?" keeps "or keep it?". A sentence mark that ends the
 * path token (comma, period, question mark) stays. A quoted path is scrubbed whole, and words that
 * follow a path and still hold a separator are absorbed (PATH_TAIL below). Remaining trade-off,
 * chosen on purpose: an unquoted path whose last space-separated word has no separator
 * ("C:\Users\First Last", ending there) leaves "Last" visible. This is for free text Dave reads
 * (goal, ask, plan, decisions); error messages keep the greedy scrub.
 */
const WINDOWS_PATH_TOKEN = new RegExp(String.raw`(?:\b[A-Za-z]:[\\/]|\\\\)${TOKEN_CHAR}`, 'g');
const POSIX_HOME_PATH_TOKEN = new RegExp(
  String.raw`(?<![\w:/.])\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b${TOKEN_CHAR}`,
  'g',
);
/** Home-relative forms: ~/x, $HOME/x, %USERPROFILE%\x. They carry file names even with no user name. */
const HOME_REL_TOKEN = new RegExp(String.raw`(?<![\w:/.~])(?:~|\$HOME|%USERPROFILE%)[\\/]${TOKEN_CHAR}`, 'g');
const PATH_START =
  /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\$HOME[\\/]|%USERPROFILE%[\\/]|\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b)/
    .source;
/**
 * A whole quoted absolute path, spaces included: "C:\Users\First Last\x", '/home/a/Acme Corp/y'.
 * Each quote kind ends at its own closing quote, so another quote character may sit inside the
 * path: "/home/alice/O'Brien/x.txt". A quote of the same kind inside the path ("/home/a/a"b/x") closes
 * it only when white space, a sentence mark or a closing bracket follows (QUOTE_CLOSES).
 * The final quote meets the same condition. Without it the match could end at an inner quote:
 * `"/home/alice/a"b/finance.txt` (no real closing quote) would leave "b/finance.txt". With no closing quote
 * the quoted form does not match, and the token scrubbers take the path.
 */
const quotedPath = (quote: string): string =>
  `${quote}${PATH_START}(?:[^${quote}\\r\\n]|${quote}(?!${QUOTE_CLOSES}|$))*${quote}(?=${QUOTE_CLOSES}|$)`;
const QUOTED_PATH = new RegExp(['"', "'", '`'].map(quotedPath).join('|'), 'g');
function pathToken(match: string): string {
  const tail = TRAILING_MARKS.exec(match);
  return `<path>${tail ? tail[0] : ''}`;
}

/**
 * Stands for a CLOSED quoted path until absorbPathTail has run. PATH_TAIL matches the text `<path>` only, so the
 * words after a closed quote ("and/or continue") are never taken as the rest of the path. A private-use character
 * that no pass in this file matches. A copy of it in the input is dropped first.
 * Not for a path in single quotes: an apostrophe can sit inside a name ("Clients' Reports/x.txt"), so a path that
 * ends at `'` is not trusted as closed. It stays `<path>` and PATH_TAIL absorbs the next separator word.
 * Over-scrubbing is on purpose: losing "and/or" beats leaking "Reports/x.txt".
 */
const CLOSED_QUOTED = '\uE000';

/** Replace every absolute path in already redacted free text with `<path>`, keeping the words around it. */
export function scrubPathsInText(text: string): string {
  return absorbPathTail(
    text
      .replaceAll(CLOSED_QUOTED, '')
      .replace(QUOTED_PATH, (quoted) => (quoted.startsWith("'") ? '<path>' : CLOSED_QUOTED))
      .replace(WINDOWS_PATH_TOKEN, pathToken)
      .replace(POSIX_HOME_PATH_TOKEN, pathToken)
      .replace(HOME_REL_TOKEN, pathToken)
      .replace(POSIX_DEEP_PATH, pathToken),
  ).replaceAll(CLOSED_QUOTED, '<path>');
}

/**
 * Control characters (not tab or line breaks), bidi overrides and isolates, zero-width characters and the BOM.
 * They are invisible or flip the text around them ("gnp.exe" shown as "exe.png"); Dave reads this text.
 * Run BEFORE redaction: a secret split by one of these matches no redact pattern, and a strip after redact would show it whole.
 */
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function stripControl(text: string): string {
  return text.replace(INVISIBLE, '');
}

export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redact(stripControl(raw.slice(0, 2000))).text;
  const noPaths = scrubPaths(redacted);
  const flat = noPaths.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_MESSAGE ? flat : `${flat.slice(0, MAX_MESSAGE - 3)}...`;
}
