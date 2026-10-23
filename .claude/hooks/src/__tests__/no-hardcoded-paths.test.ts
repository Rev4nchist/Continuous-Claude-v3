/**
 * Hardcoded user-path detector for hook source.
 *
 * Phase 2 of cross-project isolation remediation: scan src/ for literal
 * work-machine user strings that would break the hooks on any other machine.
 * Test fixtures under __tests__/ are intentional and excluded.
 *
 * Why: 4 SessionStart hooks shipped with `~/.claude/hooks`
 * baked in as a string literal. The fix uses `os.homedir()`. This test
 * regresses if anyone re-introduces the literal.
 */

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

const SRC_DIR = join(__dirname, '..');

const EXCLUDE_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('no hardcoded user paths in non-test source', () => {
  it('contains zero work-machine user literals in src/ outside __tests__', async () => {
    const forbidden = 'dav' + 'id.hayes';
    const hits: Array<{ file: string; line: number; text: string }> = [];

    for await (const file of walk(SRC_DIR)) {
      const txt = await readFile(file, 'utf8');
      const lines = txt.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(forbidden)) {
          // Skip comment lines that intentionally reference the path in
          // documentation. The literal must not appear in code.
          const trimmed = line.trim();
          const isDocComment =
            trimmed.startsWith('//') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('/*');
          if (!isDocComment) {
            hits.push({ file: file.replace(SRC_DIR + sep, ''), line: i + 1, text: line.trim() });
          }
        }
      });
    }

    expect(hits, `Found work-machine user literals in non-test src files: ${JSON.stringify(hits, null, 2)}`).toEqual([]);
  });
});
