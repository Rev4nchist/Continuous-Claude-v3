// Format check for the rubric files in this folder. Pure functions: no data, no network, no model.
// A rubric file is one JSON object between two `---` lines, then four sections: Assess, Out of scope, Reason contract, Examples.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const RUBRIC_NAMES = Object.freeze(['missed-bug', 'miss-cause', 'false-positive', 'severity', 'citation', 'context-reach', 'test-value']);

const REQUIRED = ['rubric', 'version', 'kind', 'appliesTo', 'gates', 'labels', 'inputs'];
const KINDS = ['deterministic', 'llm', 'hybrid'];
const APPLIES_TO = ['finding', 'miss', 'test', 'record', 'truth'];
const SECTIONS = ['Assess', 'Out of scope', 'Reason contract', 'Examples'];
const EXAMPLE_PARTS = ['Pass', 'Fail'];
const LABEL_KEYS = ['value', 'description', 'score'];
const LINE_SPLIT = /\r\n?|\n/;

/**
 * Rule 7: a PR reference. Four forms, matched in any case, with no word edge on the left (so pr_N and PR-N hit):
 * pr, pull, pulls or "pull request" then separators then digits; issue/N or issues/N; #N;
 * a hex SHA of 7 to 40 chars with at least one digit and one letter a-f, not touching other hex chars.
 * No `g` flag: it keeps state.
 */
export const PR_TOKEN_RE = /p(?:r|ulls?|ull request)[\s:#_/-]*\d+|issues?\/\d+|#\d+|(?<![0-9a-f])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9a-f])/i;
/** Rule 8: an integer of 3 or more digits, not touching other digits. Letters and underscores beside it do not hide it. No `g` flag. */
export const BIG_INT_RE = /(?<!\d)\d{3,}(?!\d)/;
const MODEL_RE = /\b(sonnet|opus|haiku|claude|gpt|grok|gemini)\b/i;

// Built with fromCharCode: a typed escape for this character has been turned into the raw character before.
const BOM = String.fromCharCode(0xfeff);
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fail = (why) => { throw new Error(`front matter: ${why}`); };

/** Splits the text into the JSON front matter and the body. Throws on any front matter that is not one JSON object. */
export function parseRubric(text) {
  const raw = String(text ?? '');
  const lines = (raw.startsWith(BOM) ? raw.slice(1) : raw).split(LINE_SPLIT);
  if (lines[0] !== '---') fail('the file must start with a --- line');
  const end = lines.indexOf('---', 1);
  if (end < 0) fail('no closing --- line');
  let front;
  try { front = JSON.parse(lines.slice(1, end).join('\n')); } catch { fail('the text between the --- lines is not one JSON object'); }
  if (!isPlain(front)) fail('the JSON is not an object');
  const bodyLines = lines.slice(end + 1);
  return { front, headings: headingsOf(bodyLines), body: bodyLines.join('\n'), text: lines.join('\n') };
}

/** The `##` and `###` headings of the body, outside ``` and ~~~ fences: [{ level, text, line }] with line = index in the body. */
function headingsOf(bodyLines) {
  const out = [];
  let fenced = false;
  bodyLines.forEach((l, line) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return; }
    const m = !fenced && /^(#{2,3})\s+(.*?)\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2], line });
  });
  return out;
}

function checkLabels(front) {
  const { labels } = front;
  if (!Array.isArray(labels) || labels.length === 0) return ['bad-value: labels must be a non-empty array'];
  const problems = [];
  const seen = new Set();
  labels.forEach((l, i) => {
    const keys = isPlain(l) ? Object.keys(l) : [];
    if (!isPlain(l) || LABEL_KEYS.some((k) => !keys.includes(k)) || keys.some((k) => !LABEL_KEYS.includes(k))) {
      problems.push(`bad-label: labels[${i}] must be an object with exactly value, description, score`);
      return;
    }
    if (typeof l.value !== 'string' || l.value === '') problems.push(`bad-label: labels[${i}].value must be a non-empty string`);
    if (typeof l.description !== 'string' || l.description === '') problems.push(`bad-label: labels[${i}].description must be a non-empty string`);
    const okScore = l.score === null || (typeof l.score === 'number' && Number.isFinite(l.score) && l.score >= 0 && l.score <= 1);
    if (!okScore) problems.push(`bad-score: labels[${i}].score must be a number from 0 to 1, or null`);
    if (seen.has(l.value)) problems.push(`dup-label: labels[${i}] repeats the value of an earlier label`);
    seen.add(l.value);
  });
  const plain = labels.filter(isPlain);
  if (['llm', 'hybrid'].includes(front.kind) && !plain.some((l) => l.score === null)) {
    problems.push('no-null-label: an llm or hybrid rubric needs one label with score null');
  }
  if (front.gates === true && !plain.some((l) => typeof l.score === 'number')) {
    problems.push('no-scored-label: a rubric with gates true needs at least one label with a number score');
  }
  return problems;
}

