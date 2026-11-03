// rescore --archive: re-apply the output parser and the path filter to archived raw agent answers. It calls no model.
// Input folder:  <dir>/runs.jsonl and <dir>/<pr>/<sha8>/<stem>.raw.json + <stem>.findings.json  (the layout replay.mjs archives).
// Output folder: new runs.jsonl and findings files beside copies of the files `score` reads. The archive is never written.
// The stored findingsPath of an archived row names the folder of the run that made it, which may be gone. The file is found
// by the last three parts of that path instead.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseReviewOutput, resultFromStream } from '../../github/cursor-review.mjs';

/** A failure that a better parser can change. Timeouts, crashes and stalls keep their reason. */
const PARSE_FAILURE = /no findings block|no result JSON|holds no usable item/;
const COPIED = ['dataset-resolved.json', 'labels.jsonl', 'pairs-sent.jsonl'];

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** <dir>/<pr>/<sha8>/<file> for a stored findingsPath, whatever folder it named. null when a kept part is '..', '.' or empty: it could leave the archive. */
export function archiveFile(dir, storedPath) {
  const parts = String(storedPath).split(/[\\/]/).slice(-3);
  if (parts.length < 3 || parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return path.join(dir, ...parts);
}

/** exists(sha40, file): is the file in the commit's tree? A commit this repo does not hold cannot judge, so it keeps every file. */
export function treeCheck(git) {
  const known = new Map();
  const has = (sha) => { if (!known.has(sha)) known.set(sha, git(['cat-file', '-e', `${sha}^{commit}`]).status === 0); return known.get(sha); };
  // Only a blob is a file; a folder path names a tree.
  const isBlob = (spec) => { const r = git(['cat-file', '-t', spec]); return r.status === 0 && String(r.stdout ?? '').trim() === 'blob'; };
  return (sha, file) => !has(sha) || isBlob(`${sha}:${file}`);
}

function findingsRecord(prior, parsed, model) {
  const error = parsed.modelMismatch ? `model check failed: the output names a model other than ${model}; the run is void` : (!parsed.ok ? parsed.problems.join('; ') : null);
  const counts = {};
  for (const f of parsed.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return { ...prior, status: error ? 'failed' : 'ok', error, format: parsed.format, clean: parsed.clean, problems: parsed.problems, counts, findings: error ? [] : parsed.findings, rescored: true };
}

/** { row, rec, dropped } for one archived row. rec is null when the row is carried over unchanged. */
function rescoreRow(row, { archive, exists }) {
  const stored = archiveFile(archive, row.findingsPath);
  if (stored === null) return { row: { ...row, findingsPath: null }, rec: null, stored: null, prior: {}, dropped: 0 };
  const prior = readJson(stored) ?? {};
  const rawFile = stored.replace(/\.findings\.json$/, '.raw.json');
  const raw = existsSync(rawFile) ? readFileSync(rawFile, 'utf8') : '';
  const redo = (row.status === 'ok' || PARSE_FAILURE.test(row.reason ?? '')) && resultFromStream(raw) !== null;
  if (!redo) return { row, rec: null, stored, prior, dropped: 0 };
  const parsed = parseReviewOutput(raw, { expectModel: prior.model, exists: (file) => exists(row.sha40, file) });
  const rec = findingsRecord(prior, parsed, prior.model);
  const next = { ...row, status: rec.status, findingCount: rec.findings.length, reason: rec.error, rescored: true };
  if (!rec.error) delete next.reason;
  return { row: next, rec, stored, prior, dropped: parsed.problems.filter((p) => p.startsWith('dropped a finding')).length };
}

function writeRow(res, out) {
  if (res.stored === null) return res.row;
  const target = path.join(out, ...res.stored.split(path.sep).slice(-3));
  mkdirSync(path.dirname(target), { recursive: true });
  if (res.rec) writeFileSync(target, `${JSON.stringify(res.rec, null, 2)}\n`);
  else if (existsSync(res.stored)) copyFileSync(res.stored, target);
  return { ...res.row, findingsPath: target };
}

/** Rescores every row of <archive>/runs.jsonl into <out>. Returns a short summary. exists(sha40, file) checks the reviewed tree. */
export function rescoreArchive({ archive, out, exists }) {
  const file = path.join(archive, 'runs.jsonl');
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  mkdirSync(out, { recursive: true });
  const results = rows.map((row) => rescoreRow(row, { archive, exists }));
  const written = results.map((res) => writeRow(res, out));
  writeFileSync(path.join(out, 'runs.jsonl'), `${written.map((r) => JSON.stringify(r)).join('\n')}\n`);
  for (const name of COPIED) if (existsSync(path.join(archive, name))) copyFileSync(path.join(archive, name), path.join(out, name));
  const changed = results.map((res, i) => ({ res, i })).filter(({ res, i }) => res.row.status !== rows[i].status || res.row.findingCount !== rows[i].findingCount);
  return {
    rows: rows.length,
    reparsed: results.filter((r) => r.rec).length,
    droppedFindings: results.reduce((n, r) => n + r.dropped, 0),
    changed: changed.map(({ res, i }) => ({ pr: rows[i].pr, round: rows[i].round, ts: rows[i].ts, from: `${rows[i].status}/${rows[i].findingCount}`, to: `${res.row.status}/${res.row.findingCount}` })),
  };
}
