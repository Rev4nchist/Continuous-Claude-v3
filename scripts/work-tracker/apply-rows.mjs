// apply-rows.mjs — the human gate that turns proposals from propose-rows.mjs into
// Weekly Work Tracker rows.
//
// This is the ONLY file in scripts/work-tracker/ that writes. propose-rows.mjs is
// read-only by construction; everything dangerous lives here, behind four gates the
// plan specified after a premortem found "approval is a hard gate" asserted but never
// implemented:
//
//   1. NAMED PROPOSAL     — takes a proposal id. A bare "apply the latest" is refused,
//                           because "latest" is whatever a background job wrote last.
//   2. FRESHNESS          — re-reads git HEAD and the Tracker before writing anything.
//                           If either moved since the proposal was generated, it refuses
//                           and demands a fresh proposal. The real collision on this
//                           branch is not .git/index.lock, it is approving a proposal
//                           against state that has since moved.
//   3. PER-ROW SELECTION  — explicit row numbers only. There is deliberately no --all:
//                           under a 20-row backlog, batch approval degrades to
//                           skim-and-approve, which manufactures exactly the junk rows
//                           this tool exists to prevent.
//   4. ATTRIBUTION        — the approver and timestamp are written into the row body,
//                           along with which inferred fields were corrected and which
//                           were accepted as-is, so a bad row is traceable to a decision.
//
// CLI:
//   node scripts/work-tracker/apply-rows.mjs --proposal <id> --list
//   node scripts/work-tracker/apply-rows.mjs --proposal <id> --approver dave --rows 1,3 --dry-run
//   node scripts/work-tracker/apply-rows.mjs --proposal <id> --approver dave --rows 1,3 \
//        --set 1.type=Decision --set 1.impact=High --set 3.title="Better title"
//
// Exit codes: 0 all selected rows applied · 1 refused, nothing written · 2 partial failure.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TRACKER_DS, newestRowDate, loggedShas } from './propose-rows.mjs';

// --- vocabularies ----------------------------------------------------------------
// Notion CREATES an unknown select option on write rather than rejecting it, so an
// invalid value here would silently pollute the schema instead of failing loudly.
// Validate before the API call, not after. Source of truth: .claude/skills/log-work.
export const TYPES = ['Ship', 'Fix', 'Feature', 'Integration', 'Deploy', 'Decision', 'Research', 'Design', 'Meeting'];
export const IMPACTS = ['High', 'Mid', 'Low'];
export const SECTIONS = ['Deep Dive', 'Integration', 'Metric', 'Adoption', 'Roadmap', 'Decision', 'Highlight', 'None'];
export const SOURCES = ['Code', 'Dave', 'Team'];

const SETTABLE = {
  title: { field: 'title' },
  type: { field: 'type', allowed: TYPES },
  impact: { field: 'impact', allowed: IMPACTS },
  section: { field: 'dashboardSection', allowed: SECTIONS },
  source: { field: 'source', allowed: SOURCES },
  date: { field: 'date', pattern: /^\d{4}-\d{2}-\d{2}$/ },
};

class Refusal extends Error {}

// --- args ------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { proposal: '', approver: '', rows: null, sets: [], dryRun: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--proposal') out.proposal = argv[++i] || '';
    else if (a === '--approver') out.approver = argv[++i] || '';
    else if (a === '--rows') out.rows = parseRowSelection(argv[++i]);
    else if (a === '--set') out.sets.push(parseSet(argv[++i]));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list') out.list = true;
    else if (a === '--all') {
      throw new Refusal(
        '--all does not exist, on purpose. Batch approval is the failure mode this gate '
        + 'exists to prevent: a 20-row backlog approved in one keystroke is how junk rows '
        + 'reach the one spine every report reads. Select rows explicitly: --rows 1,3,7',
      );
    } else if (a.startsWith('--')) throw new Refusal(`unknown flag ${a}`);
  }
  return out;
}

export function parseRowSelection(spec) {
  if (!spec) throw new Refusal('--rows needs a value, e.g. --rows 1,3,7 or --rows 2-4');
  const picked = new Set();
  for (const part of String(spec).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])];
      if (lo < 1 || hi < lo) throw new Refusal(`bad row range "${t}"`);
      for (let n = lo; n <= hi; n += 1) picked.add(n);
    } else if (/^\d+$/.test(t)) {
      if (Number(t) < 1) throw new Refusal('row numbers are 1-based');
      picked.add(Number(t));
    } else throw new Refusal(`bad row selector "${t}" (expected 3, or 2-4)`);
  }
  if (!picked.size) throw new Refusal('--rows selected nothing');
  return [...picked].sort((a, b) => a - b);
}

