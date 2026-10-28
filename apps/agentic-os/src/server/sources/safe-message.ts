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

export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redact(raw.slice(0, 2000)).text;
  const noPaths = redacted
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_HOME_PATH, '<path>')
    .replace(POSIX_DEEP_PATH, '<path>');
  const flat = noPaths.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_MESSAGE ? flat : `${flat.slice(0, MAX_MESSAGE - 3)}...`;
}
