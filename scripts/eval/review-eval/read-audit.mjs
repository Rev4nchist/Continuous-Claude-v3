// Answer-key read audit (re-answer-key-audit). After a run, read its saved stream and void the run when the agent reached outside its review tree.
// The tree is the cwd of the system/init event: <tmpdir>\cursor-review-<id>\tree. The tree is deleted before the audit, so the audit compares path text:
// whole segments, both slash forms, case-blind. It never resolves a link and never touches the disk for a path.
// Void rules: no-stream, unparsable, no-init, tree-form, unknown-kind (a kind that is not read, grep or glob, a tool_call key that is neither *ToolCall nor metadata, or an event type
// outside the allow list), hook-context, outside-path (+ answer-key; a drive letter with a colon and no separator counts; a `..` segment or a root inside a brace of a glob pattern or a grep
// glob argument counts, and so does a `..` segment in a string that holds a brace; a device path `\?\` or `\.\` that names no drive and no UNC share, such as GLOBALROOT or Volume{GUID}, is a root; a segment of only dots and spaces
// other than one dot is a parent reference when it is two dots and trailing spaces, else unresolvable, and both count), prefix-path, symlink, climb-name (a tracked name with a segment of only dots and spaces), symlink-check-failed, no-tool-call, no-result (no result event), record-failed and audit-error (replay only:
// the state line could not be written, or the audit threw; the row is void with a fixed reason).
// Two things are not read: grep pattern text (args.pattern and its echo result.success.pattern) and file text (a string named content or contentBlobId).
// An OBJECT named content is walked: a grep result keeps its match files in workspaceResults.{key}.content.matches[].file. A relative match file resolves against the tree.
// One exemption, glob-parent-name, for an entry of a glob result `files` list (seat answer 3, B and C). The tool prints such an entry against the parent of the tree.
//   Tree level (targetDirectory is the tree): the entry starts with the exact bytes ../.\ (two dots, FORWARD slash, one dot, BACK slash) and the rest is a tracked path of the reviewed head
//   (git ls-tree, case-blind) or one of five harness files. Folder level (targetDirectory is a folder of the tree): exactly one leading ../, then the path relative to the TREE, which must
//   start with the folder's own tree-relative path; the same checks on it. The rest has no empty, dot or two-dot segment, no root, drive or prefix form, and no answer-key segment.
//   No head list (no git, no head, a failed ls-tree) means no exemption. Every other entry with a `..` segment voids; it is never resolved against targetDirectory.
// The verdict line and the scan count the exempt entries, tree level and folder level apart, each split into tracked and harness. They also count stream gaps (a reconnecting event or a resume
// retry; a count, never a void). A verdict line never holds a path, key, entry or event type from a tool call. It does hold stream text that is not a path: the init model, the raw call id
// and the name of an unknown tool-call key (the tool kind). Rule entries hold a rule name, a tool kind, a field name and a call id.
// AUDIT_VERSION is 2. Version 2 adds the head rule climb-name, link names looked up without letter case (two link names that differ only in letter case void the head), a backslash in a link name as a void, a second link walk on slash only,
// and the line fields runOk and resultEvents. A version 1 line holds neither field. Raise it on any rule or line-format change.
// CLI: read-audit.mjs <stream> [--run-id --kind --head --repo <dir> --state <file> --no-record] | --scan [--root <dir> --prefix <p> --repo <dir>] | --summary (--runs <file> | --heads <dir>...) [--state <file>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const AUDIT_VERSION = 2;
/** The audit's own list. It is not TREE_EXCLUDES: the frozen copy holds that list, and this one must grow. A segment matches whole. */
export const ANSWER_KEY_SEGMENTS = ['review-eval/gold', 'review-eval/seeds', 'review-eval/rubrics', 'linktype-labels.json', '.claudedocs', 'local-review-shadow', 'cli-pairs', 'holdout.json', '.git'];
const KINDS = ['read', 'grep', 'glob'];
const SKIP_KEYS = new Set(['content', 'contentBlobId']);
const GREP_TEXT = new Set(['args.pattern', 'result.success.pattern']);
const GLOB_FILES = /^result\.success\.files\[\d+\]$/;
/** The exact start of a tree-level glob entry: two dots, FORWARD slash, one dot, BACK slash. No other separator mix. */
const TREE_START = '../.\\';
/** The files the harness writes into the tree, lower-case, `/` joined. They are not in the head commit. */
const HARNESS_FILES = new Set(['pr.diff', 'delta.diff', '.review/prompt.md', '.review/context.md', '.review/prior.json']);
/** The event types of a cursor-agent stream-json run. Any other type is a stream this audit has not seen. */
export const EVENT_TYPES = ['system', 'user', 'thinking', 'assistant', 'tool_call', 'result', 'connection', 'retry'];
const DEVICE_DOT = /^[\\/]{2}\.[\\/]/;
/**
 * A path segment of only dots and spaces, other than one dot. Windows trims trailing spaces and dots of a segment, so `.. ` and `.. .` act as `..`;
 * the audit cannot tell what `...` or `. ` resolves to. PARENT_SEG is the form it resolves as a parent. Every other such segment is unresolvable: it voids.
 */
