// Registered parsers for scripts/checks/parser-fixtures.mjs.
//
// An entry: { id, file, export, kind, inputs, property }.
//   file      repo-relative path of the module that holds the function.
//   export    the exported name.
//   kind      scrubber, sanitizer, classifier or parser.
//   inputs    selectors for the cases in ./inputs.mjs ("text", "path:scrub" ...).
//   property  (fn, input, output, ctx) -> null | reason.
//             ctx = { threw, ms, mod }. `threw` is the thrown value or null. `output` is undefined when the call threw.
//
// Each property states a GENERAL rule of the function's documented job (its doc comment and its tests), not one past bug.
// The rules are:
//   a path scrubber leaves no part of the path in its text, and a free-text scrubber keeps the words around the path
//   a message sanitiser returns one short flat line with no invisible character and no secret
//   a Next steps reader keeps a line that names a concrete action for Dave, even when it also names waiting
//   a diff, name-status or config reader returns what the document holds, in the stable shape, and does not throw
//   a reader that may throw throws only its own named Error
// How to break each rule is named above the property that checks it.

import { isDeepStrictEqual } from 'node:util';

const SLOW_MS = 2000;
const ALLOWED_ASK_KINDS = ['question', 'approval', 'decision', 'block'];
// The numbers of LIMITS in brief.ts today. A commit that does not export LIMITS (or lacks a key) falls back to these.
const DEFAULT_LIMITS = { title: 80, goal: 240, stopAt: 240, askItems: 8, askText: 300, planSteps: 30, planText: 200, recommend: 300, id: 100, by: 80, decisionText: 300, artifact: 300, decisionsKept: 50, proofsKept: 200 };

// ---------- shared checks ----------

const message = (err) => String(err?.message ?? err).slice(0, 120);

/** A throw or a slow call. Break it: let the function throw on an empty string, or add a nested quantifier to a regex it uses. */
function common(ctx) {
  if (ctx.threw) return `threw: ${message(ctx.threw)}`;
  if (ctx.ms > SLOW_MS) return `slow: ${Math.round(ctx.ms)} ms`;
  return null;
}

const typeIs = (output, type) => (typeof output === type ? null : `returned ${typeof output}, expected ${type}`);

/** The characters the sanitiser documents as invisible: C0 controls except tab and line breaks (LF, VT, FF, CR), DEL and C1, soft hyphen, bidi marks, zero-width marks, BOM. */
function invisibleLeft(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const control = (c < 0x20 && ![9, 10, 11, 12, 13].includes(c)) || (c >= 0x7f && c <= 0x9f);
    const mark = c === 0xad || c === 0x61c || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || c === 0x2060 || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
    if (control || mark) return `U+${c.toString(16).padStart(4, '0')}`;
  }
  return null;
}

function leaked(text, secrets) {
  const hit = (secrets ?? []).filter((s) => text.includes(s));
  return hit.length ? hit.join(', ') : null;
}

// ---------- safe-message.ts ----------

/**
 * A path scrubber must not leave any part of the path in its output. The words around the path stay when the scrubber is the free-text one.
 * Break it: delete the PATH_TAIL step, or let the quoted-path pattern end at an inner quote.
 */
const scrubber = ({ keepWords }) => (fn, input, output, ctx) => {
  const bad = common(ctx) ?? typeIs(output, 'string');
  if (bad) return bad;
  const left = leaked(output, input.secrets);
  if (left) return `output still holds path text: ${left}`;
  const lost = keepWords ? (input.keep ?? []).filter((k) => !output.includes(k)) : [];
  return lost.length ? `output lost the words around the path: ${lost.join(', ')}` : null;
};

/**
 * stripControl removes every invisible or control character and nothing else.
 * Break it: narrow the character class so one bidi or zero-width mark stays, or let it remove a tab or a line break.
 */
function stripControlProperty(fn, input, output, ctx) {
  const bad = common(ctx) ?? typeIs(output, 'string');
  if (bad) return bad;
  const left = invisibleLeft(output);
  if (left) return `invisible character ${left} is still in the output`;
  if (input.visible !== undefined && output !== input.visible) return `visible text changed: ${JSON.stringify(output)}`;
  return output.length <= input.value.length ? null : 'output is longer than the input';
}

