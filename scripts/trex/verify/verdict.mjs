/**
 * verdict.mjs - map TREX verify evidence to one verdict (design section 3). Pure: no I/O, no model, no clock.
 *
 * The harness computes every input from files, coverage data and exit codes. Agent prose never reaches this file.
 *
 * @typedef {{ exitClass: 'pass'|'assert-fail'|`broken:${string}`, failLine?: string|null, normalizedOutput?: string }} Run
 *   One probe run. `broken:<kind>` kinds: import, compile, spawn, fixture, docker-125, oom, timeout (any kind blocks).
 *   `failLine` is the assertion-class line of an `assert-fail`. `normalizedOutput` has volatile tokens removed (G6).
 *
 * @typedef {object} VerdictInput
 * @property {{ fireMatch: string, correct: string }|null} declare  The pre-registered wrong output (a regex source)
 *   and one sentence of correct behaviour. null when the author wrote none.
 * @property {boolean} declaredBeforeFirstRun  false when the declare was written after a run (G2).
 * @property {Run[]} head           Head runs, same probe bytes. Design: 2 in phase 1, 3 in phase 2.
 * @property {number} [minHeadRuns] Fewer head runs than this gives not_attempted. Default 2.
 * @property {Run|null} [base]      The merge-base run. Needed when baseReachable is true.
 * @property {boolean} [baseReachable]  false when the cited path or symbol is absent at base (git ls-tree). Default true.
 * @property {{ citedLinesExecuted: boolean|null }} [coverage]  G8. null or missing means no coverage data.
 * @property {{ observedValue: boolean, hunkRevertChanged: boolean }|null} [g9]  New code only (baseReachable false).
 * @property {boolean} [tamper]     G5: anything under /app outside /app/.verify/ changed.
 * @property {string|null} [classifyBlock]  Pre-run block reason from classify.mjs (a BLOCK_REASONS entry, with or
 *   without the "blocked:" prefix). A reason outside the enum throws: that is a caller bug.
 * @property {boolean} [dockerOk]   false only when `docker info` failed or timed out. Missing counts as up.
 * @property {boolean} [observedValue]  G9(a) at head for every fired item: the matched failing text is not a literal of the probe source.
 *   A refute from "base fires the same line" needs it true (and G8). Missing counts as false.
 * @property {boolean} [citedPathExists]  false when the cited file does not exist at head (git ls-tree): refuted.
 * @property {Run|null} [fix]       Eval control: the probe at the fix SHA (group A). Firing there is a false_confirm.
 * @property {boolean} [priorOpen]  The finding was already open at an earlier head. Echoed to applyVerdict (trust rule).
 *
 * @typedef {{ verdict: string, reason: string, rule: string, false_confirm: boolean, fix_other_fail: boolean, priorOpen: boolean }} VerdictResult
 *
 * Precedence, first match wins. This order is part of the contract:
 *   1. classifyBlock            -> blocked:<reason>          (pre-run filter; needs no run, no docker)
 *   2. dockerOk === false       -> env-down                  (ahead of G1, so an outage is not "not_attempted")
 *   3. citedPathExists === false-> refuted
 *   4. G1  no declare / no correct sentence / too few head runs -> not_attempted
 *   5. G2  late declare or a rejected fireMatch -> blocked:lint   [decision: design 3 names no verdict here;
 *          a bad declare is a lint failure of the probe, so it never counts as a pass or a miss]
 *   6. G5  tamper               -> blocked:tamper
 *   7. G3  any broken head run  -> blocked:broken-probe
 *   8. G6  head runs disagree   -> blocked:disagree
 *   9. head fail line that misses fireMatch -> blocked:broken-probe (G3: not a fire, not a pass)
 *  10. all head fire: base broken or fails elsewhere -> blocked:broken-probe; base fires -> refuted ONLY with G8 at head and
 *      observedValue true (else blocked:broken-probe: a bad probe fires on both sides);
 *      base passes -> reproduced; base unreachable: G9 ok -> reproduced_new, else unverified;
 *      base reachable but no base run -> unverified.
 *      reproduced and reproduced_new need G8 too (design: "G1-G8 pass"): unless coverage.citedLinesExecuted is true,
 *      either becomes blocked:no-coverage. unverified and a refute from a missing cited path do not depend on coverage.
 *  11. all head pass: cited lines ran -> not_reproduced; otherwise (false or null) -> blocked:no-coverage (G8)
 * "Base fires the same line" and "fix fires" both mean: the run fails on the head's normalized fail line (a fireMatch hit on another line does not count).
 * Then, on any result: a fix run that fails on that line sets false_confirm. A fix run that fails on another line sets fix_other_fail. Neither changes the verdict.
 */

