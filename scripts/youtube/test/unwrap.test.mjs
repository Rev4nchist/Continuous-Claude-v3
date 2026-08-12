// unwrap.test.mjs — prose unwrapping for the Notion publish path.
// Run: node --test --test-reporter=spec "scripts/youtube/test/*.test.mjs"
//
// Guards the fix for a verified defect (2026-07-25): ntn emits one Notion
// paragraph block PER SOURCE LINE, so hard-wrapped digest prose arrived in
// Notion split mid-sentence. Structural markdown must survive untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapProse } from '../publish.mjs';

test('joins hard-wrapped prose into one line', () => {
  const md = 'Scope. Full pass over the corpus: 67 videos, 62 with transcripts, ~262k\nwords, ingested 2026-07-25. Question asked: what changes on Monday?';
  assert.equal(
    unwrapProse(md),
    'Scope. Full pass over the corpus: 67 videos, 62 with transcripts, ~262k words, ingested 2026-07-25. Question asked: what changes on Monday?',
  );
});

test('blank lines still separate paragraphs', () => {
  const md = 'first para line one\nline two\n\nsecond para';
  assert.equal(unwrapProse(md), 'first para line one line two\n\nsecond para');
});

test('table rows are never joined', () => {
  const md = '| Idea | Verdict |\n|---|---|\n| a | ADOPT |\n| b | SKIP |';
  assert.equal(unwrapProse(md), md, 'markdown tables must survive verbatim');
});

test('headings stay on their own line and end a prose run', () => {
  const md = 'trailing prose\n## 3. Verdicts\nnext prose';
  assert.equal(unwrapProse(md), 'trailing prose\n## 3. Verdicts\nnext prose');
});

test('list items stay separate but their wrapped continuations fold in', () => {
  const md = '- first item that wraps\n  onto a second line\n- second item';
  assert.equal(unwrapProse(md), '- first item that wraps onto a second line\n- second item');
});

test('numbered lists behave the same', () => {
  const md = '1. step one\n   continued\n2. step two';
  assert.equal(unwrapProse(md), '1. step one continued\n2. step two');
});

test('fenced code blocks are passed through byte-for-byte', () => {
  const md = 'intro\n\n```bash\nnode a.mjs \\\n  --flag\n```\n\nafter';
  assert.equal(unwrapProse(md), md, 'code layout is meaningful and must not be joined');
});

test('a fence containing table-like or prose-like lines is still untouched', () => {
  const md = '```\n| not | a | table |\nwrapped looking\nline\n```';
  assert.equal(unwrapProse(md), md);
});

test('horizontal rules and blockquotes end a run', () => {
  const md = 'prose\n---\nmore prose';
  assert.equal(unwrapProse(md), 'prose\n---\nmore prose');
});

test('empty input is safe', () => {
  assert.equal(unwrapProse(''), '');
});

test('CRLF input normalizes without leaving stray carriage returns', () => {
  assert.equal(unwrapProse('one\r\ntwo\r\n\r\nthree'), 'one two\n\nthree');
});
