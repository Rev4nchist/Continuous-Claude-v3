#!/usr/bin/env node
/**
 * bus-tool-populator -- PostToolUse (Read | Grep). WS-2 Phase B.4b.
 *
 * The deferred second slice of the bus WRITE side: records the session's passive working
 * set so recall bias reflects what was looked at, not just what was edited.
 *   - Read  -> files_in_play role `read_for_context` (LOAD-BEARING -- an explicit read is a
 *              strong "this file is in play" signal).
 *   - Grep  -> files_in_play role `grep_hit` (AMBIENT -- a softer signal; the 30% ambient cap
 *              in addFileInPlay keeps grep noise from flooding out load-bearing context).
 *
 * Single-writer rule: this is a HOOK, so it MAY write L2 (only hooks do). It uses the same
 * fail-open `mutateBus` path as `post-edit-diagnostics` (Phase B.0 200ms lock cap + never-silent
 * drop + `CCV3_BUS_OFF` kill switch all honored inside mutateBus). A bus write NEVER blocks or
 * breaks the tool; the hook always emits `{}`.
 *
 * Path hygiene: only files that (a) exist on disk, (b) live under CLAUDE_PROJECT_DIR, and
 * (c) are not noise (node_modules/.git/dist/cache/...) are recorded, stored project-relative.
 */

import { readFileSync, statSync, realpathSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import { mutateBus, addFileInPlay } from './shared/context-bus.js';
import { isEngineHost } from './shared/engine-host.js';

interface HookInput {
  tool_name?: string;
  tool?: string;
  tool_input?: { file_path?: string; [k: string]: unknown };
  tool_response?: unknown;
}

/** Cap on grep_hit files recorded per call (the ambient ratio cap bounds it further). */
const GREP_HIT_CAP = 8;
/** Cap on grep-response lines scanned (bounds work on a huge response). */
const GREP_SCAN_LINES = 200;
/** Path segments that mark a file as noise -- never recorded to the bus. */
const NOISE_SEGMENTS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.claude/cache', '.venv', '__pycache__'];

function isNoise(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return NOISE_SEGMENTS.some((seg) => norm === seg || norm.startsWith(seg + '/') || norm.includes('/' + seg + '/'));
}

/**
 * Validate a candidate path: must resolve (symlinks included) to a regular FILE that stays
 * under projectDir and is not noise. Returns the project-relative (forward-slash) path, or null.
 */
function toRecordablePath(candidate: string, projectDir: string): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  let real: string;
  let realRoot: string;
  try {
    // realpathSync resolves symlinks (so an in-project symlink that points OUTSIDE the project
    // is caught by the containment check below) AND throws on a missing path -- our existence
    // check. statSync then rejects directories/devices. The ROOT is realpath'd too so the
    // containment comparison is robust to a symlinked / 8.3-short-name base (both sides canonical).
    real = realpathSync(resolve(projectDir, candidate));
    realRoot = realpathSync(projectDir);
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const relRaw = relative(realRoot, real);
  // Reject anything that escapes the project: a `..` prefix (same-volume escape) OR an ABSOLUTE
  // result. On Windows `path.relative` returns an absolute string (no `..` prefix) for UNC and
  // cross-volume targets, so the `..` check alone is insufficient -- cross-model review F1/F2.
  if (!relRaw || relRaw.startsWith('..') || isAbsolute(relRaw)) return null;
  const rel = relRaw.replace(/\\/g, '/');
  if (isNoise(rel)) return null;
  return rel;
}

/** Read -> the single read file as a recordable project-relative path (or null). */
export function extractReadFile(filePath: string | undefined, projectDir: string): string | null {
  return filePath ? toRecordablePath(filePath, projectDir) : null;
}

/**
 * Grep -> recordable file paths parsed from the (format-varying) tool_response. Handles both
 * `files_with_matches` (bare path per line) and `content`/`count` (`path:line:...` / `path:count`)
 * output modes; existence-validation rejects the non-path text. Deduped + capped. Never throws.
 */
export function extractGrepHits(toolResponse: unknown, projectDir: string): string[] {
  let text: string;
  try {
    text = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '');
  } catch {
    return [];
  }
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const lines = text.split(/\r?\n/).slice(0, GREP_SCAN_LINES);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Candidate 1: the whole line (files_with_matches; also handles Windows `C:/...` paths).
    // Candidate 2: the path before a `:<lineno>` (content/count modes). Non-greedy `.*?` stops
    // at the first colon-then-digit, so a drive prefix like `C:` (colon-then-slash) is preserved.
    const candidates = [t];
    const m = t.match(/^(.*?):\d+(?::|$)/);
    if (m && m[1]) candidates.push(m[1]);
    for (const c of candidates) {
      const rel = toRecordablePath(c, projectDir);
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        out.push(rel);
        break; // one path per line
      }
    }
    if (out.length >= GREP_HIT_CAP) break;
  }
  return out;
}

// A Read is recorded LOAD-BEARING (`read_for_context`) on purpose: the B.3 readers
// (extractBusFocus) bias recall from the load_bearing slice ONLY, so an ambient role would make
// reads invisible to recall and defeat the feature (cross-model review F3). The cost is that a
// browse-heavy turn can evict OLD load_bearing entries via the 50-slot turn-order cap -- bounded
// and acceptable: same-turn edits survive the tie-break, and prior-turn focus is already
// staleness-suppressed (~3 turns) by the readers before it would matter.
export function recordRead(filePath: string | undefined, projectDir: string): void {
  const rel = extractReadFile(filePath, projectDir);
  if (!rel) return;
  try {
    mutateBus(
      undefined,
      (b) => {
        addFileInPlay(b, { path: rel, role: 'read_for_context', turn_added: b.current_turn ?? 0 });
      },
      { projectDir },
    );
  } catch {
    /* fail-open: a bus write must never break the hook */
  }
}

export function recordGrep(toolResponse: unknown, projectDir: string): void {
  const hits = extractGrepHits(toolResponse, projectDir);
  if (hits.length === 0) return;
  try {
    mutateBus(
      undefined,
      (b) => {
        for (const h of hits) {
          addFileInPlay(b, { path: h, role: 'grep_hit', turn_added: b.current_turn ?? 0 });
        }
      },
      { projectDir },
    );
  } catch {
    /* fail-open */
  }
}

function main(): void {
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log('{}');
    return;
  }
  // Under cursor-agent (the review engine): no bus file in the reviewed tree (card engine-run-hook-files).
  if (isEngineHost(input)) {
    console.log('{}');
    return;
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const tool = input.tool_name || input.tool;
    if (tool === 'Read') recordRead(input.tool_input?.file_path, projectDir);
    else if (tool === 'Grep') recordGrep(input.tool_response, projectDir);
  } catch {
    /* fail-open */
  }
  console.log('{}');
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].includes('bus-tool-populator')) {
  main();
}