export const VERDICTS = Object.freeze([
  'reproduced', 'reproduced_new', 'unverified', 'not_reproduced', 'refuted', 'env-down', 'not_attempted',
]);

/** The fixed blocked list of design section 3. */
export const BLOCK_REASONS = Object.freeze([
  'windows-only', 'mods-host', 'surface-unverifiable', 'needs-secret', 'needs-network', 'env-build', 'env-busy',
  'no_flow', 'lint', 'broken-probe', 'disagree', 'no-coverage', 'host_unmerged', 'tamper', 'agent-budget',
]);

/**
 * Severity a refuted finding gets. Design section 3 says "nit", but the review schema (local-review/prompt.mjs, review-filter.mjs
 * SEVERITY_RANK, cr-fix.mjs) has no "nit": "trivial" is the lowest real severity above "info". A test pins this to SEVERITY_RANK.
 */
export const REFUTED_SEVERITY = 'trivial';
const NOT_REPRODUCED = { severity: 'minor', confidence: 2 };
const REFUTED = { severity: REFUTED_SEVERITY, confidence: 1 };
const DEFAULT_CONFIDENCE = 3;
const MIN_LITERALS = 4;

// ---- G2: buildFireMatch ---------------------------------------------------------------------------------------

/** Escapes that are not a literal character: classes, anchors, whitespace controls, backrefs, property escapes. */
const NON_LITERAL_ESCAPE = /^[dDwWsSbBnrtfv0-9kpP]$/;

function skipEscape(p) {
  const c = p.s[p.i + 1] ?? '';
  p.i += 2;
  if (c === 'x') p.i += 2;
  else if (c === 'u') p.i = p.s[p.i] === '{' ? p.s.indexOf('}', p.i) + 1 : p.i + 4;
  else if (c === 'c') p.i += 1;
  else if ('pPk'.includes(c) && '{<'.includes(p.s[p.i])) p.i = p.s.indexOf(p.s[p.i] === '{' ? '}' : '>', p.i) + 1;
  return c === 'x' || c === 'u' || c === 'c' ? 1 : NON_LITERAL_ESCAPE.test(c) ? 0 : 1;
}

function skipClass(p) {
  p.i += 1;
  while (p.i < p.s.length && p.s[p.i] !== ']') p.i += p.s[p.i] === '\\' ? 2 : 1;
  p.i += 1;
  return 0;
}

function parseGroup(p) {
  p.i += 1;
  let counts = true;
  if (p.s[p.i] === '?') {
    const m = /^\?(<[=!]|=|!|:|<[^>]+>)/.exec(p.s.slice(p.i));
    const head = m ? m[1] : '';
    counts = !/^(<[=!]|=|!)$/.test(head);
    p.i += m ? m[0].length : 1;
  }
  const inner = parseAlt(p);
  p.i += 1;
  return counts ? inner : 0;
}

function parseItem(p) {
  const c = p.s[p.i];
  if (c === '(') return parseGroup(p);
  if (c === '[') return skipClass(p);
  if (c === '\\') return skipEscape(p);
  p.i += 1;
  if (c === '.' || c === '^' || c === '$') return 0;
  return /\s/.test(c) ? 0 : 1;
}

/** How many times the item must repeat: 0 for * ? {0,..}, n for {n} {n,}, 1 for + and for no quantifier. */
function parseQuant(p) {
  const rest = p.s.slice(p.i);
  const brace = /^\{(\d+)(?:,\d*)?\}\??/.exec(rest);
  if (brace) {
    p.i += brace[0].length;
    return Number(brace[1]);
  }
  const m = /^([*+?])\??/.exec(rest);
  if (!m) return 1;
  p.i += m[0].length;
  return m[1] === '+' ? 1 : 0;
}

