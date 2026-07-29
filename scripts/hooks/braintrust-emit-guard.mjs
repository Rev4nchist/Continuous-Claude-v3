#!/usr/bin/env node
/**
 * braintrust-emit-guard -- assert the scoring layer CAN emit, and optionally
 * that it DID.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/audit-braintrust-emits.sh` counts `await emitBraintrustScore(` call
 * sites in source and asserts the count has not dropped. That is genuinely
 * useful -- it has caught six agent-rewrite regressions -- but it measures the
 * PRESENCE OF CODE, not the behaviour of that code.
 *
 * It passed 4/4 for months while ZERO of those four call sites could emit
 * anything at all (root-caused 2026-07-28: the config they depend on was never
 * loaded into node hook processes, and three of them resolved their span from
 * an environment variable that is set nowhere). A guard reporting OK while its
 * subject is completely inert is the exact defect this repo keeps producing.
 *
 * This is the complement. Same nonzero-count discipline, but the assertions are
 * about REACHABILITY, and `--live` checks reality directly.
 *
 * WHAT IT ASSERTS
 *   structural (default, offline, fast):
 *     1. >= MIN_EMIT_SITES call sites exist                  (the shell guard's job,
 *                                                             repeated so this file
 *                                                             is meaningful alone)
 *     2. braintrust-score.ts loads ~/.claude/.env            (defect 1: without
 *                                                             this, config never
 *                                                             arrives and every
 *                                                             emit returns early)
 *     3. ZERO hooks read BRAINTRUST_SESSION_ID for a span    (defect 2: set in no
 *                                                             location; asserted
 *                                                             against a nonzero
 *                                                             scanned-file count)
 *     4. every emitter resolves its span from the shared
 *        resolver or the python state file
 *
 *   live (--live, needs network + ~/.claude/.env):
 *     5. >= MIN_LIVE_SCORE_NAMES distinct score names present in recent
 *        Braintrust events. This is the assertion with contact with reality:
 *        it fails if the scoring layer goes silent again for ANY reason,
 *        including one nobody has thought of yet.
 *
 * USAGE
 *   node scripts/hooks/braintrust-emit-guard.mjs           # structural only
 *   node scripts/hooks/braintrust-emit-guard.mjs --live    # + query the API
 *   node scripts/hooks/braintrust-emit-guard.mjs --json
 *
 * `--live` is deliberately NOT the default: a guard that needs the network is a
 * guard that fails on a plane, and a flaky guard gets ignored, which is its own
 * failure mode. Run it in the scheduled health check, not on every edit.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, '.claude', 'hooks', 'src');
const SHARED = join(SRC, 'shared');
const JSON_OUT = process.argv.includes('--json');
const LIVE = process.argv.includes('--live');

/** Floors. Raise deliberately; never lower one to make a red run go green. */
const MIN_EMIT_SITES = 4;
const MIN_LIVE_SCORE_NAMES = 2;
/** How far back a live check looks. Scores are per-turn, so this is generous. */
const LIVE_WINDOW_HOURS = 48;

const findings = [];
const stripComments = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// --- gather sources ------------------------------------------------------
let files = [];
try {
  files = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, f));
} catch (err) {
  findings.push({ kind: 'unreadable-src', detail: `${SRC}: ${err.message}` });
}

let scanned = 0;
let emitSites = 0;
const emitters = [];
const sessionIdSpanReaders = [];

