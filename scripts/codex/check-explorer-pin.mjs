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

// The verified model allowlist (DESIGN-RESEARCH section 13). A pin value must be
// one of these; anything else on a pin line is narrative, not a pin.
const ALLOWLIST = new Set([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
]);
if (!ALLOWLIST.has(CANON)) {
  console.error(`FAIL: the guard's own pin '${CANON}' is not in the verified allowlist`);
  process.exit(1);
}

const FILES = [
  '.claude/agents/codex-worker.md',
  '.claude/agents/codex-adversary.md',
  '.claude/skills/codex/SKILL.md',
  '.claude/rules-src/codex-worker-safety.md',
  '.claude/rules-src/codex-adversarial.md',
];

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
    const pinnable = ids.filter((id) => ALLOWLIST.has(id));
    // A line enumerating 3+ distinct ids is an allowlist, not a pin statement.
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

// The live machine file is not in the repo, so disagreement is a warning, not a
// failure -- but it is the disagreement that actually breaks `--complex`.
const LIVE = join(homedir(), '.codex', 'agents', 'explorer.toml');
if (existsSync(LIVE)) {
  const lm = readFileSync(LIVE, 'utf8').match(/^\s*model\s*=\s*["']([^"']+)/m);
  const liveModel = lm ? lm[1] : '(unset)';
  if (liveModel !== CANON) console.log(`WARN: ${LIVE} pins '${liveModel}' -- '--complex' would REFUSE`);
  else console.log(`OK: live explorer.toml pins ${liveModel}`);
}

console.log(failed ? 'FAILED: explorer-pin references disagree' : `OK: every explorer-pin reference names ${CANON}`);
process.exit(failed);
