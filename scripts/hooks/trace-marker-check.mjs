/**
 * trace-marker-check -- the static half of "the tracer cannot die silently". hook-contract-guard.mjs calls it.
 *
 * The tracer (.claude/hooks/src/lib/trace-boot.ts) reaches every bundle through the esbuild `--inject` flag in
 * .claude/hooks/package.json scripts.build:raw (scripts.build runs the run-lock wrapper, which runs build:raw). Two things can remove it without any test failing: the flag leaves the build line,
 * or a dist is built before the flag existed. This check proves the REPO dist; the harness doctor's hooks:trace-fresh proves the live copy.
 *
 * Findings (kind):
 *   trace-inject-missing           scripts.build has no --inject:src/lib/trace-boot.ts
 *   trace-marker-vacuous           no registered name has a dist file: 0 of 0 proves nothing
 *   trace-marker-missing           a registered name has a dist file without the marker
 *   trace-boot-call-missing        a dist has the marker but not the injected boot call (the marker alone does not prove the tracer runs:
 *                                  another import of trace-boot carries it too). The call carries a sentinel string argument, quoted.
 *   trace-marker-count-regression  fewer dists with marker AND boot call than `minCount`
 * A registered name with no dist file (a plugin or dist-only hook) is skipped, as the contract guard skips it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TRACE_MARKER = '__CCV3_HOOK_TRACE_V1__';
/** The sentinel argument of the module-level bootTrace(...) statement in .claude/hooks/src/lib/trace-boot.ts. Only that statement carries it. */
export const BOOT_CALL_TOKEN = '__CCV3_HOOK_TRACE_BOOT_V1__';
const BOOT_CALL = new RegExp(`["']${BOOT_CALL_TOKEN}["']`);
const INJECT_FLAG = '--inject:src/lib/trace-boot.ts';

export function traceMarkerFindings({ hooksDir, names, minCount }) {
  const findings = [];
  // `build` is the run-lock wrapper line; the esbuild line is `build:raw` (card hook-build-run-lock). Read build:raw first, then build. With neither
  // holding the flag the check still fails.
  let build = '';
  try {
    const scripts = JSON.parse(readFileSync(join(hooksDir, 'package.json'), 'utf8')).scripts;
    build = String(scripts?.['build:raw'] ?? scripts?.build ?? '');
  } catch (err) {
    findings.push({ kind: 'trace-inject-missing', detail: `cannot read scripts.build:raw or scripts.build in ${join(hooksDir, 'package.json')}: ${err.message}` });
  }
  if (build && !build.includes(INJECT_FLAG)) {
    findings.push({ kind: 'trace-inject-missing', detail: `scripts.build:raw (or scripts.build when there is no build:raw) in ${join(hooksDir, 'package.json')} has no ${INJECT_FLAG}: a rebuild drops the tracer from every bundle.` });
  }
  const present = names.filter((n) => existsSync(join(hooksDir, 'dist', `${n}.mjs`)));
  if (!present.length) {
    findings.push({ kind: 'trace-marker-vacuous', detail: `0 of ${names.length} registered names have a dist/<name>.mjs under ${hooksDir}: the marker check proved nothing.` });
    return findings;
  }
  const text = new Map(present.map((n) => [n, readFileSync(join(hooksDir, 'dist', `${n}.mjs`), 'utf8')]));
  const unmarked = present.filter((n) => !text.get(n).includes(TRACE_MARKER));
  const noCall = present.filter((n) => text.get(n).includes(TRACE_MARKER) && !BOOT_CALL.test(text.get(n)));
  if (noCall.length) {
    findings.push({ kind: 'trace-boot-call-missing', detail: `${noCall.length} registered dist(s) carry ${TRACE_MARKER} but not the boot call (${BOOT_CALL_TOKEN}): ${noCall.slice(0, 8).join(', ')}. Run npm run build in ${hooksDir}.` });
  }
  if (unmarked.length) {
    findings.push({ kind: 'trace-marker-missing', detail: `${unmarked.length} registered dist(s) lack ${TRACE_MARKER}: ${unmarked.slice(0, 8).join(', ')}. Run npm run build in ${hooksDir}.` });
  }
  const marked = present.length - unmarked.length - noCall.length;
  if (marked < minCount) {
    findings.push({ kind: 'trace-marker-count-regression', detail: `${marked} registered dists carry the trace marker and the boot call, floor is ${minCount}.` });
  }
  return findings;
}
