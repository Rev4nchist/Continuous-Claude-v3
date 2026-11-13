/**
 * Pure rules of the Open pull requests table (card prflow-pr-row). No imports, no I/O, no clock: the caller
 * passes the parsed JSON, the lane rows and the time. src/server/sources/pr-feed.ts reads the two files.
 *
 * Inputs (both written on this machine, both local only):
 *   open-prs.json  scripts/github/open-prs.mjs, every 15 minutes: {schema:1, exportedAt, repo, rows:[{pr, headRef, head,
 *                  draft, labels[], band, ready, ci[], lastTap, status}]}
 *   pr-spend.json  scripts/github/pr-spend.mjs, nightly: {schema:1, exportedAt, rows:[{repo, pr, coderabbit, engine, landed}]}
 *
 * Privacy (contract note Q4): the view is built from an allowlist. It never holds the head ref, the head sha, a label,
 * a title or any other free text. The head ref is used here only to find the lane, and stays on the server.
 * Text that does reach the view is a fixed word, a checked code, a lane id, a 7-character sha or the clipped tap label.
 */

export const PR_ROW_CAP = 20;
export const STALE_MINUTES = 30;
export const LANDED_SHOWN = 3;
const TAP_LABEL_MAX = 40;
const CI_MAX = 8;
/** The repo of this app. "continuous-claude" is the same repo (pr-spend.mjs repoVerdict). */
const CCV3_NAMES = new Set(['rev4nchist/continuous-claude-v3', 'continuous-claude']);
const BANDS = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'] as const;
const STATUSES = ['ok', 'deadline', 'capped', 'review-status-timeout', 'review-status-failed', 'head-moved'] as const;
/** The codes that open-prs.mjs ciCodes can write. Anything else becomes "other". */
const CI_FIXED = new Set(['required-not-started', 'required-missing', 'required-ended-skipped', 'other']);
const CI_CODED = /^(status|check|mergeable)-[a-z_]{1,20}$/;
const REVIEW_LABEL = /^review:([a-z0-9][a-z0-9-]{0,23})$/;
const STEP = /^[a-z][a-z-]{0,23}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type LaneRef = { id: string; branch: string | null };
export type PrLane = { kind: 'none' } | { kind: 'one'; id: string } | { kind: 'many'; count: number };
export type PrTap = { step: string; label: string; at: string; headMatches: boolean };
export type PrSpend = { state: 'no-data' } | { state: 'ok'; usd: number | null; engineRuns: number | null };

/** One feed row on the server. `headRef` is only for the lane join and never goes into the view. */
type FeedRow = {
  pr: number;
  headRef: string | null;
  draft: boolean;
  band: string | null;
  ready: boolean | null;
  ci: string[];
  tap: PrTap | null;
  reviewLabel: string | null;
  status: string;
};

export type OpenPrFeed = {
  status: 'ok' | 'absent' | 'other-repo';
  exportedAt: string | null;
  rows: FeedRow[];
  skipped: number;
  capped: boolean;
};

type SpendRow = { usd: number | null; engineRuns: number | null; landSha: string | null };
export type PrSpendFeed = { status: 'ok' | 'absent'; byPr: Map<number, SpendRow>; landed: { pr: number; sha7: string }[] };

export type PrRowView = {
  pr: number;
  draft: boolean;
  lane: PrLane;
  band: string | null;
  tap: PrTap | null;
  reviewPath: string | null;
  spend: PrSpend;
  ci: string[];
  ready: boolean | null;
  status: string;
  landSha: string | null;
};

