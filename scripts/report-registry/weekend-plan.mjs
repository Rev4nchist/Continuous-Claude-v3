// weekend-plan.mjs — the Weekend Fix Plan generator (v1, DELIBERATELY DETERMINISTIC).
//
// DAVE DECIDED 2026-08-04 (handoff 2026-08-04_08-53, decisions.weekend_fix_plan_design +
// ok_semantics_redefined):
//   * System Health's Status measures the PIPELINE, not the findings. OK = check ran
//     + mirror landed + this plan generated. Warn = partial chain. Failed = chain died.
//     The WARN/FAIL findings are the report's PAYLOAD and live in the summary string.
//   * This plan combines (a) health findings ranked by severity x chronicity
//     (FAIL > new WARN > chronic WARN) with (b) Self-Improvement research digests
//     tagged integration-ready (verdict ADOPT) vs needs-more-research. Item types:
//     fix (health finding alone), upgrade (research alone), fix-via-upgrade
//     (research that addresses a health finding).
//   * Generates Friday ~08:30 IN THE SAME CHAIN — scheduled-health-check.bat invokes
//     this right after the Notion mirror; no new scheduled task. v1 is a pure node
//     merge (no claude -p) — reliability first on this spawn-fragile machine.
//
// REGISTRY CONTRACT: the .bat pre-emits pessimistic Failed rows for BOTH types
// (System Health + Weekend Plan) with one shared --runDate before the python run.
// This module final-emits both rows IN-PROCESS via emit-run's emitRun() with the
// SAME --runDate, so each update lands on its pre-emit row (caller contract #6).
// If this module crashes, both pessimistic rows stand — "chain died" — which is
// exactly what the new semantics say they should.
//
// CLI:
//   node weekend-plan.mjs --period YYYY-MM-DD --runDate <ISO> --health-exit N --mirror-exit N
//     [--dry-run]   # print the plan + synthesized statuses; write and emit NOTHING
//
// ESM, no external deps. Reuses loadRuns (freshness-guarded health JSON reader),
// lib/notion.mjs section splice, and emit-run's in-process emitter.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { loadRuns } from './health-mirror.mjs';
import { emitRun } from './emit-run.mjs';
import { parseFlags } from './make-run.mjs';
import { replaceSectionBlocks } from '../project-cards/lib/notion.mjs';
import { REPORT_CHILD_PAGES, ROOT } from './config.mjs';

export const WEEKEND_PLAN_TYPE = 'Weekend Plan';
export const PLAN_HEADING = '## Plan';
export const WEEKEND_PLAN_PAGE_ID = REPORT_CHILD_PAGES[WEEKEND_PLAN_TYPE];
const PAGE_URL = `https://www.notion.so/${String(WEEKEND_PLAN_PAGE_ID || '').replace(/-/g, '')}`;
const DIGEST_PATH = join(ROOT, '..', '..', 'docs', 'self-improvement', 'PENDING-DIGEST.md');