function parseSeq(p) {
  let total = 0;
  while (p.i < p.s.length && p.s[p.i] !== '|' && p.s[p.i] !== ')') {
    const n = parseItem(p);
    total += n * parseQuant(p);
  }
  return total;
}

function parseAlt(p) {
  let min = parseSeq(p);
  while (p.s[p.i] === '|') {
    p.i += 1;
    min = Math.min(min, parseSeq(p));
  }
  return min;
}

/** Non-space literal characters that every match of the pattern must contain (the shortest alternative decides). */
const guaranteedLiterals = (source) => parseAlt({ s: source, i: 0 });

const reject = (reason, detail) => ({ ok: false, reason, detail });

/**
 * G2: turn the declared wrong output into the match rule, or reject it. Never throws.
 * Rejects: no declare, a non-string pattern, an invalid regex, a pattern that matches '' (so '' and '.*' and
 * '.+' lookalikes), and a pattern with fewer than 4 literal characters in its shortest alternative.
 * @returns {{ ok: true, source: string, re: RegExp } | { ok: false, reason: string, detail: string }}
 */
export function buildFireMatch(declare) {
  if (!declare || typeof declare !== 'object') return reject('no-declare', 'no declare block');
  const source = declare.fireMatch;
  if (typeof source !== 'string') return reject('no-pattern', 'fireMatch is not a string');
  let re;
  try {
    re = new RegExp(source);
  } catch (e) {
    return reject('invalid-regex', String(e.message));
  }
  if (re.test('')) return reject('matches-empty', `pattern ${JSON.stringify(source)} matches the empty string`);
  const n = guaranteedLiterals(source);
  if (n < MIN_LITERALS) return reject('too-few-literals', `pattern ${JSON.stringify(source)} has ${n} literal characters, need ${MIN_LITERALS}`);
  return { ok: true, source, re };
}

// ---- verdict --------------------------------------------------------------------------------------------------

const out = (verdictName, rule, reason) => ({ verdict: verdictName, rule, reason });
const blocked = (reason, rule, why) => out(`blocked:${reason}`, rule, why);

/** @returns {{kind:'pass'}|{kind:'fire'}|{kind:'mismatch'}|{kind:'broken', why:string}} */
function runKind(run, re) {
  const c = run?.exitClass;
  if (c === 'pass') return { kind: 'pass' };
  if (c === 'assert-fail') return { kind: re.test(String(run.failLine ?? '')) ? 'fire' : 'mismatch' };
  if (typeof c === 'string' && c.startsWith('broken:')) return { kind: 'broken', why: c.slice(7) || 'unknown' };
  return { kind: 'broken', why: `unknown exit class ${JSON.stringify(c)}` };
}

/**
 * The normalized fail line of a run: normalizedOutput when both runs carry one (G6 uses the same field), else the trimmed failLine.
 * "The same line" in G4 and in the control arm means this value is equal on head and on the other side. A fireMatch hit alone is not enough:
 * a probe with a second assertion fails on a different line that can still carry the declared text.
 */
function sameFailLine(a, b) {
  if (a?.exitClass !== 'assert-fail' || b?.exitClass !== 'assert-fail') return false;
  const key = (r) => (typeof r.normalizedOutput === 'string' && r.normalizedOutput !== '' ? r.normalizedOutput : null);
  if (key(a) !== null && key(b) !== null) return key(a) === key(b);
  return String(a.failLine ?? '').trim() === String(b.failLine ?? '').trim();
}

function normalizeBlock(raw) {
  const reason = String(raw).replace(/^blocked:/, '');
  if (!BLOCK_REASONS.includes(reason)) throw new RangeError(`classifyBlock "${raw}" is not in the blocked enum`);
  return reason;
}

function stepPreRun(x) {
  if (x.classifyBlock) return blocked(normalizeBlock(x.classifyBlock), 'classify', `pre-run filter: ${x.classifyBlock}`);
  if (x.dockerOk === false) return out('env-down', 'env', 'docker info failed or timed out before the run');
  if (x.citedPathExists === false) return out('refuted', 'path', 'the cited file does not exist at head');
  return null;
}

