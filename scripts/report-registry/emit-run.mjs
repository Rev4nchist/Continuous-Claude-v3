// emit-run.mjs — THE always-emit spine. One helper, every pipeline, one process.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
// The always-emit contract (write a pessimistic row BEFORE the long call, and
// update it in place after) was hand-copied into three PowerShell wrappers and
// absent from the two .bat wrappers. By 2026-08-02 the three copies had
// diverged into three distinct production defects:
//
//   * run-sweep.ps1        — the pre-emit ABORTED on 16 of 16 runs since it
//                            shipped 2026-07-25. $ErrorActionPreference='Stop'
//                            was live over the block, and `upsert.mjs ... 2>&1`
//                            turns upsert's first stderr line into a TERMINATING
//                            NativeCommandError. Caught by its own try/catch and
//                            logged "non-fatal" — daily, unread, for 8 days.
//   * sync-tasks-dashboard.ps1 — the "pessimistic pre-emit" is make-run + upsert
//                            + a refresh spawn: a real 12-17s window, not the
//                            atomic write its header comment claims.
//   * run-research.ps1     — the ONLY copy that got it right: it saves/restores
//                            $ErrorActionPreference around the emit and parses
//                            make-run's stdout defensively. Two improvements
//                            that could not propagate to its siblings.
//
// ============================================================================
// THE STRUCTURAL FIX
// ============================================================================
// make-run and upsert run IN THIS PROCESS, not as two chained native commands.
// A wrapper therefore invokes ONE child process instead of two, and there is no
// second native command whose stderr a caller can accidentally promote to a
// terminating error. The EAP/2>&1 class is removed rather than worked around.
//
// ============================================================================
// CALLER CONTRACT — read this before wiring a new wrapper (mitigation M3)
// ============================================================================
// A wrapper can still recreate the trap OUTSIDE this helper's scope, so the
// call shape is part of the contract, not an implementation detail:
//
//   1. STDOUT carries exactly one line on success: the emitted JSON path.
//      Nothing else. Parse it, or ignore it.
//   2. STDERR IS SILENT ON THE SUCCESS PATH. Deliberate: it means a healthy run
//      produces no ErrorRecord for `2>&1` to raise, so a caller running under
//      $ErrorActionPreference='Stop' cannot be killed by benign progress output.
//      (upsert/refresh chatter is captured internally and replayed only on
//      failure, or always under --verbose.)
//   3. EXIT 0 = the row landed. EXIT 1 = it did not.
//      THIS HELPER IS HONEST ABOUT FAILURE. The "registry problems must never
//      change the pipeline's exit code" rule belongs to the CALLER, which
//      should log this exit code and then ignore it. Do not make the helper lie
//      to preserve the caller's contract — that is precisely how watchdog.mjs
//      and trust-metrics.mjs became detectors that can never fail.
//   4. In PowerShell, LOWER $ErrorActionPreference TO 'Continue' LOCALLY around
//      the call, and restore it in a finally. Do not rely on redirection style.
//      CORRECTED 2026-08-03 — the original text here claimed that redirecting to
//      a file avoided the throw and that piping through ForEach-Object was the
//      culprit. That was written without probing and is FALSE. Measured on this
//      machine's real powershell.exe 5.1 (5.1.26100.8875), EAP='Stop', against a
//      native command that exits 0 while writing ONE stderr line:
//          *>>   *>   2>>   2>$null   and a bare `$x = ... 2>&1`   ALL THROW
//          piping through ForEach-Object                            THROWS
//          bare invocation with NO redirection at all                no throw
//      So ANY stderr capture throws — the redirection style is not the variable.
//      run-research.ps1's Write-RunRow has always done the local EAP save/lower/
//      restore, which is why it was the one copy of this spine that worked;
//      run-sweep.ps1 adopted it in 1f3180a. cmd.exe callers are unaffected —
//      `>> "%LOG%" 2>&1` is fine there, since cmd has no EAP concept.
//      NOTE this does not make contract #2 redundant: silent-stderr-on-success
//      means the SUCCESS path has nothing to raise, so the EAP guard is what
//      covers the FAILURE path.
//   5. --out is MANDATORY for a pre-emit whose pipeline also does a final emit
//      for the same source. The default path is $TEMP/report-run-<source>.json;
//      if the pre-emit writes there it masquerades as the final emit and an
//      `if not exist` guard on that path stops discriminating. Lesson paid for
//      in run-sweep.ps1:78-83.
//   6. Pass the SAME --runDate to the pre-emit and the final emit. runId is
//      `<type>|<period>|<runDate>` and upsert queries by Run ID, so an identical
//      stamp UPDATES the pessimistic row instead of appending a second one.
//
// ESM, no external deps. Reuses buildRun/writeRun (make-run.mjs) and
// upsertReportRun/runScopedRefresh (upsert.mjs) — no reimplementation, so
// validation and upsert semantics can never drift from the CLI path.
import { pathToFileURL } from 'node:url';
import { buildRun, writeRun, parseFlags } from './make-run.mjs';
import { upsertReportRun, runScopedRefresh } from './upsert.mjs';

