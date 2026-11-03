/**
 * intent.mjs: the stated intent of a change, for the intent arm of the TREX bench (Dave 2026-11-03).
 *
 * The intent of a group is the PR that the end of its author range merges: the title and body from GitHub (`gh api`, a GET).
 * When the range end does not merge a PR, the intent is the range end commit message. Each intent is stored once in
 * scripts/trex/bench/intent/<group>.json, so the probe is reproducible and a human can review or edit the text.
 * A stored file is reused and never fetched again unless `refetch` is set (the --refetch-intent flag).
 *
 * The stored body is raw (trimmed to MAX_BODY). stripLate removes the lines that look written after the merge, each time the file is read.
 * intentLeakHits finds what the intent must not say: the fix PR, a later PR and the subjects of the commits between the range end and the fix.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripEnv } from '../lib/strip-env.mjs';

export const INTENT_DIR = 'scripts/trex/bench/intent';
export const MAX_BODY = 4000;
export const REPO_SLUG = 'Rev4nchist/Continuous-Claude-v3';
const SEP = '\x1f';
const REC = '\x1e';
const MIN_SUBJECT = 15;
const MAX_LATER = 500;

/** The end of an author range: "a..b" and "a...b" give b, a single commit gives itself. */
export const rangeEnd = (range) => String(range).split(/\.{2,3}/).at(-1);

/** The PR number of a GitHub "Merge pull request #N from ..." subject, or null. */
export function prFromSubject(subject) {
  const m = /^Merge pull request #(\d+) from /.exec(String(subject ?? ''));
  return m ? Number(m[1]) : null;
}

