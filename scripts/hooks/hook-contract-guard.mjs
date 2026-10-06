#!/usr/bin/env node
/**
 * hook-contract-guard -- two assertions about every REGISTERED hook, both by COUNT.
 *
 * A. OUTPUT CONTRACT. A hook that wants to speak to the model must emit a field
 *    the harness actually reads. It reads `hookSpecificOutput`. It does NOT read
 *    `result`/`message`/`reason` -- so a hook emitting those exits 0, looks
 *    healthy, and says nothing.
 *
 *    Proven 2026-07-28, not inferred: `guardrail-enforcer` fired at 19:18:35 on a
 *    prompt containing "bugs"/"fix" (state file $TEMP/claude-guardrails-45972.json
 *    written that second) and its text appeared NOWHERE in the transcript, while
 *    `memory-awareness` -- same event, same prompt, hookSpecificOutput shape --
 *    injected fine. 19 registered hooks were affected. It survived ~186 days.
 *
 * B. STDIN TIMER. `readStdin()` commonly arms a safety-net timer:
 *      setTimeout(() => resolve(data), 1000)
 *    Without `.unref()` that timer keeps the event loop alive AFTER the work is
 *    done, so the process idles for the full timeout on every single invocation.
 *    Measured on git-commit-roadmap: 1060 ms -> 52 ms once unref'd. One site was
 *    armed at 14000 ms.
 *
 * WHY BOTH ASSERT NONZERO COUNTS
 * ------------------------------
 * The defect this repo keeps producing is a green check whose subject count is
 * zero -- an ESLint boundary linting zero files, `hook-registrations-valid`
 * passing on 0 of 85, a trace-file check passing on a 10-week-dead file, a
 * scheduled task exiting 0 after 28 straight failures. Every "must be zero"
 * assertion below is therefore paired with a "and we actually looked at N things"
 * assertion. A scan that finds nothing FAILS here rather than passing.
 *
 * The registration parser is args-aware on purpose: the live settings.json uses
 * {"command":"node","args":[path]} for most entries, and a parser reading only
 * `command` sees the string "node" for all of them. That exact fault produced a
 * gate reporting "0 hook registrations all resolve" while 85 hooks were firing
 * (fixed in ee29181). Do not simplify it.
 *
 * USAGE
 *   node scripts/hooks/hook-contract-guard.mjs          # exit 1 on violation
 *   node scripts/hooks/hook-contract-guard.mjs --json
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, '.claude', 'hooks', 'src');
const LIVE_SETTINGS = 'C:/Users/david.hayes/.claude/settings.json';
const JSON_OUT = process.argv.includes('--json');

/** Floors, not targets. Raise deliberately; never lower to make a run pass. */
const MIN_REGISTERED = 60;   // live registrations resolved to a hook name
const MIN_SPEAKERS   = 20;   // hooks emitting a real contract field
const MIN_TIMER_SITES = 8;   // stdin timer sites we expect to find

const findings = [];

// --- registrations -------------------------------------------------------
function registeredHookNames(settingsPath) {
  const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const names = new Set();
  let entries = 0;
  for (const arr of Object.values(s.hooks || {})) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      for (const h of group.hooks || []) {
        entries++;
        // args-aware -- see header
        const line = [h.command, ...(h.args || [])].join(' ');
        const m = line.match(/([A-Za-z0-9._-]+)\.mjs/);
        if (m) names.add(m[1]);
      }
    }
  }
  return { names: [...names], entries };
}

let registered = { names: [], entries: 0 };
try {
  registered = registeredHookNames(LIVE_SETTINGS);
} catch (err) {
  findings.push({ kind: 'unreadable-settings', detail: `${LIVE_SETTINGS}: ${err.message}` });
}

if (registered.names.length < MIN_REGISTERED) {
  findings.push({
    kind: 'registration-count-regression',
    detail: `resolved ${registered.names.length} hook names from ${registered.entries} live entries, floor is ${MIN_REGISTERED}. Either registrations were removed, or the parser stopped resolving them -- check the args-aware branch before assuming the former.`,
  });
}