/**
 * safeMessage returns one flat line of at most 160 characters. It holds no invisible character, no part of a path and no secret,
 * even when an invisible character splits the secret or the clip would cut it.
 * Break it: clip before redacting, redact before stripping, or stop collapsing white space.
 */
function safeMessageProperty(fn, input, output, ctx) {
  const bad = common(ctx) ?? typeIs(output, 'string');
  if (bad) return bad;
  if (output.length > 160) return `output has ${output.length} characters, the limit is 160`;
  if (/[\r\n\t]|\s{2}|^\s|\s$/.test(output)) return 'output is not one trimmed line with single spaces';
  const left = invisibleLeft(output);
  if (left) return `invisible character ${left} is in the output`;
  const text = leaked(output, input.secrets);
  return text ? `output still holds: ${text}` : null;
}

// ---------- brief.ts ----------

const hasStop = (text) => /\bstop(?:ping)?\s+(?:at|before|after)\b/i.test(text);

function checkAskItem(item, limits) {
  if (!item || typeof item !== 'object') return 'an ask item is not an object';
  if (!ALLOWED_ASK_KINDS.includes(item.kind)) return `ask kind "${item.kind}" is not a known kind`;
  if (typeof item.text !== 'string' || item.text === '') return 'an ask item has no text';
  if (item.text.length > limits.askText) return `an ask text has ${item.text.length} characters, the limit is ${limits.askText}`;
  return item.source === 'parsed' ? null : `an ask item has source "${item.source}"`;
}

function checkShape(out, limits, allowed) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return 'result is not a plain object';
  const extra = Object.keys(out).filter((k) => !allowed.includes(k));
  if (extra.length) return `result has unexpected keys: ${extra.join(', ')}`;
  for (const key of ['goal', 'stopAt']) {
    const v = out[key];
    if (v !== undefined && (typeof v.text !== 'string' || v.text === '' || v.text.length > limits[key])) return `${key} text is empty, not a string or over ${limits[key]} characters`;
  }
  if (out.ask === undefined) return null;
  if (!Array.isArray(out.ask) || out.ask.length > limits.askItems) return 'ask is not a list within the item limit';
  return out.ask.map((item) => checkAskItem(item, limits)).find(Boolean) ?? null;
}

/**
 * A Next steps block keeps every item that names a concrete action for Dave, even when the item also names waiting.
 * An item that only says there is nothing to do or that something else is pending is dropped. A fenced block or a text without
 * the heading is not a block.
 * Break it: let a wait word at the start or the end of an item make it a no-ask item, or read the heading inside a code fence.
 */
function checkSteps(out, expect) {
  const asks = out.ask;
  if (expect.kind === 'no-block') return asks === undefined ? null : `expected no ask list, got ${asks.length} item(s)`;
  if (expect.kind === 'none') return Array.isArray(asks) && asks.length === 0 ? null : `expected an empty ask list, got ${JSON.stringify(asks)}`;
  if (!Array.isArray(asks) || asks.length !== expect.count) return `expected ${expect.count} ask(s), got ${asks === undefined ? 'no list' : asks.length}`;
  if (expect.verb && !asks.some((a) => a.text.toLowerCase().includes(expect.verb.toLowerCase()))) return `the ask lost its action "${expect.verb}": ${JSON.stringify(asks.map((a) => a.text))}`;
  return null;
}

const hasWords = (text, words) => text.toLowerCase().includes(String(words).toLowerCase());

function checkGoal(out, expect) {
  const { goal, stopAt } = out;
  if (expect.goal === null) { if (goal) return `expected no goal, got "${goal.text}"`; } else {
    if (!goal) return 'the goal is missing';
    if (!hasWords(goal.text, expect.goal)) return `goal "${goal.text}" lost "${expect.goal}"`;
    if (hasStop(goal.text)) return `goal "${goal.text}" still holds the stop clause`;
    if (/[.\s]$/.test(goal.text)) return `goal "${goal.text}" ends in a period or space`;
  }
  const stop = expect.stop;
  if (stop === null) return stopAt ? `expected no stop-at, got "${stopAt.text}"` : null;
  if (!stopAt) return 'the stop-at is missing';
  return hasWords(stopAt.text, stop) ? null : `stop-at "${stopAt.text}" lost "${stop}"`;
}

