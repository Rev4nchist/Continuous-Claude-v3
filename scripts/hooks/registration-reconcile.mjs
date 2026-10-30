#!/usr/bin/env node
/**
 * registration-reconcile -- RATCHET A. Can the LIVE hook configuration still be
 * rebuilt from committed state?
 *
 * WHAT THIS PROTECTS
 * ------------------
 * Q1 of the repair-vs-rebuild verification (2026-07-28) asked exactly one
 * decisive question: if `~/.claude` were deleted today, could it be rebuilt from
 * the repo? The answer was YES -- 85 of 85 live registrations were recoverable
 * from committed files, and all 18 "live-only" hooks existed in HEAD as both
 * `src/*.ts` and `dist/*.mjs`. That answer is what closed the rebuild-from-live
 * branch and made "repair, don't rebuild" the plan.
 *
 * It is also a fact with a shelf life. Nothing stops the next hook from being
 * registered live and never committed, and if enough of those accumulate the
 * premise quietly stops being true -- with no error, on any run, ever. This
 * script is what makes that fail loudly instead.
 *
 * THE PARSER TRAP -- DO NOT "SIMPLIFY" THIS
 * -----------------------------------------
 * Live `settings.json` registers most hooks as:
 *     {"type":"command","command":"node","args":["C:/.../dist/foo.mjs"]}
 * A parser that reads only `command` sees the literal string "node" for 80 of 86
 * entries and resolves zero hook names. That is not hypothetical: it shipped, and
 * `/health-check` reported "PASS | 0 hook registrations all resolve" while 85
 * hooks were firing (fixed in ee29181). The `[command, ...args].join(' ')` below
 * is the fix. Both shapes must stay supported.
 *
 * WHY EVERY ASSERTION CARRIES A NONZERO DENOMINATOR
 * -------------------------------------------------
 * The recurring defect in this repo is a green check whose subject count is zero.
 * So "0 unrecoverable" is never asserted alone -- it is always paired with "and
 * we resolved at least N live names to check against". A scan that finds nothing
 * FAILS here.
 *
 * USAGE
 *   node scripts/hooks/registration-reconcile.mjs           # exit 1 on violation
 *   node scripts/hooks/registration-reconcile.mjs --json
 *   node scripts/hooks/registration-reconcile.mjs --update-baseline
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_OUT = process.argv.includes('--json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const BASELINE_PATH = join(REPO, '.claude', 'hooks', 'registration-baseline.json');

/** Committed sources of truth, in the order a rebuild would consult them. */
const COMMITTED = [
  '.claude/settings.json.template',
  'docs/reviews/2026-06-10/harvest/registrations-active.json',
];

const LIVE = join(homedir(), '.claude', 'settings.json');

/** Floors. Raise deliberately; never lower one to make a red run go green. */
// Lowered 2026-10-06 (80/75 -> 75/68), keeping the original ~4-6 of slack under the
// re-recorded baseline of 79 entries / 72 names. Every lost name has a commit,
// listed in the commit that made this change (Dave approved the lower floors).
// Lowered 2026-10-29 (75/68 -> 69/60) for the Maestro removal (PR 211): maestro-enforcer,
// maestro-state-manager, maestro-cleanup and session-start-recovery left settings.json, so the
// live count is 73 entries / 64 names; the floors keep the same ~4 of slack. Dave approved.
// Lowered 2026-10-29 (69/60 -> 65/57) for the prompt-hook merge: the 5 UserPromptSubmit entries
// (heartbeat, memory-awareness, user-confirmation-detector, bus-session-populator, lane-context)
// become 1 prompt-submit entry, so live is 69 entries / 61 names; ~4 of slack kept. Dave approved.
const MIN_LIVE_ENTRIES = 65;
const MIN_LIVE_NAMES = 57;
const MIN_COVERAGE = 0.95;   // fraction of live names findable in committed state

const findings = [];

/**
 * Pull hook script basenames out of any settings-shaped JSON.
 * Tolerant of both registration shapes and of the harvest's flat-ish layout,
 * because a rebuild would be too.
 */
