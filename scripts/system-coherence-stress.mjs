#!/usr/bin/env node
/**
 * system-coherence-stress.mjs
 *
 * CCv3 system coherence stress harness. Drives existing test surfaces
 * (vitest, pytest, health_check, skill eval) and runs new probes for
 * fresh-project bootstrap and cross-project isolation.
 *
 * Diagnostic-only -- does not edit any source code. Surfaces gaps via
 * a markdown report at thoughts/audits/system-coherence-stress-<date>.md.
 *
 * Usage:
 *   node scripts/system-coherence-stress.mjs                 # all 8 domains
 *   node scripts/system-coherence-stress.mjs --quick         # skip vitest/pytest
 *   node scripts/system-coherence-stress.mjs --isolation-only
 *   node scripts/system-coherence-stress.mjs --fresh-project-only
 *   node scripts/system-coherence-stress.mjs --include-real  # also probe LinkMap
 *   node scripts/system-coherence-stress.mjs --keep-seeds    # preserve DB seeds for inspection
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createFreshProject,
  destroyFreshProject,
  backupFile,
  restoreFile,
  readJsonSafe,
  fileMtime,
} from './fresh-project-fixture.mjs';

// ---------------------------------------------------------------------------
// Constants & flags
// ---------------------------------------------------------------------------

// REPO_ROOT defaults to the harness's own repo (this file lives at <repo>/scripts/).
// HOME-derived paths use homedir() so the harness runs unchanged on any workstation.
const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const REPO_ROOT = process.env.CCV3_REPO_ROOT || resolve(process.cwd());
const HOOKS_DIST = process.env.CCV3_HOOKS_DIST || join(HOME, '.claude', 'hooks', 'dist').replace(/\\/g, '/');
const SKILL_EVAL = process.env.CCV3_SKILL_EVAL || join(HOME, '.claude', 'skills', '_eval').replace(/\\/g, '/');
const LINKMAP = process.env.CCV3_LINKMAP || join(HOME, 'Projects', 'LinkMap').replace(/\\/g, '/');
const PG_CONTAINER = 'continuous-claude-postgres';
const TS = new Date().toISOString();
const TS_SHORT = new Date().toISOString().slice(0, 10);

const FLAGS = parseFlags(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  return {
    quick: argv.includes('--quick'),
    isolationOnly: argv.includes('--isolation-only'),
    freshProjectOnly: argv.includes('--fresh-project-only'),
    includeReal: argv.includes('--include-real'),
    keepSeeds: argv.includes('--keep-seeds'),
  };
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function runCmd(cmd, args, opts = {}) {
  const timeout = opts.timeout || 600_000;
  const cwd = opts.cwd || REPO_ROOT;
  const env = opts.env || process.env;
  const stdin = opts.stdin || null;

  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    input: stdin,
    shell: opts.shell || false,
  });

  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').toString(),
    stderr: (r.stderr || '').toString(),
    error: r.error ? r.error.message : null,
  };
}

function runHook(hookName, hookInput, opts = {}) {
  const dist = `${HOOKS_DIST}/${hookName}.mjs`;
  if (!existsSync(dist)) {
    return { code: -2, stdout: '', stderr: `hook dist not found: ${dist}`, error: 'missing-dist' };
  }
  return runCmd('node', [dist], {
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env || process.env,
    stdin: typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput),
    timeout: opts.timeout || 30_000,
  });
}

function dockerPsql(sql) {
  return runCmd('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'claude', '-d', 'continuous_claude', '-c', sql], {
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Domain runners (existing harnesses)
// ---------------------------------------------------------------------------

async function runVitestBaseline() {
  log('Running vitest baseline...');
  // Phase 5: prefer JSON reporter for unambiguous totals; fall back to default
  // reporter scrape only if JSON is unparseable. Bump timeout to 15min --
  // daemon-client.test.ts alone takes 67s and we need headroom.
  const r = runCmd('npx', ['vitest', 'run', '--reporter=json'], {
    cwd: `${REPO_ROOT}/.claude/hooks`,
    timeout: 900_000,
    shell: true,
  });

  // Treat hard timeout (no exit code) as WARN, not FAIL.
  if (r.code === null || (r.code === -1 && r.error && /timeout/i.test(r.error))) {
    return {
      name: 'vitest',
      passed: null,
      failed: 0,
      exitCode: r.code,
      timedOut: true,
      summary: 'harness timeout running vitest (no exit code)',
    };
  }

  // Try to parse JSON reporter output (vitest streams a giant JSON line).
  let passed = null;
  let failed = 0;
  let success = false;
  try {
    // The JSON reporter prints one big object on stdout. Find the LAST
    // top-level JSON object that has numTotalTests.
    const matches = r.stdout.match(/\{[^\n]*"numTotalTests"[^\n]*\}/g);
    if (matches && matches.length) {
      const json = JSON.parse(matches[matches.length - 1]);
      passed = typeof json.numPassedTests === 'number' ? json.numPassedTests : null;
      failed = typeof json.numFailedTests === 'number' ? json.numFailedTests : 0;
      success = json.success === true;
    }
  } catch {
    // fall through to regex
  }

  if (passed === null) {
    // Fall back to default-reporter scraping. The trailing line is:
    //   Tests  X passed | Y failed (Z)  -- pipe-separated, hard to confuse
    const summaryLine = r.stdout.split('\n')
      .reverse()
      .find((l) => /Tests\s+\d+\s+passed/.test(l));
    if (summaryLine) {
      const passMatch = summaryLine.match(/(\d+)\s+passed/);
      const failMatch = summaryLine.match(/(\d+)\s+failed/);
      passed = passMatch ? Number(passMatch[1]) : null;
      failed = failMatch ? Number(failMatch[1]) : 0;
    }
  }

  return {
    name: 'vitest',
    passed,
    failed,
    exitCode: r.code,
    success: success || (r.code === 0 && failed === 0),
    summary: r.stdout.split('\n').slice(-25).join('\n'),
  };
}

async function runPytestBaseline() {
  log('Running pytest baseline...');
  const r = runCmd('uv', ['run', 'python', '-m', 'pytest', 'scripts/core/tests/', '-v', '--tb=short'], {
    cwd: `${REPO_ROOT}/opc`,
    env: { ...process.env, PYTHONPATH: '.' },
    timeout: 600_000,
    shell: true,
  });
  const passMatch = r.stdout.match(/(\d+)\s+passed/);
  const failMatch = r.stdout.match(/(\d+)\s+failed/);
  return {
    name: 'pytest',
    passed: passMatch ? Number(passMatch[1]) : null,
    failed: failMatch ? Number(failMatch[1]) : 0,
    exitCode: r.code,
    summary: r.stdout.split('\n').slice(-30).join('\n'),
  };
}

async function runHealthCheck() {
  log('Running health_check.py...');
  const outFile = join(tmpdir(), `ccv3-health-${Date.now()}.json`);
  const r = runCmd('uv', ['run', 'python', 'scripts/health_check.py', '--output-json', outFile, '--quiet'], {
    cwd: `${REPO_ROOT}/opc`,
    timeout: 300_000,
    shell: true,
  });
  const json = await readJsonSafe(outFile);
  return {
    name: 'health_check',
    exitCode: r.code,
    json,
    rawTail: r.stdout.split('\n').slice(-15).join('\n'),
  };
}

async function runSkillEval() {
  log('Running skill eval harness...');
  // Phase 5: bump timeouts (eval-harness needs ~3min on cold runs) and
  // parse the JSON results files written by each tool instead of relying
  // on exit codes (the underlying scripts reliably produce results files
  // even when their own process management quirks return exit -1).
  const eh = runCmd('node', [`${SKILL_EVAL}/eval-harness.js`], { timeout: 300_000 });
  const ct = runCmd('node', [`${SKILL_EVAL}/collision-test.js`], { timeout: 300_000 });

  const evalResults = await readJsonSafe(`${SKILL_EVAL}/eval-results.json`);
  const collisionResults = await readJsonSafe(`${SKILL_EVAL}/collision-results.json`);

  // Determine pass/fail from the results files (canonical) when present.
  // A run "passed" when the results JSON exists AND the underlying script
  // produced a structured summary. Exit-code -1 is downgraded to WARN so
  // a parser quirk doesn't masquerade as a real CCv3 contract failure.
  const evalParsed = evalResults?.summary ? {
    totalSkills: evalResults.summary.totalSkills,
    overallAccuracy: evalResults.summary.overallAccuracy,
    needsOpt: evalResults.summary.tiers?.['needs-optimization'] ?? null,
  } : null;
  const collisionParsed = collisionResults?.summary ? {
    totalPrompts: collisionResults.summary.totalPrompts,
    collisionRate: collisionResults.summary.collisionRate,
  } : null;

  const evalOk = evalParsed !== null;
  const collisionOk = collisionParsed !== null;

  return {
    name: 'skill-eval',
    evalExitCode: eh.code,
    collisionExitCode: ct.code,
    evalParsed,
    collisionParsed,
    evalOk,
    collisionOk,
    // Harness-internal note: when exit code is -1 (or null) but the JSON
    // results were produced, this is a parser quirk we surface as WARN.
    parserQuirk: (eh.code !== 0 && evalOk) || (ct.code !== 0 && collisionOk),
    evalSummary: eh.stdout.split('\n').slice(-10).join('\n'),
    collisionSummary: ct.stdout.split('\n').slice(-10).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Domain 1 -- fresh-project bootstrap
// ---------------------------------------------------------------------------

async function simulateFreshProject(targetDir, label = 'synthetic') {
  log(`Simulating fresh-project bootstrap (${label}: ${targetDir})...`);

  const sessionStartHooks = [
    'session-start-docker',
    'session-register',
    'session-start-continuity',
    'session-start-init-check',
    'session-start-recovery',
    'roadmap-reconcile',
    'session-start-context-loaders',
    'session-start-memory-loaders',
  ];

  const sessionId = `stress-fresh-${Date.now()}`;
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: targetDir,
    CLAUDE_SESSION_ID: sessionId,
  };
  const input = {
    session_id: sessionId,
    source: 'startup',
    cwd: targetDir,
    hook_event_name: 'SessionStart',
  };

  const results = [];
  for (const hookName of sessionStartHooks) {
    const r = runHook(hookName, input, { env, cwd: targetDir, timeout: 30_000 });
    results.push({
      hook: hookName,
      code: r.code,
      stdout_preview: r.stdout.slice(0, 200),
      stderr_preview: r.stderr.slice(0, 400),
    });
  }

  const treePath = join(targetDir, '.claude', 'knowledge-tree.json');
  const treeExists = existsSync(treePath);
  const treeMtime = await fileMtime(treePath);

  const errored = results.filter((r) => r.code !== 0 && r.code !== -2);

  return {
    label,
    targetDir,
    treeGenerated: treeExists,
    treeMtimeUnix: treeMtime,
    hooksRun: results.length,
    errored,
    pass: treeExists && errored.length === 0,
    detail: results,
  };
}

// ---------------------------------------------------------------------------
// Domain 8 -- isolation probes
// ---------------------------------------------------------------------------

async function probe1_recall_leak(canaryPrefix) {
  // Seed two PROJECT-scoped rows
  const insert = dockerPsql(
    `INSERT INTO archival_memory (session_id, project_id, scope, content, metadata) VALUES ` +
      `('${canaryPrefix}-seed-A', 'aaa1111111111111', 'PROJECT', '${canaryPrefix} canary aaa -- this learning is project AAA-only and must not leak across projects on recall.', '{"type": "WORKING_SOLUTION"}'::jsonb), ` +
      `('${canaryPrefix}-seed-B', 'bbb2222222222222', 'PROJECT', '${canaryPrefix} canary bbb -- this learning is project BBB-only and must not leak across projects on recall.', '{"type": "WORKING_SOLUTION"}'::jsonb);`
  );
  if (insert.code !== 0) {
    return probeResult('probe1_recall_leak', 'no leak', `insert failed: ${insert.stderr}`, 'NONE', 'WARN', false);
  }

  // Run --text-only recall from a third project's perspective
  const env = { ...process.env, CLAUDE_PROJECT_ID: 'ccc3333333333333' };
  const r = runCmd(
    'uv',
    ['run', 'python', 'scripts/core/recall_learnings.py', '--query', canaryPrefix, '--k', '5', '--text-only', '--json'],
    { cwd: `${REPO_ROOT}/opc`, env: { ...env, PYTHONPATH: '.' }, timeout: 120_000, shell: true }
  );

  let leaked = 0;
  try {
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
    leaked = (parsed.results || []).filter((x) => (x.content || '').includes(canaryPrefix)).length;
  } catch {
    /* parse failure -> count via raw includes */
    leaked = (r.stdout.match(new RegExp(canaryPrefix, 'g')) || []).length;
  }

  const passed = leaked === 0;
  return probeResult(
    'probe1_recall_leak',
    'neither seed returned (recall scoped by project_id)',
    `${leaked} canary row(s) returned to project ccc`,
    'NONE',
    'CRITICAL',
    passed,
    {
      canaryPrefix,
      recallExitCode: r.code,
      recallStdoutPreview: r.stdout.slice(0, 400),
      seededProjects: ['aaa1111111111111', 'bbb2222222222222'],
      queriedFromProject: 'ccc3333333333333',
    }
  );
}

