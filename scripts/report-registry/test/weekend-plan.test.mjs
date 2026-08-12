// weekend-plan.test.mjs — pure tests for the Weekend Fix Plan merge/ranking spine.
// Run: node --test "scripts/report-registry/test/*.test.mjs"  (explicit glob, never bare dir)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  severityRank, classifyFindings, parseDigestQueue, matchesFinding,
  buildPlan, planCounts, systemHealthSummary, synthesizeSystemHealthStatus,
  buildPlanBlocks,
} from '../weekend-plan.mjs';

// --- fixtures --------------------------------------------------------------------
const r = (name, status, severity, over = {}) => ({
  name, status, severity, evidence: `${name} evidence`, remediation: '', ...over,
});
const HEALTH = {
  counts: { PASS: 41, WARN: 3, FAIL: 1, SKIP: 2 },
  results: [
    r('docker-daemon-running', 'PASS', 'INFO'),
    r('claude-opc-dir-set', 'WARN', 'MEDIUM'),
    r('hook-orphans', 'WARN', 'LOW'),
    r('skill-descriptions', 'WARN', 'HIGH'),
    r('git-remote-sync', 'FAIL', 'MEDIUM'),
  ],
};
const DIGEST = `# header

---

## 2026-08-01 — skills (Skills System)

- **Date:** 2026-08-01
- **Verdict:** ADOPT
- **Headline:** Adopt an FP/FN-driven optimizer.
- **Proposal:** \`docs/self-improvement/proposals/2026-08-01-skills.md\`

---

## 2026-07-31 — doc-rag (Doc-RAG (PageIndex))

- **Date:** 2026-07-31
- **Verdict:** SKIP
- **Headline:** Do not build reasoning-tree RAG.
- **Proposal:** \`docs/self-improvement/proposals/2026-07-31-doc-rag.md\`

---

## 2026-08-03 — learning-loop (Self-Improvement / Learning Extraction)

- **Date:** 2026-08-03
- **Verdict:** ADOPT
- **Headline:** Close the loop.
- **Proposal:** \`docs/self-improvement/proposals/2026-08-03-learning-loop.md\`

---

*Queue clear above this line — no pending digests. Last sweep: X.*
`;

test('severityRank orders CRITICAL..INFO; unknown last', () => {
  assert.ok(severityRank('CRITICAL') < severityRank('HIGH'));
  assert.ok(severityRank('HIGH') < severityRank('MEDIUM'));
  assert.ok(severityRank('INFO') < severityRank('whatever'));
});

test('classifyFindings keeps WARN/FAIL only and tags chronicity from previous run', () => {
  const prev = new Set(['hook-orphans']);
  const f = classifyFindings(HEALTH, prev);
  assert.deepEqual(f.map((x) => x.name).sort(), ['claude-opc-dir-set', 'git-remote-sync', 'hook-orphans', 'skill-descriptions']);
  assert.equal(f.find((x) => x.name === 'hook-orphans').chronic, true);
  assert.equal(f.find((x) => x.name === 'claude-opc-dir-set').chronic, false);
});

test('parseDigestQueue reads blocks; ADOPT -> integrationReady, SKIP not', () => {
  const q = parseDigestQueue(DIGEST);
  assert.equal(q.length, 3);
  const skills = q.find((d) => d.componentId === 'skills');
  assert.equal(skills.integrationReady, true);
  assert.equal(skills.proposalPath, 'docs/self-improvement/proposals/2026-08-01-skills.md');
  assert.match(skills.headline, /optimizer/);
  assert.equal(q.find((d) => d.componentId === 'doc-rag').integrationReady, false);
});

test('matchesFinding: hyphen-part, singular-normalized, >=3 chars', () => {
  assert.equal(matchesFinding('skills', 'skill-descriptions'), true);
  assert.equal(matchesFinding('hooks', 'hook-orphans'), true);
  assert.equal(matchesFinding('cli-integration', 'cli-qlty'), true);
  assert.equal(matchesFinding('memory', 'skill-descriptions'), false);
});