function checkRank(out, expect) {
  if (expect.labelled === undefined || !out.goal) return null;
  const sentence = out.goal.rank === 'sentence';
  return sentence === !expect.labelled ? null : `goal rank is "${out.goal.rank}" but the line is ${expect.labelled ? 'labelled' : 'unlabelled prose'}`;
}

function turnEndProperty(allowed) {
  return (fn, input, output, ctx) => {
    const bad = common(ctx) ?? checkShape(output, { ...DEFAULT_LIMITS, ...ctx.mod.LIMITS }, allowed);
    if (bad) return bad;
    const secret = leaked(JSON.stringify(output), input.secrets);
    if (secret) return `a secret is in the result: ${secret}`;
    const { expect } = input;
    if (!expect) return null;
    if ('kind' in expect) return allowed.includes('ask') ? checkSteps(output, expect) : null;
    return checkGoal(output, expect) ?? checkRank(output, expect);
  };
}

// ---------- review-filter.mjs ----------

/** Numbers in a parsed hunk: new numbers run on from newStart over '+' and ' ' lines, old numbers from oldStart over '-' and ' ' lines. */
function checkHunkNumbers(h) {
  let n = h.newStart;
  let o = h.oldStart;
  for (const line of h.lines) {
    if (line.t !== '-') { if (line.new !== n) return `new line number ${line.new}, expected ${n}`; n += 1; }
    if (line.t !== '+') { if (line.old !== o) return `old line number ${line.old}, expected ${o}`; o += 1; }
  }
  return null;
}

const countOf = (h, ops) => h.lines.filter((l) => ops.includes(l.t)).length;

function checkEntry(key, entry) {
  if (typeof key !== 'string' || key === '' || /[\r\n]/.test(key)) return `bad key ${JSON.stringify(key)}`;
  for (const h of entry.hunks) {
    const bad = checkHunkNumbers(h);
    if (bad) return `${key}: ${bad}`;
  }
  return null;
}

function checkExpectedFiles(map, expect) {
  const names = expect.names ?? expect.files.map((f) => f.name);
  if (!isDeepStrictEqual([...map.keys()].sort(), [...names].sort())) return `keys ${JSON.stringify([...map.keys()])}, expected ${JSON.stringify(names)}`;
  for (const f of expect.files ?? []) {
    const hunks = map.get(f.name).hunks;
    const got = hunks.map((h) => ({ oldLines: h.oldLines, newLines: h.newLines }));
    if (!isDeepStrictEqual(got, f.hunks)) return `${f.name}: hunks ${JSON.stringify(got)}, expected ${JSON.stringify(f.hunks)}`;
    const wrong = hunks.find((h) => countOf(h, [' ', '+']) !== h.newLines || countOf(h, [' ', '-']) !== h.oldLines);
    if (wrong) return `${f.name}: a hunk holds a different number of lines than its header counts (a content line was read as a header)`;
  }
  return null;
}

/**
 * parseHunks keys every file by its new path (old path for a deleted file), with no CR in a key, and every hunk holds exactly the
 * lines its header counts, whatever the line ends or the content of a line look like.
 * Break it: split on "\n" only, end a hunk at a line that starts with "---", or take a name from the header line alone.
 */
function parseHunksProperty(fn, input, output, ctx) {
  const bad = common(ctx);
  if (bad) return bad;
  if (!(output instanceof Map)) return 'result is not a Map';
  for (const [key, entry] of output) {
    const problem = checkEntry(key, entry);
    if (problem) return problem;
  }
  return input.expect ? checkExpectedFiles(output, input.expect) : null;
}

// ---------- local-review.mjs ----------

function checkNameRow(row) {
  if (!row || typeof row !== 'object') return 'a row is not an object';
  if (typeof row.filename !== 'string' || row.filename === '') return 'a row has no file name';
  return 'previous_filename' in row && typeof row.previous_filename !== 'string' ? 'previous_filename is not a string' : null;
}

/**
 * parseNameStatus returns one row per changed file, with the old name on a rename or copy, for any NUL-separated name,
 * and only well-formed rows for cut or malformed output.
 * Break it: split on newline or tab, or read a rename as two files.
 */
