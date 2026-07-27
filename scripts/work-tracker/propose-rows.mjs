// propose-rows.mjs — derive candidate Weekly Work Tracker rows from git history.
//
// READ-ONLY BY CONSTRUCTION. This file imports no write helper and calls no Notion
// mutation. Its only outputs are stdout and a proposal JSON in $TEMP. A separate
// `--apply` step (not this file) is the human gate that writes.
//
// WHY THIS EXISTS: every report reads the Weekly Work Tracker, but rows only appear
// when a human remembers `/log-work`. On 2026-07-27 the newest row was 07-25 while
// 25+ commits had landed since — so the reports misrepresented the work even though
// every pipeline was healthy. A perfectly healthy pipeline still misreports if the
// spine is empty.
//
// DEDUP, in order of actual strength (premortem finding, verified):
//   1. DATE WATERMARK (primary)  — only consider commits after the newest row's Date.
//   2. SHA match     (secondary) — only 12 of 71 existing rows carry SHAs at all, so
//                                  this catches rows THIS tool wrote and little else.
//                                  Do not rely on it as the main defence.
//
// CLI:
//   node scripts/work-tracker/propose-rows.mjs              # propose since watermark
//   node scripts/work-tracker/propose-rows.mjs --since 2026-07-26
//   node scripts/work-tracker/propose-rows.mjs --json       # machine-readable only
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const TRACKER_DS = '6e8d9b17-f8ef-4d56-9f13-00344650ac03';
export const DEFAULT_PROJECT_ROW = '34b76fd7-ac82-8104-82ca-df3e801695c0';

// --- Type inference -------------------------------------------------------------
// A conventional-commit prefix was never designed to carry reporting semantics, so
// every value here is a PRE-FILLED DEFAULT THE HUMAN IS EXPECTED TO CORRECT — never
// presented as authoritative. Proposals carry `typeInferred: true` to say so.
export const TYPE_BY_PREFIX = {
  feat: 'Ship',
  fix: 'Fix',
  docs: 'Design',
  refactor: 'Feature',
  perf: 'Feature',
  build: 'Deploy',
  ci: 'Deploy',
  test: 'Fix',
  chore: 'Fix',
};
export function inferType(prefix) {
  return TYPE_BY_PREFIX[String(prefix || '').toLowerCase()] || 'Ship';
}

// --- git ------------------------------------------------------------------------
// Record-separated so subjects containing our field delimiter cannot corrupt parsing.
// Written as ESCAPES, never literal control bytes: an invisible 0x01 in source is a
// landmine -- editors, copy-paste and git filters can silently eat it, and the
// failure mode is a parser that splits on every character.
const REC = '\x01';
const FLD = '\x02';