function namesFrom(obj) {
  const names = new Set();
  let entries = 0;
  let unparsed = 0;

  const visitHook = (h) => {
    entries++;
    const line = [h.command, ...(h.args || [])].filter(Boolean).join(' ');
    const m = line.match(/([A-Za-z0-9._-]+)\.(mjs|py)\b/);
    if (m) names.add(m[1]);
    else unparsed++;
  };

  // TWO shapes, handled EXPLICITLY. Not a generic walk.
  //
  //   settings-shaped   obj.hooks.<Event>[].hooks[]        -- {command, args?}
  //   harvest-shaped    a FLAT array of {event, matcher, command}
  //
  // Both mistakes were made here before this comment existed, and they fail in
  // opposite directions:
  //
  //   Descending ONLY into `hooks` arrays read the 2026-06-10 harvest as ZERO
  //   registrations -- reporting 95.1% coverage with 4 hooks "unrecoverable"
  //   when all 4 were sitting in that file. That understates recoverability,
  //   which is the direction that would wrongly argue for a rebuild.
  //
  //   Then treating ANY object with a string `command` as a registration
  //   over-matched into `mcpServers` and the statusLine, inventing hook names
  //   "launcher" and "server", inflating 86 entries to 96 and manufacturing 8
  //   phantom unparsed entries. That overstates the problem.
  //
  // A pattern is not better for being broader. It has to match the question.
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    // harvest-shaped: flat array of registration records
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && typeof item.command === 'string') visitHook(item);
      }
      return;
    }

    // settings-shaped: only ever under the top-level `hooks` key
    const events = node.hooks;
    if (!events || typeof events !== 'object') return;
    for (const groups of Object.values(events)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const h of (group?.hooks || [])) {
          if (h && typeof h === 'object' && typeof h.command === 'string') visitHook(h);
        }
      }
    }
  };

  walk(obj);
  return { names: [...names], entries, unparsed };
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// --- live ---------------------------------------------------------------
const liveJson = readJson(LIVE);
if (!liveJson) {
  findings.push({ kind: 'live-unreadable', detail: `cannot read/parse ${LIVE}` });
}
const live = liveJson ? namesFrom(liveJson) : { names: [], entries: 0, unparsed: 0 };

if (live.entries < MIN_LIVE_ENTRIES) {
  findings.push({
    kind: 'live-entry-floor',
    detail: `parsed ${live.entries} live hook entries, floor ${MIN_LIVE_ENTRIES}. Registrations were removed, or the parser stopped seeing them -- check the args-aware branch BEFORE assuming the former.`,
  });
}
if (live.names.length < MIN_LIVE_NAMES) {
  findings.push({
    kind: 'live-name-floor',
    detail: `resolved ${live.names.length} distinct hook names, floor ${MIN_LIVE_NAMES}.`,
  });
}
// Only meaningful once we know the scan wasn't empty -- hence the guard.
if (live.entries >= MIN_LIVE_ENTRIES && live.unparsed > 0) {
  findings.push({
    kind: 'unparsed-entries',
    detail: `${live.unparsed} of ${live.entries} live entries did not resolve to a hook script. A registration this script cannot see is one a rebuild would silently drop.`,
  });
}

// --- committed ----------------------------------------------------------
const committedNames = new Set();
const committedSeen = [];
for (const rel of COMMITTED) {
  const abs = join(REPO, rel);
  if (!existsSync(abs)) { committedSeen.push({ file: rel, present: false, names: 0 }); continue; }
  const parsed = readJson(abs);
  if (!parsed) { committedSeen.push({ file: rel, present: true, names: 0, unparseable: true }); continue; }
  const { names } = namesFrom(parsed);
  names.forEach((n) => committedNames.add(n));
  committedSeen.push({ file: rel, present: true, names: names.length });
}

if (committedNames.size === 0) {
  findings.push({ kind: 'vacuous', detail: 'zero names resolved from ANY committed file -- this guard proved nothing about recoverability.' });
}