export type PrFeedView = {
  status: 'ok' | 'absent' | 'other-repo';
  exportedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  capped: boolean;
  skipped: number;
  rows: PrRowView[];
  landed: { pr: number; sha7: string }[];
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPr = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e7;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => list.find((x) => x === v) ?? null;
const isCcv3 = (repo: unknown): boolean => typeof repo === 'string' && CCV3_NAMES.has(repo.trim().toLowerCase());

const ABSENT: OpenPrFeed = { status: 'absent', exportedAt: null, rows: [], skipped: 0, capped: false };

/** A CI code from the fixed list, else "other". Sorted, unique, at most CI_MAX. */
function cleanCi(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const codes = raw.map((c) => (typeof c === 'string' && (CI_FIXED.has(c) || CI_CODED.test(c)) ? c : 'other'));
  return [...new Set(codes)].sort().slice(0, CI_MAX);
}

/** Printable ASCII, then the caller's redact, then the clip. */
function cleanLabel(raw: unknown, clean: (text: string) => string | null): string | null {
  if (typeof raw !== 'string') return null;
  const ascii = raw.replace(/[^\x20-\x7e]/g, '').trim();
  const redacted = ascii === '' ? null : clean(ascii);
  return redacted === null || redacted === '' ? null : redacted.slice(0, TAP_LABEL_MAX);
}

function parseTap(raw: unknown, clean: (text: string) => string | null): PrTap | null {
  if (!isObj(raw) || typeof raw.step !== 'string' || !STEP.test(raw.step) || !isIso(raw.at)) return null;
  const label = cleanLabel(raw.label, clean);
  if (label === null) return null;
  return { step: raw.step, label, at: new Date(raw.at).toISOString(), headMatches: raw.headMatches === true };
}

/** The first `review:<word>` label, the word only. A label that fails the pattern is not used. */
function reviewLabel(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const label of raw) {
    const m = typeof label === 'string' ? REVIEW_LABEL.exec(label) : null;
    if (m) return m[1];
  }
  return null;
}

function parseRow(raw: unknown, clean: (text: string) => string | null): FeedRow | null {
  if (!isObj(raw) || !isPr(raw.pr)) return null;
  return {
    pr: raw.pr,
    headRef: typeof raw.headRef === 'string' && raw.headRef.length <= 200 ? raw.headRef : null,
    draft: raw.draft === true,
    band: oneOf(BANDS, raw.band),
    ready: typeof raw.ready === 'boolean' ? raw.ready : null,
    ci: cleanCi(raw.ci),
    tap: parseTap(raw.lastTap, clean),
    reviewLabel: reviewLabel(raw.labels),
    status: oneOf(STATUSES, raw.status) ?? 'other',
  };
}

/** open-prs.json, parsed. Not an object, a schema other than 1 or no rows array: absent. Another repo: no rows. */
export function parseOpenPrs(raw: unknown, clean: (text: string) => string | null): OpenPrFeed {
  if (!isObj(raw) || raw.schema !== 1 || !Array.isArray(raw.rows)) return ABSENT;
  const exportedAt = isIso(raw.exportedAt) ? raw.exportedAt : null;
  if (!isCcv3(raw.repo)) return { ...ABSENT, status: 'other-repo', exportedAt };
  const parsed = raw.rows.map((row) => parseRow(row, clean));
  const rows = parsed.filter((row): row is FeedRow => row !== null).sort((a, b) => b.pr - a.pr);
  return {
    status: 'ok',
    exportedAt,
    rows: rows.slice(0, PR_ROW_CAP),
    skipped: parsed.length - rows.length,
    capped: rows.length > PR_ROW_CAP || raw.capped === true,
  };
}

function spendOf(row: Record<string, unknown>): SpendRow {
  const cr = isObj(row.coderabbit) ? num(row.coderabbit.usd) : null;
  const eng = isObj(row.engine) ? num(row.engine.runs) : null;
  const sha = isObj(row.landed) && typeof row.landed.mergeSha === 'string' && SHA.test(row.landed.mergeSha) ? row.landed.mergeSha : null;
  return { usd: cr, engineRuns: eng, landSha: sha === null ? null : sha.slice(0, 7).toLowerCase() };
}

