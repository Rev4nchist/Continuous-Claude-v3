// Tests for scripts/github/local-review/prompt.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/prompt.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseReviewOutput } from '../cursor-review.mjs';
import {
  FIX_PROMPT_PREAMBLE, MAX_PROMPT_CHARS, PROMPT_PATH, PROMPT_VERSION, buildEnginePrompt, lastJsonBlock,
} from './prompt.mjs';
// The v2 names come through a namespace, so a missing export fails its own tests and not the whole file.
import * as P from './prompt.mjs';

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

// ---------- the withdrawn list (phase 1, funnel) ----------

test('lastJsonBlock returns withdrawn as {id, path, line, severity, reason} items (breaks if withdrawn is dropped from the answer)', () => {
  const w = { id: 'w1', path: 'a.mjs', line: 9, severity: 'major', reason: 'the caller guards it' };
  const got = lastJsonBlock(block({ findings: [], reviewed: [], prior: {}, withdrawn: [w] }));
  assert.deepEqual(got.withdrawn, [w]);
});

test('lastJsonBlock: withdrawn is [] when absent or the wrong type, bad items are dropped, and the prompt example echo is not counted (breaks if the normaliser trusts the model)', () => {
  assert.deepEqual(lastJsonBlock(block({ findings: [], reviewed: [], prior: {} })).withdrawn, []);
  assert.deepEqual(lastJsonBlock(block({ findings: [], reviewed: [], prior: {}, withdrawn: 'x' })).withdrawn, []);
  const mixed = [null, 'str', 7, { id: 'k', path: 'a.mjs', line: '12', severity: 'minor', reason: 5 }, { id: 'ex', path: '<REPLACE: path>', line: 12, severity: 'major', reason: 'echo' }];
  const got = lastJsonBlock(block({ findings: [], reviewed: [], prior: {}, withdrawn: mixed })).withdrawn;
  assert.deepEqual(got, [{ id: 'k', path: 'a.mjs', line: 12, severity: 'minor', reason: '5' }]);
});

test('lastJsonBlock: a withdrawn item without a path and a line is dropped, so withdrawn:[{}] adds nothing to the funnel (breaks if asWithdrawn keeps an empty item)', () => {
  const ok = { id: 'w1', path: 'a.mjs', line: 9, severity: 'major', reason: 'guarded' };
  const bad = [{}, { id: 'x', reason: 'no place' }, { path: 'a.mjs', reason: 'no line' }, { line: 4, reason: 'no path' }];
  assert.deepEqual(lastJsonBlock(block({ findings: [], reviewed: [], prior: {}, withdrawn: [...bad, ok] })).withdrawn, [ok]);
  assert.deepEqual(lastJsonBlock(block({ findings: [], reviewed: [], prior: {}, withdrawn: [{}] })).withdrawn, []);
});
test('the prompt asks for withdrawn, keeps the disprove step, and its example round-trips with a withdrawn item (breaks if the prompt stops asking for the list or phase 1 removes disprove early)', () => {
  const text = buildEnginePrompt({ files: [] }).promptText;
  assert.match(text, /"withdrawn"/);
  assert.match(text, /Disprove each finding/);
  assert.equal(lastJsonBlock(text).withdrawn.length, 0, 'the example item holds a <REPLACE: ...> path, so it is not counted');
});

