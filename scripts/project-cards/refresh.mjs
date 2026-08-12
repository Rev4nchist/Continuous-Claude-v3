// refresh.mjs — CLI entry for the living project-card engine.
//   node refresh.mjs "<project name>"     refresh one card
//   node refresh.mjs --all                refresh every FourthOS Projects row
//
// Pipeline (per project): resolve row -> fetch Decisions & Outputs -> assemble
// HTML -> hash (AS_OF excluded) -> compare state -> write out/<slug>.html + emit
// a publish manifest. The engine NEVER calls the Notion MCP or claude -p; the
// /project-card skill consumes the manifest and does the one MCP embed-bind step.
//
// Filesystem paths, section headings, and state I/O come from the shared lib
// (config/util/state) so refresh.mjs and sweep.mjs agree on shape and decisions.
import { mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ntnVersion,
  queryProjects,
  getProjectByName,
  queryDecisionsForProject,
  title,
  richText,
  selectName,
  statusName,
  checkbox,
  urlVal,
  multiSelect,
  dateStart,
} from './lib/notion.mjs';
import { OUT_DIR, CARD_SECTION_HEADING } from './lib/config.mjs';
import { slugify, dateStamp } from './lib/util.mjs';
import { readState, writeState, needsPublish } from './lib/state.mjs';
import { readSeries, latestPrev } from './lib/history.mjs';
import { computeAttention, quantizeAttentionForHash } from './lib/attention.mjs';
import { assembleCard } from './assembler.mjs';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Extract a Notion page id from a URL, or null if it is not a Notion link.
function notionPageId(url) {
  if (!url || !/notion\.(so|com)/i.test(url)) return null;
  const m = url.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i)
    || url.match(/[0-9a-f]{32}/i);
  return m ? m[0].replace(/-/g, '') : null;
}

function normalizeProject(page) {
  const p = page.properties || {};
  return {
    rowId: page.id,
    name: title(p.Project),
    health: selectName(p.Health),
    currentFocus: richText(p['Current Focus']),
    nextMilestone: richText(p['Next Milestone']),
    decisionNeeded: checkbox(p['Decision Needed?']),
    latestUpdate: richText(p['Latest Update']),
    strategicBet: richText(p['Strategic Bet']),
    status: statusName(p.Status),
    sponsors: richText(p['Sponsors / Stakeholders']),
    projectPage: urlVal(p['Project Page']),
    lastEdited: page.last_edited_time,
    pillars: multiSelect(p.Pillar),
    outcomeTypes: multiSelect(p['Outcome Type']),
    reviewDate: dateStart(p['Review Date']),
    stats: [],
  };
}

function normalizeDecision(page) {
  const p = page.properties || {};
  return {
    output: title(p.Output),
    whyItMatters: richText(p['Why It Matters']),
    decisionFinding: richText(p['Decision / Finding']),
    nextStep: richText(p['Next Step']),
    impact: selectName(p.Impact),
    type: selectName(p.Type),
    status: statusName(p.Status),
    link: urlVal(p.Link),
    lastEdited: page.last_edited_time,
  };
}

// Resolve the stable slug/state-key for a project.
//   1. Reuse the existing slug if a card already tracks this projectRowId, so a
//      project keeps the same key (and output file) across runs — idempotent.
//   2. Otherwise mint a fresh slug with util.slugify's collision guard, so two
//      different projects whose names collapse to the same base never share a
//      slug. `assigned` accumulates slugs minted earlier in this same run so a
//      --all batch is internally collision-free too.
function resolveSlug(project, state, assigned) {
  for (const [slug, card] of Object.entries(state.cards)) {
    if (card && card.projectRowId === project.rowId) return slug;
  }
  const taken = new Set([...Object.keys(state.cards), ...assigned]);
  return slugify(project.name, taken);
}

