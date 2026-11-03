// TREX baseline adapter: turns the TREX bench rows (proofs-trex.json, negatives.json) into inputs for the review engine and the review-eval
// scorer. Pure parsing and shaping only. It never starts an engine run. Plan: .claudedocs/2026-11-03-trex-review-baseline.md.
//
// Reviewed diff per row: positives review the bench authorRange (the change that introduced the defect, bench spec section 5);
// negatives review head^1..head (their own merge). S6 and S7 share one range, so they share one engine run.

/** The 11 negatives the P0 bench tested. N2 and N6 mapped no_match (untested); K1 and K2 are skip-class. */
export const NEGATIVE_IDS = Object.freeze(['N3', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16']);
/** The 15 graded positives. S18 is reported outside the 15 and is not run. */
export const POSITIVE_IDS = Object.freeze(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15']);

export const normPath = (p) => String(p ?? '').replaceAll('\\', '/').replace(/^\.\//, '');

/** git pathspec-free range text 'a..b' -> { base, head }. Refs may carry ^ (ac03ec78^1). */
export function splitRange(range) {
  const m = /^(.+?)\.\.(.+)$/.exec(String(range ?? ''));
  if (!m) throw new Error(`not a range: ${JSON.stringify(range)}`);
  return { base: m[1], head: m[2] };
}

/**
 * Old-side line ranges of each file in a `git diff -U0` text. { 'a/b.mjs': [{ start, end }] }.
 * '@@ -12 +12,2 @@' means count 1. '@@ -12,0 +13,2 @@' is a pure insertion after line 12: the range is that one line.
 * A deleted-file or binary diff yields no ranges. Paths use forward slashes.
 */
export function parseOldRanges(diffText) {
  const out = {};
  let file = null;
  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    const f = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (f) { file = normPath(f[2]); continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      (out[file] ??= []).push({ start, end: count === 0 ? start : start + count - 1 });
    }
  }
  return out;
}

/**
 * The engine runs. rows: [{ id, kind, base40, head40, ... }]. Rows with the same base40..head40 share one run.
 * Returns [{ runId, pr, base40, head40, kind, rowIds[] }] in row order. pr is a synthetic integer: positives from 9001, negatives from 9101.
 */
export function planRuns(rows) {
  const byRange = new Map();
  const next = { positive: 9001, negative: 9101 };
  for (const r of rows) {
    const key = `${r.base40}..${r.head40}`;
    const hit = byRange.get(key);
    if (hit) { hit.rowIds.push(r.id); continue; }
    byRange.set(key, { runId: r.id, pr: next[r.kind]++, base40: r.base40, head40: r.head40, kind: r.kind, rowIds: [r.id] });
  }
  return [...byRange.values()];
}

/** One review-eval dataset finding per positive row and per fix hunk: a real Major with the defect file and, when known, its old-side lines. */
export function datasetFindings(rows, runs) {
  const prOf = new Map(runs.flatMap((r) => r.rowIds.map((id) => [id, r])));
  const out = [];
  for (const row of rows.filter((r) => r.kind === 'positive')) {
    const run = prOf.get(row.id);
    for (const file of row.defectFiles) {
      const known = (row.oldRanges?.[normPath(file)] ?? []).filter((s) => s.start >= 1); // start 0 = the fix created the file
      const spans = known.length > 0 ? known : [null];
      spans.forEach((s, i) => out.push({
        key: `${row.id}:${normPath(file)}:${i}`, row: row.id, pr: run.pr, round: 1, severity: 'major', verdict: 'real', source: 'inline',
        path: normPath(file), startLine: s?.start ?? null, endLine: s?.end ?? null, sha40: run.head40, resolvedBy: 'trex',
      }));
    }
  }
  return out;
}

/** An engine record finding -> the replay findings shape evaluateRuns reads: { file, line, lineEnd, severity, title }. */
export function toEvalFinding(f) {
  const line = Number.isFinite(f.startLine) ? f.startLine : Number.isFinite(f.line) ? f.line : null;
  const lineEnd = Number.isFinite(f.endLine) ? f.endLine : line;
  return { file: normPath(f.file), line, lineEnd, severity: String(f.severity ?? '').toLowerCase(), title: String(f.title ?? ''), body: String(f.body ?? ''), confidence: f.confidence ?? null };
}

/** The findings file for one engine record: { findings: [...] }. A failed or missing record gives null. */
export function findingsFile(record) {
  if (!record || record.status !== 'ok') return null;
  return { findings: (record.findings ?? []).map(toEvalFinding), durationMs: (record.runs ?? []).reduce((a, r) => a + (r.durationMs ?? 0), 0) };
}

/** One runs.jsonl row (replay shape) for evaluateRuns/scorecard. promptSha256 is null: the engine prompt is local-review's, not the frozen v0. */
export function runRow({ run, record, findingsPath, ts }) {
  const ok = Boolean(record) && record.status === 'ok';
  return {
    schema: 1, set: 'dev', pr: run.pr, round: 1, sha40: run.head40, base40: run.base40, range: 'normal', status: ok ? 'ok' : 'failed',
    promptSha256: null, cursorRunId: record?.runId ?? null, findingsPath: ok ? findingsPath : null, durationMs: (record?.runs ?? []).reduce((a, r) => a + (r.durationMs ?? 0), 0),
    usage: null, findingCount: ok ? (record.findings ?? []).length : 0, ts,
  };
}

/** Negatives: false alarms are Major or Critical findings with confidence >= 3 (the engine's own majorsOpen rule). */
export function majorFindings(findings) {
  return findings.filter((f) => ['major', 'critical'].includes(String(f.severity).toLowerCase()) && (f.confidence ?? 3) >= 3);
}
