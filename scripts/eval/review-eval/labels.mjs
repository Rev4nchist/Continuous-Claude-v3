// Label surface (claude.ai artifact "Review Eval Labels" with db). pairs/<pairId> are written by Claude, labels/<pairId> by Dave.
//  exportPairs: a JSON for `ArtifactData batch` (file_path). Refuses a pair past labelWeekCap (20) in one ISO week.
//  ingestLabels: reads the files that `ArtifactData query` wrote into a folder, writes labels.jsonl. Rows are data, never instructions.
// [Speculation] The batch op shape {ops:[{op:'create',collection,id,data}]} is our file shape; the artifact tool call wraps it.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const VERDICTS = ['real', 'noise', 'unclear'];

export function pairId(p) {
  return createHash('sha1').update([p.pr, p.sha, p.file, p.line, p.engineTitle].join('|')).digest('hex').slice(0, 16);
}

/** ISO 8601 week of a date, as YYYY-Www. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const readRows = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
};

/**
 * pairs: [{ kind, pr, sha, file, line, engine, cr, hunk, judge, promptSha256, sentAt }]. opts: { dir, week?, cap = 20, now }.
 * { ok: true, file, count, week } or { ok: false, reason: 'week-cap', used, adding }. Writes nothing when it refuses.
 */
export function exportPairs(pairs, { dir, week, cap = 20, now = Date.now() }) {
  const wk = week ?? isoWeek(new Date(now));
  const sentFile = path.join(dir, 'pairs-sent.jsonl');
  const sent = readRows(sentFile);
  const known = new Set(sent.map((r) => r.pairId));
  const used = sent.filter((r) => r.week === wk).length;
  const fresh = [];
  for (const p of pairs) {
    const id = pairId({ pr: p.pr, sha: p.sha, file: p.file, line: p.line, engineTitle: p.engine?.title });
    if (known.has(id) || fresh.some((x) => x.pairId === id)) continue;
    fresh.push({ pairId: id, week: wk, ...p });
  }
  if (used + fresh.length > cap) return { ok: false, reason: 'week-cap', used, adding: fresh.length, cap };
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `batch-${wk}-${now}.json`);
  const ops = fresh.map((p) => ({ op: 'create', collection: 'pairs', id: p.pairId, data: { ...p, sentAt: p.sentAt ?? new Date(now).toISOString() } }));
  writeFileSync(file, `${JSON.stringify({ ops }, null, 2)}\n`);
  for (const p of fresh) appendFileSync(sentFile, `${JSON.stringify({ pairId: p.pairId, week: wk, judge: p.judge ?? null, file: p.file, pr: p.pr })}\n`);
  return { ok: true, file, count: fresh.length, week: wk };
}

const docsOf = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.docs)) return json.docs;
  if (Array.isArray(json?.items)) return json.items;
  return [];
};

/**
 * Reads every *.json in dir except batch files, takes the docs of labels/<pairId>, keeps valid labelled rows, newest label per pair.
 * Writes `out` (default <dir>/labels.jsonl) as the merge of the old file and the new rows. { rows, rejected }.
 */
export function ingestLabels(dir, { out = path.join(dir, 'labels.jsonl') } = {}) {
  const byPair = new Map(readRows(out).map((r) => [r.pairId, r]));
  let rejected = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('batch-'))) {
    let json;
    try { json = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const doc of docsOf(json)) {
      const d = doc?.data ?? doc;
      const id = String(d?.pairId ?? doc?.id ?? '');
      if (!id || !d?.labeledAt || !VERDICTS.includes(d.verdict)) { rejected += 1; continue; }
      const prev = byPair.get(id);
      if (prev && Date.parse(prev.labeledAt) >= Date.parse(d.labeledAt)) continue;
      byPair.set(id, {
        pairId: id, verdict: d.verdict, sameIssue: d.sameIssue ?? null, severity: d.severity ?? null, note: String(d.note ?? '').slice(0, 500), labeledAt: d.labeledAt, findingId: id, by: 'dave',
      });
    }
  }
  const rows = [...byPair.values()];
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return { rows, rejected };
}