function checkFront(front, name) {
  const problems = [];
  for (const k of REQUIRED) if (!Object.hasOwn(front, k)) problems.push(`missing-key: ${k}`);
  Object.keys(front).forEach((k, i) => { if (!REQUIRED.includes(k)) problems.push(`unknown-key: position ${i} of the front matter is not a known key`); });
  const bad = (k, why) => problems.push(`bad-value: ${k} ${why}`);
  if (Object.hasOwn(front, 'rubric') && front.rubric !== name) bad('rubric', `must be "${name}"`);
  if (Object.hasOwn(front, 'version') && !(Number.isInteger(front.version) && front.version === 1)) bad('version', 'must be the integer 1');
  if (Object.hasOwn(front, 'kind') && !KINDS.includes(front.kind)) bad('kind', `must be one of ${KINDS.join(', ')}`);
  if (Object.hasOwn(front, 'appliesTo') && !APPLIES_TO.includes(front.appliesTo)) bad('appliesTo', `must be one of ${APPLIES_TO.join(', ')}`);
  if (Object.hasOwn(front, 'gates') && typeof front.gates !== 'boolean') bad('gates', 'must be true or false');
  const inputsOk = Array.isArray(front.inputs) && front.inputs.every((s) => typeof s === 'string' && s !== '');
  if (Object.hasOwn(front, 'inputs') && !inputsOk) bad('inputs', 'must be an array of non-empty strings');
  if (Object.hasOwn(front, 'labels')) problems.push(...checkLabels(front));
  return problems;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function checkHeadings({ headings, body }) {
  const problems = [];
  const lines = body.split(LINE_SPLIT);
  const h2 = headings.filter((h) => h.level === 2);
  const h3 = headings.filter((h) => h.level === 3);
  if (!sameList(h2.map((h) => h.text), SECTIONS)) problems.push(`headings: the ## headings must be ${SECTIONS.join(', ')}, in that order`);
  if (!sameList(h3.map((h) => h.text), EXAMPLE_PARTS)) problems.push('headings: Examples needs ### Pass and then ### Fail, and no other ### heading');
  const examples = h2.find((h) => h.text === 'Examples');
  if (examples && h3.some((h) => h.line < examples.line)) problems.push('headings: the ### headings must sit under Examples');
  for (const part of EXAMPLE_PARTS) {
    const at = headings.findIndex((h) => h.level === 3 && h.text === part);
    if (at < 0) continue;
    const stop = headings[at + 1]?.line ?? lines.length;
    if (!lines.slice(headings[at].line + 1, stop).some((l) => /^\s*[-*]\s+\S/.test(l))) problems.push(`headings: ### ${part} has no bullet`);
  }
  return problems;
}

/** Line numbers (1-based) of the lines that match re. */
const linesMatching = (text, re) => text.split(LINE_SPLIT).flatMap((l, i) => (re.test(l) ? [i + 1] : []));

/**
 * The problems of one parsed rubric (see parseRubric), as `<code>: <detail>` strings. [] means the file is valid.
 * Rules 7 and 8 and the model-name check read the whole file text (front matter too) in NFKC form.
 * A problem never prints a matched token, a key name or a label value.
 */
export function checkRubric(parsed, name) {
  const problems = [...checkFront(parsed.front, name), ...checkHeadings(parsed)];
  const text = parsed.text.normalize('NFKC');
  for (const n of linesMatching(text, PR_TOKEN_RE)) problems.push(`pr-token: line ${n} holds a PR reference or a SHA`);
  for (const n of linesMatching(text, BIG_INT_RE)) problems.push(`big-int: line ${n} holds an integer of 3 or more digits`);
  for (const n of linesMatching(text, MODEL_RE)) problems.push(`model-name: line ${n} names a model`);
  return problems;
}

/** Problems of a whole rubrics folder: a symlink entry, a missing file, an extra .md file (in any case), and the problems of each file. */
export function checkDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const problems = entries.filter((e) => e.isSymbolicLink()).map((e) => `symlink: ${e.name}`);
  const md = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort();
  const want = RUBRIC_NAMES.map((n) => `${n}.md`);
  for (const w of want) if (!md.includes(w)) problems.push(`missing-file: ${w}`);
  for (const f of md) if (!want.includes(f)) problems.push(`extra-file: ${f}`);
  for (const file of want.filter((w) => md.includes(w))) {
    const name = file.slice(0, -3);
    try {
      problems.push(...checkRubric(parseRubric(readFileSync(path.join(dir, file), 'utf8')), name).map((p) => `${file}: ${p}`));
    } catch (e) {
      problems.push(`${file}: ${e.message}`);
    }
  }
  return problems;
}