// --- severity / ranking (pure) ---------------------------------------------------
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
export function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf(String(sev || '').toUpperCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

// --- health findings (pure) ------------------------------------------------------
// WARN/FAIL results from the (freshness-verified) health JSON, tagged with
// chronicity: a name also present in the PREVIOUS run's WARN/FAIL set is chronic;
// otherwise it is new this week (new outranks chronic per the design).
export function classifyFindings(json, previousWarnNames = new Set()) {
  return (json.results || [])
    .filter((r) => r.status === 'WARN' || r.status === 'FAIL')
    .map((r) => ({
      name: r.name,
      status: r.status,
      severity: String(r.severity || 'INFO').toUpperCase(),
      evidence: r.evidence || '',
      remediation: r.remediation || '',
      chronic: previousWarnNames.has(r.name),
    }));
}

// --- research digests (pure) -----------------------------------------------------
// Parse PENDING-DIGEST.md blocks (both this repo's deterministic append-digest.mjs
// shape and the older headless-written variants — same bullet fields throughout).
// integrationReady = verdict ADOPT (deterministic v1 tagging per the design);
// everything else (WATCH/SKIP/unknown) is needs-more-research and never enters
// the plan as an upgrade.
export function parseDigestQueue(content) {
  const out = [];
  const sections = String(content || '').split(/^## /m).slice(1);
  for (const s of sections) {
    const headingLine = s.split(/\r?\n/, 1)[0] || '';
    const hm = headingLine.match(/^(\d{4}-\d{2}-\d{2})\s*[—-]+\s*([\w-]+)\s*(?:\(([^)]*)\))?/);
    if (!hm) continue;
    const field = (label) => {
      const m = s.match(new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const verdict = field('Verdict').toUpperCase();
    const proposalMatch = field('Proposal').match(/`([^`]+)`/);
    out.push({
      date: hm[1],
      componentId: hm[2],
      name: hm[3] || hm[2],
      verdict,
      headline: field('Headline'),
      proposalPath: proposalMatch ? proposalMatch[1] : '',
      integrationReady: verdict === 'ADOPT',
    });
  }
  return out;
}

// --- component <-> check matching (pure, v1 heuristic) ---------------------------
// A research component "addresses" a health finding when any hyphen-part of the
// component id (>= 3 chars, singular-normalized) appears in the check name.
// e.g. hooks -> hook-orphans, skills -> skill-descriptions, cli-integration ->
// cli-qlty. Deliberately simple; misses are just typed fix + upgrade separately.
export function matchesFinding(componentId, findingName) {
  const name = String(findingName || '').toLowerCase();
  return String(componentId || '')
    .toLowerCase()
    .split('-')
    .map((p) => p.replace(/s$/, ''))
    .filter((p) => p.length >= 3)
    .some((p) => name.includes(p));
}

// --- plan assembly (pure) --------------------------------------------------------
// Ranking: FAIL > new WARN > chronic WARN (severity within each band), then
// upgrades (newest research first). fix-via-upgrade keeps its finding's rank band —
// it IS that finding, plus a ready-made research path to fix it.
export function buildPlan({ findings = [], research = [] }) {
  // Newest research first, one entry per component: a component researched twice
  // (e.g. a second pass) contributes its LATEST digest only — both for the
  // fix-via-upgrade pairing and for the upgrade list.
  const ready = [];
  const seen = new Set();
  for (const r of research.filter((x) => x.integrationReady)
    .sort((a, b) => b.date.localeCompare(a.date))) {
    if (!seen.has(r.componentId)) { seen.add(r.componentId); ready.push(r); }
  }
  const matchedComponents = new Set();
  const items = findings.map((f) => {
    const match = ready.find((r) => matchesFinding(r.componentId, f.name)) || null;
    if (match) matchedComponents.add(match.componentId);
    return {
      kind: match ? 'fix-via-upgrade' : 'fix',
      name: f.name,
      status: f.status,
      severity: f.severity,
      chronic: f.chronic,
      detail: f.remediation || f.evidence || '',
      research: match,
    };
  });
  const upgrades = ready
    .filter((r) => !matchedComponents.has(r.componentId))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => ({
      kind: 'upgrade',
      name: r.componentId,
      status: '',
      severity: '',
      chronic: false,
      detail: r.headline,
      research: r,
    }));
  const band = (it) => {
    if (it.kind === 'upgrade') return 3;
    if (it.status === 'FAIL') return 0;
    return it.chronic ? 2 : 1;
  };
  const sorted = [...items].sort((a, b) => (band(a) - band(b))
    || (severityRank(a.severity) - severityRank(b.severity))
    || a.name.localeCompare(b.name));
  return [...sorted, ...upgrades].map((it, i) => ({ rank: i + 1, ...it }));
}

// --- summaries + status synthesis (pure) -----------------------------------------
export function planCounts(plan) {
  const c = { fix: 0, 'fix-via-upgrade': 0, upgrade: 0 };
  for (const it of plan) c[it.kind] = (c[it.kind] || 0) + 1;
  return c;
}

// The findings are the PAYLOAD: they live here, in the summary string, not in Status.
export function systemHealthSummary(json, plan, { healthExit }) {
  const c = json.counts || {};
  const k = planCounts(plan);
  return `${(json.results || []).length} checks: ${c.PASS ?? 0} pass, ${c.WARN ?? 0} warn, `
    + `${c.FAIL ?? 0} fail (health exit=${healthExit}); plan: ${plan.length} items `
    + `(${k.fix} fix, ${k['fix-via-upgrade']} fix-via-upgrade, ${k.upgrade} upgrade)`;
}

// New OK semantics (Dave, 2026-08-04): OK = check ran (fresh JSON existed — the
// caller only reaches this with one) + mirror landed + plan generated. Warn =
// partial chain. The "chain died" Failed case never reaches this function: a
// missing/stale JSON throws in loadRuns and the pessimistic pre-emit rows stand.
export function synthesizeSystemHealthStatus({ mirrorExit, planWrote }) {
  if (mirrorExit === 0 && planWrote) return 'OK';
  return 'Warn';
}

// --- Notion blocks (pure) --------------------------------------------------------
const seg = (content, { link, bold } = {}) => {
  const o = { type: 'text', text: { content: String(content ?? '').slice(0, 2000) } };
  if (link && /^https?:\/\//i.test(link)) o.text.link = { url: link };
  if (bold) o.annotations = { bold: true };
  return o;
};
const cell = (...segs) => segs;

export function buildPlanBlocks(plan, { generatedAt = '', period = '' } = {}) {
  const intro = {
    type: 'paragraph',
    paragraph: {
      rich_text: [
        seg(`Generated ${generatedAt} for week ending ${period}. `, { bold: true }),
        seg(`${plan.length} item(s) — fix = health finding, upgrade = integration-ready research, `
          + 'fix-via-upgrade = research that addresses a live finding. Ranked FAIL > new WARN > chronic WARN > upgrades.'),
      ],
    },
  };
  if (plan.length === 0) {
    return [intro, {
      type: 'paragraph',
      paragraph: { rich_text: [seg('Nothing queued — no WARN/FAIL findings and no integration-ready research.')] },
    }];
  }
  const header = {
    type: 'table_row',
    table_row: {
      cells: [
        cell(seg('#', { bold: true })), cell(seg('Type', { bold: true })),
        cell(seg('Item', { bold: true })), cell(seg('Severity', { bold: true })),
        cell(seg('Chronicity', { bold: true })), cell(seg('Detail / research', { bold: true })),
      ],
    },
  };
  const rows = plan.map((it) => {
    const detail = [];
    if (it.detail) detail.push(seg(it.detail));
    if (it.research) {
      if (detail.length) detail.push(seg(' — '));
      detail.push(seg(`${it.research.componentId} (${it.research.date}): ${it.research.headline}`));
      if (it.research.proposalPath) detail.push(seg(` [${it.research.proposalPath}]`));
    }
    return {
      type: 'table_row',
      table_row: {
        cells: [
          cell(seg(String(it.rank))),
          cell(seg(it.kind, { bold: true })),
          cell(seg(it.name)),
          cell(seg(it.severity ? `${it.status} ${it.severity}` : '—')),
          cell(seg(it.kind === 'upgrade' ? '—' : (it.chronic ? 'chronic' : 'NEW'))),
          cell(...(detail.length ? detail : [seg('—')])),
        ],
      },
    };
  });
  return [intro, {
    type: 'table',
    table: { table_width: 6, has_column_header: true, has_row_header: false, children: [header, ...rows] },
  }];
}

// --- main ------------------------------------------------------------------------
function emitBoth({ period, runDate, shStatus, shSummary, wpStatus, wpSummary }) {
  // In-process emits (no child processes); distinct --out so neither masquerades
  // as another pipeline's emit file (emit-run caller contract #5).
  const results = [];
  for (const [type, status, summary, out] of [
    ['System Health', shStatus, shSummary, join(tmpdir(), 'report-run-Health-Check-final.json')],
    [WEEKEND_PLAN_TYPE, wpStatus, wpSummary, join(tmpdir(), 'report-run-Weekend-Plan.json')],
  ]) {
    try {
      const res = emitRun({
        type, period, runDate, status, source: 'Health-Check',
        artifactUrl: type === WEEKEND_PLAN_TYPE
          ? PAGE_URL
          : 'https://www.notion.so/innovativemusings/CCv3-Weekly-Health-Checks-34c76fd7ac8280a984afc486a9844290',
        summary, out,
      });
      console.error(`[weekend-plan] ${type}: registry ${res.action} (status=${status})`);
      results.push({ type, ok: true });
    } catch (e) {
      console.error(`[weekend-plan] ${type}: registry emit FAILED: ${e.message}`);
      results.push({ type, ok: false });
    }
  }
  return results;
}

export function main(argv = process.argv.slice(2)) {
  const f = parseFlags(argv);
  const dryRun = f['dry-run'] === true || f['dry-run'] === 'true';
  const period = f.period;
  const runDate = f.runDate;
  const healthExit = Number(f['health-exit'] ?? -1);
  const mirrorExit = Number(f['mirror-exit'] ?? -1);
  if (!period || !runDate) {
    console.error('usage: weekend-plan.mjs --period YYYY-MM-DD --runDate <ISO> --health-exit N --mirror-exit N [--dry-run]');
    return 1;
  }
  if (!WEEKEND_PLAN_PAGE_ID) {
    console.error('[weekend-plan] FATAL: no "Weekend Plan" entry in report-runs.ids.json childPages');
    return 1;
  }

  // 1) Health findings — loadRuns enforces freshness; a stale/missing JSON means
  // the check step died, i.e. the chain died: leave both pessimistic pre-emit rows
  // standing (with a sharper breadcrumb) and exit 1.
  let loaded;
  try {
    loaded = loadRuns();
  } catch (e) {
    console.error(`[weekend-plan] health JSON unusable: ${e.message}`);
    if (!dryRun) {
      emitBoth({
        period, runDate,
        shStatus: 'Failed', shSummary: `chain died before a usable health JSON existed (health exit=${healthExit}): ${e.message}`.slice(0, 1800),
        wpStatus: 'Failed', wpSummary: 'no plan generated - the health check produced no fresh JSON this run',
      });
    }
    return 1;
  }

  const findings = classifyFindings(loaded.json, loaded.previousWarnNames);
  const research = existsSync(DIGEST_PATH) ? parseDigestQueue(readFileSync(DIGEST_PATH, 'utf8')) : [];
  const plan = buildPlan({ findings, research });
  const generatedAt = new Date().toISOString();
  const blocks = buildPlanBlocks(plan, { generatedAt, period });

  if (dryRun) {
    console.log(`[dry-run] plan for ${period} — ${plan.length} item(s):`);
    for (const it of plan) {
      console.log(`  ${it.rank}. [${it.kind}] ${it.name}`
        + `${it.severity ? ` (${it.status} ${it.severity}${it.chronic ? ', chronic' : ', new'})` : ''}`
        + `${it.research ? ` <- ${it.research.componentId}@${it.research.date}` : ''}`);
    }
    console.log(`[dry-run] System Health summary: ${systemHealthSummary(loaded.json, plan, { healthExit })}`);
    return 0;
  }

  // 2) Write the plan section on the (job-owned) Weekend Fix Plan page.
  let planWrote = false;
  try {
    replaceSectionBlocks(WEEKEND_PLAN_PAGE_ID, PLAN_HEADING, blocks);
    console.error(`[weekend-plan] wrote "${PLAN_HEADING}" (${plan.length} item(s)) on ${WEEKEND_PLAN_PAGE_ID}`);
    planWrote = true;
  } catch (e) {
    console.error(`[weekend-plan] plan write FAILED: ${e.message}`);
  }

  // 3) Final registry emits — update both pre-emit rows in place.
  const shStatus = synthesizeSystemHealthStatus({ mirrorExit, planWrote });
  const k = planCounts(plan);
  const results = emitBoth({
    period, runDate,
    shStatus,
    shSummary: systemHealthSummary(loaded.json, plan, { healthExit })
      + (mirrorExit === 0 ? '' : `; mirror exit=${mirrorExit}`)
      + (planWrote ? '' : '; plan write FAILED'),
    wpStatus: planWrote ? 'OK' : 'Failed',
    wpSummary: planWrote
      ? `${plan.length} items queued (${k.fix} fix, ${k['fix-via-upgrade']} fix-via-upgrade, ${k.upgrade} upgrade) for the weekend`
      : 'plan generation succeeded but the Notion write failed; no plan published',
  });

  const allOk = planWrote && results.every((r) => r.ok);
  console.log(`weekend-plan: ${allOk ? 'OK' : 'PARTIAL'} items=${plan.length} systemHealth=${shStatus}`);
  return allOk ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[weekend-plan] FATAL: ${e.message}`);
    process.exit(1);
  }
}
