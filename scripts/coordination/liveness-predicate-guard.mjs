#!/usr/bin/env node
/**
 * liveness-predicate-guard -- one question, one answer, asserted by COUNT.
 *
 * WHAT IT GUARDS
 * --------------
 * "Is this session alive?" must be answered EVERYWHERE by
 *
 *     GREATEST(last_heartbeat, last_activity_at) <op> now() - <interval>
 *
 * and NEVER by bare `last_heartbeat`. `heartbeat.ts` fires on UserPromptSubmit
 * ONLY, so that column measures the HUMAN typing, not the agent working.
 * Measured peak staleness during a 12-agent workflow: 505s, while the session
 * edited continuously. Demonstrated live on session 079ae1e7 -- heartbeat age
 * 1521s, activity age 25s, the file-claim lock said DEAD while the session was
 * mid-edit. Any other session could have reclaimed its claims out from under it.
 *
 * WHY A GUARD AND NOT JUST A FIX
 * ------------------------------
 * The predicate is spelled out at a dozen independent call sites across four
 * languages. It was fixed once, on the dashboard, on 2026-07-27 -- and the lock,
 * the lane board, the peer-warning hook, the dashboard router and the session
 * REAPER all kept the old rule for another day. That is the house defect: an
 * unbound contract between artifacts where only one side gets implemented, and
 * nothing fails when the others do not. A one-time fix reproduces it.
 *
 * WHY IT ASSERTS A NONZERO COUNT
 * ------------------------------
 * Five vacuous gates surfaced here in a single day -- an ESLint boundary linting
 * zero files, `hook-registrations-valid` passing on 0 of 85, `hook-orphans`
 * reporting 114 false positives from that same fault, a trace-file check passing
 * on a 10-week-dead file, and a scheduled task exiting 0 after 28 straight
 * failures. Every one of them PASSED BY FINDING NOTHING. The single guard in
 * this repo with a real catch record (scripts/audit-braintrust-emits.sh, six
 * regressions) works precisely because it asserts a nonzero count.
 *
 * So this guard fails if:
 *   1. any guarded file is missing            (the glob found nothing)
 *   2. any guarded file has ZERO correct forms (it stopped asking the question)
 *   3. any bare-column staleness test remains  (the actual regression)
 *
 * Condition 2 is the one that matters. Without it, deleting every predicate in
 * the file would make this guard pass.
 *
 * USAGE
 *   node scripts/coordination/liveness-predicate-guard.mjs          # exit 1 on violation
 *   node scripts/coordination/liveness-predicate-guard.mjs --json
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_OUT = process.argv.includes('--json');

/**
 * Explicit list, NOT a glob. A glob that stops matching is indistinguishable
 * from a codebase that is clean, and that ambiguity is the entire failure mode
 * this file exists to prevent. Adding a new site means adding it here, on
 * purpose. `minCorrect` is the count below which the file has stopped asking
 * the liveness question at all.
 */
const GUARDED = [
  { file: '.claude/hooks/src/shared/db-utils-pg.ts', minCorrect: 5,
    why: 'the file-claim lock: reclamation predicate, its classifier, the contended re-read, isSessionActive, getActiveSessions' },
  { file: '.claude/hooks/src/lane-context.ts', minCorrect: 1,
    why: 'the peer-collision warning -- a working peer dropped from here is a silent collision' },
  { file: 'scripts/coordination/lane.mjs', minCorrect: 5,
    why: 'lane reclamation, board peers, peers command, deny-message display, say --to resolution' },
  { file: 'scripts/coordination/render-board.mjs', minCorrect: 9,
    why: 'the rendered board, its live-vs-stale claim health counts, the held_now predicate behind the headline counter, and the two reconciliation queries the page PRINTS. Raised 4 -> 9 on 2026-07-29, set to the MEASURED count rather than a guessed floor: at 6 the negative control did not fire (deleting held_now left 8, still above the floor, and the guard passed on the exact regression it was being ratcheted for). A floor below the real count is slack the next regression spends. If a site legitimately goes away, lower this deliberately and say why.' },
  { file: 'opc/scripts/dashboard/routers/file_claims.py', minCorrect: 1,
    why: 'the dashboard active-claims view' },
  { file: 'opc/scripts/core/cleanup_sessions.py', minCorrect: 2,
    why: 'the session REAPER -- this one DELETEs, so a false "dead" is destructive' },
  { file: 'scripts/coordination/t3-to-seat.mjs', minCorrect: 1,
    why: 'Seat active/idle status check must use GREATEST(last_heartbeat, last_activity_at)' },
];

/**
 * The correct form, in both spellings that exist:
 *   - literal SQL:  GREATEST(s.last_heartbeat, s.last_activity_at)
 *   - lane.mjs helper: ALIVE_AT('s.') / ALIVE_AT()
 *
 * db-utils-pg.ts must use the LITERAL form: RESOLVE_CLAIM_SQL is extracted from
 * source as raw text at run time by claim-sql-probe.mjs, so a ${...} template
 * substitution inside it would be handed to Postgres verbatim.
 */
const CORRECT = [
  /GREATEST\(\s*[\w.]*last_heartbeat\s*,\s*[\w.]*last_activity_at\s*\)/g,
  /ALIVE_AT\([^)]*\)/g,
];