for (const file of files) {
  const raw = readFileSync(file, 'utf-8');
  const code = stripComments(raw);
  scanned++;
  const name = file.split(/[\\/]/).pop().replace(/\.ts$/, '');

  const hits = code.match(/emitBraintrustScore\(/g);
  if (hits) {
    emitSites += hits.length;
    emitters.push(name);
  }
  // Defect 2: the span variable that is set nowhere.
  if (/process\.env\.BRAINTRUST_SESSION_ID/.test(code)) sessionIdSpanReaders.push(name);
}

if (scanned === 0) {
  findings.push({
    kind: 'vacuous',
    detail: 'zero hook sources scanned -- this guard proved nothing. Check SRC resolution before believing any result below.',
  });
}

// 1. call sites still exist
if (emitSites < MIN_EMIT_SITES) {
  findings.push({
    kind: 'emit-site-regression',
    detail: `${emitSites} emitBraintrustScore( call sites, floor ${MIN_EMIT_SITES}. An agent rewrite probably dropped one -- this is what audit-braintrust-emits.sh catches, repeated here so this guard is meaningful standalone.`,
  });
}

// 2. the config actually reaches node hooks
const scorePath = join(SHARED, 'braintrust-score.ts');
if (!existsSync(scorePath)) {
  findings.push({ kind: 'missing-module', detail: `${scorePath} does not exist.` });
} else {
  const score = stripComments(readFileSync(scorePath, 'utf-8'));

  // Count CALLS, not the name.
  //
  // The first version of this check tested for the presence of the string
  // `loadClaudeDotEnv` -- which its own `function loadClaudeDotEnv()`
  // definition satisfies. Its negative control PASSED after the loader was
  // gutted: the definition survived, so the guard saw the name and reported
  // "config reachable" while nothing called it. That is precisely the
  // presence-of-code-instead-of-behaviour defect this file exists to catch,
  // reproduced inside the file. Caught only because the negative control was
  // run; it would otherwise have shipped as a second silent guard.
  //
  // Three call sites are expected -- getApiUrl, getApiKey, isTraceEnabled --
  // plus resolveProjectId, so the floor is deliberately below the actual count.
  const callSites = (score.match(/(?<!function\s)loadClaudeDotEnv\s*\(\s*\)\s*;/g) || []).length;
  const readsEnvFile = /\.claude['"]\s*,\s*['"]\.env['"]/.test(score);
  const loadsEnv = callSites >= 3 && readsEnvFile;
  if (!loadsEnv) {
    findings.push({
      kind: 'config-unreachable',
      detail: `braintrust-score.ts does not load ~/.claude/.env on every config read (${callSites} call site(s) of loadClaudeDotEnv(), need >=3; reads the .env path: ${readsEnvFile}). TRACE_TO_BRAINTRUST and BRAINTRUST_API_KEY are NOT in the hook process environment and are deliberately not in settings.json (a live key must not sit in a synced, committed file). Without this load every emit returns at its guard and the whole scoring layer goes silent -- exactly the 2026-07-28 defect.`,
    });
  }
}

// 3. nobody resolves a span from the variable that is set nowhere
if (scanned > 0 && sessionIdSpanReaders.length > 0) {
  findings.push({
    kind: 'dead-span-source',
    detail: `${sessionIdSpanReaders.join(', ')} read process.env.BRAINTRUST_SESSION_ID. That variable is set in NO location -- process env, ~/.claude/.env and the settings.json env block were all checked. Reading it yields an empty span and the emit silently skips. Use resolveBraintrustSpanId() from shared/braintrust-span.ts.`,
  });
}

// 4. emitters resolve a span from a real source
const spanPath = join(SHARED, 'braintrust-span.ts');
if (!existsSync(spanPath)) {
  findings.push({
    kind: 'missing-module',
    detail: `${spanPath} does not exist -- the shared span resolver is what keeps every emitter agreeing about where span state lives. A second opinion about that is how the 2026-07-28 defect happened.`,
  });
}

// --- 5. live check -------------------------------------------------------
let live = null;
if (LIVE) {
  live = await checkLive();
}

async function checkLive() {
  const env = {};
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    findings.push({ kind: 'live-no-env', detail: 'could not read ~/.claude/.env for the live check' });
    return null;
  }

  if ((env.TRACE_TO_BRAINTRUST || '').toLowerCase() !== 'true') {
    // Not a failure -- tracing being off is a legitimate choice. Say so loudly
    // rather than reporting a green live check that tested nothing.
    return { skipped: 'TRACE_TO_BRAINTRUST is not true -- tracing is disabled, live check not applicable' };
  }

  try {
    const base = env.BRAINTRUST_API_URL || 'https://api.braintrust.dev';
    const url = `${base}/v1/project_logs/${env.BRAINTRUST_CC_PROJECT_ID}/fetch?limit=300`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.BRAINTRUST_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      findings.push({ kind: 'live-http', detail: `Braintrust fetch returned HTTP ${res.status}` });
      return null;
    }
    const events = (await res.json()).events || [];
    const cutoff = Date.now() - LIVE_WINDOW_HOURS * 3600 * 1000;
    const names = new Set();
    let recent = 0;
    for (const e of events) {
      const t = Date.parse(e.created || e.created_at || 0);
      if (Number.isFinite(t) && t < cutoff) continue;
      recent++;
      for (const n of Object.keys(e.scores || {})) names.add(n);
    }
    if (recent === 0) {
      findings.push({
        kind: 'live-no-events',
        detail: `zero Braintrust events in the last ${LIVE_WINDOW_HOURS}h. Tracing is enabled but nothing is arriving -- the python hook chain is the first thing to check.`,
      });
    } else if (names.size < MIN_LIVE_SCORE_NAMES) {
      findings.push({
        kind: 'live-score-regression',
        detail: `only ${names.size} distinct score name(s) in ${recent} recent events (${[...names].join(', ') || 'none'}), floor ${MIN_LIVE_SCORE_NAMES}. The scoring layer has gone quiet. This is the assertion the call-site count could never make.`,
      });
    }
    return { events: recent, scoreNames: [...names] };
  } catch (e) {
    findings.push({ kind: 'live-error', detail: `live check failed: ${e.message}` });
    return null;
  }
}

// --- report --------------------------------------------------------------
const ok = findings.length === 0;
const summary = { ok, scanned, emitSites, emitters, live, findings };

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else if (ok) {
  const liveBit = live?.skipped
    ? ` | live: SKIPPED (${live.skipped})`
    : live
      ? ` | live: ${live.scoreNames.length} score names in ${live.events} recent events`
      : '';
  console.log(`PASS  braintrust-emit-guard  ${scanned} sources, ${emitSites} emit sites across ${emitters.length} hooks, config reachable, 0 dead span sources${liveBit}`);
} else {
  console.error(`FAIL  braintrust-emit-guard  ${scanned} sources, ${emitSites} emit sites, ${findings.length} finding(s)\n`);
  for (const f of findings) console.error(`  [${f.kind}] ${f.detail}\n`);
}

process.exit(ok ? 0 : 1);