// `--set 3.type=Decision` -> { row: 3, key: 'type', value: 'Decision' }
export function parseSet(spec) {
  const m = /^(\d+)\.([a-zA-Z]+)=([\s\S]*)$/.exec(String(spec || ''));
  if (!m) throw new Refusal(`bad --set "${spec}" (expected <row>.<field>=<value>, e.g. 2.impact=High)`);
  const key = m[2].toLowerCase();
  if (!SETTABLE[key]) {
    throw new Refusal(`--set field "${m[2]}" is not settable (allowed: ${Object.keys(SETTABLE).join(', ')})`);
  }
  const value = m[3];
  const rule = SETTABLE[key];
  if (rule.allowed && !rule.allowed.includes(value)) {
    throw new Refusal(`--set ${key}="${value}" invalid (allowed: ${rule.allowed.join(' | ')})`);
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    throw new Refusal(`--set ${key}="${value}" invalid (expected ${rule.pattern})`);
  }
  return { row: Number(m[1]), key, value };
}

// Apply overrides onto a row and RECORD what changed. The record is the point: a row
// whose Type was inferred and accepted is a different kind of evidence from one a human
// deliberately set, and the body must be able to tell them apart later.
export function applySets(row, sets) {
  const next = { ...row };
  const corrected = [];
  for (const s of sets) {
    const field = SETTABLE[s.key].field;
    const before = next[field];
    if (String(before) === s.value) continue;
    next[field] = s.value;
    corrected.push({ field: s.key, from: before, to: s.value });
  }
  return { row: next, corrected };
}

// --- proposal loading ------------------------------------------------------------
const proposalDir = () => process.env.TEMP || tmpdir();
const proposalPath = (id) => join(proposalDir(), `work-rows-proposal-${id}.json`);