const CLIMB_SEG = /^(?!\.$)(?=[. ]*\.)[. ]+$/;
const PARENT_SEG = /^\.\.( [. ]*)?$/;
const DOT_DOT = /(^|[\\/])(?!\.(?:[\\/]|$))(?=[. ]*\.)[. ]+(?=[\\/]|$)/;
/** One alternative of a brace list: the text after `{` or `,` up to the next `,`, `{` or `}`. */
const BRACE_ALT = /[{,]([^,{}]*)/g;
const PREFIX = /^(?:[~%$]|file:)/i;
/** A drive letter and a colon with no separator: Windows resolves it against that drive's own cwd, so it is never tree-relative. `C:` alone is a root (parseRoot). */
const DRIVE_REL = /^[A-Za-z]:(?![\\/]|$)/;
/** The keys of a tool_call that are not a call: anything else is a call of a kind this audit has not seen. */
const META_KEYS = new Set(['toolCallId', 'startedAtMs', 'completedAtMs', 'hookAdditionalContexts']);
const DEFAULT_PREFIX = '2026-11-04-p1-holdout-';
const STREAM_GZ = '.stream.jsonl.gz';
const noExempt = () => ({ tree: { tracked: 0, harness: 0 }, folder: { tracked: 0, harness: 0 } });
const noTypes = () => ({ ...Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])), other: 0 });

// ---- path text ----
/** The root of an absolute path in any of its forms, and the rest. null: the string is relative. */
function parseRoot(s) {
  const t = s.replace(/^[\\/]{2}\?[\\/]/, '');
  const longPath = t !== s;
  if (longPath && /^UNC[\\/]/i.test(t)) return { root: '//', rest: t.slice(4) };
  let m = /^([A-Za-z]):(?:[\\/]|$)/.exec(t);
  if (m) return { root: `${m[1].toLowerCase()}:`, rest: t.slice(m[0].length) };
  // A device path (`\\?\` or `\\.\` and a name that is no drive and no UNC share: GLOBALROOT, Volume{GUID}) is a root, never tree-relative. The `\\.\` form is never unwrapped, even before a drive.
  if (longPath || DEVICE_DOT.test(s)) return { root: '//', rest: (longPath ? t : s.slice(4)).replace(/^[\\/]+/, '') };
  if (/^[\\/]{2}/.test(t)) return { root: '//', rest: t.replace(/^[\\/]+/, '') };
  m = /^\/([A-Za-z])(?:\/|$)/.exec(t);
  if (m) return { root: `${m[1].toLowerCase()}:`, rest: t.slice(m[0].length) };
  if (/^[\\/]/.test(t)) return { root: '/', rest: t.replace(/^[\\/]+/, '') };
  return null;
}

/** Resolve `.` and `..` by segment. A `..` above the start is `escaped`. */
function fold(start, parts) {
  const segs = [...start];
  let escaped = false;
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (CLIMB_SEG.test(p)) {
      if (!PARENT_SEG.test(p) || segs.length === 0) escaped = true; // an unresolvable segment, or a parent above the start
      else segs.pop();
    } else segs.push(p.toLowerCase());
  }
  return { segs, escaped };
}

/** { abs, root, segs, escaped } | null (empty). A relative path resolves against `base` (never the process cwd). Lower-case, `\` folded, `\\?\` stripped, /c/ mapped to c:. */
export function normalizePath(s, base = null) {
  if (typeof s !== 'string' || s === '') return null;
  const r = parseRoot(s);
  if (r) return { abs: true, root: r.root, ...fold([], r.rest.split(/[\\/]+/)) };
  const w = fold(base?.segs ?? [], s.split(/[\\/]+/));
  return { abs: base?.abs ?? false, root: base?.root ?? null, segs: w.segs, escaped: w.escaped || Boolean(base?.escaped) };
}

const sameDir = (a, b) => a.root === b.root && !a.escaped && !b.escaped && a.segs.length === b.segs.length && a.segs.every((s, i) => s === b.segs[i]);

/** Is p (a string, resolved against base, or a normalized path) inside tree? Whole segments: tree2 is outside, an empty path is inside. */
export function isInside(p, tree, base = tree) {
  const n = typeof p === 'string' ? normalizePath(p, base) : p;
  if (n === null) return true;
  return Boolean(tree?.abs) && n.abs && n.root === tree.root && !n.escaped && tree.segs.every((s, i) => n.segs[i] === s);
}

const KEY_SEQS = ANSWER_KEY_SEGMENTS.map((k) => k.toLowerCase().split('/'));
function hasAnswerKey(s) {
  const segs = s.toLowerCase().split(/[\\/]+/);
  return KEY_SEQS.some((seq) => segs.some((_, i) => seq.every((q, j) => segs[i + j] === q)));
}

/** null: nothing to report. Else { rule, answerKey }. Only an absolute path, a path with a `..` segment, or a prefix form is checked. */
function classify(s, tree) {
  if (typeof s !== 'string' || s === '') return null;
  if (PREFIX.test(s)) return { rule: 'prefix-path', answerKey: hasAnswerKey(s) };
  if (DRIVE_REL.test(s)) return { rule: 'outside-path', answerKey: hasAnswerKey(s) };
  if (parseRoot(s) === null && !DOT_DOT.test(s)) return null;
  return isInside(s, tree) ? null : { rule: 'outside-path', answerKey: hasAnswerKey(s) };
}

// ---- stream ----
/** { events, bad }: one JSON object per line. A line that is not a JSON object counts in bad. */
export function parseStream(text) {
  const events = [];
  let bad = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) events.push(ev); else bad += 1;
    } catch { bad += 1; }
  }
  return { events, bad };
}

/** { text, sha256 } of a stream file (gunzipped when the name ends in .gz). text null: missing, or a damaged gz (corrupt: true). */
export function readStream(file) {
  let buf = null;
  try { buf = file && existsSync(file) ? readFileSync(file) : null; } catch { buf = null; }
  if (buf === null) return { text: null, sha256: null };
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (buf.length === 0) return { text: '', sha256 };
  if (!String(file).endsWith('.gz')) return { text: buf.toString('utf8'), sha256 };
  try { return { text: gunzipSync(buf).toString('utf8'), sha256 }; } catch { return { text: null, sha256, corrupt: true }; }
}

