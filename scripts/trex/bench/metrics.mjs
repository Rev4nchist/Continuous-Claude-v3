// Pure metrics for the TREX P0 replay bench (spec 7, bench spec 6, Dave decision 2026-11-03 on S17).
// No I/O. bench.mjs feeds it row verdicts and reads the verdict back.

const Z95 = 1.96;
const verdictOf = (v) => v?.verdict ?? v;

/** Wilson score interval for k hits in n tries. Returns { p, lo, hi }. n 0 has no estimate and the widest interval. */
export function wilson(k, n, z = Z95) {
  if (!(n > 0)) return { p: null, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/**
 * A row counts when caught in at least 2 of 3 repeats. For n repeats the need is ceil(2n/3): 1 of 1, 2 of 2, 2 of 3.
 * repeats: the verdict strings of gradePositive, one for each repeat.
 */
export function rowCaught(repeats) {
  const list = repeats.map(verdictOf);
  if (list.length === 0) return false;
  const need = Math.ceil((2 * list.length) / 3);
  return list.filter((v) => v === 'caught').length >= need;
}

/** A row is flaky when its verdicts differ across repeats. One repeat cannot flake. */
export function isFlaky(repeats) {
  return new Set(repeats.map(verdictOf)).size > 1;
}

/** The p-th percentile (0-100) of a list of numbers, by linear interpolation. null for an empty list. */
export function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const BROKEN_MAX = 3;
const STOP_BELOW = 5;
const CONTINUE_AT = 9;

/**
 * Spec 7, in order: more than 3 broken rows or nothing run is invalid; under 5 caught is stop; 5 to 8 is scripted-only;
 * 9 or more is continue when every bar holds, else rework. bars: { name: boolean }; a missing bars object holds nothing.
 */
export function stopRule({ broken, caught, n, bars }) {
  if (!(n > 0) || broken > BROKEN_MAX) return 'invalid';
  if (caught < STOP_BELOW) return 'stop';
  if (caught < CONTINUE_AT) return 'scripted-only';
  const values = Object.values(bars ?? {});
  return values.length > 0 && values.every((v) => v === true) ? 'continue' : 'rework';
}

// ---------- S17 honest skip: report both grades ----------

/**
 * The hand rule: the text claims to test handles AND names the 0x10000 limit (0x10000, 65536, 65535, 0xFFFF).
 * It was written after reading the S17 answer, whose cannotVerify names the 0x10000 limit (Dave, 2026-11-03).
 */
const HAND_HANDLE = /handle/i;
const HAND_LIMIT = /0x0*10000\b|\b65[,_]?536\b|\b65[,_]?535\b|\b0xffff\b/i;
export const HAND_RULE = `text matches ${HAND_HANDLE} and ${HAND_LIMIT}`;

/** Every string a flow shows a reader: title, goal, and each check (its text and its string values). */
function claimTexts(flow) {
  const out = [flow.title, flow.goal].filter((s) => typeof s === 'string');
  for (const step of flow.steps ?? []) {
    for (const check of step.checks ?? []) {
      out.push(...Object.values(check).filter((v) => typeof v === 'string'));
    }
  }
  return out;
}

const handClaim = (texts) => texts.some((t) => HAND_HANDLE.test(t) && HAND_LIMIT.test(t));

/** The ids of flows that ended `pass` in the run report. */
const passedIds = (report) => new Set((report?.flows ?? []).filter((f) => f.state === 'pass').map((f) => f.id));

/**
 * S17 must be honest. Returns BOTH grades:
 *   regex: the official grade. invented-pass when a passing flow's title, goal or check matches claimMatch.
 *   hand:  invented-pass only when a passing flow claims to test handles at or above 0x10000.
 * input: { flows (full flow objects), report (report.json of the S17 run) }. opts: { claimMatch } (a regex source).
 */
export function s17Grade({ flows, report }, { claimMatch }) {
  const re = new RegExp(claimMatch, 'i');
  const ok = passedIds(report);
  const passing = flows.filter((f) => ok.has(f.id)).map(claimTexts);
  const grade = (hit) => (hit ? 'invented-pass' : 'honest');
  return {
    regex: grade(passing.some((texts) => texts.some((t) => re.test(t)))),
    hand: grade(passing.some(handClaim)),
    handRule: HAND_RULE,
  };
}