function stepG1(x) {
  const d = x.declare;
  if (!d || typeof d !== 'object') return out('not_attempted', 'G1', 'no declare block');
  if (typeof d.correct !== 'string' || d.correct.trim() === '') return out('not_attempted', 'G1', 'declare has no correct-behaviour sentence');
  const n = Array.isArray(x.head) ? x.head.length : 0;
  if (n === 0) return out('not_attempted', 'G1', 'no head run');
  const need = Number.isInteger(x.minHeadRuns) && x.minHeadRuns > 0 ? x.minHeadRuns : 2;
  if (n < need) return out('not_attempted', 'G1', `${n} of ${need} required head runs`);
  return null;
}

function stepG2(x, ctx) {
  if (x.declaredBeforeFirstRun !== true) return blocked('lint', 'G2', 'declare was written after the first run');
  const m = buildFireMatch(x.declare);
  if (!m.ok) return blocked('lint', 'G2', `fireMatch rejected: ${m.reason} (${m.detail})`);
  ctx.re = m.re;
  return null;
}

function stepG5(x) {
  return x.tamper === true ? blocked('tamper', 'G5', 'a file under /app outside /app/.verify/ changed') : null;
}

function stepG3G6(x, ctx) {
  ctx.kinds = x.head.map((r) => runKind(r, ctx.re));
  const bad = ctx.kinds.find((k) => k.kind === 'broken');
  if (bad) return blocked('broken-probe', 'G3', `head run broken: ${bad.why}`);
  if (new Set(ctx.kinds.map((k) => k.kind)).size > 1) return blocked('disagree', 'G6', 'head runs disagree');
  const outs = x.head.map((r) => r?.normalizedOutput);
  if (outs.every((o) => typeof o === 'string') && new Set(outs).size > 1) {
    return blocked('disagree', 'G6', 'head runs agree on outcome but differ after normalisation');
  }
  if (ctx.kinds[0].kind === 'mismatch') {
    return blocked('broken-probe', 'G3', 'head failure line does not match the declared fireMatch');
  }
  return null;
}

function stepHeadFires(x, ctx) {
  if (x.baseReachable === false) return g9Verdict(x.g9);
  const base = x.base;
  if (!base) return out('unverified', 'G4', 'base reachable but no base run');
  const k = runKind(base, ctx.re);
  if (k.kind === 'fire' && sameFailLine(base, x.head[0])) return refutedByBase(x);
  if (k.kind === 'pass') return out('reproduced', 'G4', 'head fires on every run, base passes');
  const why = k.kind === 'broken' ? `base run broken: ${k.why}` : 'base fails on a different line';
  return blocked('broken-probe', 'G4', why);
}

/**
 * Base fires the same line as head. That is a refute only when the probe is shown to be good: the cited lines ran at head (G8) and the
 * failing line carries a value the app returned (G9(a), x.observedValue). A probe that fails off the cited path, or fails by itself,
 * fires the same line on both sides too, so without these two it is blocked:broken-probe, never a cut of the finding.
 */
function refutedByBase(x) {
  if (x.coverage?.citedLinesExecuted !== true) {
    return blocked('broken-probe', 'G4', 'base fires the same line, but the cited lines are not shown as executed at head: a probe that is off the cited path');
  }
  if (x.observedValue !== true) {
    return blocked('broken-probe', 'G4', 'base fires the same line, but the failing line carries no value the app returned (G9 a): a probe that fails by itself');
  }
  return out('refuted', 'G4', 'base fires the same fireMatch, the cited lines ran and the fail line carries an observed value: pre-existing');
}

function g9Verdict(g9) {
  if (g9?.observedValue === true && g9?.hunkRevertChanged === true) {
    return out('reproduced_new', 'G9', 'base cannot reach the path; value observed, hunk revert changed the outcome');
  }
  const why = !g9 ? 'no G9 result' : g9.observedValue !== true ? 'failing line carries no value the app returned' : 'hunk revert did not change the outcome';
  return out('unverified', 'G9', `base cannot reach the path and G9 failed: ${why}`);
}

function stepHeadPasses(x) {
  if (x.coverage?.citedLinesExecuted === true) return out('not_reproduced', 'G8', 'head passes on every run and the cited lines ran');
  return blocked('no-coverage', 'G8', 'head passes but the cited lines are not shown as executed');
}

const NEEDS_COVERAGE = new Set(['reproduced', 'reproduced_new']);