// --- A. output contract --------------------------------------------------
/** Fields the harness reads. */
const CONTRACT = /hookSpecificOutput|permissionDecision|systemMessage|updatedInput/;
/** The discarded shape, but only when it CARRIES something. */
const LEGACY_SPEAKING = [
  /result:\s*['"](?:continue|block)['"]\s*,\s*(?:message|reason)\b/,
  /\{\s*(?:message|reason)\s*\}/,
  /result:\s*['"]block['"]\s*,[\s\S]{0,80}?\breason\b/,
  /values:\s*\{\s*system\b/,
];

/**
 * Hooks allowed to keep the discarded shape, each with the reason.
 *
 * ONLY SessionEnd belongs here, and only because the session is over -- there is
 * no turn left for injected context to reach. These three do real work in their
 * side effects (writing handoffs, recording outcome, clearing state) and their
 * `message` is vestigial.
 *
 * This list is deliberately small and named. "It's just advisory" is NOT a reason
 * to be on it: a hook on UserPromptSubmit / PostToolUse / SessionStart CAN be
 * heard, so if it has something to say it must say it properly. Adding a name
 * here requires stating why the model does not need to hear it.
 */
const ALLOWED_DISCARD = new Map([
  ['maestro-cleanup', 'SessionEnd -- no turn remains to receive context'],
  ['session-outcome', 'SessionEnd -- no turn remains to receive context'],
  ['session-end-handoff-indexer', 'SessionEnd -- no turn remains to receive context'],
]);

/**
 * Registered hooks found to use the discarded `values.system` shape on 2026-10-06, when that
 * shape joined LEGACY_SPEAKING. They are NOT exempt on merit: each must move to
 * hookSpecificOutput (or be retired), then leave this list. Never add a name here.
 */
const KNOWN_DEBT = new Map([
  ['roadmap-reconcile', 'values.system output; fix in a follow-up hook PR'],
  ['periodic-extract', 'values.system output; fix in a follow-up hook PR'],
]);

const speakers = [];
const mute = [];
const debtUsed = new Set();   // KNOWN_DEBT names that still discard output
let sourcesScanned = 0;

for (const name of registered.names) {
  const file = join(SRC, `${name}.ts`);
  if (!existsSync(file)) continue;   // dist-only / plugin hooks are out of scope
  sourcesScanned++;
  const src = readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const hasContract = CONTRACT.test(src);
  const speaksLegacy = LEGACY_SPEAKING.some((re) => re.test(src));

  if (hasContract) speakers.push(name);
  // A bare {result:'continue'} is the honest no-op and is NOT a violation.
  const discards = speaksLegacy && !hasContract && !ALLOWED_DISCARD.has(name);
  if (discards && KNOWN_DEBT.has(name)) debtUsed.add(name);
  else if (discards) mute.push(name);
}

// A fixed or removed hook must leave KNOWN_DEBT, or its exemption outlives the debt.
for (const name of KNOWN_DEBT.keys()) {
  if (!debtUsed.has(name)) {
    findings.push({
      kind: 'stale-debt',
      detail: `${name} is in KNOWN_DEBT but no longer discards output (fixed, retired or unregistered). Remove it from KNOWN_DEBT.`,
    });
  }
}

if (sourcesScanned === 0) {
  findings.push({ kind: 'vacuous', detail: 'zero hook sources scanned -- this guard proved nothing about the output contract.' });
} else {
  if (speakers.length < MIN_SPEAKERS) {
    findings.push({
      kind: 'speaker-count-regression',
      detail: `${speakers.length} registered hooks emit a real contract field, floor is ${MIN_SPEAKERS} (scanned ${sourcesScanned} sources). A drop means hooks stopped being able to talk to the model.`,
    });
  }
  for (const name of mute) {
    findings.push({
      kind: 'discarded-output',
      detail: `${name}.ts carries a message in a discarded legacy field ({result,message|reason} or values.system), which the harness never reads, and emits no hookSpecificOutput. Use shared/output.ts outputWithMessage(msg, <event>) or outputDeny(reason).`,
    });
  }
}

// --- B. stdin timer census ----------------------------------------------
const TIMER = /setTimeout\(\s*\(\)\s*=>\s*resolve\([^)]*\)\s*,\s*\d+\s*\)/g;
let timerSites = 0;
let timerSafe = 0;
const timerUnsafe = [];

let files = [];
try {
  files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
} catch (err) {
  findings.push({ kind: 'unreadable-src', detail: `${SRC}: ${err.message}` });
}

for (const f of files) {
  const src = readFileSync(join(SRC, f), 'utf-8');
  for (const m of src.matchAll(TIMER)) {
    timerSites++;
    const tail = src.slice(m.index, m.index + m[0].length + 40);
    const cleared = /\.unref\(\)/.test(tail) || /const\s+\w+\s*=\s*$/.test(src.slice(Math.max(0, m.index - 30), m.index));
    const hasClearTimeout = /clearTimeout/.test(src);
    if (cleared || hasClearTimeout) timerSafe++;
    else timerUnsafe.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
}

if (timerSites < MIN_TIMER_SITES) {
  findings.push({
    kind: 'timer-census-vacuous',
    detail: `found only ${timerSites} stdin timer sites, expected at least ${MIN_TIMER_SITES}. The pattern probably changed -- update TIMER rather than accepting a clean run that looked at nothing.`,
  });
}
for (const site of timerUnsafe) {
  findings.push({
    kind: 'dangling-timer',
    detail: `${site}: setTimeout(...resolve...) with no .unref()/clearTimeout -- the process will idle for the full timeout after its work completes (measured 1060ms -> 52ms when fixed).`,
  });
}

// --- report --------------------------------------------------------------
const ok = findings.length === 0;
const summary = {
  ok,
  liveEntries: registered.entries,
  registeredNames: registered.names.length,
  sourcesScanned,
  speakers: speakers.length,
  discardedOutput: mute.length,
  knownDebt: [...debtUsed],
  timerSites,
  timerSafe,
  findings,
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else if (ok) {
  console.log(
    `PASS  hook-contract-guard  ${registered.entries} live entries / ${registered.names.length} names, ` +
    `${sourcesScanned} sources scanned, ${speakers.length} speak the contract, 0 discarded-output, ${debtUsed.size} known-debt (${[...debtUsed].join(', ') || 'none'}), ` +
    `${timerSafe}/${timerSites} timers safe`);
} else {
  console.error(
    `FAIL  hook-contract-guard  ${registered.entries} live entries / ${registered.names.length} names, ` +
    `${sourcesScanned} sources scanned, ${speakers.length} speakers, ${timerSafe}/${timerSites} timers safe, ` +
    `${findings.length} finding(s)\n`);
  for (const f of findings) console.error(`  [${f.kind}] ${f.detail}\n`);
}

process.exit(ok ? 0 : 1);
