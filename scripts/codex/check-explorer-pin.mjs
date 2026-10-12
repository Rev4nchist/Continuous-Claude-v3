#!/usr/bin/env node
/**
 * Guard: every place naming the `--complex` explorer pin must name the SAME model.
 *
 * Written 2026-09-03 after this inconsistency was introduced and missed FOUR times
 * in one session. The pin lives in a machine-local file (~/.codex/agents/
 * explorer.toml) while the check enforcing it, its refusal string, its NOTE line,
 * its failure-table row, its recovery instruction and several prose mentions live
 * in the repo. Changing the file without all of them left `--complex` refusing a
 * VALID config -- a config disagreeing with its own gate.
 *
 * The first version of this guard was bash and was VACUOUS: it excluded every line
 * mentioning `gpt-4.1`, which is most of them (they explain the role-fallback), so
 * a planted `gpt-5.5` passed and it printed OK. Rewritten here and demonstrated
 * failing on purpose. Do not "simplify" it back to a grep pipeline without
 * re-running that demonstration.
 *
 * Source of truth: the executable `grep -Eq` pattern in codex-worker.md Step 2 --
 * the one value that actually gates a run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../../.claude/scripts/codex/adversary.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER = join(REPO, '.claude', 'agents', 'codex-worker.md');
const worker = readFileSync(WORKER, 'utf8');

// The executable pattern writes the id as a REGEX, e.g. gpt-5\.6-luna. Requiring
// the escaped dot is what pins us to that pattern rather than to prose.
const m = worker.match(/gpt-5\\\.[0-9a-z.\\-]+/);
if (!m) {
  console.error('FAIL: no executable explorer-pin pattern found in codex-worker.md');
  process.exit(1);
}
const CANON = m[0].replace(/\\/g, '');
console.log(`canonical explorer pin (from the executable guard): ${CANON}`);

// The verified model allowlist: the runner's MODELS table is the single source
// (DESIGN-RESEARCH sections 13 and 19). A pin value must be one of these; anything
// else on a pin line is narrative, not a pin.
const ALLOWLIST = new Set(Object.keys(MODELS));
if (!ALLOWLIST.has(CANON)) {
  console.error(`FAIL: the guard's own pin '${CANON}' is not in the verified allowlist`);
  process.exit(1);
}

const FILES = [
  '.claude/agents/codex-worker.md',
  '.claude/agents/codex-adversary.md',
  '.claude/skills/codex/SKILL.md',
  '.claude/rules-ondemand/codex-worker-safety.md',
  '.claude/rules-ondemand/codex-adversarial.md',
];

// KNOWN LIMIT, stated rather than papered over: `docs/codex-integration/**` is
// NOT checked. It was added on 2026-09-03 after review found a stale
// `sub-agents on gpt-5.5` acceptance criterion there, and then removed again the
// same hour because the check cannot work on that tree. Those docs are a DATED
// ARCHIVE: their July sections legitimately record `gpt-5.5` (it was the pin
// then), and the 2026-09-03 correction quotes the old value deliberately.
// Annotating such a line leaves the old id ON the line, so an equality check
// stays red forever and gets switched off -- worse than no check. Separating
// "history" from "instruction" needs a per-line marker nobody will maintain.
// So: docs drift is a HUMAN review item. If you change the pin, grep
// docs/codex-integration for the old id and annotate (do not rewrite) history,
// but fix any present-tense acceptance criterion outright.

// Adding a docs/ path to FILES must FAIL LOUDLY rather than quietly inherit the
// strict equality check. The KNOWN LIMIT above explains why that tree cannot be
// equality-checked; an earlier revision carried a `startsWith('docs/')` softening
// branch here, which became unreachable the moment docs came out of FILES and
// would have silently loosened the check for whoever put one back (flagged in
// review, 2026-09-03). Better to stop and make them read the note.
const stray = FILES.find((f) => f.startsWith('docs/'));
if (stray) {
  console.error(`FAIL: ${stray} is in FILES, but docs/ cannot be equality-checked -- read the KNOWN LIMIT note above.`);
  process.exit(1);
}

let failed = 0;
for (const rel of FILES) {
  const p = join(REPO, rel);
  if (!existsSync(p)) continue;
  readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
    // Pin context only: the line must be about the explorer AND about pinning it.
    if (!/explorer/i.test(line)) return;
    if (!/\bpin(ned|s)?\b|profile/i.test(line)) return;
    const ids = [...new Set((line.match(/gpt-[0-9][0-9a-z.\\-]*/g) || []).map((s) => s.replace(/\\/g, '').replace(/\.$/, '')))];
    // Only a REAL allowlisted id can be a pin value. This deliberately ignores
    // narrative tokens that are not pins and were false positives in the first
    // version: bare `gpt-5` (a family, e.g. "an explorer on gpt-5"), the
    // deliberately-invalid `gpt-5.6-bogus` used in probe write-ups, and
    // `gpt-4.1`, which these lines WARN about rather than pin.
    // BLIND SPOT 1, found on PR #37: a single line can be BOTH an allowlist and
    // a pin statement. SKILL.md:30 enumerates all six model ids AND, 400 chars
    // later on the same line, said "explorer.toml pinned to gpt-5.5 or it
    // refuses". The old "3+ ids means allowlist, skip the line" rule skipped the
    // whole line and never saw the stale pin. So before that rule applies, pull
    // out any EXPLICIT pin clause and check it on its own.
    // Match ANY allowlisted id named within ~140 chars AFTER `explorer.toml` on
    // a pin-context line, rather than only the "pinned to <id>" phrasing. The
    // narrower version missed "checks explorer.toml for the <id> pin", which is
    // exactly how SKILL.md:30 words it -- and line 30 is the allowlist line, so
    // the fallback check below skips it and this pass is its ONLY coverage.
    // Scan EVERY id in each clause, not just the first. The previous version
    // used matchAll with the id inside the pattern, so each match consumed
    // through the FIRST id and a second one in the same window was never seen --
    // e.g. "explorer.toml ... gpt-5.6-luna ... or gpt-5.5" would pass. Take the
    // bounded window after each `explorer.toml` and check all of it.
    for (const anchor of line.matchAll(/explorer\.toml/gi)) {
      const window = line.slice(anchor.index, anchor.index + 160).split('.md')[0];
      for (const idm of window.matchAll(/gpt-[0-9][0-9a-z.-]*/gi)) {
        const id = idm[0].replace(/\.$/, '');
        if (ALLOWLIST.has(id) && id !== CANON) {
          console.log(`DRIFT ${rel}:${i + 1} pin clause names '${id}', guard demands '${CANON}'`);
          console.log(`      ...${window.slice(0, 130)}`);
          failed = 1;
        }
      }
    }
    const pinnable = ids.filter((id) => ALLOWLIST.has(id));
    // A line enumerating 3+ distinct ids is an allowlist, not a pin statement --
    // but only AFTER the explicit-pin-clause pass above has had a look at it.
    if (pinnable.length >= 3) return;
    for (const id of pinnable) {
      if (id !== CANON) {
        console.log(`DRIFT ${rel}:${i + 1} names '${id}', guard demands '${CANON}'`);
        console.log(`      ${line.trim().slice(0, 150)}`);
        failed = 1;
      }
    }
  });
}