// Atomic write for a card HTML file: temp file + rename (never a torn card).
function writeCard(htmlPath, html) {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${htmlPath}.tmp`;
  writeFileSync(tmp, html, 'utf8');
  renameSync(tmp, htmlPath);
}

// Refresh one project; mutate `state`; return a manifest object.
// `assigned` is the set of slugs already minted in this run (collision guard).
function refreshProject(projectPage, state, assigned) {
  const project = normalizeProject(projectPage);
  const decisions = queryDecisionsForProject(project.rowId, 5).map(normalizeDecision);
  const slug = resolveSlug(project, state, assigned);
  assigned.add(slug);

  // New signals (iter2): health trend + "needs attention" scoring. Read-only here —
  // sweep owns WRITING health history; refresh only READS the series it left behind.
  const series = readSeries(slug);
  const prevHealth = latestPrev(slug);
  // computeAttention takes already-extracted plain values; map our normalized field
  // names (lastEdited / reviewDate) onto the shape it documents (…ISO suffixes).
  const attention = {
    ...computeAttention(
      {
        health: project.health,
        decisionNeeded: project.decisionNeeded,
        lastEditedISO: project.lastEdited,
        reviewDateISO: project.reviewDate,
      },
      series,
    ),
    prevHealth, // the "was X" health from latestPrev, for a "was X, now Y" trend line
  };

  // Both assembler calls receive the SAME series + attention; they differ ONLY by the
  // volatile as-of stamp. That keeps the iter1 hash contract intact: the as-of stamp
  // is excluded from the content hash, while every meaningful signal the assembler
  // renders (stats / review / decision text, plus the new trend + attention state)
  // IS in the canonical string, so a genuine state change still re-publishes.
  const cardSignals = { series, attention };
  const html = assembleCard(project, decisions, { ...cardSignals, asOf: dateStamp() });
  // Canonical (hash) render QUANTIZES the day-counters (2026-08-04): staleDays/
  // reviewDays tick daily, and feeding them raw made every card flip changed=true
  // every morning — all 11 republished daily, blowing the sweep budget on
  // slow-spawn mornings. Bands (fresh/stale, later/due-soon/overdue) still flip
  // the hash; the displayed card above keeps exact day counts.
  const canonical = assembleCard(project, decisions, {
    series, attention: quantizeAttentionForHash(attention), asOf: '',
  });
  const contentHash = sha256(canonical);

  const nowIso = new Date().toISOString();
  const prev = state.cards[slug];
  const pageId = (prev && prev.pageId) || notionPageId(project.projectPage);
  const htmlPath = join(OUT_DIR, `${slug}.html`);

  // Shared publish decision (REL#1 self-heal): true when the card was never
  // published OR its publishedHash lags the freshly-computed contentHash — so a
  // card whose publish previously FAILED (publishedHash behind contentHash) is
  // re-flagged needsPublish even when the content itself did not change.
  const publish = needsPublish(prev, contentHash);

  // No-op when the canonical content is unchanged AND the card is already on disk.
  // Even here, `publish` re-flags an unpublished / publish-failed card.
  if (prev && prev.contentHash === contentHash && existsSync(htmlPath)) {
    state.cards[slug] = { ...prev, projectRowId: project.rowId, lastRefreshAttempt: nowIso };
    return {
      projectName: project.name, slug, pageId, htmlPath, contentHash,
      changed: false, needsPublish: publish, cardSectionHeading: CARD_SECTION_HEADING,
    };
  }

  writeCard(htmlPath, html);

  state.cards[slug] = {
    projectRowId: project.rowId,
    pageId: pageId || null,
    attachmentId: (prev && prev.attachmentId) || null,
    contentHash,
    // publishedHash only advances on a confirmed publish (state.recordPublish),
    // never at refresh — preserve the prior value so needsPublish stays honest.
    publishedHash: (prev && prev.publishedHash) || null,
    lastPublished: (prev && prev.lastPublished) || null,
    lastRefreshAttempt: nowIso,
  };

  return {
    projectName: project.name,
    slug,
    pageId: pageId || null,
    htmlPath,
    contentHash,
    changed: true,
    needsPublish: publish,
    cardSectionHeading: CARD_SECTION_HEADING,
  };
}

// Batch-refresh every roster page, ISOLATING a per-project failure (#8): one
// throwing project must not abort the whole `--all` batch and lose the state
// already computed for the projects processed before it. A failure is captured
// as a `{ projectName, error }` result row; every success still mutates `state`,
// and the caller ALWAYS persists `state` afterwards. `refreshFn` is injectable so
// the isolation contract is unit-testable without live Notion calls. Exported.
export function refreshAll(pages, state, assigned, refreshFn = refreshProject) {
  const results = [];
  for (const pg of pages) {
    const name = title(pg.properties?.Project);
    try {
      results.push(refreshFn(pg, state, assigned));
    } catch (e) {
      results.push({ projectName: name, error: e.message });
      console.error(`[refresh] project "${name || '(unnamed)'}" failed (batch continues): ${e.message}`);
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node refresh.mjs "<project name>" | --all');
    process.exit(2);
  }

  const version = ntnVersion();
  console.error(`ntn ${version}`); // human-facing contract log; stdout stays pure JSON

  const state = readState();
  const assigned = new Set(); // slugs minted this run — collision guard for --all
  let output;

  try {
    if (args[0] === '--all') {
      const pages = queryProjects();
      const results = refreshAll(pages, state, assigned);
      const failed = results.filter((r) => r && r.error).length;
      output = {
        ntnVersion: version, count: results.length, failed, results,
      };
    } else {
      const name = args.join(' ');
      const page = getProjectByName(name);
      const manifest = refreshProject(page, state, assigned);
      output = { ntnVersion: version, ...manifest };
    }
  } finally {
    // ALWAYS persist whatever state was computed — even if the single-project
    // path threw after some `--all` cards were already refreshed in a prior loop.
    writeState(state);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

// Only run the live pipeline when invoked directly (not when imported by tests),
// so refreshAll and the helpers stay importable without spawning ntn.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