// --- reconcile ----------------------------------------------------------
const unrecoverable = live.names.filter((n) => !committedNames.has(n));
const coverage = live.names.length ? (live.names.length - unrecoverable.length) / live.names.length : 0;

// A name in committed config is only truly recoverable if its code is committed too.
const missingSource = [];
for (const n of live.names) {
  const src = join(REPO, '.claude', 'hooks', 'src', `${n}.ts`);
  const dist = join(REPO, '.claude', 'hooks', 'dist', `${n}.mjs`);
  const py = join(REPO, '.claude', 'hooks', `${n}.py`);
  if (!existsSync(src) && !existsSync(dist) && !existsSync(py)) missingSource.push(n);
}

if (live.names.length >= MIN_LIVE_NAMES) {
  if (coverage < MIN_COVERAGE) {
    findings.push({
      kind: 'coverage-regression',
      detail: `${(coverage * 100).toFixed(1)}% of live hook names are present in committed config (floor ${(MIN_COVERAGE * 100).toFixed(0)}%). Unrecoverable: ${unrecoverable.join(', ') || '(none)'}. The repo is drifting toward NOT being a viable base -- which is the premise the whole repair plan rests on.`,
    });
  }
  for (const n of missingSource) {
    findings.push({
      kind: 'no-committed-code',
      detail: `${n} is registered live but has no committed src/dist/py in this repo. Deleting ~/.claude would lose it entirely.`,
    });
  }
}

// --- baseline ratchet ---------------------------------------------------
const current = { liveEntries: live.entries, liveNames: live.names.length };
let baseline = readJson(BASELINE_PATH);

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    _comment: 'Floors recorded by scripts/hooks/registration-reconcile.mjs. Regenerate deliberately with --update-baseline; a DROP is a finding, not a reason to rewrite this file.',
    recordedAt: new Date().toISOString(),
    ...current,
  }, null, 2) + '\n');
  console.log(`baseline written: ${current.liveEntries} entries / ${current.liveNames} names`);
  process.exit(0);
}

if (baseline) {
  if (current.liveEntries < baseline.liveEntries) {
    findings.push({
      kind: 'baseline-drop',
      detail: `live entries ${current.liveEntries} < recorded baseline ${baseline.liveEntries}. Hooks were deregistered. If deliberate, re-record with --update-baseline and say why in the commit.`,
    });
  }
  if (current.liveNames < baseline.liveNames) {
    findings.push({
      kind: 'baseline-drop',
      detail: `distinct hook names ${current.liveNames} < recorded baseline ${baseline.liveNames}.`,
    });
  }
} else {
  findings.push({
    kind: 'no-baseline',
    detail: `no baseline at ${BASELINE_PATH}. Create it once with --update-baseline so future drops are detectable.`,
  });
}

// --- report -------------------------------------------------------------
const ok = findings.length === 0;
const summary = {
  ok,
  live: { entries: live.entries, names: live.names.length, unparsed: live.unparsed },
  committed: { sources: committedSeen, distinctNames: committedNames.size },
  coveragePct: Number((coverage * 100).toFixed(1)),
  unrecoverable,
  missingCommittedCode: missingSource,
  baseline: baseline ? { liveEntries: baseline.liveEntries, liveNames: baseline.liveNames } : null,
  findings,
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else if (ok) {
  console.log(
    `PASS  registration-reconcile  live ${live.entries} entries / ${live.names.length} names, ` +
    `${committedNames.size} names in committed config, coverage ${(coverage * 100).toFixed(1)}%, ` +
    `${live.unparsed} unparsed, ${missingSource.length} without committed code`);
} else {
  console.error(
    `FAIL  registration-reconcile  live ${live.entries} entries / ${live.names.length} names, ` +
    `coverage ${(coverage * 100).toFixed(1)}%, ${findings.length} finding(s)\n`);
  for (const f of findings) console.error(`  [${f.kind}] ${f.detail}\n`);
}

process.exit(ok ? 0 : 1);