// Capture console output from the imported modules so the success path stays
// silent on stderr (contract #2). ALWAYS restores, including on throw. The
// caller supplies the sink so captured chatter SURVIVES a throw and can be
// replayed by the failure path.
export function captureConsole(fn, sink = []) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => sink.push(a.map(String).join(' '));
  console.error = (...a) => sink.push(a.map(String).join(' '));
  try {
    return { value: fn(), lines: sink };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// Build the run + write it + upsert it. Transport/refresh injectable so tests
// exercise this exact path without touching Notion.
export function emitRun(opts, {
  upsert = upsertReportRun,
  refresh = runScopedRefresh,
  doUpsert = true,
  doRefresh = true,
  sink = [],
} = {}) {
  const run = buildRun(opts);
  const path = writeRun(run, { out: opts.out });
  if (!doUpsert) return { run, path, action: 'emit-only', lines: sink };

  const { value: result } = captureConsole(() => upsert(run), sink);
  if (doRefresh) captureConsole(() => refresh(run.type), sink);
  return { run, path, action: result.action, pageId: result.pageId, lines: sink };
}

export function main(sink = []) {
  const f = parseFlags(process.argv.slice(2));
  const verbose = f.verbose === true || f.verbose === 'true';
  const asJson = f.json === true || f.json === 'true';

  const out = typeof f.out === 'string' ? f.out : undefined;
  const res = emitRun(
    {
      type: f.type, period: f.period, runDate: f.runDate, status: f.status,
      source: f.source, artifactUrl: f.artifactUrl, docxUrl: f.docxUrl,
      summary: f.summary, commit: f.commit,
      corrective: f.corrective === true || f.corrective === 'true',
      out,
    },
    {
      doUpsert: !(f['no-upsert'] === true || f['no-upsert'] === 'true'),
      doRefresh: !(f['no-refresh'] === true || f['no-refresh'] === 'true'),
      sink,
    },
  );

  if (verbose && sink.length) for (const l of sink) console.error(l);
  if (asJson) {
    console.log(JSON.stringify({
      ok: true, runId: res.run.runId, path: res.path,
      action: res.action, pageId: res.pageId ?? null,
    }));
  } else {
    console.log(res.path); // Contract #1: exactly one line, the emitted path.
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // ONE sink, created here and threaded through, so the catch below can replay
  // chatter captured before the throw instead of an always-empty array.
  const sink = [];
  try {
    process.exit(main(sink));
  } catch (e) {
    // Contract #3: honest about failure. Captured chatter replayed so a
    // failure is never silent.
    console.error(`[emit-run] FAILED: ${e.message}`);
    for (const l of sink) console.error(l);
    process.exit(1);
  }
}