const isTreeForm = (cwd, tmpdir) => {
  const t = normalizePath(tmpdir);
  const c = normalizePath(cwd);
  if (!t || !c?.abs || c.escaped || c.root !== t.root || !t.segs.every((s, i) => c.segs[i] === s)) return false;
  const rest = c.segs.slice(t.segs.length);
  return rest.length === 2 && /^cursor-review-.+/.test(rest[0]) && rest[1] === 'tree';
};

const keyLabel = (field, k) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(k) && !field.endsWith('workspaceResults') ? k : '{key}');
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

/** Rule entries, de-duplicated. An answer-key tag adds an answer-key entry beside its outside-path entry. */
function ruleSet() {
  const rules = [];
  const seen = new Set();
  const add = (rule, tool = null, field = null, callId = null, answerKey = false) => {
    for (const r of answerKey && rule !== 'answer-key' ? [rule, 'answer-key'] : [rule]) {
      const entry = { rule: r, tool, field, callId, answerKey };
      const k = JSON.stringify(entry);
      if (!seen.has(k)) { seen.add(k); rules.push(entry); }
    }
  };
  return { rules, add };
}

/** A set of lower-case repo paths (`/` joined) from any list of names, or null when there is no head list. */
function trackedSet(list) {
  if (!list) return null;
  return new Set([...list].map((p) => String(p).toLowerCase()));
}

/**
 * Does a glob pattern or a grep glob argument hold a `..` segment or a root inside a brace (after `{` or `,`)? DOT_DOT needs a separator before the dots and parseRoot needs the root at the start.
 * Also: a `..` segment in a string with a brace. An alternative can hold a separator, so the text folds inside the tree where the expansion climbs out (`{a,b/c}/../../x`). Cannot be resolved: void.
 */
function braceHazard(s) {
  if (s.includes('{') && DOT_DOT.test(s)) return true;
  for (const m of s.matchAll(BRACE_ALT)) {
    if (DOT_DOT.test(m[1]) || DRIVE_REL.test(m[1]) || parseRoot(m[1]) !== null) return true;
  }
  return false;
}

/** The argument fields that hold a glob: every string under args of a glob call except targetDirectory (a path), and the glob argument of a grep call. */
const isGlobArg = (field, kind) => (kind === 'glob' ? /^args\./.test(field) && field !== 'args.targetDirectory' : kind === 'grep' && field === 'args.glob');

/**
 * The rest of a glob entry that the tool printed against the parent of the tree, as a tracked path or a harness file.
 * { level: 'tree' | 'folder', via: 'tracked' | 'harness' } or null (not exempt). Needs a head list.
 */
function exemptEntry(s, c, st) {
  if (!st.tracked) return null;
  let rest;
  let level;
  if (c.tdIsTree) {
    if (!s.startsWith(TREE_START)) return null;
    rest = s.slice(TREE_START.length);
    level = 'tree';
  } else if (c.tdRel) {
    if (!s.startsWith('../')) return null; // exactly one leading two-dot segment, with a forward slash
    rest = s.slice(3);
    level = 'folder';
  } else return null;
  const segs = rest.split(/[\\/]/).map((p) => p.toLowerCase());
  if (rest === '' || segs.some((p) => p === '' || p === '.' || CLIMB_SEG.test(p))) return null;
  if (PREFIX.test(rest) || DRIVE_REL.test(rest) || parseRoot(rest) !== null || hasAnswerKey(rest)) return null;
  if (level === 'folder' && !c.tdRel.every((p, i) => segs[i] === p)) return null;
  const key = segs.join('/');
  const via = st.tracked.has(key) ? 'tracked' : HARNESS_FILES.has(key) ? 'harness' : null;
  return via ? { level, via } : null;
}

function checkString(s, field, c, st, isKey = false) {
  if (!isKey && isGlobArg(field, c.kind)) {
    st.braceChecked.set(`${c.callId}|${field}`, c.kind);
    if (braceHazard(s)) { st.add('outside-path', c.kind, field, c.callId, hasAnswerKey(s)); return; }
  }
  if (c.kind === 'glob' && !isKey && GLOB_FILES.test(field) && DOT_DOT.test(s)) {
    const ex = exemptEntry(s, c, st);
    if (ex) st.exempt[ex.level][ex.via] += 1;
    else st.add('outside-path', c.kind, field, c.callId, hasAnswerKey(s)); // never resolved against targetDirectory
    return;
  }
  const hit = classify(s, st.tree);
  if (hit) st.add(hit.rule, c.kind, field, c.callId, hit.answerKey);
}

