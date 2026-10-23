/**
 * smart-search-router — ripgrep argv injection-safety tests (Phase 1b, ST-08 slice)
 *
 * D2b-10 / GAP4-01: the ripgrep fallback previously interpolated a
 * model-controlled Grep pattern into an execSync shell string with naive
 * escaping (only `"` and `$`). buildRipgrepArgs returns an argv array consumed
 * by spawnSync(..., {shell:false}) so no shell ever sees the pattern — closing
 * the injection. Retired #1: `-e <pattern> -- <path>` keeps a leading-dash
 * pattern literal and terminates flag parsing before the path operand.
 */
import { describe, it, expect } from 'vitest';
import { buildRipgrepArgs, classifyQuery, isScopedCall } from '../smart-search-router.js';

describe('buildRipgrepArgs — injection-safe ripgrep argv', () => {
  it('passes the pattern via -e so a leading-dash pattern is literal, not a flag', () => {
    const args = buildRipgrepArgs('--files', '.');
    expect(args[0]).toBe('-e');
    expect(args[1]).toBe('--files'); // verbatim, treated as the search pattern
    expect(args).toContain('--');
    expect(args[args.length - 1]).toBe('.');
    expect(args.indexOf('--')).toBeLessThan(args.length - 1);
  });

  it('hands a shell-metachar payload through as a SINGLE verbatim argv element', () => {
    const payload = 'a" & calc & "b ; $(rm -rf /) `id`';
    const args = buildRipgrepArgs(payload, '/some/dir');
    expect(args[1]).toBe(payload); // exactly one element, byte-identical, no escaping
    expect(args.filter((a) => a === payload).length).toBe(1);
  });

  it('keeps the path after the -- terminator so a dash-leading path is not a flag', () => {
    const args = buildRipgrepArgs('foo', '-rf');
    const term = args.indexOf('--');
    expect(term).toBeGreaterThanOrEqual(0);
    expect(args.slice(term + 1)).toEqual(['-rf']);
  });

  it('preserves the original ripgrep flags (type/line-number/max-count)', () => {
    const args = buildRipgrepArgs('foo', '.');
    expect(args).toContain('--type');
    expect(args).toContain('py');
    expect(args).toContain('--line-number');
    expect(args).toContain('--max-count');
    expect(args).toContain('10');
  });
});

// --- 2026-07-25 routing-bug fixes (flagged in the 2026-07-24 Serena-evaluation
// handoff): regex-literal patterns misclassified as structural, and explicitly
// scoped Grep calls (path/glob/type) rerouted with their scoping silently dropped.

describe('classifyQuery — regex-literal patterns beat the structural check', () => {
  it('treats escaped-paren patterns as literal (was: structural deny)', () => {
    expect(classifyQuery(String.raw`main\(\)`)).toBe('literal');
  });
  it('treats escaped-brace patterns as literal', () => {
    expect(classifyQuery(String.raw`LearningResult \{`)).toBe('literal');
  });
  it('treats alternation as literal', () => {
    expect(classifyQuery('recallViaDaemon|DEFAULT_RECALL_TIMEOUT_MS')).toBe('literal');
  });
  it('treats char-class patterns as literal', () => {
    expect(classifyQuery('^## [A-Z]')).toBe('literal');
  });
  it('still classifies plain declaration prefixes as structural', () => {
    expect(classifyQuery('function checkDbMemory')).toBe('structural');
    expect(classifyQuery('class Foo')).toBe('structural');
    expect(classifyQuery('import os')).toBe('structural');
  });
  it('still classifies natural-language queries as semantic', () => {
    expect(classifyQuery('how does the recall fallback work')).toBe('semantic');
  });
});

describe('isScopedCall — explicit path/glob/type passes through to native Grep', () => {
  it('true when path is set', () => {
    expect(isScopedCall({ pattern: 'function checkDbMemory', path: 'src/memory-awareness.ts' })).toBe(true);
  });
  it('true when glob is set', () => {
    expect(isScopedCall({ pattern: 'class Foo', glob: '**/*.ts' })).toBe(true);
  });
  it('true when type is set', () => {
    expect(isScopedCall({ pattern: 'def main', type: 'py' })).toBe(true);
  });
  it('false for a bare project-wide pattern', () => {
    expect(isScopedCall({ pattern: 'def main' })).toBe(false);
  });
});