function nameStatusProperty(fn, input, output, ctx) {
  const bad = common(ctx);
  if (bad) return bad;
  if (!Array.isArray(output)) return 'result is not an array';
  const row = output.map(checkNameRow).find(Boolean);
  if (row) return row;
  const want = input.expect?.files;
  return want && !isDeepStrictEqual(output, want) ? `got ${JSON.stringify(output)}, expected ${JSON.stringify(want)}` : null;
}

const KNOWN_ARGS = ['pr', 'gates', 'facts', 'repo', 'fresh', 'json', 'engineHere', 'error'];

/**
 * parseArgs returns { error } or a settings object with a positive whole PR number. It does not throw, and a command line without --pr is an error.
 * Break it: accept 0 or a decimal for --pr, or let a missing value throw.
 */
function parseArgsProperty(fn, input, output, ctx) {
  const bad = common(ctx);
  if (bad) return bad;
  if (!output || typeof output !== 'object') return 'result is not an object';
  const extra = Object.keys(output).filter((k) => !KNOWN_ARGS.includes(k));
  if (extra.length) return `unknown keys: ${extra.join(', ')}`;
  if (!input.value.includes('--pr') && typeof output.error !== 'string') return 'a command line without --pr gave no error';
  if (output.error !== undefined) return typeof output.error === 'string' && output.error !== '' ? null : 'error is not a message';
  return Number.isInteger(output.pr) && output.pr > 0 ? null : `pr is ${JSON.stringify(output.pr)}, not a positive whole number`;
}

// ---------- context.mjs ----------

function checkReadItems(items, shape) {
  if (!Array.isArray(items)) return 'result is not an array';
  const bad = items.find((it) => !it || shape.some((k) => typeof it[k] !== 'string' || it[k] === ''));
  return bad ? `an item has an empty or missing field: ${JSON.stringify(bad)}` : null;
}

/**
 * A config reader returns [] when its key is absent, the items of a document it supports (exactly what the document holds),
 * and otherwise throws an Error that names the key, so the caller can leave the section out. Any other throw is a crash.
 * Break it: let a quoted value, a CRLF line end or a blank line in a block change the text, or let a bad shape throw a TypeError.
 */
const configProperty = ({ key, field, shape }) => (fn, input, output, ctx) => {
  const want = input.expect?.[field];
  if (ctx.threw) {
    const named = ctx.threw instanceof Error && ctx.threw.message.startsWith(`${key}:`);
    if (want) return `threw on a supported document: ${message(ctx.threw)}`;
    return named ? null : `threw something other than its own Error: ${message(ctx.threw)}`;
  }
  if (ctx.ms > SLOW_MS) return `slow: ${Math.round(ctx.ms)} ms`;
  const bad = checkReadItems(output, shape);
  if (bad) return bad;
  if (!input.value.includes(key) && output.length > 0) return `read ${output.length} item(s) from a text without ${key}`;
  return want && !isDeepStrictEqual(output, want) ? `got ${JSON.stringify(output)}, expected ${JSON.stringify(want)}` : null;
};

// ---------- local-review/verify.mjs ----------

const VERDICTS = ['CONFIRMED', 'REFUTED', 'UNCERTAIN'];

const REFUTED_AT = '{"verdict":"REFUTED","refutedAt":"src/app.mjs:2"}';

/** The shape of one parseVerdict result, with the rule that it is no REFUTED. `what` names the text that gave it. */
function checkNotRefuted(output, what) {
  if (!output || typeof output !== 'object') return `${what}: result is not an object`;
  if (!VERDICTS.includes(output.verdict)) return `${what}: verdict ${JSON.stringify(output.verdict)} is not one of ${VERDICTS.join(', ')}`;
  if (typeof output.parsed !== 'boolean') return `${what}: parsed is ${typeof output.parsed}, not a boolean`;
  if (output.verdict === 'REFUTED') return `${what} gave REFUTED`;
  return output.refutedAt === null ? null : `${what}: refutedAt is set on a verdict that is not REFUTED`;
}