export function listProposalIds(dir = proposalDir(), { readdir = readdirSync } = {}) {
  return readdir(dir)
    .map((f) => /^work-rows-proposal-(.+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

function loadProposal(id) {
  if (!id) {
    const available = listProposalIds();
    throw new Refusal(
      '--proposal <id> is required; there is no "apply the latest". "Latest" is whatever '
      + 'process wrote last, which is not the thing a human reviewed.\n'
      + (available.length
        ? `Available ids:\n${available.map((x) => `  ${x}`).join('\n')}`
        : 'No proposals found. Run propose-rows.mjs first.'),
    );
  }
  let raw;
  try {
    raw = readFileSync(proposalPath(id), 'utf8');
  } catch {
    throw new Refusal(`no proposal "${id}" at ${proposalPath(id)}. Known ids: ${listProposalIds().join(', ') || '(none)'}`);
  }
  const p = JSON.parse(raw);
  if (!p.basis || !Array.isArray(p.rows)) throw new Refusal(`proposal "${id}" is malformed (no basis/rows)`);
  return p;
}

// --- gate 2: freshness -----------------------------------------------------------
// Compares the world now against the world the proposal was generated against. Runs
// ONCE, before any write — the Tracker row count necessarily moves while we write, so
// re-checking mid-run would refuse against our own effects.
export function checkFreshness(basis, now) {
  const drift = [];
  if (basis.headSha && now.headSha !== basis.headSha) {
    drift.push(`git HEAD moved: ${basis.headSha} -> ${now.headSha} (new commits may belong in these rows)`);
  }
  if (basis.trackerRowCount != null && now.trackerRowCount !== basis.trackerRowCount) {
    drift.push(`Tracker row count moved: ${basis.trackerRowCount} -> ${now.trackerRowCount} (someone else logged work)`);
  }
  if (basis.watermark && now.watermark !== basis.watermark) {
    drift.push(`watermark moved: ${basis.watermark} -> ${now.watermark} (a newer row now exists)`);
  }
  return drift;
}

// A selected row whose commits were logged by someone else since the proposal is a
// double-log waiting to happen. Checked per row so one stale row does not void the rest.
export function rowsAlreadyLogged(rows, logged) {
  const hits = [];
  for (const { n, row } of rows) {
    const shas = String(row.commits || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const dup = shas.filter((s) => logged.has(s.slice(0, 7)));
    if (dup.length) hits.push({ n, dup });
  }
  return hits;
}

// --- write shape -----------------------------------------------------------------
export function buildProperties(row, { projectRow }) {
  if (!row.title || !String(row.title).trim()) throw new Error('row has no title');
  if (!TYPES.includes(row.type)) throw new Error(`invalid Type "${row.type}" (allowed: ${TYPES.join(' | ')})`);
  if (!IMPACTS.includes(row.impact)) throw new Error(`invalid Impact "${row.impact}" (allowed: ${IMPACTS.join(' | ')})`);
  if (!SECTIONS.includes(row.dashboardSection)) throw new Error(`invalid Dashboard Section "${row.dashboardSection}"`);
  if (!SOURCES.includes(row.source)) throw new Error(`invalid Source "${row.source}"`);
  const props = {
    Title: { title: [{ text: { content: String(row.title).slice(0, 2000) } }] },
    Type: { select: { name: row.type } },
    Impact: { select: { name: row.impact } },
    Source: { select: { name: row.source } },
    'Dashboard Section': { select: { name: row.dashboardSection } },
    'Published in Report': { checkbox: !!row.publishedInReport },
  };
  if (row.date) props.Date = { date: { start: row.date } };
  if (row.commits) props.Commits = { rich_text: [{ text: { content: String(row.commits) } }] };
  const rel = row.projectRelation || projectRow;
  if (rel) props.Project = { relation: [{ id: rel }] };
  return props;
}

// Gate 4. Says who decided, when, from what, and — critically — which machine guesses
// they corrected versus accepted. "Impact=Mid" accepted from a heuristic and "Impact=Mid"
// chosen by a human are not the same claim, and a weekly report built on the second is
// worth more than one built on the first.
export function buildProvenanceBlock({ approver, proposalId, baseHead, commits, corrected, inferredAccepted }) {
  const at = new Date().toISOString();
  const lines = [
    `Applied by ${approver} at ${at} from proposal ${proposalId} (base HEAD ${baseHead || 'unknown'}).`,
    commits ? `Derived from commits: ${commits}.` : 'No commits recorded.',
    corrected.length
      ? `Corrected before apply: ${corrected.map((c) => `${c.field} ${c.from} -> ${c.to}`).join('; ')}.`
      : 'No fields corrected.',
    inferredAccepted.length
      ? `Machine-inferred and accepted as-is (treat as weaker evidence): ${inferredAccepted.join(', ')}.`
      : 'No inferred fields accepted unreviewed.',
  ];
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: lines.join(' ') } }] },
  };
}

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7);
  } catch { return ''; }
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// --- main ------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proposal = loadProposal(args.proposal);
  const numbered = proposal.rows.map((row, i) => ({ n: i + 1, row }));

  if (args.list) {
    console.log(`\nProposal ${proposal.proposalId}  generated ${proposal.generatedAt}`);
    console.log(`Basis: watermark=${proposal.basis.watermark} head=${proposal.basis.headSha} trackerRows=${proposal.basis.trackerRowCount}\n`);
    for (const { n, row } of numbered) {
      console.log(`${String(n).padStart(2)}. [${row.date}] ${row.title}`);
      console.log(`    type=${row.type}${row.typeInferred ? '*' : ''} impact=${row.impact}${row.impactInferred ? '*' : ''} section=${row.dashboardSection} commits=${row.commits}`);
    }
    console.log('\n* = machine-inferred default. Correct it with --set <row>.<field>=<value> when applying.\n');
    return 0;
  }

  if (!args.approver.trim()) {
    throw new Refusal('--approver <name> is required: a row nobody is named on is a row nobody can be asked about.');
  }
  if (!args.rows) {
    throw new Refusal('--rows is required (there is no --all). Run with --list to see the rows and their numbers.');
  }
  const badRow = args.rows.find((n) => n > numbered.length);
  if (badRow) throw new Refusal(`row ${badRow} does not exist; proposal ${proposal.proposalId} has ${numbered.length} rows`);

  const badSet = args.sets.find((s) => !args.rows.includes(s.row));
  if (badSet) throw new Refusal(`--set targets row ${badSet.row}, which is not in --rows ${args.rows.join(',')}`);

  const selected = numbered.filter(({ n }) => args.rows.includes(n));

  // Gate 2 — re-read the world before writing to it.
  const { queryDataSource } = await import('../project-cards/lib/notion.mjs');
  const trackerRows = queryDataSource(TRACKER_DS, {});
  const now = {
    headSha: headSha(),
    trackerRowCount: trackerRows.length,
    watermark: newestRowDate(trackerRows),
  };
  const drift = checkFreshness(proposal.basis, now);
  if (drift.length && !args.dryRun) {
    throw new Refusal(
      `state moved since proposal ${proposal.proposalId} was generated:\n`
      + drift.map((d) => `  - ${d}`).join('\n')
      + '\n\nNothing was written. Re-run propose-rows.mjs and review the fresh proposal.',
    );
  }
  if (drift.length) console.log(`DRIFT (would refuse outside --dry-run):\n${drift.map((d) => `  - ${d}`).join('\n')}\n`);

  const dup = rowsAlreadyLogged(selected, loggedShas(trackerRows));
  if (dup.length) {
    throw new Refusal(
      'these selected rows carry commits the Tracker already records:\n'
      + dup.map((d) => `  - row ${d.n}: ${d.dup.join(', ')}`).join('\n')
      + '\n\nNothing was written. Re-run propose-rows.mjs; its SHA dedup will drop them.',
    );
  }

  const missing = [];
  for (const { n, row } of selected) {
    for (const sha of String(row.commits || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (!commitExists(sha)) missing.push(`row ${n}: ${sha}`);
    }
  }
  if (missing.length) {
    throw new Refusal(`proposal references commits this repo no longer has (rebased or wrong repo):\n  ${missing.join('\n  ')}`);
  }

  // Write, one row at a time, reporting each outcome.
  const { createPage, insertBlocksAfter } = await import('../project-cards/lib/notion.mjs');
  let applied = 0;
  const failures = [];
  for (const { n, row: raw } of selected) {
    const { row, corrected } = applySets(raw, args.sets.filter((s) => s.row === n));
    const correctedFields = new Set(corrected.map((c) => c.field));
    const inferredAccepted = [
      raw.typeInferred && !correctedFields.has('type') ? `Type=${row.type}` : null,
      raw.impactInferred && !correctedFields.has('impact') ? `Impact=${row.impact}` : null,
    ].filter(Boolean);

    let props;
    try {
      props = buildProperties(row, { projectRow: raw.projectRelation });
    } catch (e) {
      failures.push(`row ${n}: ${e.message}`);
      console.error(`  ${n}. REJECTED — ${e.message}`);
      continue;
    }

    const provenance = buildProvenanceBlock({
      approver: args.approver.trim(),
      proposalId: proposal.proposalId,
      baseHead: proposal.basis.headSha,
      commits: row.commits,
      corrected,
      inferredAccepted,
    });

    if (args.dryRun) {
      console.log(`  ${n}. WOULD CREATE  [${row.date}] ${row.title}`);
      console.log(`      Type=${row.type} Impact=${row.impact} Section=${row.dashboardSection} Source=${row.source} Commits=${row.commits}`);
      console.log(`      body: ${provenance.paragraph.rich_text[0].text.content}`);
      applied += 1;
      continue;
    }

    try {
      const page = createPage(TRACKER_DS, props);
      try {
        insertBlocksAfter(page.id, null, [provenance]);
      } catch (e) {
        // The row is the spine; its provenance note is not. Losing the note is a
        // traceability gap worth shouting about, not a reason to leave a half-written row.
        console.error(`  ${n}. WARN — row created (${page.id}) but provenance note failed: ${e.message}`);
      }
      applied += 1;
      console.log(`  ${n}. CREATED ${page.url || page.id}  [${row.date}] ${row.title}`);
    } catch (e) {
      failures.push(`row ${n}: ${e.message}`);
      console.error(`  ${n}. FAILED — ${e.message}`);
    }
  }

  console.log(`\n${args.dryRun ? 'DRY RUN — nothing written. ' : ''}${applied}/${selected.length} row(s) ${args.dryRun ? 'would be applied' : 'applied'} by ${args.approver.trim()}.`);
  if (failures.length) {
    console.error(`${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
    return 2;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof Refusal) {
        console.error(`\n[apply-rows] REFUSED: ${e.message}\n`);
        process.exit(1);
      }
      console.error(`[apply-rows] FATAL: ${e.message}`);
      process.exit(1);
    });
}