// BLIND SPOT 2, found on PR #37: a stale claim need not contain a model id at
// all. SKILL.md:117 read "Refuses if the explorer pin is missing" -- zero ids on
// the line, so an id-comparison guard is blind to it BY CONSTRUCTION, no matter
// how the line rules are tuned. Since 2026-09-03 the runtime WARNS and proceeds,
// so any live surface still promising a refusal is simply wrong. Checked as
// language, not as a value.
for (const rel of FILES) {
  const p = join(REPO, rel);
  if (!existsSync(p)) continue;
  readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
    // Must be about the EXPLORER PIN specifically. `--complex` alone is too
    // broad: codex-worker.md:149 says a resume with --complex must NOT be
    // refused/mislabelled, which is about resume mode-scoping, not the gate.
    if (!/explorer/i.test(line)) return;
    if (!/\brefus(e|es|ed|al|ing)\b/i.test(line)) return;
    // Discriminator, deliberately dumb: every CORRECT line now says WARNS,
    // because that is what the runtime does. An earlier attempt enumerated
    // negations (no longer refuses, false refusal, ...) and kept missing
    // phrasings -- it went red at baseline on lines that were already right.
    // Worse, writing that pattern from Python turned \b into a literal
    // BACKSPACE byte, so the exclusion silently matched nothing. Presence of
    // 'warn' is a far more reliable signal than absence of every negation.
    // "warn" ALONE is not enough, and that was a real hole: "the pin warning is
    // emitted, then execution refuses" contains "warn" and would have been
    // suppressed while asserting exactly the behaviour this check exists to
    // catch. Require warn AND explicit proceed / non-refusal wording.
    if (/\bwarn/i.test(line) && /\bproceed|no longer refus|does not refus|doesn't refus|not refuse|instead of refus/i.test(line)) return;
    // Past tense is a different claim from a promise. One narrow exclusion,
    // not an open-ended negation list: 'This USED TO REFUSE ...' is history.
    if (/\bused to\b/i.test(line)) return;
    console.log(`STALE ${rel}:${i + 1} still promises a refusal; --complex warns and proceeds since 2026-09-03`);
    console.log(`      ${line.trim().slice(0, 140)}`);
    failed = 1;
  });
}

// The live machine file is not in the repo, so disagreement is a warning, not a
// failure. Since 2026-09-03 the runtime only WARNS on a mismatch too (§17: an
// A/B with the file deleted found identical fan-out and zero gpt-4.1), so a
// mismatch no longer blocks anything -- it just means the repo and the machine
// disagree about a value neither has been shown to use.
const LIVE = join(homedir(), '.codex', 'agents', 'explorer.toml');
if (existsSync(LIVE)) {
  const lm = readFileSync(LIVE, 'utf8').match(/^\s*model\s*=\s*["']([^"']+)/m);
  const liveModel = lm ? lm[1] : '(unset)';
  if (liveModel !== CANON) console.log(`WARN: ${LIVE} pins '${liveModel}', repo expects '${CANON}' -- '--complex' WARNS and proceeds (no longer refuses)`);
  else console.log(`OK: live explorer.toml pins ${liveModel}`);
}

console.log(failed ? 'FAILED: explorer-pin references disagree' : `OK: every explorer-pin reference names ${CANON}`);
process.exit(failed);
