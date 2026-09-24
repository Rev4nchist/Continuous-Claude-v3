// The guard is only useful if it counts what Claude Code counts. The end-to-end check is the
// guard's own run against ~/.claude, which matched Claude Code's warning (42 files, 153,689 chars).
// These tests cover the parsers and the import walk, one test per listed way they could miscount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findImports, isPathScoped, collect } from '../context-budget-guard.mjs';

test('an @path in inline code or a fenced block is not an import', () => {
  const text = 'Use `see @inline.md` here.\n```\n@RULES.md\n```\n@real.md\n';
  assert.deepEqual(findImports(text, 'user/CLAUDE.md'), ['user/real.md']);
});

test('a nested import resolves against the importing file folder, in its own scope', () => {
  assert.deepEqual(findImports('see @child.md and @../top.md\n', 'user/docs/architecture/INDEX.md'),
    ['user/docs/architecture/child.md', 'user/docs/top.md']);
  assert.deepEqual(findImports('@AGENTS.md\n', 'project/CLAUDE.md'), ['project/AGENTS.md']);
});

test('an email address is not an import', () => {
  assert.deepEqual(findImports('mail dkhayes44@gmail.com today\n', 'user/CLAUDE.md'), []);
});

test('@~/.claude/ imports count in the user scope; other home paths do not', () => {
  assert.deepEqual(findImports('@~/.claude/extra.md @~/other/file.md\n', 'project/CLAUDE.md'), ['user/extra.md']);
});

test('an import that climbs out of its scope is skipped', () => {
  assert.deepEqual(findImports('@../outside.md\n', 'project/CLAUDE.md'), []);
});

test('paths: frontmatter with CRLF endings marks the rule path-scoped', () => {
  assert.equal(isPathScoped('---\r\npaths:\r\n  - "**/*.ts"\r\n---\r\n# Rule\r\n'), true);
});

test('paths: in the body, not the frontmatter, does not exclude the rule', () => {
  assert.equal(isPathScoped('# Rule\n\npaths: are described here\n'), false);
  assert.equal(isPathScoped('---\ndescription: x\n---\npaths: y\n'), false);
});

test('a file first reached at the depth limit still has its imports counted via a shorter path', () => {
  // CLAUDE.md -> a1 -> a2 -> a3 -> a4 -> shared (depth 5, its child would be depth 6: cut).
  // A rule imports shared directly (depth 1), so leaf is within reach and must be counted once.
  const files = {
    'user/CLAUDE.md': '@a1.md\n', 'user/a1.md': '@a2.md\n', 'user/a2.md': '@a3.md\n',
    'user/a3.md': '@a4.md\n', 'user/a4.md': '@shared.md\n', 'user/shared.md': '@leaf.md\n',
    'user/leaf.md': 'x', 'user/rules/r.md': '@../shared.md\n',
  };
  const rows = collect({ read: (k) => files[k] ?? null, rules: () => ['user/rules/r.md'] });
  const keys = rows.map((r) => r.file).sort();
  assert.ok(keys.includes('user/leaf.md'));
  assert.equal(keys.length, new Set(keys).size);
});