test('buildPlan: FAIL > new WARN (severity order) > chronic WARN; upgrades last; fix-via-upgrade pairs research', () => {
  const findings = classifyFindings(HEALTH, new Set(['hook-orphans']));
  const research = parseDigestQueue(DIGEST);
  const plan = buildPlan({ findings, research });
  const kinds = plan.map((p) => `${p.rank}:${p.kind}:${p.name}`);
  // Band 0: FAIL git-remote-sync. Band 1 (new): skill-descriptions HIGH before
  // claude-opc-dir-set MEDIUM. Band 2 (chronic): hook-orphans. Then upgrades:
  // learning-loop (no matching finding). skills matched a finding -> NOT an upgrade.
  assert.deepEqual(kinds, [
    '1:fix:git-remote-sync',
    '2:fix-via-upgrade:skill-descriptions',
    '3:fix:claude-opc-dir-set',
    '4:fix:hook-orphans',
    '5:upgrade:learning-loop',
  ]);
  const fvu = plan.find((p) => p.kind === 'fix-via-upgrade');
  assert.equal(fvu.research.componentId, 'skills');
  assert.deepEqual(planCounts(plan), { fix: 3, 'fix-via-upgrade': 1, upgrade: 1 });
});

test('systemHealthSummary carries the findings as payload (counts + plan size)', () => {
  const plan = buildPlan({ findings: classifyFindings(HEALTH, new Set()), research: [] });
  const s = systemHealthSummary(HEALTH, plan, { healthExit: 1 });
  assert.match(s, /5 checks: 41 pass, 3 warn, 1 fail \(health exit=1\)/);
  assert.match(s, /plan: 4 items \(4 fix, 0 fix-via-upgrade, 0 upgrade\)/);
});

test('synthesizeSystemHealthStatus: OK only when mirror landed AND plan wrote', () => {
  assert.equal(synthesizeSystemHealthStatus({ mirrorExit: 0, planWrote: true }), 'OK');
  assert.equal(synthesizeSystemHealthStatus({ mirrorExit: 2, planWrote: true }), 'Warn');
  assert.equal(synthesizeSystemHealthStatus({ mirrorExit: 0, planWrote: false }), 'Warn');
});

test('buildPlanBlocks: table with header + one row per item; empty plan -> no table', () => {
  const plan = buildPlan({ findings: classifyFindings(HEALTH, new Set()), research: [] });
  const blocks = buildPlanBlocks(plan, { generatedAt: 'T', period: '2026-08-07' });
  const table = blocks.find((b) => b.type === 'table');
  assert.equal(table.table.table_width, 6);
  assert.equal(table.table.children.length, 1 + plan.length);
  const empty = buildPlanBlocks([], { generatedAt: 'T', period: 'P' });
  assert.equal(empty.find((b) => b.type === 'table'), undefined);
  assert.match(empty[1].paragraph.rich_text[0].text.content, /Nothing queued/);
});

test('buildPlan: newest research per component wins pairing; repeat components dedup to one upgrade', () => {
  const findings = [{ name: 'skill-descriptions', status: 'WARN', severity: 'LOW', chronic: false, evidence: '', remediation: '' }];
  const research = [
    { date: '2026-07-20', componentId: 'skills', name: 'Skills', verdict: 'ADOPT', headline: 'old', proposalPath: '', integrationReady: true },
    { date: '2026-08-01', componentId: 'skills', name: 'Skills', verdict: 'ADOPT', headline: 'new', proposalPath: '', integrationReady: true },
    { date: '2026-07-23', componentId: 'coordination', name: 'C', verdict: 'ADOPT', headline: 'old c', proposalPath: '', integrationReady: true },
    { date: '2026-08-04', componentId: 'coordination', name: 'C', verdict: 'ADOPT', headline: 'new c', proposalPath: '', integrationReady: true },
  ];
  const plan = buildPlan({ findings, research });
  const fvu = plan.find((p) => p.kind === 'fix-via-upgrade');
  assert.equal(fvu.research.date, '2026-08-01');
  const upgrades = plan.filter((p) => p.kind === 'upgrade');
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].research.date, '2026-08-04');
});
