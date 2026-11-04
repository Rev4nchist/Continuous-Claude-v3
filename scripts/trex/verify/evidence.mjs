// evidence.mjs: turn raw runner output into the inputs verdict.mjs wants. Pure functions, no I/O, no Docker, no model.
//
//   runFromStep(step)            step {code, stdout, stderr, timedOut} -> verdict.mjs Run { exitClass, failLine, normalizedOutput }
//   normalizeOutput(text)        drops volatile tokens so two runs of the same probe compare equal (G6)
//   observedValue(...)           G9(a): the matched failure text is not a literal of the probe source
//   hunkRevertChanged(...)       G9(b): reverting the cited hunk turned a failing probe into a passing one
//   tamperedFiles(porcelain)     G5: the paths `git status --porcelain` lists outside /app/.verify/
//
// The failing-line shapes and the broken-run markers are prove-check's: classifyRun is imported, not copied.
// Probe protocol: a probe prints TAP failing lines (`not ok 1 - <what happened, with the value the app returned>`) and exits 1.

import { classifyRun } from '../../checks/prove-check.mjs';

const ANY_FAILING_LINE = '.';

/** broken-run text from classifyRun -> the verdict.mjs `broken:<kind>` kind. */
function brokenKind(why) {
  const w = String(why);
  if (/timed out|no exit code/.test(w)) return 'timeout';
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|is not exported|does not provide an export|cannot import/i.test(w)) return 'import';
  if (/SyntaxError|error TS\d+/.test(w)) return 'compile';
  return 'error';
}

/** Out of memory: the process was killed with exit 137 (SIGKILL, the OOM killer), or a runtime printed "out of memory". */
const isOom = (run) => run.code === 137 || /out of memory/i.test(`${run.stdout}\n${run.stderr}`);

const ANSI = /\u001b\[[0-9;]*m/g;
const VOLATILE = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/0x[0-9a-f]{6,}/gi, '<addr>'],
  [/\b\d+(?:\.\d+)?\s?ms\b/g, '<ms>'],
  [/\bpid[ =:]*\d+/gi, 'pid <n>'],
  [/\/tmp\/[\w.-]+/g, '/tmp/<x>'],
];

/** Text with ANSI codes, timestamps, uuids, addresses, durations, pids and temp paths removed. A random number in the text is NOT removed. */
export function normalizeOutput(text) {
  let t = String(text ?? '').replace(ANSI, '');
  for (const [re, to] of VOLATILE) t = t.replace(re, to);
  return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
}

/**
 * One probe run as a verdict.mjs Run. A timeout, an import or compile error, a crash with no failing line and an unrunnable spawn are
 * `broken:<kind>`. Exit 0 with no failing line is `pass`. Any failing line is an `assert-fail` and its first line is the failLine.
 */
export function runFromStep(step) {
  const timedOut = step?.timedOut === true;
  const run = { code: timedOut ? null : (step?.code ?? null), stdout: step?.stdout ?? '', stderr: step?.stderr ?? '', error: timedOut ? 'timed out' : undefined };
  const c = classifyRun({ fireMatch: ANY_FAILING_LINE, cmd: [] }, run);
  if (c.verdict === 'broken') return { exitClass: `broken:${isOom(run) ? 'oom' : brokenKind(c.why)}`, failLine: null, normalizedOutput: normalizeOutput(c.why) };
  if (c.verdict === 'fire') return { exitClass: 'assert-fail', failLine: c.fireLine, normalizedOutput: normalizeOutput(c.fireLine) };
  return { exitClass: 'pass', failLine: null, normalizedOutput: '' };
}

/**
 * G9(a): the failure carries a value the app returned. The part of the failing line that the declared fireMatch matched must not
 * appear as a literal in the probe source. An unconditional `not ok ... ZETA` fails this, because ZETA is in the source.
 */
export function observedValue(failLine, fireSource, probeSource) {
  let m = null;
  try { m = new RegExp(fireSource).exec(String(failLine ?? '')); } catch { return false; }
  if (!m || m[0] === '') return false;
  return !String(probeSource ?? '').includes(m[0]);
}

/** G9(b): the head run failed on its assertion and the run with the cited hunk reverted passes. Broken reruns (a deleted file) never count. */
export function hunkRevertChanged(headRun, revertedRun) {
  return headRun?.exitClass === 'assert-fail' && revertedRun?.exitClass === 'pass';
}

/** Paths from `git status --porcelain` output that lie outside .verify/. Renames list both sides. */
export function tamperedFiles(porcelain) {
  const paths = [];
  for (const line of String(porcelain ?? '').split('\n')) {
    if (line.length < 4) continue;
    for (const p of line.slice(3).split(' -> ')) paths.push(p.replace(/^"|"$/g, ''));
  }
  return paths.filter((p) => p !== '.verify' && !p.startsWith('.verify/'));
}