export function readCommits(sinceDate, { repo = process.cwd(), run = execFileSync } = {}) {
  const out = run('git', [
    '-C', repo, 'log', `--since=${sinceDate}`, '--no-merges', '--name-only',
    `--pretty=format:${REC}%H${FLD}%ad${FLD}%s`, '--date=short',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return parseGitLog(out);
}

// Pure: raw `git log` text -> commit objects. Exported so the parser is testable
// without a repo.
export function parseGitLog(text) {
  const commits = [];
  for (const rec of String(text).split(REC)) {
    if (!rec.trim()) continue;
    const [header, ...fileLines] = rec.split('\n');
    const [sha, date, ...subjectParts] = header.split(FLD);
    if (!sha) continue;
    const subject = subjectParts.join(FLD);
    const files = fileLines.map((l) => l.trim()).filter(Boolean);
    const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject);
    commits.push({
      sha: sha.slice(0, 7),
      fullSha: sha,
      date,
      subject,
      prefix: m ? m[1] : '',
      scope: m ? (m[2] || '') : '',
      description: m ? m[3] : subject,
      files,
      topDir: topLevelDir(files),
    });
  }
  return commits;
}

// The dominant top-level directory of a commit — used as a grouping boundary so
// unrelated work sharing a scope is not merged into one misleading row.
export function topLevelDir(files) {
  if (!files || !files.length) return '';
  const counts = {};
  for (const f of files) {
    const top = String(f).split(/[/\\]/)[0];
    counts[top] = (counts[top] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// --- Grouping -------------------------------------------------------------------
// Scope alone is NOT a work-unit boundary: six `fix(coordination):` commits spread
// over two days in two directories are not one reportable unit. Key on
// scope + date + topDir so a group can never span more than one of either.
export function groupCommits(commits) {
  const groups = new Map();
  for (const c of commits) {
    const key = `${c.scope || c.prefix || 'misc'}|${c.date}|${c.topDir}`;
    if (!groups.has(key)) groups.set(key, { key, scope: c.scope, prefix: c.prefix, date: c.date, topDir: c.topDir, commits: [] });
    groups.get(key).commits.push(c);
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}

// --- Dedup ----------------------------------------------------------------------
export function loggedShas(rows, { get } = {}) {
  const read = get || ((r, n) => {
    const p = r.properties?.[n];
    return p?.rich_text?.map((x) => x.plain_text).join('') ?? '';
  });
  const set = new Set();
  for (const r of rows) {
    for (const s of String(read(r, 'Commits')).split(/[,\s]+/)) {
      const t = s.trim();
      if (t) set.add(t.slice(0, 7));
    }
  }
  return set;
}

// A group whose commits are only PARTLY logged is SPLIT, never suppressed and never
// re-proposed whole: suppressing loses the unlogged work, re-proposing duplicates the
// logged commit. Returns null when every commit in the group is already logged.
export function splitPartial(group, logged) {
  const fresh = group.commits.filter((c) => !logged.has(c.sha));
  const already = group.commits.filter((c) => logged.has(c.sha)).map((c) => c.sha);
  if (!fresh.length) return null;
  return { ...group, commits: fresh, partiallyLogged: already.length > 0, alreadyLogged: already };
}

// --- Proposal shape -------------------------------------------------------------
export function toProposedRow(group) {
  const titles = group.commits.map((c) => c.description);
  const title = titles.length === 1
    ? capitalize(titles[0])
    : `${capitalize(group.scope || group.prefix || 'work')}: ${titles.length} commits (${shortJoin(titles)})`;
  return {
    title,
    type: inferType(group.prefix),
    typeInferred: true,          // ALWAYS true — a default to correct, not a fact
    impact: 'Mid',               // heuristics do not know impact; the human does
    impactInferred: true,
    source: 'Code',
    dashboardSection: 'Deep Dive',
    date: group.date,
    commits: group.commits.map((c) => c.sha).join(', '),
    projectRelation: DEFAULT_PROJECT_ROW,
    publishedInReport: false,
    scope: group.scope,
    topDir: group.topDir,
    partiallyLogged: !!group.partiallyLogged,
    alreadyLogged: group.alreadyLogged || [],
  };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const shortJoin = (t) => t.slice(0, 2).map((x) => x.split(' ').slice(0, 4).join(' ')).join('; ') + (t.length > 2 ? ' …' : '');

// --- Buried work ------------------------------------------------------------------
// The watermark is a HIGH-water mark, and that is a hole: applying a row dated 07-26
// advances it past unlogged 07-25 commits, which are then neither proposed nor logged
// — invisible to every report, forever. Observed for real on 2026-07-27: applying one
// 07-26 row buried 4e4c621, b855583 and 29de6f1.
//
// So we look BACK from the watermark and report any commit in that window whose SHA no
// row records. These are NOT proposed (that would re-propose the whole history every
// run); they are surfaced with the --since command that recovers them. Silence is the
// bug; a warning is the fix.
export function buriedCommits(commits, logged, watermark) {
  return commits.filter((c) => c.date < watermark && !logged.has(c.sha));
}

export function lookbackDate(watermark, days = 14) {
  const d = new Date(`${watermark}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return watermark;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Newest `Date` across existing rows — the watermark that does the real dedup work.
export function newestRowDate(rows) {
  let best = '';
  for (const r of rows) {
    const d = r.properties?.Date?.date?.start || '';
    if (d && d > best) best = d;
  }
  return best;
}

// --- main -----------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const sinceIdx = argv.indexOf('--since');
  const sinceArg = sinceIdx !== -1 ? argv[sinceIdx + 1] : null;

  const { queryDataSource } = await import('../project-cards/lib/notion.mjs');
  const rows = queryDataSource(TRACKER_DS, {});
  const watermark = sinceArg || newestRowDate(rows);
  if (!watermark) throw new Error('could not determine a watermark date (no --since, and no dated rows)');

  const logged = loggedShas(rows);
  const commits = readCommits(watermark);
  const groups = groupCommits(commits);
  const proposals = groups.map((g) => splitPartial(g, logged)).filter(Boolean).map(toProposedRow);

  // Look back past the watermark for work it stepped over. Skipped when --since was
  // given explicitly: the caller has already chosen the window.
  const lookback = lookbackDate(watermark);
  const buried = sinceArg ? [] : buriedCommits(readCommits(lookback), logged, watermark);

  const id = `${watermark}-${commits.length}c`;
  const outPath = join(process.env.TEMP || tmpdir(), `work-rows-proposal-${id}.json`);
  const proposal = {
    proposalId: id,
    generatedAt: new Date().toISOString(),
    // `--apply` MUST re-read both and refuse if either moved (stale-proposal race).
    basis: { watermark, headSha: headSha(), trackerRowCount: rows.length },
    rows: proposals,
    buried: buried.map((c) => ({ sha: c.sha, date: c.date, subject: c.subject })),
  };
  writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');

  if (asJson) { console.log(JSON.stringify(proposal, null, 2)); return; }

  console.log(`\nWatermark: ${watermark}  (newest existing Tracker row)`);
  console.log(`Commits since: ${commits.length}   Groups: ${groups.length}   Proposed rows: ${proposals.length}`);
  // `logged.size` counts DISTINCT SHAs, not rows — printing it as "rows with SHAs"
  // reads as 30/71 rows when it is really 30 SHAs spread across ~12 rows.
  console.log(`Existing rows: ${rows.length}   distinct SHAs known: ${logged.size} (across the few rows that carry them)`);
  console.log(`SHA dedup is SECONDARY — the date watermark does the real work.\n`);
  for (const [i, p] of proposals.entries()) {
    console.log(`${String(i + 1).padStart(2)}. [${p.date}] ${p.title}`);
    console.log(`    type=${p.type}* impact=${p.impact}* section=${p.dashboardSection}  dir=${p.topDir}  commits=${p.commits}`);
    if (p.partiallyLogged) console.log(`    PARTIAL: already logged -> ${p.alreadyLogged.join(', ')} (split, not suppressed)`);
  }
  console.log(`\n* = inferred default, correct before applying.`);

  if (buried.length) {
    console.log(`\nBURIED — ${buried.length} commit(s) below the watermark that no row records.`);
    console.log(`The watermark is a high-water mark, so applying a newer row steps over these.`);
    for (const c of buried) console.log(`    ${c.date}  ${c.sha}  ${c.subject}`);
    console.log(`Recover with: node scripts/work-tracker/propose-rows.mjs --since ${lookback}`);
  }
  console.log(`Proposal written: ${outPath}`);
  console.log(`NOTHING was written to Notion. Review, then apply with the proposal id.\n`);
}

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7);
  } catch { return ''; }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(`[propose-rows] FATAL: ${e.message}`); process.exit(1); });
}
