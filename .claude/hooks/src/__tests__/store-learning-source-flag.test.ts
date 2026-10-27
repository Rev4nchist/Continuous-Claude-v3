/**
 * Provenance: every hook that spawns scripts/core/store_learning.py must pass --source.
 *
 * The store_learning.py CLI defaults --source to "manual". A hook that drops the flag
 * still writes, but the row is labelled "manual" and not "hook", and nothing flags it.
 * This static scan catches the drop at test time.
 *
 * Breaks when: a hook argv for store_learning.py loses '--source', or the scan finds
 * no spawn site at all (a vacuous pass).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const SCRIPT = 'scripts/core/store_learning.py';
const WINDOW = 30; // lines after the script literal that hold the rest of the argv

function hookSources(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

describe('hooks that spawn store_learning.py pass --source', () => {
  const sites: { file: string; line: number; ok: boolean }[] = [];
  for (const file of hookSources()) {
    const lines = readFileSync(join(SRC, file), 'utf-8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (!text.includes(SCRIPT) || isComment(text)) return;
      const window = lines.slice(i, i + WINDOW).join('\n');
      sites.push({ file, line: i + 1, ok: /['"]--source['"]\s*,\s*['"](hook|manual|handoff|llm)['"]/.test(window) });
    });
  }

  it('finds the known spawn sites (not a vacuous scan)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('every spawn site passes --source with a valid value', () => {
    const missing = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line}`);
    expect(missing).toEqual([]);
  });
});