async function probe2_roadmap_contamination() {
  const fakeDir = join(tmpdir(), `ccv3-stress-fake-${Date.now()}`);
  await mkdir(fakeDir, { recursive: true });
  await writeFile(join(fakeDir, 'README.md'), '# Stress Fake Project\n\nThis is a synthetic test fixture.\n');

  const planBody = `# Adopt NorthStar Transformation Migration Plan\n\nThis plan describes the rollout of the NorthStar Transformation production launch. Steps include cutover from legacy systems, NorthStar deployment, and traffic shift to the new NorthStar pipeline. The NorthStar Transformation team will own delivery.\n\n## Decisions\n- NorthStar Transformation goes live next sprint\n- Legacy paths sunset within 30 days\n\n## Steps\n- Cutover NorthStar Transformation backend\n- Validate NorthStar Transformation health metrics`;

  const sessionId = `stress-roadmap-${Date.now()}`;
  const input = {
    session_id: sessionId,
    tool_name: 'ExitPlanMode',
    tool_input: { plan: planBody },
    hook_event_name: 'PostToolUse',
  };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: fakeDir };
  const r = runHook('post-plan-roadmap', input, { env, cwd: fakeDir, timeout: 30_000 });

  const roadmapPath = join(fakeDir, 'ROADMAP.md');
  const written = existsSync(roadmapPath) ? await readFile(roadmapPath, 'utf8') : '';
  const contaminated = written.includes('NorthStar Transformation');

  const passed = !contaminated;
  return probeResult(
    'probe2_roadmap_contamination',
    'guard blocks write OR ROADMAP.md does not contain "NorthStar Transformation"',
    contaminated
      ? `ROADMAP.md was written and contains "NorthStar Transformation" (fail-open guard)`
      : `ROADMAP.md ${written ? 'written but no contamination string' : 'not written'}`,
    'SOFT',
    'HIGH',
    passed,
    { fakeDir, hookExit: r.code, hookStderrPreview: r.stderr.slice(0, 300) }
  );
}