/** The hostile text around verdict objects that must not decide: a REFUTED with no location, and a valid REFUTED with a second verdict object. */
function checkDerived(fn, value) {
  const texts = { 'the text before a REFUTED with no location': `${value}{"verdict":"REFUTED"}`, 'the text between a REFUTED and a second verdict object': `${REFUTED_AT}${value}{"verdict":"CONFIRMED"}` };
  for (const [what, text] of Object.entries(texts)) {
    let out;
    try { out = fn(text); } catch (err) { return `${what}: threw: ${message(err)}`; }
    const bad = checkNotRefuted(out, what);
    if (bad) return bad;
  }
  return null;
}

/**
 * parseVerdict returns one of the three verdicts and a boolean parsed flag for any text, and no hostile text is a REFUTED:
 * not alone, not before a REFUTED that has no location, and not between a REFUTED and a second verdict object. Only one exact verdict
 * object with a path:line location can drop a finding.
 * Break it: let a text with no verdict object default to REFUTED, let a REFUTED with no location pass, let the first of two
 * verdict objects win, return a lower-case verdict, or let a bad JSON span throw.
 */
function parseVerdictProperty(fn, input, output, ctx) {
  return common(ctx) ?? checkNotRefuted(output, 'a generic text') ?? checkDerived(fn, input.value);
}

// ---------- the registry ----------

const SAFE = 'apps/agentic-os/src/server/sources/safe-message.ts';
const BRIEF = '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts';
const FILTER = 'scripts/github/review-filter.mjs';
const REVIEW = 'scripts/github/local-review.mjs';
const CONTEXT = 'scripts/github/local-review/context.mjs';
const VERIFY = 'scripts/github/local-review/verify.mjs';

const SCRUB_INPUTS = ['text', 'path', 'path:scrub'];
const PROSE_INPUTS = ['text', 'prose', 'prose:steps', 'prose:restate'];

export const REGISTRY = [
  { id: 'safe-message.scrubPaths', file: SAFE, export: 'scrubPaths', kind: 'scrubber', inputs: SCRUB_INPUTS, property: scrubber({ keepWords: false }) },
  { id: 'safe-message.scrubPathsInText', file: SAFE, export: 'scrubPathsInText', kind: 'scrubber', inputs: SCRUB_INPUTS, property: scrubber({ keepWords: true }) },
  { id: 'safe-message.stripControl', file: SAFE, export: 'stripControl', kind: 'sanitizer', inputs: ['text', 'text:control'], property: stripControlProperty },
  { id: 'safe-message.safeMessage', file: SAFE, export: 'safeMessage', kind: 'sanitizer', inputs: ['text', 'text:error', 'text:secret', 'path', 'path:scrub'], property: safeMessageProperty },
  { id: 'brief.parseTurnEnd', file: BRIEF, export: 'parseTurnEnd', kind: 'classifier', inputs: PROSE_INPUTS, property: turnEndProperty(['goal', 'stopAt', 'ask']) },
  { id: 'brief.parseStep', file: BRIEF, export: 'parseStep', kind: 'parser', inputs: PROSE_INPUTS, property: turnEndProperty(['goal', 'stopAt']) },
  { id: 'review-filter.parseHunks', file: FILTER, export: 'parseHunks', kind: 'parser', inputs: ['text', 'text:diff'], property: parseHunksProperty },
  { id: 'local-review.parseNameStatus', file: REVIEW, export: 'parseNameStatus', kind: 'parser', inputs: ['text', 'path:namestatus'], property: nameStatusProperty },
  { id: 'local-review.parseArgs', file: REVIEW, export: 'parseArgs', kind: 'parser', inputs: ['argv'], property: parseArgsProperty },
  { id: 'context.parsePathInstructions', file: CONTEXT, export: 'parsePathInstructions', kind: 'parser', inputs: ['text', 'text:yaml'], property: configProperty({ key: 'path_instructions', field: 'pi', shape: ['path', 'instructions'] }) },
  { id: 'context.parseFilePatterns', file: CONTEXT, export: 'parseFilePatterns', kind: 'parser', inputs: ['text', 'text:yaml'], property: configProperty({ key: 'filePatterns', field: 'fp', shape: ['files', 'applyTo'] }) },
  { id: 'verify.parseVerdict', file: VERIFY, export: 'parseVerdict', kind: 'parser', inputs: ['text'], property: parseVerdictProperty },
];