/**
 * A staleness TEST on the bare column -- `last_heartbeat` within a short reach
 * of a comparison against now(). Deliberately not "any mention of
 * last_heartbeat": the column is still legitimately SELECTed, INSERTed, written
 * by heartbeat.ts and discussed in comments. Only the COMPARISON is the bug.
 */
const BARE_TEST = [
  /last_heartbeat\s*(?:>=|<=|>|<)\s*(?:NOW|now)\s*\(\)/g,
  /(?:NOW|now)\s*\(\)[^;\n]{0,60}?(?:>=|<=|>|<)\s*last_heartbeat/g,
  /**
   * The SAME test, HTML-escaped. render-board.mjs PRINTS its reconciliation
   * queries onto the page, so those comparisons are written `&gt;` / `&lt;` and
   * the two literal patterns above cannot see them. That is not hypothetical: the
   * printed `sessions` query advertised `last_heartbeat &gt; now()` while the code
   * it documented had already been fixed to GREATEST(...), so the page's own
   * falsify-it-in-ten-seconds affordance was handing the reader the predicate the
   * guard exists to forbid. Caught 2026-07-29 by a negative control that failed
   * for the wrong reason (the count check, not this one).
   */
  /last_heartbeat\s*(?:&gt;=|&lt;=|&gt;|&lt;)\s*(?:NOW|now)\s*\(\)/g,
  /(?:NOW|now)\s*\(\)[^;\n]{0,60}?(?:&gt;=|&lt;=|&gt;|&lt;)\s*last_heartbeat/g,
];

/**
 * Strip comments before ANY counting.
 *
 * Found by negative control, which is the only reason it is here: with the
 * regression reinstated in lane-context.ts the bare-heartbeat check fired
 * correctly, but the count check did NOT -- because the doc comment directly
 * above the query says the words "GREATEST(last_heartbeat, last_activity_at)",
 * and that prose satisfied minCorrect all by itself. A guard that can be
 * satisfied by a comment describing the fix, rather than by the fix, is the
 * defect it was written to catch. Both scans now see code only.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // TS/JS block
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // TS/JS line (not the // in a URL)
    .replace(/--[^\n]*/g, ' ')          // SQL line, incl. inside TS template literals
    .replace(/#[^\n]*/g, ' ');          // Python line
}

const findings = [];
let filesScanned = 0;
let totalCorrect = 0;

for (const spec of GUARDED) {
  const abs = join(REPO, spec.file);

  // Condition 1: a guarded file that vanished is a FAILURE, never a skip.
  if (!existsSync(abs)) {
    findings.push({ file: spec.file, kind: 'missing',
      detail: `guarded file does not exist -- it moved or was deleted. Update GUARDED in ${relative(REPO, fileURLToPath(import.meta.url))}, do not silently drop it.` });
    continue;
  }

  const src = stripComments(readFileSync(abs, 'utf-8'));
  filesScanned++;

  // Count correct forms, then REMOVE them, so the bare-form scan cannot see the
  // `last_heartbeat` that lives inside a correct GREATEST(...).
  let stripped = src;
  let correct = 0;
  for (const re of CORRECT) {
    const hits = src.match(re);
    if (hits) correct += hits.length;
    stripped = stripped.replace(re, ' __ALIVE__ ');
  }
  totalCorrect += correct;

  // Condition 2: the file must still be ASKING the question. This is the check
  // that stops the guard from passing on an empty file.
  if (correct < spec.minCorrect) {
    findings.push({ file: spec.file, kind: 'count-regression',
      detail: `${correct} correct liveness predicate(s), expected at least ${spec.minCorrect} (${spec.why}). Either a call site lost its predicate, or the site count legitimately changed -- if the latter, update minCorrect deliberately and say why.` });
  }

  // Condition 3: the regression itself.
  for (const re of BARE_TEST) {
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split('\n').length;
      findings.push({ file: spec.file, kind: 'bare-heartbeat', line,
        detail: `staleness test on bare last_heartbeat: ${m[0].replace(/\s+/g, ' ').trim()} -- use GREATEST(last_heartbeat, last_activity_at)` });
    }
  }
}

// The guard's own vacuity check. If the loop above scanned nothing, every
// per-file assertion was skipped and this file would exit 0 having proved
// exactly nothing.
if (filesScanned === 0) {
  findings.push({ file: '(all)', kind: 'vacuous',
    detail: 'zero files scanned -- this guard proved nothing. Check REPO resolution.' });
}

const ok = findings.length === 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ ok, filesScanned, totalCorrect, findings }, null, 2));
} else if (ok) {
  console.log(`PASS  liveness-predicate-guard  ${filesScanned}/${GUARDED.length} files, ${totalCorrect} correct predicates, 0 bare-heartbeat tests`);
} else {
  console.error(`FAIL  liveness-predicate-guard  ${filesScanned}/${GUARDED.length} files, ${totalCorrect} correct predicates, ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  [${f.kind}] ${f.file}${f.line ? `:${f.line}` : ''}\n      ${f.detail}\n`);
  }
}

process.exit(ok ? 0 : 1);
