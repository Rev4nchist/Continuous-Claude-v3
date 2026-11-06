/**
 * Pure helpers for the TypeScript path of post-edit-diagnostics.
 *
 * The hook must type-check the project that owns the edited file, not CLAUDE_PROJECT_DIR:
 * a repo root without tsconfig.json makes tsc print its help text and report nothing.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve, relative, isAbsolute } from 'path';

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: number;
  message: string;
}

/** One diagnostic line of `tsc --pretty false` (same shape in TS 5.9 and TS 7). */
export const TSC_LINE_REGEX = /^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/;

const MAX_EDITED = 10;
const MAX_OTHER_FILES = 5;
const MAX_CHARS = 9000;

export function classifyExtension(filePath: string): 'ts' | 'js' | 'python' | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'ts';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'js';
  if (['.py', '.pyx', '.pyi'].includes(ext)) return 'python';
  return null;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk up from the edited file's folder to stopDir (inclusive) and return the first
 * tsconfig.json. A file outside stopDir walks up to its own filesystem root.
 */
export function findNearestTsconfig(filePath: string, stopDir: string): string | null {
  const stop = resolve(stopDir);
  const bounded = isInside(resolve(filePath), stop);
  let dir = dirname(resolve(filePath));
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      return null;
    }
    if (bounded && dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A solution-style config (`files: []` plus `references`) type-checks nothing with `-p`. */
export function isSolutionStyleTsconfig(tsconfigPath: string): boolean {
  try {
    const text = readFileSync(tsconfigPath, 'utf-8');
    return /"files"\s*:\s*\[\s*\]/.test(text) && /"references"\s*:/.test(text);
  } catch {
    return false;
  }
}

export function parseTscOutput(stdout: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  for (const raw of stdout.split('\n')) {
    const m = raw.replace(/\r$/, '').match(TSC_LINE_REGEX);
    if (!m) continue;
    out.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4] as 'error' | 'warning',
      code: parseInt(m[5], 10),
      message: m[6],
    });
  }
  return out;
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase();
  return n(a) === n(b);
}

/**
 * Build the context note: edited-file errors first (capped), then a count per other file.
 * `cwd` is the folder tsc ran in; diagnostic paths are relative to it.
 */
export function formatTsDiagnostics(
  diags: TscDiagnostic[],
  editedFile: string,
  cwd: string,
  tsconfigLabel: string,
): string {
  const edited = diags.filter((d) => samePath(resolve(cwd, d.file), editedFile));
  const others = diags.filter((d) => !samePath(resolve(cwd, d.file), editedFile));
  const perFile = new Map<string, number>();
  for (const d of others) perFile.set(d.file, (perFile.get(d.file) ?? 0) + 1);

  const lines: string[] = [
    `TypeScript (${tsconfigLabel}): ${edited.length} in the edited file, ${others.length} in ${perFile.size} other files.`,
  ];
  for (const d of edited.slice(0, MAX_EDITED)) {
    lines.push(`   - ${d.file}:${d.line}:${d.column}: TS${d.code} ${d.message}`);
  }
  if (edited.length > MAX_EDITED) lines.push(`   ... ${edited.length - MAX_EDITED} more in the edited file`);

  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_OTHER_FILES);
  if (top.length) {
    lines.push('   Other files:');
    for (const [file, n] of top) lines.push(`   - ${file}: ${n} error${n === 1 ? '' : 's'}`);
    if (perFile.size > top.length) lines.push(`   ... ${perFile.size - top.length} more files`);
  }

  let text = lines.join('\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n   ... (truncated)';
  return text;
}
