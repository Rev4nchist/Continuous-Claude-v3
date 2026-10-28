import { redact } from './redact';

/**
 * An exception message that is safe to put in a DTO.
 *
 * Order matters: redact secrets first, then replace absolute paths, then clip. Clipping first
 * could cut a token or a path in half so a pattern no longer matches the remainder.
 *
 * A path is replaced up to the next quote or line end, even when it holds spaces: a Windows
 * home folder can be "C:\Users\First Last". Losing a little message text is better than
 * leaking a user name.
 */

const MAX_MESSAGE = 160;

const WINDOWS_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\)[^'"`<>|\r\n]*/g;
const POSIX_HOME_PATH =
  /(?<![\w:/.])\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b[^'"`<>|\r\n]*/g;
const POSIX_DEEP_PATH = /(?<![\w:/.])(?:\/[\w.@~+-]+){2,}\/?/g;

/** Replace every absolute path in already redacted text with `<path>`. For error messages: greedy to the line end. */
export function scrubPaths(text: string): string {
  return text
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_HOME_PATH, '<path>')
    .replace(POSIX_DEEP_PATH, '<path>');
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
const WINDOWS_PATH_TOKEN = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*/g;
const POSIX_HOME_PATH_TOKEN =
  /(?<![\w:/.])\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b[^\s'"`<>|]*/g;
const TRAILING_MARKS = /[.,;:!?)\]}]+$/;
/** A whole quoted absolute path, spaces included: "C:\Users\First Last\x", '/home/a/Acme Corp/y'. */
const QUOTED_PATH =
  /(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|root|tmp|var|etc|usr|opt|mnt|srv|private|run|proc)\b)[^"'`\r\n]*\1/g;
/**
 * Words right after a scrubbed path that still hold a path separator ("Corp/layoffs.csv",
 * "Last\My") are the rest of a path with spaces: absorb them. A plain word (or, to, today) has no
 * separator, so the sentence around the path survives.
 */
const PATH_TAIL = /<path>((?:[ \t]+[^\s'"`<>|]*[\\/][^\s'"`<>|]*)+)/g;

function pathToken(match: string): string {
  const tail = TRAILING_MARKS.exec(match);
  return `<path>${tail ? tail[0] : ''}`;
}

/** Replace every absolute path in already redacted free text with `<path>`, keeping the words around it. */
export function scrubPathsInText(text: string): string {
  return text
    .replace(QUOTED_PATH, '<path>')
    .replace(WINDOWS_PATH_TOKEN, pathToken)
    .replace(POSIX_HOME_PATH_TOKEN, pathToken)
    .replace(POSIX_DEEP_PATH, pathToken)
    .replace(PATH_TAIL, (_all, tail: string) => `<path>${TRAILING_MARKS.exec(tail)?.[0] ?? ''}`);
}

export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redact(raw.slice(0, 2000)).text;
  const noPaths = scrubPaths(redacted);
  const flat = noPaths.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_MESSAGE ? flat : `${flat.slice(0, MAX_MESSAGE - 3)}...`;
}