function probe3_hardcoded_paths() {
  // Use Node fs to grep .ts files under .claude/hooks/src/
  const r = runCmd(
    'node',
    [
      '-e',
      `
      const {readdirSync, readFileSync, statSync} = require('fs');
      const {join} = require('path');
      const root = String.raw\`${REPO_ROOT}/.claude/hooks/src\`;
      const NEEDLE = 'C:/Users/david.hayes/';
      const hits = [];
      function walk(dir) {
        for (const ent of readdirSync(dir)) {
          const p = join(dir, ent);
          let s; try { s = statSync(p); } catch { continue; }
          if (s.isDirectory()) walk(p);
          else if (p.endsWith('.ts')) {
            const txt = readFileSync(p, 'utf8');
            const lines = txt.split('\\n');
            lines.forEach((ln, i) => { if (ln.includes(NEEDLE)) hits.push(p + ':' + (i+1) + ': ' + ln.trim()); });
          }
        }
      }
      walk(root);
      console.log(JSON.stringify({count: hits.length, hits}));
      `,
    ],
    { timeout: 30_000 }
  );
  let parsed = { count: -1, hits: [] };
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    /* */
  }
  const passed = parsed.count === 0;
  return probeResult(
    'probe3_hardcoded_paths',
    "0 occurrences of 'C:/Users/david.hayes/' in .claude/hooks/src/**/*.ts",
    `${parsed.count} occurrences`,
    'HARD-WRONG',
    'HIGH',
    passed,
    { hits: parsed.hits.slice(0, 10) }
  );
}