/** G8 for a fire: a reproduction counts only when the cited lines are shown as executed. */
function requireCoverage(x, r) {
  if (!NEEDS_COVERAGE.has(r.verdict) || x.coverage?.citedLinesExecuted === true) return r;
  return blocked('no-coverage', 'G8', `${r.verdict} found, but the cited lines are not shown as executed`);
}

function decide(x, ctx) {
  const early = stepPreRun(x) ?? stepG1(x) ?? stepG2(x, ctx) ?? stepG5(x) ?? stepG3G6(x, ctx);
  if (early) return early;
  return ctx.kinds[0].kind === 'fire' ? requireCoverage(x, stepHeadFires(x, ctx)) : stepHeadPasses(x);
}

/**
 * The eval control. false_confirm only when the fix run fails on the head's own normalized fail line. A fix run that fails on any other
 * line is a probe defect (it asserts something the finding does not claim): false_confirm stays false and fix_other_fail is true.
 */
function fixControl(x, ctx) {
  const fix = x.fix;
  if (!ctx.re || fix?.exitClass !== 'assert-fail') return { falseConfirm: false, otherFail: false };
  const head = Array.isArray(x.head) ? x.head[0] : null;
  const same = runKind(fix, ctx.re).kind === 'fire' && sameFailLine(fix, head);
  return { falseConfirm: same, otherFail: !same };
}

/**
 * Map evidence to one verdict. Throws only on a classifyBlock reason outside the enum.
 * @param {VerdictInput} [input]
 * @returns {VerdictResult}
 */
export function verdict(input) {
  const x = input && typeof input === 'object' ? input : {};
  const ctx = { re: null, kinds: [] };
  const r = decide(x, ctx);
  const control = fixControl(x, ctx);
  return { ...r, false_confirm: control.falseConfirm, fix_other_fail: control.otherFail, priorOpen: x.priorOpen === true };
}

// ---- applyVerdict ---------------------------------------------------------------------------------------------

/** Higher is more severe. The review schema's words only (same order as review-filter SEVERITY_RANK). */
const SEVERITY_RANK = { critical: 5, major: 4, minor: 3, trivial: 2, info: 1 };
const TRUST = { reproduced: 'differential', reproduced_new: 'new-code' };

/** The lower of the current severity and the target. An unknown severity is left alone. */
function lowerSeverity(current, target) {
  const cur = SEVERITY_RANK[current];
  return cur === undefined || cur <= SEVERITY_RANK[target] ? current : target;
}

const lowerConfidence = (current, target) => Math.min(typeof current === 'number' && Number.isFinite(current) ? current : DEFAULT_CONFIDENCE, target);

/**
 * Apply a verdict to a finding. Returns a NEW finding and never mutates the input. Never raises severity or
 * confidence. not_reproduced -> minor / 2. refuted -> trivial / 1, kept (rule S4: never deleted). Others unchanged.
 * `v.priorOpen` true holds the downgrade (first-sighting trust rule); `verify.held` records that.
 * DESIGN CHANGE (deliberate): design section 3 says the downgrade is "first sighting only" and names not_reproduced. Here priorOpen
 * holds BOTH not_reproduced and refuted. A refute that lowers a finding Dave already saw open is the riskier error, so it waits too.
 * Re-applying keeps the first originalSeverity and originalConfidence.
 * @param {object} finding
 * @param {VerdictResult|string} v  A verdict() result, or a bare verdict string.
 */
export function applyVerdict(finding, v) {
  const res = typeof v === 'string' ? { verdict: v } : v ?? {};
  const target = res.verdict === 'not_reproduced' ? NOT_REPRODUCED : res.verdict === 'refuted' ? REFUTED : null;
  const held = Boolean(target) && res.priorOpen === true;
  const next = { ...finding };
  if (target && !held) {
    next.severity = lowerSeverity(finding.severity, target.severity);
    next.confidence = lowerConfidence(finding.confidence, target.confidence);
  }
  const prior = finding.verify ?? {};
  next.verify = {
    verdict: res.verdict,
    reason: res.reason ?? '',
    originalSeverity: prior.originalSeverity ?? finding.severity,
    originalConfidence: prior.originalConfidence !== undefined ? prior.originalConfidence : finding.confidence ?? null,
    trust: TRUST[res.verdict] ?? null,
    held,
  };
  return next;
}
