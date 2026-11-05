#!/usr/bin/env node
/**
 * changed-lines.mjs: the new-side lines a unified diff adds or changes.
 *
 * Usage: node scripts/checks/changed-lines.mjs --diff <file>      (or the diff on stdin)
 * Output: JSON [{ path, ranges: [[start, end], ...] }]
 *
 * Rules:
 *   - A range holds consecutive added lines on the new side. Both ends are inclusive.
 *   - A removed line adds no range. A deleted file is not listed.
 *   - A renamed file is listed under its new path. A rename with no edit has no ranges.
 *   - CRLF diffs and the "\ No newline at end of file" marker are safe: parseHunks handles both.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from '../github/review-filter.mjs';

/** Joins sorted line numbers into [start, end] runs. */
function toRanges(lines) {
  const ranges = [];
  for (const n of lines) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

function addedLines(entry) {
  const nums = entry.hunks.flatMap((h) => h.lines.filter((l) => l.t === '+').map((l) => l.new));
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** diffText: unified diff. Returns [{ path, ranges }] in diff order. */
export function changedLines(diffText) {
  const text = String(diffText ?? '');
  // parseHunks starts a file only at "diff --git", so a plain unified diff would give no files at all.
  if (/^@@ /m.test(text) && !/^diff --git /m.test(text)) {
    throw new Error('changed-lines: diff has hunks but no "diff --git" header. Pass a Git-format diff.');
  }
  const out = [];
  for (const entry of parseHunks(diffText).values()) {
    if (!entry.file) continue; // deleted file
    out.push({ path: entry.file, ranges: toRanges(addedLines(entry)) });
  }
  return out;
}

/** True when line is inside one of the ranges. */
export function inRanges(ranges, line) {
  return (ranges ?? []).some(([a, b]) => line >= a && line <= b);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

const USAGE = 'Usage: changed-lines.mjs --diff <file>   (or pipe a diff on stdin)\n';

// A terminal has no piped diff. Reading it would hang, so print the usage instead.
if (isMain()) {
  const i = process.argv.indexOf('--diff');
  const file = i > 0 ? process.argv[i + 1] : undefined;
  if (process.argv.includes('--help')) {
    process.stdout.write(USAGE);
  } else if (!file && process.stdin.isTTY) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    const text = readFileSync(file ?? 0, 'utf8');
    process.stdout.write(`${JSON.stringify(changedLines(text), null, 2)}\n`);
  }
}