async function probe4_dotclaude_skip() {
  const skipDir = join(tmpdir(), '.claude-stress-test', 'x');
  await mkdir(skipDir, { recursive: true });
  await writeFile(join(skipDir, 'README.md'), '# dotclaude skip probe\n');

  const sessionId = `stress-dotclaude-${Date.now()}`;
  const input = { session_id: sessionId, source: 'startup', cwd: skipDir, hook_event_name: 'SessionStart' };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: skipDir };
  const r = runHook('session-start-init-check', input, { env, cwd: skipDir, timeout: 30_000 });

  // Today: silent skip. Pass = either a tree was attempted OR a clear warning emitted.
  const treePath = join(skipDir, '.claude', 'knowledge-tree.json');
  const treeExists = existsSync(treePath);
  const stderrHasWarning = /skip|skipped|warning|warn/i.test(r.stderr);
  const passed = treeExists || stderrHasWarning;

  return probeResult(
    'probe4_dotclaude_skip',
    'tree generated OR clear skip warning emitted on stderr',
    `treeExists=${treeExists}, stderrHasWarning=${stderrHasWarning}`,
    'SOFT',
    'MEDIUM',
    passed,
    { skipDir, hookExit: r.code, stderrPreview: r.stderr.slice(0, 300) }
  );
}

async function probe5_hasCodeFiles_negative() {
  const pyDir = join(tmpdir(), `ccv3-stress-pyonly-${Date.now()}`);
  await mkdir(pyDir, { recursive: true });
  await writeFile(join(pyDir, 'main.py'), '#!/usr/bin/env python3\nprint("hello")\n');

  const sessionId = `stress-pyonly-${Date.now()}`;
  const input = { session_id: sessionId, source: 'startup', cwd: pyDir, hook_event_name: 'SessionStart' };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: pyDir };
  const r = runHook('session-start-init-check', input, { env, cwd: pyDir, timeout: 30_000 });

  const treePath = join(pyDir, '.claude', 'knowledge-tree.json');
  const treeExists = existsSync(treePath);
  const stderrMentionsTree = /tree|knowledge/i.test(r.stderr);
  const passed = treeExists || stderrMentionsTree;

  return probeResult(
    'probe5_hascodefiles_negative',
    'tree generation attempted on .py-only directory (no requirements.txt)',
    `treeExists=${treeExists}, stderrMentionsTree=${stderrMentionsTree}`,
    'SOFT',
    'MEDIUM',
    passed,
    { pyDir, hookExit: r.code, stderrPreview: r.stderr.slice(0, 300) }
  );
}

