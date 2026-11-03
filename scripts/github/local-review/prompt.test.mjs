// Tests for scripts/github/local-review/prompt.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/prompt.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewOutput } from '../cursor-review.mjs';
import {
  FIX_PROMPT_PREAMBLE, MAX_PROMPT_CHARS, PROMPT_PATH, PROMPT_VERSION, buildEnginePrompt, lastJsonBlock,
} from './prompt.mjs';

const FENCE = '```';
const block = (obj) => `${FENCE}json\n${JSON.stringify(obj)}\n${FENCE}`;
const finding = { file: 'a.mjs', startLine: 5, endLine: 6, severity: 'major', category: 'correctness', title: 'bad', body: 'because', confidence: 4, evidence: ['a.mjs:5'] };

// ---------- 13.2 prompt text ----------

test('13.2 a comment added by the PR does not drop a finding: the old "documents as intended" rule is gone and the new rule is present (breaks if the v0 sentence is restored)', () => {
  const { promptText } = buildEnginePrompt({ mode: 'full', files: ['a.mjs'] });
  assert.doesNotMatch(promptText, /documents? (?:it |that )?as intended/i);
  assert.doesNotMatch(promptText, /intended is not a major finding/i);
  assert.match(promptText, /only when it already exists in the base version/);
  assert.match(promptText, /A comment that this change adds .* is not proof/);
  assert.match(promptText, /PR body .* never a reason to drop a finding/);
});

test('13.2 the prompt goes to a file and argv stays short and names that file (breaks if the prompt text is put in argv)', () => {
  const { promptText, argv } = buildEnginePrompt({ mode: 'full', files: ['a.mjs'] });
  assert.equal(PROMPT_PATH, '.review/PROMPT.md');
  assert.ok(Array.isArray(argv) && argv.length === 1);
  assert.ok(argv[0].length < 400, `argv is ${argv[0].length} chars`);
  assert.ok(argv[0].includes('.review/PROMPT.md'));
  assert.ok(promptText.length > argv[0].length * 5);
  assert.ok(!promptText.includes(argv[0]), 'the argument is not a copy of the prompt');
});

test('the prompt carries the version, the CR fixPrompt preamble, the taxonomy and the answer keys (breaks if a section is dropped)', () => {
  const { promptText, promptVersion } = buildEnginePrompt({ files: ['a.mjs'] });
  assert.equal(PROMPT_VERSION, 'v1');
  assert.equal(promptVersion, 'v1');
  assert.match(promptText, /prompt v1/);
  assert.ok(promptText.includes(FIX_PROMPT_PREAMBLE));
  for (const word of ['outside_diff', 'nitpick', 'quick_win', 'heavy_lift', 'data_integrity', 'Disprove each finding', 'every defect in this one pass', '"reviewed"', '"prior"']) {
    assert.ok(promptText.includes(word), word);
  }
});

test('the example answer in the prompt round-trips through lastJsonBlock (breaks if the example is not valid JSON)', () => {
  const answer = lastJsonBlock(buildEnginePrompt({ files: [] }).promptText);
  assert.ok(answer);
  assert.equal(answer.findings.length, 1);
  assert.deepEqual(Object.keys(answer.prior), ['<finding id>']);
});

test('delta mode names DELTA.diff and PRIOR.json; full mode does not (breaks if the mode is ignored)', () => {
  const delta = buildEnginePrompt({ mode: 'delta' }).promptText;
  const full = buildEnginePrompt({ mode: 'full' }).promptText;
  assert.match(delta, /DELTA\.diff/);
  assert.match(delta, /PRIOR\.json/);
  assert.match(delta, /A finding you do not answer stays open/);
  assert.doesNotMatch(full, /DELTA\.diff|PRIOR\.json/);
  assert.throws(() => buildEnginePrompt({ mode: 'weird' }), /mode must be/);
});

