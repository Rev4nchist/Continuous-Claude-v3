/**
 * The error of a failed racer of lane-race-probe.mjs, as one line: "code N: <stderr>".
 * The first Linux CI run of the probes showed "0 denied, 24 errored" and nothing else, so the cause stayed unknown (card
 * coord-test-suite, PR 2). Whitespace is collapsed, the text is cut to 600 characters, and every scheme://user:pass@ url is
 * masked with maskUrl. A bare password is not known here: run-probes.mjs masks it in the output of the whole probe.
 * No shebang and no argv read: it is a module, never a program.
 */
import { maskUrl } from './scratch-db.mjs';

export const RACER_ERROR_LIMIT = 600;

/** `racer` is { code, err } as the probe collects it from execFile. Pure. */
export function racerError({ code, err } = {}) {
  const text = String(err ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, (m) => maskUrl(m))
    .replace(/\s+/g, ' ')
    .trim();
  return `code ${code}: ${text ? text.slice(0, RACER_ERROR_LIMIT) : '(no stderr)'}`;
}
