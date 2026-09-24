// The guard is only useful if it counts what Claude Code counts. The end-to-end check is the
// guard's own run against ~/.claude, which matched Claude Code's warning (42 files, 153,689 chars).
// These tests cover the two parsers, one test per listed way they could miscount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findImports, isPathScoped } from '../context-budget-guard.mjs';

test('an @path in inline code or a fenced block is not an import', () => {
  const text = 'Use `see @inline.md` here.\n```\n@RULES.md\n```\n@real.md\n';
  assert.deepEqual(findImports(text, 'CLAUDE.md'), ['real.md']);
});

test('a nested import resolves against the importing file folder', () => {
  assert.deepEqual(findImports('see @child.md and @../top.md\n', 'docs/architecture/INDEX.md'),
    ['docs/architecture/child.md', 'docs/top.md']);
});

test('an email address is not an import', () => {
  assert.deepEqual(findImports('mail dkhayes44@gmail.com today\n', 'CLAUDE.md'), []);
});

test('a home-relative import is outside the set and is skipped', () => {
  assert.deepEqual(findImports('@~/other/file.md\n', 'CLAUDE.md'), []);
});

test('paths: frontmatter with CRLF endings marks the rule path-scoped', () => {
  assert.equal(isPathScoped('---\r\npaths:\r\n  - "**/*.ts"\r\n---\r\n# Rule\r\n'), true);
});

test('paths: in the body, not the frontmatter, does not exclude the rule', () => {
  assert.equal(isPathScoped('# Rule\n\npaths: are described here\n'), false);
  assert.equal(isPathScoped('---\ndescription: x\n---\npaths: y\n'), false);
});