// ---------- prompt v2 (lane re-finder-v2) ----------
// v1 is the frozen engine prompt. These literals are the v1 values before v2 was added: a v1 change is a new freeze, never an edit.
const MODES = ['full', 'delta'];
const V1 = {
  full: { sha: '23bcd1d05fac1dc1f36494446100649c9d51e71ca6f1ed2659b6727199f42650', len: 4003, textSha: '6ff99562b3f970d62a9bee18d153c1bf84b6afc4c3616686ff89a69dcb8dc832' },
  delta: { sha: '32f81c130408b298f19ce8af823807dc933b05d8a99b64e6ce5ba9708c0f20ee', len: 4406, textSha: '3950eb48c7e58a8b110d134ddf57543029a8c26135e7736cf5837b56b306eeb6' },
};
const V1_ARGV = ['Read .review/PROMPT.md in this folder and follow it exactly. It tells you how to review PR.diff and how to answer. End with the one fenced json block it describes.'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** A v2 build. It asserts the version, so a v2 test never passes on a v1 text when the option is ignored. */
function v2(opts = {}) {
  const got = P.buildEnginePrompt({ promptVersion: 'v2', ...opts });
  assert.equal(got.promptVersion, 'v2', 'promptVersion "v2" was ignored');
  return got;
}
const OVERALL = ['correct', 'incorrect', 'unsure'];
/** The lines of one "## <heading>" section, up to the next "## " line. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no section ${heading}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('v2: v1 stays byte-identical, so promptSha256, the text hash, the text length and argv match the values before v2 in both modes (breaks if one character of v1 text changes)', () => {
  for (const mode of MODES) {
    const got = buildEnginePrompt({ mode, files: [] });
    assert.equal(got.promptSha256, V1[mode].sha, mode);
    assert.equal(got.promptText.length, V1[mode].len, mode);
    assert.equal(sha256(got.promptText), V1[mode].textSha, mode);
    assert.deepEqual(got.argv, V1_ARGV, mode);
    assert.equal(got.promptVersion, 'v1', mode);
  }
});

test('v2: the default call and promptVersion "v1" give the same promptText, argv, promptSha256 and promptVersion (breaks if the default moves to v2)', () => {
  assert.equal(PROMPT_VERSION, 'v1');
  assert.deepEqual(P.PROMPT_VERSIONS, ['v1', 'v2']);
  for (const mode of MODES) {
    const input = { mode, files: ['src/a.mjs'], agentFiles: ['pkg/CLAUDE.md'] };
    assert.deepEqual(P.buildEnginePrompt({ ...input, promptVersion: 'v1' }), buildEnginePrompt(input), mode);
  }
});

test('v2: an unknown promptVersion throws (breaks if a bad version falls back to v1 or v2)', () => {
  for (const bad of ['v3', 'V2', 'v0', '', null, 2]) {
    assert.throws(() => P.buildEnginePrompt({ promptVersion: bad }), /promptVersion must be/, String(bad));
  }
});

test('v2: the text differs from v1, says prompt v2, and has no disprove step, no withdrawn, no band and no blocks-merge wording (breaks if v2 reuses the v1 method or answer)', () => {
  for (const mode of MODES) {
    const got = v2({ mode, files: [] });
    assert.equal(got.promptVersion, 'v2', mode);
    assert.notEqual(got.promptSha256, V1[mode].sha, mode);
    assert.match(got.promptText, /^# Code review task \(prompt v2\)$/m, mode);
    assert.doesNotMatch(got.promptText, /prompt v1/, mode);
    assert.doesNotMatch(got.promptText, /Disprove each finding/, mode);
    assert.doesNotMatch(got.promptText, /disprove/i, mode);
    assert.doesNotMatch(got.promptText, /withdrawn/i, mode);
    assert.doesNotMatch(got.promptText, /\bband\b/i, mode);
    assert.doesNotMatch(got.promptText, /blocks? merge/i, mode);
  }
});

test('v2: the text asks to list every supportable defect then rank, allows confidence 1 and 2, and asks for trigger, pReal and overallCorrectness (breaks if a v2 rule is dropped)', () => {
  for (const mode of MODES) {
    const t = v2({ mode }).promptText;
    assert.match(t, /List every defect you can support with a "path:line"/, mode);
    assert.match(t, /rank them, strongest first/, mode);
    assert.match(t, /- confidence: 1 to 5\./, mode);
    assert.match(t, /1 and 2 are allowed: report a likely defect with low confidence\. Do not drop it\./, mode);
    assert.match(t, /- trigger: \{"input"/, mode);
    assert.match(t, /- pReal: a number from 0 to 1/, mode);
    assert.match(t, /"overallCorrectness" is "correct", "incorrect" or "unsure"/, mode);
    for (const kept of ['Look for: bugs', 'every defect in this one pass', 'outside_diff', 'nitpick', 'follow_up', 'short active sentences', 'quick_win', 'data_integrity', FIX_PROMPT_PREAMBLE]) {
      assert.ok(t.includes(kept), `${mode}: ${kept}`);
    }
  }
});

test('v2: the Files, Untrusted data, Intent and This change sections equal v1 in both modes (breaks if v2 edits a shared section)', () => {
  for (const mode of MODES) {
    const input = { mode, files: ['src/a.mjs'], agentFiles: ['pkg/CLAUDE.md'] };
    const one = buildEnginePrompt(input).promptText;
    const two = v2(input).promptText;
    for (const h of ['Files', 'Untrusted data', 'Intent', 'This change']) assert.equal(section(two, h), section(one, h), `${mode}: ${h}`);
  }
});

test('v2: delta mode names DELTA.diff and PRIOR.json; full mode does not (breaks if v2 ignores the mode)', () => {
  const delta = v2({ mode: 'delta' }).promptText;
  const full = v2({ mode: 'full' }).promptText;
  assert.match(delta, /DELTA\.diff/);
  assert.match(delta, /PRIOR\.json/);
  assert.match(delta, /A finding you do not answer stays open/);
  assert.doesNotMatch(full, /DELTA\.diff|PRIOR\.json/);
  assert.notEqual(v2({ mode: 'delta' }).promptSha256, v2({ mode: 'full' }).promptSha256);
});

test('v2: promptSha256 ignores the file list (breaks if the v2 file list is hashed)', () => {
  const a = v2({ files: ['a.mjs'] });
  const b = v2({ files: ['b.mjs', 'c.mjs'], agentFiles: ['CLAUDE.md'] });
  assert.match(a.promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.promptSha256, b.promptSha256);
  assert.notEqual(a.promptText, b.promptText);
});

test('v2: 5000 normal paths stay under the limit and the long-path input throws PROMPT_TOO_LONG (breaks if v2 skips the list cap or the guard)', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `scripts/github/some/dir/file-${i}.mjs`);
  const { promptText } = v2({ files: many });
  assert.ok(promptText.length < MAX_PROMPT_CHARS);
  assert.match(promptText, /\.\.\. and 4900 more/);
  const longPaths = Array.from({ length: 100 }, (_, i) => `${'d/'.repeat(190)}file${i}.mjs`);
  assert.throws(() => v2({ files: longPaths, agentFiles: longPaths }), (err) => err.code === 'PROMPT_TOO_LONG' && /24000/.test(err.message));
});

test('v2: the fixed text is at most 800 characters longer than v1 in each mode (breaks if v2 grows past the size target)', () => {
  for (const mode of MODES) {
    const len = v2({ mode, files: [] }).promptText.length;
    assert.ok(len <= V1[mode].len + 800, `${mode}: v2 is ${len}, v1 is ${V1[mode].len}`);
  }
});

test('v2: the example answer round-trips through lastJsonBlock with overallCorrectness and a finding that keeps trigger and pReal (breaks if the v2 example is not valid JSON or lacks a key)', () => {
  for (const mode of MODES) {
    const a = lastJsonBlock(v2({ mode, files: [] }).promptText);
    assert.ok(a, mode);
    assert.ok(OVERALL.includes(a.overallCorrectness), mode);
    assert.equal(a.findings.length, 1, mode);
    const [f] = a.findings;
    assert.equal(typeof f.pReal, 'number', mode);
    assert.ok(f.pReal >= 0 && f.pReal <= 1, mode);
    assert.deepEqual(Object.keys(f.trigger).sort(), ['at', 'input', 'wrong'], mode);
    assert.deepEqual(a.withdrawn, [], mode);
  }
});

test('lastJsonBlock returns each overallCorrectness value and passes trigger and pReal through on a finding (breaks if the key is not read or findings are rebuilt)', () => {
  const f2 = { ...finding, pReal: 0.7, trigger: { input: 'an empty list', at: 'a.mjs:5', wrong: 'throws' } };
  for (const v of OVERALL) {
    const got = lastJsonBlock(block({ findings: [f2], reviewed: [], prior: {}, overallCorrectness: v }));
    assert.equal(got.overallCorrectness, v);
    assert.deepEqual(got.findings, [f2]);
  }
});

test('lastJsonBlock: a wrong value, a wrong type or an absent overallCorrectness leaves the key out, not null (breaks if it returns null or the raw value)', () => {
  const answers = [{ findings: [], reviewed: [], prior: {} }];
  for (const v of ['Correct', 'yes', '', ' correct', 1, 0, true, false, null, ['correct'], { value: 'correct' }]) answers.push({ findings: [], reviewed: [], prior: {}, overallCorrectness: v });
  for (const a of answers) {
    const got = lastJsonBlock(block(a));
    assert.ok(got);
    assert.equal('overallCorrectness' in got, false, JSON.stringify(a.overallCorrectness));
  }
});

test('lastJsonBlock: a v1 answer gives exactly the v1 shape (breaks if v2 adds a key to every answer)', () => {
  const got = lastJsonBlock(block({ findings: [finding], reviewed: ['a.mjs'], prior: { abc: 'fixed' }, withdrawn: [] }));
  assert.deepEqual(got, { findings: [finding], reviewed: ['a.mjs'], prior: { abc: 'fixed' }, withdrawn: [] });
  assert.deepEqual(Object.keys(got), ['findings', 'reviewed', 'prior', 'withdrawn']);
  assert.equal('overallCorrectness' in lastJsonBlock(buildEnginePrompt({ files: [] }).promptText), false);
});

test('majorThreshold keeps Major for a valid p >= 0.5 and for a missing or invalid p, and demotes only a valid p below 0.5 (breaks if a missing pReal demotes a Major or the cut moves)', () => {
  assert.equal(P.MAJOR_P_REAL_MIN, 0.5);
  const table = [
    [0, false], [0.49, false], [0.5, true], [1, true],
    [undefined, true], [null, true], [NaN, true], ['0.9', true], ['0.1', true], [-1, true], [2, true], [Infinity, true], [-Infinity, true],
    [{}, true], [[0.1], true], [Symbol('p'), true],
  ];
  for (const [p, want] of table) assert.equal(P.majorThreshold(p), want, String(p));
  assert.equal(P.majorThreshold(), true);
});