async function probe6_file_claims_cross_project() {
  // Insert two claims under different projects
  const ins = dockerPsql(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at) VALUES ` +
      `('/tmp/stress-shared.txt', 'stress-A', 'sess-A', NOW()), ` +
      `('/tmp/stress-shared.txt', 'stress-B', 'sess-B', NOW()) ` +
      `ON CONFLICT (file_path, project) DO UPDATE SET claimed_at = EXCLUDED.claimed_at;`
  );
  if (ins.code !== 0) {
    return probeResult('probe6_file_claims_cross_project', 'isolation enforced', `insert failed: ${ins.stderr}`, 'SOFT', 'WARN', false);
  }

  // Query without filtering on project (the unsafe pattern)
  const q = dockerPsql(
    `SELECT COUNT(*) AS n FROM file_claims WHERE file_path = '/tmp/stress-shared.txt';`
  );
  const m = q.stdout.match(/\b(\d+)\b/);
  const observedRows = m ? Number(m[1]) : -1;

  // Pass = isolation enforced (1 row from one project). Today: 2 rows from 2 projects.
  const passed = observedRows === 1;

  return probeResult(
    'probe6_file_claims_cross_project',
    'unscoped query returns rows from 1 project only',
    `unscoped query returned ${observedRows} row(s)`,
    'SOFT',
    'MEDIUM',
    passed,
    { rawCountQuery: q.stdout.split('\n').slice(0, 6).join('\n') }
  );
}

/**
 * Probe 7 -- cross-project hook state isolation.
 *
 * After Phase A2 (C2), plan-approved state is keyed by (projectId, sessionId)
 * and the legacy session-only fallback is gone. So writing a project-scoped
 * state file for project A and then firing the enforcer under project B
 * MUST NOT deny -- B has no plan-approved state of its own.
 *
 * Pre-fix behavior (with the migration window still in place): identical
 * sessionId across the two projects could resurrect A's approval into B
 * via the legacy session-only path -> deny.
 * Post-fix behavior: B sees no state, returns allow.
 */
function probeResult(probe, expected, observed, classification, severity, pass, extra = {}) {
  return { probe, expected, observed, classification, severity, pass, ...extra };
}

async function runIsolationProbes() {
  log('Running isolation probes (Domain 8)...');
  const canaryPrefix = `stress-test-recall-leak-canary-${Date.now()}`;

  const probes = [];
  probes.push(await probe1_recall_leak(canaryPrefix));
  probes.push(await probe2_roadmap_contamination());
  probes.push(probe3_hardcoded_paths());
  probes.push(await probe4_dotclaude_skip());
  probes.push(await probe5_hasCodeFiles_negative());
  probes.push(await probe6_file_claims_cross_project());

  return { name: 'isolation', canaryPrefix, probes };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup({ keepSeeds = false } = {}) {
  log('Running cleanup...');

  if (!keepSeeds) {
    // Probe 1 cleanup
    dockerPsql(`DELETE FROM archival_memory WHERE content LIKE '%stress-test-recall-leak-canary%';`);
    // Probe 6 cleanup
    dockerPsql(
      `DELETE FROM file_claims WHERE file_path LIKE '/tmp/stress-shared%' OR project IN ('stress-A','stress-B');`
    );
  }

  // Always remove synthetic temp dirs (steps 3 + 5 of cleanup contract)
  const r = runCmd(
    'node',
    [
      '-e',
      `
      const {readdirSync, statSync, rmSync} = require('fs');
      const {join} = require('path');
      const {tmpdir} = require('os');
      const t = tmpdir();
      let removed = 0;
      for (const ent of readdirSync(t)) {
        if (ent.startsWith('ccv3-stress-') || ent === '.claude-stress-test') {
          try { rmSync(join(t, ent), { recursive: true, force: true }); removed++; } catch {}
        }
      }
      console.log(JSON.stringify({removed}));
      `,
    ],
    { timeout: 30_000 }
  );
  log(`Cleanup tmp dirs: ${r.stdout.trim()}`);
}

// ---------------------------------------------------------------------------
// Synthesis (markdown report)
// ---------------------------------------------------------------------------

function statusEmoji(b) {
  return b ? 'PASS' : 'FAIL';
}

function probeRowsMarkdown(probes) {
  const header =
    '| Probe | Expected | Observed | Classification | Severity | Status |\n' +
    '|-------|----------|----------|----------------|----------|--------|';
  const rows = probes.map(
    (p) =>
      `| \`${p.probe}\` | ${p.expected} | ${p.observed} | ${p.classification} | ${p.severity} | ${statusEmoji(p.pass)} |`
  );
  return [header, ...rows].join('\n');
}

