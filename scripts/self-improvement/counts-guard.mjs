// counts-guard: the final pass of a --counts run of failure-audit.mjs or ask-rate.mjs (card coord-seat-counts, part B).
// Design note: .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md, section 3: no listed (holdout or gold) id may stand in any output.
// A counts output holds model names and entrypoint words that come from transcripts, so the pass runs on the whole text before anything is written.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from '../coordination/board-mask.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function primaryRoot() {
  try {
    return path.dirname(execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return REPO; }
}

/**
 * { ok, code, line }. ok false with code 3 when a listed id stands in one of the texts or the id list cannot be read: the caller prints
 * `line` to stderr, writes nothing and exits with `code`. A root with no id list is a note (ok true, `line` is the note). Ids are never printed.
 */
export function checkCounts(texts, idRoot = null) {
  let ids;
  try { ids = readIdList(idRoot || primaryRoot()); } catch (e) {
    if (e && e.kind === 'absent') return { ok: true, code: 0, line: 'counts mode: note: no listed-id list in this root; the output holds counts only' };
    return { ok: false, code: 3, line: 'counts mode: the listed-id list could not be read; no output' };
  }
  if (texts.some((t) => countListed(t, ids) > 0)) return { ok: false, code: 3, line: 'counts mode: a listed id reached the output; no output' };
  return { ok: true, code: 0, line: null };
}