function walk(v, field, c, st) {
  if (typeof v === 'string') { checkString(v, field, c, st); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${field}[${i}]`, c, st)); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (SKIP_KEYS.has(k) && typeof x === 'string') continue; // file text only: a grep result keeps its match list (file paths) under an object named content
    const f = field === '' ? keyLabel(field, k) : `${field}.${keyLabel(field, k)}`;
    if (c.kind === 'grep' && GREP_TEXT.has(f)) continue;
    checkString(k, f, c, st, true);
    walk(x, f, c, st);
  }
}

/** The call's targetDirectory against the tree: tdIsTree (it is the tree) or tdRel (the tree-relative segments of a folder inside the tree). Neither when it is absent or outside. */
function callContext(kind, b, callId, tree) {
  const td = typeof b.args?.targetDirectory === 'string' ? b.args.targetDirectory : '';
  const tdN = td === '' ? null : normalizePath(td, tree);
  const inside = Boolean(tdN) && isInside(tdN, tree);
  const tdIsTree = inside && sameDir(tdN, tree);
  return { kind, callId, tdIsTree, tdRel: inside && !tdIsTree ? tdN.segs.slice(tree.segs.length) : null };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function auditCall(ev, index, st) {
  const tc = isObject(ev.tool_call) ? ev.tool_call : {};
  const keys = Object.keys(tc).filter((k) => k.endsWith('ToolCall'));
  const callId = String(ev.call_id ?? tc.toolCallId ?? `event-${index}`);
  if (keys.length === 0 || Object.keys(tc).some((k) => !k.endsWith('ToolCall') && !META_KEYS.has(k))) st.add('unknown-kind', null, 'tool_call', callId);
  for (const key of keys) {
    const kind = key.slice(0, -'ToolCall'.length);
    st.seen.set(`${callId}|${key}`, kind);
    if (nonEmpty(tc.hookAdditionalContexts)) st.add('hook-context', kind, 'hookAdditionalContexts', callId);
    if (!KINDS.includes(kind) || !isObject(tc[key])) { st.add('unknown-kind', kind, 'tool_call', callId); continue; }
    if (st.tree?.abs) walk(tc[key], '', callContext(kind, tc[key], callId, st.tree), st);
  }
}

function auditInits(events, tmpdir, st) {
  const inits = events.filter((e) => e.type === 'system' && e.subtype === 'init');
  const first = inits.find((e) => typeof e.cwd === 'string' && e.cwd !== '');
  if (!first) { st.add('no-init'); return null; }
  st.tree = normalizePath(first.cwd);
  const bad = inits.some((e) => typeof e.cwd !== 'string' || !isTreeForm(e.cwd, tmpdir) || !sameDir(normalizePath(e.cwd), st.tree));
  if (bad) st.add('tree-form', null, 'cwd');
  return first;
}

/** Event types and stream gaps. An event whose type is outside the list voids; its type text is never stored. A gap is a reconnecting event or a resume retry. */
function auditEvents(events, st) {
  const types = noTypes();
  let gaps = 0;
  for (const ev of events) {
    if (EVENT_TYPES.includes(ev.type)) types[ev.type] += 1;
    else { types.other += 1; st.add('unknown-kind', null, 'type'); }
    if ((ev.type === 'connection' && ev.subtype === 'reconnecting') || (ev.type === 'retry' && ev.is_resume === true)) gaps += 1;
  }
  return { types, gaps };
}

const zeroResult = () => ({ counts: { toolCalls: 0, read: 0, grep: 0, glob: 0, other: 0 }, exempt: noExempt(), eventTypes: noTypes(), gaps: 0, braceChecked: { glob: 0, grep: 0 } });

function voidResult(rule) {
  const { rules, add } = ruleSet();
  add(rule);
  return { verdict: 'void', rules, tree: null, model: null, ...zeroResult() };
}

/**
 * Audit the text of a stream. opts: { tmpdir (default os.tmpdir()), symlinks (rule entries of checkHeadSymlinks), tracked (the tracked paths of the reviewed head: any list of `/` paths; none = no exemption),
 * runOk (default true: the run reports success, so a stream with no result event voids; false switches off the no-result rule only) }.
 * Returns { verdict: 'pass' | 'void', rules[], tree, model, counts: { toolCalls, read, grep, glob, other }, exempt: { tree: { tracked, harness }, folder: { tracked, harness } }, eventTypes, gaps, braceChecked: { glob, grep } }.
 * `tree` is the init cwd: for tests only, it never goes to a verdict line.
 */
export function auditStream(text, { tmpdir = os.tmpdir(), symlinks = [], tracked = null, runOk = true } = {}) {
  if (text === null || text === undefined || text === '') return voidResult('no-stream');
  const { events, bad } = parseStream(text);
  const { rules, add } = ruleSet();
  const st = { tree: null, add, seen: new Map(), exempt: noExempt(), tracked: trackedSet(tracked), braceChecked: new Map() };
  if (bad > 0) add('unparsable', null, 'stream');
  const init = auditInits(events, tmpdir, st);
  const { types, gaps } = auditEvents(events, st);
  // A stream cut at a line end. Only for a run that reports success (runOk): an engine run with status incomplete keeps its own status, and the other rules still read its stream.
  if (types.result === 0 && runOk !== false) add('no-result', null, 'stream');
  events.forEach((ev, i) => { if (ev.type === 'tool_call' || ev.tool_call) auditCall(ev, i, st); });
  const kinds = [...st.seen.values()];
  const counts = { toolCalls: kinds.length, read: 0, grep: 0, glob: 0, other: 0 };
  for (const k of kinds) counts[KINDS.includes(k) ? k : 'other'] += 1;
  if (kinds.filter((k) => KINDS.includes(k)).length === 0) add('no-tool-call');
  for (const s of symlinks) add(s.rule, s.tool ?? null, s.field ?? null, s.callId ?? null, Boolean(s.answerKey));
  const braceChecked = { glob: 0, grep: 0 };
  for (const kind of st.braceChecked.values()) braceChecked[kind] += 1;
  return { verdict: rules.length > 0 ? 'void' : 'pass', rules, tree: init?.cwd ?? null, model: init?.model ?? null, counts, exempt: st.exempt, eventTypes: types, gaps, braceChecked };
}

/** auditStream of a file. A missing or empty file is no-stream, a damaged gz is unparsable. Adds streamSha256. */
export function auditFile(file, opts = {}) {
  const s = readStream(file);
  const result = s.corrupt ? voidResult('unparsable') : auditStream(s.text, opts);
  return { ...result, streamSha256: s.sha256 };
}

// ---- symlinks in the head commit ----
const FAILED = { rule: 'symlink-check-failed', tool: null, field: 'git', callId: null, answerKey: false };
const SYMLINK = { rule: 'symlink', tool: null, field: 'tree-entry', callId: null, answerKey: false };
const CLIMB_NAME = { rule: 'climb-name', tool: null, field: 'tree-entry', callId: null, answerKey: false };

/** The most links one walk may follow. A longer chain, or a loop, voids. */
const MAX_LINK_STEPS = 40;

const isAbsoluteTarget = (t) => PREFIX.test(t) || DRIVE_REL.test(t) || parseRoot(t) !== null;

/**
 * The text check: the target read as path text from the folder of the link, no link followed. Windows applies a two-dot step to the path text,
 * so `l/../..` climbs two levels whatever `l` points at. True when the text climbs above the root or holds a segment that cannot be resolved.
 */
function escapesByText(name, target) {
  const here = name.split('/').slice(0, -1);
  for (const seg of target.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (!CLIMB_SEG.test(seg)) { here.push(seg); continue; }
    if (!PARENT_SEG.test(seg) || here.length === 0) return true;
    here.pop();
  }
  return false;
}

/**
 * Does a link leave the tree? Two checks, and either one voids: the text check (escapesByText, the Windows reading) and the link walk (the Unix reading).
 * The walk goes one segment at a time from the folder of the link, as a real lookup does.
 * When a path prefix is itself a link of the head (links: Map name -> target), its target replaces it, resolved from that link's folder, before the next segment.
 * The walk runs twice: once with a backslash as a separator (Windows) and once on slash only (POSIX); either one that leaves the tree voids. Link names are looked up in lower case.
 * Voids on: an absolute target at any step, a `..` above the root, a segment of dots and spaces that is not exactly two dots (unresolvable), more than MAX_LINK_STEPS links followed.
 */
function escapesTree(name, target, links) {
  if (isAbsoluteTarget(target.replace(/\\/g, '/')) || escapesByText(name, target)) return true;
  return walkLinks(name, target, links, true) || walkLinks(name, target, links, false);
}

/**
 * One link walk. windows: a backslash splits a segment (the Windows reading). Not windows: only a slash splits, so `a\b` is one name (the POSIX reading).
 * The lookup key is lower-case: a case-blind file system (WSL on NTFS, macOS) follows `alias` to a link named `Alias`.
 */
function walkLinks(name, target, links, windows) {
  const form = (t) => (windows ? t.replace(/\\/g, '/') : t);
  const here = name.split('/').slice(0, -1);
  const rest = form(target).split('/');
  let steps = 0;
  while (rest.length > 0) {
    const seg = rest.shift();
    if (seg === '' || seg === '.') continue;
    if (CLIMB_SEG.test(seg)) { if (!PARENT_SEG.test(seg) || here.length === 0) return true; here.pop(); continue; }
    here.push(seg);
    const via = links.get(here.join('/').toLowerCase());
    if (via === undefined) continue;
    steps += 1;
    const next = form(via);
    if (steps > MAX_LINK_STEPS || isAbsoluteTarget(next)) return true;
    here.pop();
    rest.unshift(...next.split('/'));
  }
  return false;
}

/**
 * One ls-tree of the head commit gives both checks. git: (args) => { status, stdout }.
 * { ran, tracked, rules }. ran: false when no git or no head is given (the checks did not run). tracked: the lower-case tracked paths (a Set), or null when there is no list.
 * rules: a symlink (git ls-tree mode 120000) whose target is absolute or leaves the tree. A failed ls-tree or cat-file is a rule (symlink-check-failed), never a pass.
 */
export function readHeadCommit({ git, head }) {
  if (typeof git !== 'function' || !head) return { ran: false, tracked: null, rules: [] };
  const ls = git(['ls-tree', '-r', '-z', head]);
  if (ls.status !== 0) return { ran: true, tracked: null, rules: [FAILED] };
  const rules = [];
  const tracked = new Set();
  const links = new Map(); // lower-case name -> target of every mode 120000 entry the head holds (the lookup key of a case-blind file system)
  const forms = new Map(); // lower-case name -> the names as written: every tracked name and every folder prefix of a tracked path
  const flagged = new Set(); // lower-case names already reported as a collision
  const linkList = []; // [name, target] of each link, so two names that differ only in letter case are both checked
  const entries = String(ls.stdout ?? '').split('\0').map((e) => /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(e)).filter(Boolean);
  for (const m of entries) {
    const segs = m[3].split('/');
    for (let i = 1; i <= segs.length; i += 1) {
      const prefix = segs.slice(0, i).join('/');
      const key = prefix.toLowerCase();
      if (!forms.has(key)) forms.set(key, new Set());
      forms.get(key).add(prefix);
    }
  }
  for (const m of entries) {
    tracked.add(m[3].toLowerCase());
    if (m[3].split('/').some((seg) => CLIMB_SEG.test(seg))) rules.push(CLIMB_NAME); // git cannot hold a segment of exactly two dots, so every such segment is a hit
    if (m[1] !== '120000') continue;
    if (m[3].includes('\\')) rules.push(SYMLINK); // a POSIX lookup reads a\b as one name, a Windows lookup as two
    const lower = m[3].toLowerCase();
    if (forms.get(lower).size > 1 && !flagged.has(lower)) { flagged.add(lower); rules.push(SYMLINK); } // fail closed: a link name and another tracked name or folder equal in lower case, written differently. The lower-case lookup keeps one target and follows the link past the real folder; such a head cannot be checked out on a case-blind file system
    const blob = git(['cat-file', 'blob', m[2]]);
    if (blob.status !== 0) rules.push(FAILED);
    else { links.set(m[3].toLowerCase(), String(blob.stdout ?? '')); linkList.push([m[3], String(blob.stdout ?? '')]); }
  }
  for (const [name, target] of linkList) if (escapesTree(name, target, links)) rules.push(SYMLINK);
  return { ran: true, tracked, rules };
}

/** The symlink rules of readHeadCommit. [] when the check did not run. */
export const checkHeadSymlinks = (o) => readHeadCommit(o).rules;

// ---- state file ----
export function defaultStatePath(env = process.env) {
  return env.READ_AUDIT_LEDGER || path.join(os.homedir(), '.claude', 'state', 'review-engine', 'read-audit.jsonl');
}

export function appendLine(file, line) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** Every readable line of a JSONL file. A missing file gives []; a damaged line is skipped. */
export function readLines(file) {
  return existsSync(file) ? readRequiredLines(file) : [];
}

/** Every readable line of a JSONL file that must exist. A missing or unreadable file throws; a damaged line is skipped. */
function readRequiredLines(file) {
  const out = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

/** The newest row per key. By ts; on a tie, or an unreadable ts, the later line wins. A copy of score.mjs newestPerRound (that one is not exported). Returns Map(key -> { t, i, r }). */
function newestBy(rows, keyOf) {
  const best = new Map();
  rows.forEach((r, i) => {
    const key = keyOf(r);
    const t = Date.parse(r.ts);
    const prev = best.get(key);
    if (!prev || !(t < prev.t)) best.set(key, { t, i, r });
  });
  return best;
}

/** Map(runId -> newest line). A run counts only when its newest line is pass. */
export function newestByRunId(lines) {
  return new Map([...newestBy(lines, (l) => l.runId)].map(([k, v]) => [k, v.r]));
}

// ---- the verdict line ----
function agentVersionBeside(streamPath) {
  if (!streamPath || !String(streamPath).endsWith(STREAM_GZ)) return null;
  try { return JSON.parse(readFileSync(`${String(streamPath).slice(0, -STREAM_GZ.length)}.json`, 'utf8')).cursorAgentVersion ?? null; } catch { return null; }
}

function buildLine({ kind, runId, streamPath, result, head, pr, round, symlinkCheck, ts, runOk = true }) {
  return {
    schema: 1, ts, runId: runId ?? null, kind, streamPath: streamPath ?? null, streamSha256: result.streamSha256 ?? null, verdict: result.verdict, rules: result.rules,
    counts: result.counts, exempt: { 'glob-parent-name': result.exempt }, gaps: result.gaps, symlinkCheck, auditVersion: AUDIT_VERSION, head: head ?? null, pr: pr ?? null, round: round ?? null,
    model: result.model, agentVersion: agentVersionBeside(streamPath), runOk: runOk !== false, resultEvents: result.eventTypes?.result ?? 0,
  };
}

/** The patch replay.mjs puts last in its run row: {} on a pass; on a void, status failed, void true and a reason that starts read-audit: (never "timed out"). */
function voidPatch(line) {
  if (line.verdict !== 'void') return {};
  return { status: 'failed', void: true, reason: `read-audit: ${[...new Set(line.rules.map((r) => r.rule))].join(',')}` };
}

/**
 * The only call replay.mjs makes. o: { kind: 'engine' | 'cursor-review', streamPath, runId, head, pr, round, git?, statePath?, tmpdir?, env?, now?, runOk? (false for a run that did not report success: no no-result void) }.
 * Audits the stream, writes one line to the state file (o.statePath, else READ_AUDIT_LEDGER, else the home folder) and returns { patch, line, recordError? }.
 * It writes no Cursor ledger line and starts no run. A failed state write never throws: it voids the row with the reason read-audit: record-failed (recordError is set),
 * because a run counts only when its newest line is pass and a failed write leaves no line. The head list (one ls-tree) feeds both the symlink check and the exemption.
 */
export function auditReplay(o) {
  try { return auditReplayRun(o); } catch { return auditErrorResult(o); } // never print or store the error: it can hold path text
}

const ERROR_PATCH = { status: 'failed', void: true, reason: 'read-audit: audit-error' };

/** A throw inside the audit (a git handle, a clock, a bad option). The row is still void: a fixed patch, and a best-effort state line that uses the real clock, not o.now. */
function auditErrorResult(o) {
  let line = null;
  try {
    line = buildLine({ ...voidOpts(o), result: voidResult('audit-error'), symlinkCheck: 'not-run', ts: new Date().toISOString(), runOk: o?.runOk !== false });
    appendLine(o?.statePath ?? defaultStatePath(o?.env ?? process.env), line);
  } catch { /* the patch below still voids the row */ }
  return { patch: { ...ERROR_PATCH }, line, auditError: true };
}

const voidOpts = (o) => ({ kind: o?.kind, runId: o?.runId, streamPath: o?.streamPath, head: o?.head, pr: o?.pr, round: o?.round });

function auditReplayRun(o) {
  const head = readHeadCommit({ git: o.git, head: o.head });
  const result = auditFile(o.streamPath, { tmpdir: o.tmpdir, symlinks: head.rules, tracked: head.tracked, runOk: o.runOk !== false });
  const symlinkCheck = !head.ran ? 'not-run' : head.rules.length > 0 ? 'void' : 'pass';
  const line = buildLine({ ...o, result, symlinkCheck, ts: new Date((o.now ?? Date.now)()).toISOString(), runOk: o.runOk !== false });
  let recordError = false;
  try { appendLine(o.statePath ?? defaultStatePath(o.env ?? process.env), line); } catch { recordError = true; }
  const patch = recordError ? voidPatch({ verdict: 'void', rules: [...line.rules, { rule: 'record-failed' }] }) : voidPatch(line);
  return { patch, line, ...(recordError ? { recordError } : {}) };
}

// ---- summary ----
const roundKey = (r) => `${r.pr}|${r.round}|${r.sha40}`;

/**
 * runs: run rows (runs.jsonl). lines: read-audit state lines. heads: [{ head, runIds[] }].
 * Returns { voids: [label], replaced: [roundKey], unaudited }. A round is replaced when it has a void row and its newest row is not void (the score.mjs rule).
 */
export function summarize({ runs = [], lines = [], heads = [] }) {
  const newest = newestByRunId(lines);
  const best = newestBy(runs, roundKey);
  const voidRows = runs.filter((r) => r.void === true);
  const voids = voidRows.map(roundKey);
  for (const r of runs) if (r.void !== true && newest.get(r.cursorRunId)?.verdict === 'void') voids.push(roundKey(r)); // a later audit of the run found a void
  const replaced = [...new Set(voidRows.map(roundKey))].filter((k) => best.get(k).r.void !== true);
  let unaudited = runs.filter((r) => ['ok', 'incomplete'].includes(r.status) && r.void !== true && !newest.has(r.cursorRunId)).length;
  for (const h of heads) {
    for (const id of h.runIds) {
      const line = newest.get(id);
      if (!line) unaudited += 1;
      else if (line.verdict === 'void') voids.push(`head ${h.head}|${id}`);
    }
  }
  return { voids, replaced, unaudited };
}

function readHead(dir) {
  const ids = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.trace.json')) continue;
    try { ids.push(JSON.parse(readFileSync(path.join(dir, f), 'utf8')).runId ?? f.slice(0, -5)); } catch { ids.push(f.slice(0, -5)); }
  }
  return { head: path.basename(dir), runIds: ids };
}

const NOTE = 'NOTE: a batch with a void run is NOTE, not PASS, until the seat has read each void stream and written the reason. A replaced round stays out of the counted set.';

const NOTE_UNAUDITED = 'NOTE: an unaudited run has no verdict line (the audit did not run, or its state write failed). It does not count.';

function summaryMode(a, io) {
  if (!a.runs && a.heads.length === 0) { io.err('usage: read-audit.mjs --summary (--runs <runs.jsonl> | --heads <dir>...) [--state <file>]\n'); return 2; }
  let lines;
  try { lines = readLines(a.state ?? defaultStatePath(io.env)); } catch { io.err(`the state file cannot be read
${USAGE}`); return 2; } // a missing state file is [] (unaudited runs, exit 1); one that exists and cannot be read is not "no lines". The error text holds the path: never print it
  let heads;
  try { heads = a.heads.map(readHead); } catch { io.err(`a head folder cannot be read
${USAGE}`); return 2; } // the error text holds the folder path: never print it
  let runs = [];
  try { if (a.runs) runs = readRequiredLines(a.runs); } catch { io.err(`the runs file is missing or cannot be read
${USAGE}`); return 2; } // a missing runs file is not "0 void": the batch was not read. The error text holds the path: never print it
  const s = summarize({ runs, lines, heads });
  io.out(`void runs: ${s.voids.length}\n`);
  for (const v of s.voids) io.out(`VOID ${v}\n`);
  for (const k of s.replaced) io.out(`REPLACED ${k}\n`);
  io.out(`unaudited: ${s.unaudited}\n`);
  if (s.voids.length > 0) io.out(`${NOTE}\n`);
  if (s.unaudited > 0) io.out(`${NOTE_UNAUDITED}\n`);
  return s.voids.length > 0 || s.replaced.length > 0 || s.unaudited > 0 ? 1 : 0; // fail closed: an unaudited run has no line, so it cannot count
}

// ---- scan: counts only, no path, no line written ----
function walkFiles(dir, accept, acc = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, accept, acc); else if (accept(p)) acc.push(p);
  }
  return acc;
}

function findStreams(root, prefix) {
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(prefix)); } catch { return []; }
  return dirs.flatMap((d) => walkFiles(path.join(root, d.name, 'engine-state'), (p) => p.endsWith(STREAM_GZ))).sort();
}

/** The primary checkout: the parent of the git common dir, else this checkout. */
function primaryTop() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.dirname(r.stdout.trim()) : path.resolve(here, '..', '..', '..');
}
const defaultScanRoot = () => path.join(primaryTop(), '.claude', 'cache', 'e2e');

/** The head of a saved stream: the nearest folder name of 40 hex digits above it. null: none. */
function headFromPath(file) {
  const segs = path.dirname(file).split(/[\\/]/);
  for (let i = segs.length - 1; i >= 0; i -= 1) if (/^[0-9a-f]{40}$/i.test(segs[i])) return segs[i].toLowerCase();
  return null;
}

/** The tracked list of a head, read once per head. The scan has no state file and runs no symlink check. null: no head, or ls-tree failed. */
function headLister(repo) {
  const git = gitIn(repo);
  const cache = new Map();
  return (head) => {
    if (!head) return null;
    if (!cache.has(head)) cache.set(head, readHeadCommit({ git, head }).tracked);
    return cache.get(head);
  };
}

function scanOne(file, tmpdir, tracked) {
  try { return auditFile(file, { tmpdir, tracked }); } catch { return voidResult('scan-error'); } // never print the error: it can hold the folder path
}

const sum = (into, from) => { for (const k of Object.keys(into)) into[k] += from[k]; };
const total = (o) => o.tracked + o.harness;

function scanMode(a, io) {
  const files = findStreams(a.root ?? defaultScanRoot(), a.prefix ?? DEFAULT_PREFIX);
  const listHead = headLister(a.repo ?? primaryTop());
  const tot = {
    pass: 0, void: 0, kinds: { read: 0, grep: 0, glob: 0, other: 0 }, exempt: noExempt(), types: noTypes(), brace: { glob: 0, grep: 0 }, gapStreams: 0, gapEvents: 0, listed: 0, unlisted: 0,
    streamsByRule: new Map(), entries: new Map(),
  };
  for (const f of files) {
    const tracked = listHead(headFromPath(f));
    tot[tracked ? 'listed' : 'unlisted'] += 1;
    const r = scanOne(f, io.tmpdir, tracked);
    tot[r.verdict] += 1;
    sum(tot.kinds, r.counts);
    sum(tot.exempt.tree, r.exempt.tree);
    sum(tot.exempt.folder, r.exempt.folder);
    sum(tot.types, r.eventTypes);
    sum(tot.brace, r.braceChecked);
    tot.gapEvents += r.gaps;
    if (r.gaps > 0) tot.gapStreams += 1;
    for (const rule of new Set(r.rules.map((x) => x.rule))) tot.streamsByRule.set(rule, (tot.streamsByRule.get(rule) ?? 0) + 1);
    for (const x of r.rules) { const k = `${x.rule} ${x.tool ?? '-'} ${x.field ?? '-'}`; tot.entries.set(k, (tot.entries.get(k) ?? 0) + 1); }
  }
  const out = [`streams: ${files.length}`, `pass: ${tot.pass}`, `void: ${tot.void}`, 'by rule:'];
  if (tot.streamsByRule.size === 0) out.push('  (none)');
  for (const [rule, n] of [...tot.streamsByRule].sort()) out.push(`  ${rule}: ${n}`);
  for (const [k, n] of [...tot.entries].sort()) out.push(`    ${k}: ${n}`);
  out.push('by tool kind:', ...Object.entries(tot.kinds).map(([k, n]) => `  ${k}: ${n}`));
  const { tree, folder } = tot.exempt;
  const seen = EVENT_TYPES.filter((t) => tot.types[t] > 0);
  out.push(
    `glob-parent-name tree-level exempt: ${total(tree)} (tracked ${tree.tracked}, harness ${tree.harness})`,
    `glob-parent-name subfolder entries checked: ${total(folder)} (tracked ${folder.tracked}, harness ${folder.harness})`,
    `event types seen: ${seen.length}`, ...seen.map((t) => `  ${t}: ${tot.types[t]}`), `event types outside the list: ${tot.types.other}`,
    `streams with a gap: ${tot.gapStreams}, gap events: ${tot.gapEvents}`,
    `brace-checked arguments: glob ${tot.brace.glob}, grep glob ${tot.brace.grep}`,
    `head lists: read ${tot.listed}, not read ${tot.unlisted}`, 'symlink check: not run',
  );
  io.out(`${out.join('\n')}\n`);
  return tot.void > 0 || files.length === 0 ? 1 : 0;
}

// ---- one stream ----
function gitIn(dir) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

function singleMode(a, io) {
  const file = a.positional[0];
  const runId = a.runId ?? path.basename(file).replace(/(\.stream\.jsonl\.gz|\.raw\.json|\.jsonl)$/, '');
  const git = a.repo ? gitIn(a.repo) : undefined;
  const head = readHeadCommit({ git, head: a.head });
  const result = auditFile(file, { tmpdir: io.tmpdir, symlinks: head.rules, tracked: head.tracked });
  const symlinkCheck = !head.ran ? 'not-run' : head.rules.length > 0 ? 'void' : 'pass';
  const line = buildLine({ kind: a.kind ?? 'stream', runId, streamPath: file, result, head: a.head, pr: null, round: null, symlinkCheck, ts: new Date().toISOString() });
  let recorded = true;
  if (!a.noRecord) { try { appendLine(a.state ?? defaultStatePath(io.env), line); } catch { recorded = false; } } // the error text holds the folder path: never print it
  io.out(`${JSON.stringify(line)}\n`);
  if (!recorded) io.err('read-audit: record-failed (the verdict line was not written, so this run does not count)\n');
  return result.verdict === 'void' || !recorded ? 1 : 0;
}

const VALUE_FLAGS = { '--run-id': 'runId', '--kind': 'kind', '--head': 'head', '--repo': 'repo', '--state': 'state', '--root': 'root', '--runs': 'runs', '--prefix': 'prefix' };

function parseArgs(argv) {
  const a = { positional: [], heads: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--scan') a.scan = true;
    else if (f === '--summary') a.summary = true;
    else if (f === '--no-record') a.noRecord = true;
    else if (f === '--heads') { while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { i += 1; a.heads.push(argv[i]); } }
    else if (VALUE_FLAGS[f] && argv[i + 1] !== undefined) { i += 1; a[VALUE_FLAGS[f]] = argv[i]; }
    else if (f.startsWith('--')) return { error: `unknown or incomplete flag ${f}` };
    else a.positional.push(f);
  }
  return a;
}

const USAGE = 'usage: read-audit.mjs <stream> [--run-id <id> --kind <k> --head <sha> --repo <dir> --state <file> --no-record] | --scan [--root <dir> --prefix <p> --repo <dir>] | --summary (--runs <file> | --heads <dir>...) [--state <file>]\n';

/** deps: { out, err, env, tmpdir }. Returns the exit code: 0 pass, 1 void (or a REPLACED round, or no streams to scan), 2 usage. */
export function main(argv, deps = {}) {
  const io = { out: deps.out ?? ((s) => process.stdout.write(s)), err: deps.err ?? ((s) => process.stderr.write(s)), env: deps.env ?? process.env, tmpdir: deps.tmpdir ?? os.tmpdir() };
  const a = parseArgs(argv);
  if (a.error) { io.err(`${a.error}\n${USAGE}`); return 2; }
  if (a.scan) return scanMode(a, io);
  if (a.summary) return summaryMode(a, io);
  if (a.positional.length !== 1) { io.err(USAGE); return 2; }
  return singleMode(a, io);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