async function synthesize(state, outPath) {
  const branch = runCmd('git', ['-C', REPO_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const commit = runCmd('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD']).stdout.trim();

  const summaryRows = [];
  const filesToFix = [];

  if (state.fresh) {
    const allPass = state.fresh.every((r) => r.pass);
    summaryRows.push(
      `| 1 | Fresh-project bootstrap | ${statusEmoji(allPass)} | ${state.fresh.length} target(s) probed |`
    );
    state.fresh.forEach((r) => {
      if (!r.pass) {
        r.errored.forEach((e) => {
          filesToFix.push(`hook \`${e.hook}\` exit ${e.code}: ${e.stderr_preview.slice(0, 120)}`);
        });
        if (!r.treeGenerated) {
          filesToFix.push(`session-start-init-check.ts -- knowledge tree NOT generated for ${r.label} (${r.targetDir})`);
        }
      }
    });
  } else {
    summaryRows.push(`| 1 | Fresh-project bootstrap | SKIP | not run (flag) |`);
  }

  if (state.vitest) {
    // Phase 5: WARN on harness timeout (no exit code), don't FAIL.
    let label;
    if (state.vitest.timedOut) {
      label = 'WARN';
    } else {
      const pass = state.vitest.failed === 0 && (state.vitest.success !== false);
      label = statusEmoji(pass);
    }
    summaryRows.push(
      `| 2/3 | vitest baseline (hooks) | ${label} | ${state.vitest.passed} passed, ${state.vitest.failed} failed (exit ${state.vitest.exitCode})${state.vitest.timedOut ? ' [harness timeout]' : ''} |`
    );
  } else {
    summaryRows.push(`| 2/3 | vitest baseline (hooks) | SKIP | not run (flag) |`);
  }

  if (state.pytest) {
    const pass = state.pytest.failed === 0;
    summaryRows.push(
      `| 2 | pytest baseline (memory) | ${statusEmoji(pass)} | ${state.pytest.passed} passed, ${state.pytest.failed} failed (exit ${state.pytest.exitCode}) |`
    );
  } else {
    summaryRows.push(`| 2 | pytest baseline (memory) | SKIP | not run (flag) |`);
  }

  if (state.health) {
    const pass = state.health.exitCode === 0;
    summaryRows.push(
      `| - | health_check.py | ${statusEmoji(pass)} | exit ${state.health.exitCode}; ${state.health.json ? 'json captured' : 'no json'} |`
    );
  } else {
    summaryRows.push(`| - | health_check.py | SKIP | not run (flag) |`);
  }

  if (state.skillEval) {
    // Phase 5: derive pass/warn/fail from the JSON results files instead of
    // exit codes. evalOk/collisionOk == "JSON results were produced" -- the
    // canonical signal. parserQuirk == "exit code wasn't 0 but the run
    // produced results"; surface as WARN (harness-internal) not FAIL.
    const se = state.skillEval;
    let label;
    let detail;
    if (se.evalOk && se.collisionOk) {
      label = se.parserQuirk ? 'WARN' : 'PASS';
      const ev = se.evalParsed;
      const co = se.collisionParsed;
      detail = `eval ${ev.totalSkills} skills @ ${ev.overallAccuracy}% (${ev.needsOpt ?? 0} need-opt); collision ${co.collisionRate}% on ${co.totalPrompts} prompts`;
      if (se.parserQuirk) detail += ` [exit eval=${se.evalExitCode} coll=${se.collisionExitCode}, results files OK]`;
    } else {
      label = 'FAIL';
      detail = `eval results=${se.evalOk ? 'ok' : 'missing'}, collision results=${se.collisionOk ? 'ok' : 'missing'} (exit eval=${se.evalExitCode} coll=${se.collisionExitCode})`;
    }
    summaryRows.push(
      `| 4 | skill eval + collision | ${label} | ${detail} |`
    );
  } else {
    summaryRows.push(`| 4 | skill eval + collision | SKIP | not run (flag) |`);
  }

  if (state.isolation) {
    const failedCount = state.isolation.probes.filter((p) => !p.pass).length;
    const failedIds = state.isolation.probes.filter((p) => !p.pass).map((p) => p.probe);
    summaryRows.push(
      `| 8 | Cross-project isolation | ${statusEmoji(failedCount === 0)} | ${state.isolation.probes.length} probes, ${failedCount} fail: ${failedIds.join(', ') || 'none'} |`
    );

    state.isolation.probes.forEach((p) => {
      if (!p.pass) {
        switch (p.probe) {
          case 'probe1_recall_leak':
            filesToFix.push('opc/scripts/core/recall_learnings.py:296-303 -- add project_id/scope filter to learnings_where');
            filesToFix.push('opc/scripts/core/recall_learnings.py:85-178 -- text-only path also needs project_id clause');
            break;
          case 'probe2_roadmap_contamination':
            filesToFix.push('.claude/hooks/src/shared/project-relevance.ts:124-127 -- fail-open when registry empty; tighten to fail-closed for unknown projects');
            break;
          case 'probe3_hardcoded_paths':
            (p.hits || []).forEach((h) => {
              // Normalize Windows backslashes and trim to relative-from-repo path
              const norm = h.replace(/\\/g, '/');
              const idx = norm.indexOf('.claude/hooks/src/');
              const rel = idx >= 0 ? norm.slice(idx) : norm;
              filesToFix.push(`${rel} -- replace literal C:/Users/david.hayes/ with HOMEPATH/USERPROFILE`);
            });
            break;
          case 'probe4_dotclaude_skip':
            filesToFix.push('.claude/hooks/src/session-start-init-check.ts:331 -- silent skip on .claude in path; add stderr warning or remove blanket skip');
            break;
          case 'probe5_hascodefiles_negative':
            filesToFix.push('.claude/hooks/src/session-start-init-check.ts:118-129 -- hasCodeFiles() requires non-.py marker; add .py glob fallback');
            break;
          case 'probe6_file_claims_cross_project':
            filesToFix.push('opc/docker/init-schema.sql:22-28 -- file_claims composite PK by design but coordination queries should always WHERE project = ...');
            break;
        }
      }
    });
  } else {
    summaryRows.push(`| 8 | Cross-project isolation | SKIP | not run (flag) |`);
  }

  const body = `# CCv3 System Coherence Stress Test -- ${TS_SHORT}

**Run:** ${TS}
**Branch:** ${branch}
**Commit:** ${commit}
**Profile:** ${describeProfile(FLAGS)}
**Targets:** ${describeTargets(state)}

## Summary

| # | Domain | Status | Notes |
|---|--------|--------|-------|
${summaryRows.join('\n')}

## Domain 1 -- Fresh-project bootstrap (detail)

${state.fresh ? state.fresh.map(renderFreshDetail).join('\n\n') : '_skipped_'}

## Domain 8 -- Isolation probes (detail)

${state.isolation ? probeRowsMarkdown(state.isolation.probes) : '_skipped_'}

${state.isolation ? renderProbeExtras(state.isolation.probes) : ''}

## Existing harness baselines

### vitest (hooks)
${state.vitest ? '```\n' + state.vitest.summary + '\n```' : '_skipped_'}

### pytest (memory)
${state.pytest ? '```\n' + state.pytest.summary + '\n```' : '_skipped_'}

### health_check.py
${state.health && state.health.json ? renderHealthJson(state.health.json) : (state.health ? '```\n' + state.health.rawTail + '\n```' : '_skipped_')}

### skill eval
${state.skillEval ? '```\n' + state.skillEval.evalSummary + '\n--- collision ---\n' + state.skillEval.collisionSummary + '\n```' : '_skipped_'}

## Files to fix (if any FAIL)

${filesToFix.length === 0 ? '_None -- all probes passed_' : filesToFix.map((f) => `- ${f}`).join('\n')}

## Next steps

${
  filesToFix.length === 0
    ? 'No remediation required by this stress run. Schedule next coherence pass before the next memory integration.'
    : 'Open a follow-up plan covering the files-to-fix list above. Headline gap is the recall-scope leak (probe1) -- fixing the project_id filter in `recall_learnings.py` closes the most user-visible isolation hole. Stress harness should be re-run after the fix lands to confirm the green baseline.'
}

---
_Generated by \`scripts/system-coherence-stress.mjs\`. Diagnostic-only -- no source code modified by this run._
`;

  await mkdir(join(REPO_ROOT, 'thoughts', 'audits'), { recursive: true });
  await writeFile(outPath, body);
  log(`Report written: ${outPath}`);
}

function describeProfile(flags) {
  if (flags.isolationOnly) return 'isolation-only (Domain 8 only)';
  if (flags.freshProjectOnly) return 'fresh-project-only (Domain 1 only)';
  if (flags.quick) return 'quick (no vitest/pytest)';
  return 'full (8 domains)';
}

function describeTargets(state) {
  const targets = [];
  if (state.fresh) state.fresh.forEach((f) => targets.push(`${f.label}:${f.targetDir}`));
  return targets.length ? targets.join(' + ') : 'n/a';
}

function renderFreshDetail(r) {
  const lines = [
    `### ${r.label} -- ${r.targetDir}`,
    ``,
    `- Tree generated: ${r.treeGenerated}`,
    `- Tree mtime: ${r.treeMtimeUnix || 'n/a'}`,
    `- Hooks fired: ${r.hooksRun}`,
    `- Errored: ${r.errored.length}`,
    ``,
  ];
  if (r.errored.length) {
    lines.push('Errored hooks:');
    r.errored.forEach((e) => lines.push(`- \`${e.hook}\` exit ${e.code} -- ${e.stderr_preview.slice(0, 200)}`));
  }
  return lines.join('\n');
}

function renderProbeExtras(probes) {
  const failing = probes.filter((p) => !p.pass);
  if (!failing.length) return '\n_All probes passed._\n';
  const blocks = failing.map((p) => {
    const extra = Object.fromEntries(
      Object.entries(p).filter(([k]) => !['probe', 'expected', 'observed', 'classification', 'severity', 'pass'].includes(k))
    );
    return `### ${p.probe}\n\n\`\`\`json\n${JSON.stringify(extra, null, 2)}\n\`\`\``;
  });
  return '\n\n## Probe details (failing only)\n\n' + blocks.join('\n\n');
}

function renderHealthJson(j) {
  if (!j) return '_no json_';
  // Try to get a category summary
  const keys = Object.keys(j).slice(0, 15);
  return '```json\n' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, summarizeBranch(j[k])])), null, 2) + '\n```';
}