/** gh with the TREX child env (no Anthropic key). Returns { status, stdout, stderr }. Tests pass their own. */
export function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, env: stripEnv(process.env), maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const relFile = (group) => `${INTENT_DIR}/${group}.json`;
const lf = (text) => String(text ?? '').replace(/\r\n/g, '\n');
const firstLine = (text) => lf(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const splitSep = (out) => { const i = String(out).indexOf(SEP); return i < 0 ? [lf(out).split('\n')[0], ''] : [lf(out).slice(0, i), lf(out).slice(i + 1)]; };

// ---------- load and fetch ----------

function readStored(file, group) {
  let v;
  try { v = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { return { error: `${relFile(group)} is not valid JSON (${err.message})` }; }
  const ok = v && typeof v === 'object' && typeof v.title === 'string' && v.title.trim() !== '' && typeof v.body === 'string';
  if (!ok) return { error: `${relFile(group)} needs a non-empty "title" string and a "body" string` };
  return { intent: { pr: Number.isInteger(v.pr) ? v.pr : null, title: v.title, body: v.body, source: v.source ?? 'edited', fetchedAt: v.fetchedAt ?? null } };
}

function fetchPr(gh, n) {
  const r = gh(['api', `repos/${REPO_SLUG}/pulls/${n}`, '--jq', '{title,body,merged_at,number}']);
  if (r.status !== 0) return { error: `gh api pulls/${n} failed: ${String(r.stderr).trim() || `exit ${r.status}`}` };
  let v;
  try { v = JSON.parse(r.stdout); } catch { return { error: `gh api pulls/${n} did not return JSON` }; }
  if (!v || v.number !== n || typeof v.title !== 'string' || v.title.trim() === '') return { error: `gh api pulls/${n} returned no title or another PR number` };
  return { title: v.title, body: String(v.body ?? '').slice(0, MAX_BODY), mergedAt: v.merged_at ?? null };
}

/** { intent } or { error }, fresh from git and gh. Writes nothing. */
function fetchIntent(range, git, gh, now) {
  const end = rangeEnd(range);
  const r = git(['log', '-1', '--format=%s%x1f%B', end]);
  if (r.status !== 0) return { error: `git log ${end} failed: ${String(r.stderr).trim()}` };
  const [subject, message] = splitSep(r.stdout);
  const fetchedAt = new Date(now()).toISOString();
  const n = prFromSubject(subject.trim());
  if (n === null) {
    const body = message.replace(/^[^\n]*\n?/, '').trim().slice(0, MAX_BODY);
    return { intent: { pr: null, title: subject.trim(), body, source: 'commit', fetchedAt, rangeEnd: end } };
  }
  const pr = fetchPr(gh, n);
  if (pr.error) return pr;
  return { intent: { pr: n, title: pr.title, body: pr.body, source: 'pr', fetchedAt, mergedAt: pr.mergedAt, rangeEnd: end } };
}

/**
 * The intent of a group: { intent, file, status: 'stored' | 'fetched' | 'refetched', fetched } or { error }.
 * opts: { root, git, gh?, now?, refetch? }. A stored file is read as it is. A failed fetch writes no file.
 */
export function loadIntent(group, range, { root, git, gh = defaultGh, now = Date.now, refetch = false }) {
  const file = path.join(root, ...INTENT_DIR.split('/'), `${group}.json`);
  const had = existsSync(file);
  if (had && !refetch) {
    const stored = readStored(file, group);
    return stored.error ? stored : { ...stored, file, status: 'stored', fetched: false };
  }
  const got = fetchIntent(range, git, gh, now);
  if (got.error) return got;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(got.intent, null, 2)}\n`);
  return { intent: got.intent, file, status: had ? 'refetched' : 'fetched', fetched: true };
}

// ---------- strip what was written after the merge ----------

const PR_NUMBER = /(?:(?<![\w&])#|\bPR\s+|\bpull request\s+|\/pull\/)(\d+)\b/gi;
const LATE_TEXT = /follow[- ]?up|fixed in/i;
const LATE_HEADING = /post[- ]?merge|after (?:the )?merge|addendum|follow[- ]?ups?/i;
const prNumbers = (text) => [...new Set([...String(text).matchAll(PR_NUMBER)].map((m) => Number(m[1])))];

/**
 * Removes the lines that look written after the merge: a line that names a PR number above `limit` (default: the PR number),
 * a line with "follow-up" or "fixed in", and a whole section under a post-merge or follow-up heading.
 * Returns { title, body, stripped }. With a null limit the PR number rule is off.
 */
export function stripLate(intent, limit = intent.pr) {
  const late = (line) => LATE_TEXT.test(line) || (limit != null && prNumbers(line).some((n) => n > limit));
  const kept = [];
  const stripped = [];
  let skipLevel = null;
  for (const line of lf(intent.body).split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (skipLevel !== null && h && h[1].length <= skipLevel) skipLevel = null;
    if (skipLevel !== null) { if (line.trim()) stripped.push(line.trim()); continue; }
    if (h && LATE_HEADING.test(h[2])) { skipLevel = h[1].length; stripped.push(line.trim()); continue; }
    if (late(line)) { stripped.push(line.trim()); continue; }
    kept.push(line);
  }
  if (stripped.length === 0) return { title: intent.title, body: lf(intent.body), stripped };
  return { title: intent.title, body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), stripped };
}

// ---------- leak facts ----------

function containingPr(git, sha) {
  const own = git(['log', '-1', '--format=%s%x1f%b', sha]);
  if (own.status === 0) {
    const [subject, body] = splitSep(own.stdout);
    const n = prFromSubject(subject.trim());
    if (n !== null) return { n, title: firstLine(body) };
  }
  const list = git(['log', '--merges', '--ancestry-path', '--reverse', '--format=%s%x1f%b%x1e', `${sha}..HEAD`]);
  if (list.status !== 0) return null;
  for (const rec of String(list.stdout).split(REC)) {
    const [subject, body] = splitSep(rec.replace(/^\n+/, ''));
    const n = prFromSubject(subject.trim());
    if (n !== null) return { n, title: firstLine(body) };
  }
  return null;
}

/**
 * What the intent text must not say, from git only. { fixPr: { n, title } | null, endPr: n | null, later: [subject] }.
 * fixPr is the PR that merges the fix (or contains it), endPr the PR that merges or contains the range end, later the subjects of the
 * commits between the range end and the fix. A git failure gives null and an empty list: the scan then checks less, and never throws.
 */
export function intentFacts(git, { end, fix }) {
  if (!fix) return { fixPr: null, endPr: null, later: [] };
  const fixPr = containingPr(git, fix);
  const endPr = containingPr(git, end);
  const log = git(['log', '--format=%s', `${end}..${fix}`]);
  const later = log.status === 0 ? lf(log.stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, MAX_LATER) : [];
  return { fixPr: fixPr ? { n: fixPr.n, title: fixPr.title } : null, endPr: endPr ? endPr.n : null, later };
}

/**
 * Hits in the intent text, as text lines. opts: { pr, facts, title? }.
 * Rules: names the fix PR number or title, names a PR above the intent PR, holds the subject of a later commit.
 * When the fix is in the same PR as the intent (S1: bug and fix on one branch), the fix PR rules are off, because that PR is the intent.
 * A later commit with the same subject as the intent title (a repeated merge subject) is no hit.
 */
export function intentLeakHits(text, { pr, facts, title = '' }) {
  const hits = [];
  const low = String(text).toLowerCase();
  const own = pr ?? facts.endPr;
  const fix = facts.fixPr && facts.fixPr.n !== own ? facts.fixPr : null;
  for (const n of prNumbers(text)) {
    if (fix && n === fix.n) hits.push(`names the fix PR #${n}`);
    else if (own != null && n > own) hits.push(`names a later PR #${n}`);
  }
  if (fix && fix.title.length >= MIN_SUBJECT && low.includes(fix.title.toLowerCase())) hits.push(`holds the title of the fix PR #${fix.n}`);
  const ownTitle = String(title).trim().toLowerCase();
  for (const s of facts.later) {
    if (s.length >= MIN_SUBJECT && s.toLowerCase() !== ownTitle && low.includes(s.toLowerCase())) hits.push(`holds the later commit subject "${s}"`);
  }
  return hits;
}