test('promptSha256 covers the fixed rules only: it ignores the file list and differs by mode (breaks if the file list is hashed)', () => {
  const a = buildEnginePrompt({ mode: 'full', files: ['a.mjs'] });
  const b = buildEnginePrompt({ mode: 'full', files: ['b.mjs', 'c.mjs'], agentFiles: ['CLAUDE.md'] });
  assert.equal(a.promptSha256, b.promptSha256);
  assert.match(a.promptSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(a.promptSha256, buildEnginePrompt({ mode: 'delta', files: ['a.mjs'] }).promptSha256);
  assert.notEqual(a.promptText, b.promptText);
});

test('changed files and removed agent files are listed (breaks if agentFiles is ignored)', () => {
  const { promptText } = buildEnginePrompt({ files: ['src/a.mjs'], agentFiles: ['pkg/CLAUDE.md'] });
  assert.match(promptText, /- src\/a\.mjs/);
  assert.match(promptText, /removed from the folder[^\n]*:\n- pkg\/CLAUDE\.md/);
});

// ---------- 20 length guard ----------

test('20 prompt-length-refuses: an input that pushes the prompt past 24000 characters throws PROMPT_TOO_LONG, never a silent cut (breaks if the guard is removed)', () => {
  const longPaths = Array.from({ length: 100 }, (_, i) => `${'d/'.repeat(190)}file${i}.mjs`);
  assert.equal(MAX_PROMPT_CHARS, 24000);
  assert.throws(() => buildEnginePrompt({ files: longPaths, agentFiles: longPaths }), (err) => err.code === 'PROMPT_TOO_LONG' && /24000/.test(err.message));
});

test('20 a normal change stays under the limit even with 5000 files, because the list is capped (breaks if the list cap is removed)', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `scripts/github/some/dir/file-${i}.mjs`);
  const { promptText } = buildEnginePrompt({ files: many });
  assert.ok(promptText.length < MAX_PROMPT_CHARS);
  assert.match(promptText, /\.\.\. and 4900 more/);
});

test('20 maxChars is honoured (breaks if the option is ignored)', () => {
  assert.throws(() => buildEnginePrompt({ files: ['a.mjs'], maxChars: 500 }), /500 limit/);
});

// ---------- lastJsonBlock ----------

test('lastJsonBlock returns findings, reviewed and prior from the last block (breaks if a field is dropped)', () => {
  const text = `Notes.\n${block({ findings: [finding], reviewed: ['a.mjs'], prior: { abc: 'fixed' } })}`;
  const got = lastJsonBlock(text);
  assert.deepEqual(got.findings, [finding]);
  assert.deepEqual(got.reviewed, ['a.mjs']);
  assert.deepEqual(got.prior, { abc: 'fixed' });
});

test('lastJsonBlock: the last block wins over an earlier example (breaks if it returns the first block)', () => {
  const text = `${block({ findings: [], reviewed: [], prior: {} })}\nThen:\n${block({ findings: [finding], reviewed: [], prior: {} })}`;
  assert.equal(lastJsonBlock(text).findings.length, 1);
});

test('lastJsonBlock: a broken last block never falls back to an earlier clean example (breaks if it scans backwards past a bad block)', () => {
  const text = `${block({ findings: [], reviewed: [], prior: {} })}\n${FENCE}json\n{ "findings": [ \n${FENCE}`;
  assert.equal(lastJsonBlock(text), null);
  const notAnswer = `${block({ findings: [], reviewed: [], prior: {} })}\n${block({ note: 'x' })}`;
  assert.equal(lastJsonBlock(notAnswer), null);
});

test('lastJsonBlock: an unclosed last fence gives null, not the earlier block (breaks if unclosed is ignored)', () => {
  const text = `${block({ findings: [], reviewed: [], prior: {} })}\n${FENCE}json\n{"findings":[`;
  assert.equal(lastJsonBlock(text), null);
});

test('lastJsonBlock tolerates CRLF line ends (breaks if the split is on \\n only)', () => {
  const text = `intro\r\n${FENCE}json\r\n${JSON.stringify({ findings: [finding], reviewed: ['a.mjs'], prior: {} })}\r\n${FENCE}\r\n`;
  assert.equal(lastJsonBlock(text).findings.length, 1);
});

test('lastJsonBlock normalises a wrong-typed reviewed and prior and refuses a missing findings array (breaks if findings is optional)', () => {
  const got = lastJsonBlock(block({ findings: [], reviewed: 'a.mjs', prior: ['x'] }));
  assert.deepEqual([got.reviewed, got.prior], [[], {}]);
  assert.equal(lastJsonBlock(block({ reviewed: ['a'], prior: {} })), null);
  assert.equal(lastJsonBlock(block([finding])), null);
  assert.equal(lastJsonBlock(''), null);
  assert.equal(lastJsonBlock(undefined), null);
});

test('a language-tagged earlier block does not confuse the pairing (breaks if only json fences open a block)', () => {
  const text = `${FENCE}js\nconst x = 1;\n${FENCE}\n${block({ findings: [finding], reviewed: [], prior: {} })}`;
  assert.equal(lastJsonBlock(text).findings.length, 1);
});

test('the answer shape the prompt asks for passes the landed parseReviewOutput and lastJsonBlock reads the same text (breaks if the prompt schema drops file or title)', () => {
  const text = `Done.\n${block({ findings: [finding], reviewed: ['a.mjs'], prior: {} })}`;
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 5 });
  const parsed = parseReviewOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings.length, 1);
  assert.equal(lastJsonBlock(parsed.text).findings[0].confidence, 4);
});