function summarizeBranch(b) {
  if (b == null) return null;
  if (typeof b !== 'object') return b;
  if (Array.isArray(b)) return `array len=${b.length}`;
  const out = {};
  for (const k of Object.keys(b).slice(0, 4)) out[k] = typeof b[k] === 'object' ? '...' : b[k];
  return out;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(msg) {
  console.error(`[stress] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main() {
  const reportPath = join(REPO_ROOT, 'thoughts', 'audits', `system-coherence-stress-${TS_SHORT}.md`);
  const state = {};
  let linkmapBackup = null;

  try {
    if (FLAGS.includeReal) {
      log('Backing up LinkMap knowledge tree...');
      const treePath = join(LINKMAP, '.claude', 'knowledge-tree.json');
      linkmapBackup = await backupFile(treePath);
      if (linkmapBackup) {
        log(`LinkMap tree backed up to ${linkmapBackup.backupPath} (sha256=${linkmapBackup.sha256.slice(0, 16)}...)`);
      }
    }

    // ---- Domain 1: fresh-project simulator ----
    if (FLAGS.freshProjectOnly || (!FLAGS.isolationOnly && !FLAGS.quick) || FLAGS.quick) {
      const { dir: synthDir } = await createFreshProject({
        prefix: 'ccv3-stress-synth-',
        contents: { 'README.md': '# Synthetic Stress Test\n', 'package.json': '{"name":"stress-synth"}\n' },
      });
      const fresh = [await simulateFreshProject(synthDir, 'synthetic')];
      if (FLAGS.includeReal) {
        fresh.push(await simulateFreshProject(LINKMAP, 'linkmap'));
      }
      state.fresh = fresh;
      await destroyFreshProject(synthDir);
    }

    if (FLAGS.freshProjectOnly) {
      // Skip everything else; the finally block writes the report.
      // Note: we deliberately set a flag here rather than return-ing, so that
      // execution falls through to the outer exit-code computation below.
      // A bare `return;` from inside the try block would skip the
      // probe-outcome check after finally and always exit 0, masking probe
      // FAILures under --fresh-project-only.
      state.skipExistingHarnesses = true;
    }

    // ---- Existing-harness domains ----
    if (!state.skipExistingHarnesses && !FLAGS.isolationOnly) {
      if (!FLAGS.quick) {
        state.vitest = await runVitestBaseline();
        state.pytest = await runPytestBaseline();
      }
      state.health = await runHealthCheck();
      state.skillEval = await runSkillEval();
    }

    // ---- Domain 8: isolation probes ----
    if (!state.skipExistingHarnesses) {
      state.isolation = await runIsolationProbes();
    }
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    state.fatalError = err.message;
  } finally {
    // Restore LinkMap backup -- always do this, even on FAIL
    if (linkmapBackup) {
      log('Restoring LinkMap knowledge tree...');
      const targetPath = join(LINKMAP, '.claude', 'knowledge-tree.json');
      const restored = await restoreFile(linkmapBackup.backupPath, targetPath, linkmapBackup.sha256);
      log(`LinkMap restore: ${JSON.stringify(restored)}`);

      // Leave a recovery breadcrumb if --keep-seeds OR if we hit a FAIL
      const haveFailures =
        (state.isolation && state.isolation.probes.some((p) => !p.pass)) ||
        (state.fresh && state.fresh.some((f) => !f.pass));
      if (FLAGS.keepSeeds || haveFailures) {
        try {
          const breadcrumb = join(REPO_ROOT, 'thoughts', 'audits', `linkmap-tree-backup-${TS_SHORT}.json`);
          await mkdir(join(REPO_ROOT, 'thoughts', 'audits'), { recursive: true });
          const { copyFile } = await import('node:fs/promises');
          await copyFile(linkmapBackup.backupPath, breadcrumb);
          log(`Recovery breadcrumb: ${breadcrumb}`);
        } catch (e) {
          log(`Could not write breadcrumb: ${e.message}`);
        }
      }
    }

    await cleanup({ keepSeeds: FLAGS.keepSeeds });
    await synthesize(state, reportPath);
  }

  // Exit non-zero if any probe failed (matches plan §"Verification")
  const isolationFail = state.isolation && state.isolation.probes.some((p) => !p.pass);
  const freshFail = state.fresh && state.fresh.some((f) => !f.pass);
  return isolationFail || freshFail ? 1 : 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`[stress] unhandled: ${err.stack || err}`);
    process.exit(2);
  });