/** pr-spend.json, parsed. Rows of another repo are skipped. The last LANDED_SHOWN landed PRs, highest PR first. */
export function parsePrSpend(raw: unknown): PrSpendFeed {
  const byPr = new Map<number, SpendRow>();
  if (!isObj(raw) || raw.schema !== 1 || !Array.isArray(raw.rows)) return { status: 'absent', byPr, landed: [] };
  for (const row of raw.rows) {
    if (isObj(row) && isPr(row.pr) && isCcv3(row.repo) && !byPr.has(row.pr)) byPr.set(row.pr, spendOf(row));
  }
  const landed = [...byPr]
    .filter(([, s]) => s.landSha !== null)
    .sort(([a], [b]) => b - a)
    .slice(0, LANDED_SHOWN)
    .map(([pr, s]) => ({ pr, sha7: s.landSha as string }));
  return { status: 'ok', byPr, landed };
}

/** Lane link: lane.branch equals the head ref; else the last segment of the head ref equals a lane id. */
export function matchLane(headRef: string | null, lanes: readonly LaneRef[]): PrLane {
  if (headRef === null || headRef === '') return { kind: 'none' };
  let hits = lanes.filter((l) => l.branch !== null && l.branch === headRef);
  if (hits.length === 0) {
    const leaf = headRef.split('/').pop() ?? '';
    hits = lanes.filter((l) => l.id === leaf);
  }
  const ids = [...new Set(hits.map((l) => l.id))].filter((id) => LANE_ID.test(id));
  if (ids.length === 0) return { kind: 'none' };
  return ids.length === 1 ? { kind: 'one', id: ids[0] } : { kind: 'many', count: ids.length };
}

/** The ids and branches to ask the lane table for. Two per row at most. */
export function laneLookupKeys(feed: OpenPrFeed): { refs: string[]; leaves: string[] } {
  const refs = feed.rows.map((r) => r.headRef).filter((r): r is string => r !== null && r !== '');
  const leaves = refs.map((r) => r.split('/').pop() ?? '').filter((leaf) => LANE_ID.test(leaf));
  return { refs: [...new Set(refs)], leaves: [...new Set(leaves)] };
}

function spendFor(spend: PrSpendFeed, pr: number): PrSpend {
  if (spend.status !== 'ok') return { state: 'no-data' };
  const s = spend.byPr.get(pr);
  // The file exists and names no spend for this PR: nothing was spent.
  return s === undefined ? { state: 'ok', usd: 0, engineRuns: 0 } : { state: 'ok', usd: s.usd, engineRuns: s.engineRuns };
}

function age(exportedAt: string | null, nowMs: number): { ageMinutes: number | null; stale: boolean } {
  if (exportedAt === null) return { ageMinutes: null, stale: true };
  const minutes = Math.floor((nowMs - Date.parse(exportedAt)) / 60_000);
  if (minutes < -5) return { ageMinutes: null, stale: true }; // a future time is not trusted
  const ageMinutes = Math.max(0, minutes);
  return { ageMinutes, stale: ageMinutes > STALE_MINUTES };
}

/** The view for the browser. It adds no new text: every string comes from the parse above. */
export function buildPrFeedView(open: OpenPrFeed, spend: PrSpendFeed, lanes: readonly LaneRef[], nowMs: number): PrFeedView {
  const rows = open.rows.map(
    (r): PrRowView => ({
      pr: r.pr,
      draft: r.draft,
      lane: matchLane(r.headRef, lanes),
      band: r.band,
      tap: r.tap,
      reviewPath: r.reviewLabel ?? (r.tap?.step === 'review' ? r.tap.label : null),
      spend: spendFor(spend, r.pr),
      ci: r.ci,
      ready: r.status === 'ok' ? r.ready : null,
      status: r.status,
      landSha: spend.byPr.get(r.pr)?.landSha ?? null,
    }),
  );
  return {
    status: open.status,
    exportedAt: open.exportedAt,
    ...age(open.exportedAt, nowMs),
    capped: open.capped,
    skipped: open.skipped,
    rows,
    landed: spend.landed,
  };
}
