// The drift check is only as good as its frontmatter reader. The end-to-end check is the script's
// own run over .claude/agents. These tests cover the one-line YAML scalars it reads, one test per
// spelling that a raw `(.+)$` capture misread (CodeRabbit, PR #66).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatterModel } from './check-agent-model-drift.mjs';

const agent = (lines) => ['---', 'name: x', ...lines, '---', 'body'].join('\n');

test('a double-quoted effort reads as its bare value', () => {
  assert.equal(frontmatterModel(agent(['model: sonnet', 'effort: "high"'])).effort, 'high');
});

test('a single-quoted effort reads as its bare value', () => {
  assert.equal(frontmatterModel(agent(['model: sonnet', "effort: 'high'"])).effort, 'high');
});

test('a trailing comment is not part of the value', () => {
  assert.equal(frontmatterModel(agent(['model: sonnet', 'effort: high   # Dave rule'])).effort, 'high');
  assert.equal(frontmatterModel(agent(['model: sonnet', 'effort: "high" # note'])).effort, 'high');
});

test('a quoted, commented model reads as its bare value', () => {
  assert.equal(frontmatterModel(agent(['model: "sonnet"  # tier', 'effort: high'])).model, 'sonnet');
});

test('a missing effort stays undefined, so the gate reports it', () => {
  assert.equal(frontmatterModel(agent(['model: sonnet'])).effort, undefined);
});

test('a lower effort keeps its value, so the gate rejects it', () => {
  assert.equal(frontmatterModel(agent(['model: sonnet', 'effort: "medium" # x'])).effort, 'medium');
});
