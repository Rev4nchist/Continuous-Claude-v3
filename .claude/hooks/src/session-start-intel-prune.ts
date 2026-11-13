#!/usr/bin/env node
/**
 * session-start-intel-prune -- SessionStart. WS-2 Phase B (B.5).
 *
 * Wires the (previously unwired) pruneIntelBus into the session lifecycle: on each session
 * start, delete rotated intel-bus generations (`intel-bus.jsonl.1`/`.2`) older than the
 * retention window (7 days). The live log is never touched. This is the ONLY wiring of
 * pruneIntelBus; without it rotated telemetry accumulated forever.
 *
 * Fail-open: pruneIntelBus swallows all errors; this hook always emits `{}` and never blocks
 * session start. Honors CCV3_BUS_OFF (no prune when bus I/O is disabled).
 */

import { readFileSync } from 'fs';
import { pruneIntelBus } from './shared/intel-bus.js';
import { isCompactSource, parseSessionSource } from './shared/session-source.js';
import { isEngineHost } from './shared/engine-host.js';

/** Run the prune against a given project dir (default: env/cwd). Exported for the smoke test. */
export function runPrune(projectDir?: string): void {
  if (process.env.CCV3_BUS_OFF === '1') return;
  pruneIntelBus(projectDir ? { projectDir } : {});
}

function main(): void {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf-8');
  } catch {
    /* ignore */
  }
  // Under cursor-agent (the review engine): never rename or delete files in the reviewed tree (card engine-run-hook-files).
  let engine = false;
  try {
    engine = isEngineHost(JSON.parse(stdin));
  } catch {
    /* not JSON: not an engine payload */
  }
  if (engine) {
    console.log('{}');
    return;
  }
  // After /compact the prune already ran at this session's start.
  if (isCompactSource(parseSessionSource(stdin))) {
    console.log('{}');
    return;
  }
  try {
    runPrune();
  } catch {
    /* fail-open */
  }
  console.log('{}');
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].includes('session-start-intel-prune')) {
  main();
}
