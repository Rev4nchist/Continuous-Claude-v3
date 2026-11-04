// coverage.mjs: TREX verify coverage (design G8). Opt-in per flow. No model, no Docker import.
//
//   wrapAction(action, flowId)        the cli action with coverage switched on (flow-run.mjs calls it when ctx.coverage names the flow)
//   loadContainerCoverage(exec, id)   reads what the run left in /app/.verify/<id>/ through the env exec
//   makeCoverage(data)                .citedLinesExecuted(file, startLine, endLine) -> true | false | null
//
// Node targets run with NODE_V8_COVERAGE=/app/.verify/<id>/cov. V8 offsets are UTF-16 units of the source string (not bytes),
// so the reader needs the source text. Ranges nest: the innermost range that holds a line's first non-blank character gives its count.
// A line that opens a function declaration or method also needs that function's own range to have count > 0 (the module range alone does not make `export function f() {` run).
//
// Bash targets: the design said `bash -x` with PS4='+${BASH_SOURCE}:${LINENO} '. Probed in trex:49d167ec9ca1 (bash 5.2.15) on 2026-11-03:
// bash ignores PS4 from the environment, with `bash -x` and with SHELLOPTS=xtrace. Only a PS4 set inside a startup file works, and BASH_ENV
// is read by every nested non-interactive bash too. So a prelude writes a one-line BASH_ENV file (PS4 and set -x), opens fd 9 on the trace
// file and sets BASH_XTRACEFD=9, which keeps the trace out of the script's stderr. A `#!/bin/sh` (dash) target is not traced: its answer is null/false.
//
// Answers: true = a code line in the range ran; false = data of the right kind exists and the range did not run (or the file never loaded);
// null = no data of the right kind (no coverage files, no trace, or no source text to place V8 offsets).

import path from 'node:path';

export const VERIFY_DIR = '/app/.verify';
const APP_URL = 'file:///app/';
export const covDir = (flowId) => `${VERIFY_DIR}/${flowId}/cov`;
export const traceFile = (flowId) => `${VERIFY_DIR}/${flowId}/trace`;
const XTRACE_LINE = "PS4='+${BASH_SOURCE}:${LINENO} '; set -x";
const PRELUDE = 'd=$1; x=$2; shift 2; mkdir -p "$d" && printf \'%s\\n\' "$x" > "$d/xtrace.env" && exec 9>>"$d/trace" && export BASH_XTRACEFD=9 BASH_ENV="$d/xtrace.env" && exec "$@"';

// ---------- wrapper ----------

/** 'node', 'bash' or null for a cli argv. A bare path that ends in .sh counts as bash. `sh` (dash) has no BASH_SOURCE and is left alone. */
export function targetKind(cmd) {
  if (!Array.isArray(cmd) || typeof cmd[0] !== 'string') return null;
  const base = path.posix.basename(cmd[0]);
  if (base === 'node') return 'node';
  if (base === 'bash' || /\.sh$/.test(cmd[0])) return 'bash';
  return null;
}

/** True when coverage is on for this flow: `coverage` is true (every container cli flow) or a list of flow ids. */
export function coverageWanted(coverage, flow) {
  if (flow?.profile === 'host' || flow?.driver !== 'cli') return false;
  if (coverage === true) return true;
  return Array.isArray(coverage) && coverage.includes(flow.id);
}

/** A copy of the action with coverage on, or the same object when its argv is neither node nor bash. */
export function wrapAction(action, flowId) {
  const kind = targetKind(action?.cmd);
  if (kind === 'node') return { ...action, env: { ...action.env, NODE_V8_COVERAGE: covDir(flowId) } };
  if (kind !== 'bash') return action;
  const cmd = /\.sh$/.test(action.cmd[0]) && path.posix.basename(action.cmd[0]) !== 'bash' ? ['bash', ...action.cmd] : action.cmd;
  return { ...action, cmd: ['sh', '-c', PRELUDE, 'sh', `${VERIFY_DIR}/${flowId}`, XTRACE_LINE, ...cmd] };
}

// ---------- reader ----------

const isShell = (file) => /\.(sh|bash)$/.test(file);
const bare = (file) => String(file).replace(/^\.\//, '').replace(/^\/app\//, '');
const isLine = (n) => Number.isInteger(n) && n >= 1;

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The count of the innermost range that holds `offset`; an offset in no range counts 0. */
function countAt(ranges, offset) {
  let best = null;
  for (const r of ranges) {
    if (r.startOffset > offset || offset >= r.endOffset) continue;
    if (best === null || r.endOffset - r.startOffset <= best.endOffset - best.startOffset) best = r;
  }
  return best ? best.count : 0;
}

const rangesOf = (script) => (script.functions ?? []).flatMap((f) => f.ranges ?? []);
/** The function-level range of each function entry (its first range). It starts at `function`, `async`, `get` or the method name, not at `export`. */
const headersOf = (script) => (script.functions ?? []).map((f) => f.ranges?.[0]).filter(Boolean);
/** What may stand before a function's own start on its declaration line. Anything else (`arr.map(`, `const f = `) is an expression that ran. */
const DECL_PREFIX = /^(?:(?:export|default|static|async)\s+)*$/;

/**
 * True when the line's code ran. A line that opens with a function declaration or method ran only if that function ran: the
 * module range (count 1 once the file loads) holds the `export` word, so the first character alone would read true for a
 * function nobody called. Other lines use the innermost range at their first non-blank character.
 */
function lineRan(script, ranges, offset, lineEnd) {
  if (countAt(ranges, offset) <= 0) return false;
  return headersOf(script)
    .filter((h) => h.startOffset >= offset && h.startOffset < lineEnd)
    .filter((h) => DECL_PREFIX.test(script.text.slice(offset, h.startOffset)))
    .every((h) => countAt(ranges, h.startOffset) > 0);
}

/** Executed code lines (1-based) of one script, from its V8 ranges and its source text. Blank and `//` lines are not code. */
function v8Lines(script, text, wanted) {
  const ranges = rangesOf(script);
  const withText = { ...script, text };
  const starts = lineStarts(text);
  const lines = new Set();
  for (const n of wanted) {
    if (n > starts.length) continue;
    const from = starts[n - 1];
    const to = n < starts.length ? starts[n] : text.length;
    const raw = text.slice(from, to);
    const first = raw.search(/\S/);
    if (first < 0 || raw.slice(first).startsWith('//')) continue;
    if (lineRan(withText, ranges, from + first, to)) lines.add(n);
  }
  return lines;
}

/** Map of trace file -> Set of line numbers. A line is `+`-prefixed (one `+` per nesting level), then FILE:LINE, then a space. */
export function parseTrace(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\++(\S+):(\d+) /.exec(line);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(Number(m[2]));
  }
  return map;
}

function sameFile(traced, wanted) {
  const a = bare(traced);
  return a === wanted || a.endsWith(`/${wanted}`) || wanted.endsWith(`/${a}`);
}

/**
 * @param {{ v8?: object[], trace?: string|null, sources?: Record<string,string> }} data
 *   v8: parsed NODE_V8_COVERAGE files ({ result: [...] }). sources: tree-relative file -> text at the head.
 */
export function makeCoverage(data = {}) {
  const v8 = Array.isArray(data.v8) ? data.v8 : [];
  const sources = data.sources ?? {};
  const traced = typeof data.trace === 'string' && data.trace.trim() !== '' ? parseTrace(data.trace) : null;

  const scriptsFor = (file) => v8.flatMap((j) => (j?.result ?? []).filter((s) => s.url === `${APP_URL}${file}`));

  function v8Answer(file, start, end) {
    if (v8.length === 0) return null;
    const scripts = scriptsFor(file);
    if (scripts.length === 0) return false;
    const text = sources[file];
    if (typeof text !== 'string') return null;
    const wanted = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    return scripts.some((s) => v8Lines(s, text, wanted).size > 0);
  }

  function traceAnswer(file, start, end) {
    if (traced === null) return null;
    for (const [f, lines] of traced) {
      if (!sameFile(f, file)) continue;
      for (let n = start; n <= end; n += 1) if (lines.has(n)) return true;
    }
    return false;
  }

  return {
    /** @returns {boolean|null} see the file header */
    citedLinesExecuted(file, startLine, endLine) {
      if (!isLine(startLine) || !isLine(endLine) || endLine < startLine) throw new RangeError('startLine and endLine must be integers, 1 <= startLine <= endLine');
      const f = bare(file);
      return isShell(f) ? traceAnswer(f, startLine, endLine) : v8Answer(f, startLine, endLine);
    },
  };
}

// ---------- container loader ----------

const EXEC_SEC = 60;

async function catFile(exec, file) {
  const r = await exec(['cat', '--', file], { cwd: '.', timeoutSec: EXEC_SEC });
  return r?.code === 0 && r.timedOut !== true && typeof r.stdout === 'string' ? r.stdout : null;
}

async function listDir(exec, dir) {
  const r = await exec(['sh', '-c', 'ls -1 "$1" 2>/dev/null', 'sh', dir], { cwd: '.', timeoutSec: EXEC_SEC });
  return r?.code === 0 && typeof r.stdout === 'string' ? r.stdout.split('\n').filter(Boolean) : [];
}

function parseV8(text) {
  try {
    const j = JSON.parse(text);
    return { result: (j?.result ?? []).filter((s) => typeof s?.url === 'string' && s.url.startsWith(APP_URL)) };
  } catch { return null; }
}

/**
 * Reads the coverage a flow left in the container. `exec` is env.exec. `files` are the tree-relative files whose source text V8 needs.
 * Never throws: an exec error gives no data, which the reader answers with null.
 * @returns {Promise<{ v8: object[], trace: string|null, sources: Record<string,string> }>}
 */
export async function loadContainerCoverage(exec, flowId, files = []) {
  const out = { v8: [], trace: null, sources: {} };
  try {
    const dir = covDir(flowId);
    for (const name of (await listDir(exec, dir)).filter((n) => n.endsWith('.json'))) {
      const parsed = parseV8((await catFile(exec, `${dir}/${name}`)) ?? '');
      if (parsed) out.v8.push(parsed);
    }
    out.trace = await catFile(exec, traceFile(flowId));
    for (const f of files.map(bare).filter((f) => !isShell(f))) {
      const text = await catFile(exec, `/app/${f}`);
      if (text !== null) out.sources[f] = text;
    }
  } catch { return { v8: [], trace: null, sources: {} }; }
  return out;
}
