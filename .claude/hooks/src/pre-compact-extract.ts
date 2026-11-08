#!/usr/bin/env node
/**
 * Pre-Compact Memory Extract Hook
 *
 * L0 Defense Layer: Extracts thinking blocks BEFORE context compression.
 * This prevents early session insights from being lost to compaction.
 *
 * Hook: PreCompact
 * Trigger: Before Claude compacts context (manual or auto)
 *
 * Key Insight: PreCompact has JSONL transcript access, so we can extract
 * thinking blocks that are about to be "forgotten" before they're summarized away.
 *
 * State tracked in: .claude/extraction-state.json (per session; see shared/extraction-state.ts)
 */

import * as fs from 'fs';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';
import * as path from 'path';
import { mutateStateWithLock } from './shared/atomic-write.js';
import {
  parseState,
  sessionStartLine,
  inCooldown,
  withLaunchStamp,
  type ExtractionStateV2,
} from './shared/extraction-state.js';

export interface PreCompactInput {
  trigger: 'manual' | 'auto';
  session_id: string;
  transcript_path: string;
  custom_instructions?: string;
}

export interface HookOutput {
  continue: boolean;
  systemMessage?: string;
}

interface ExtractionResult {
  learnings_stored: number;
  learnings_skipped: number;
  learnings_deduped: number;
  new_last_line: number;
  hashes: string[];
  errors: string[];
}

function getOpcDir(): string {
  return process.env.CLAUDE_OPC_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'continuous-claude', 'opc');
}

function getStateFilePath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'extraction-state.json');
}

function readStateOrNull(stateFile: string): string | null {
  try {
    return fs.readFileSync(stateFile, 'utf-8');
  } catch {
    return null;
  }
}

function runBackgroundExtraction(
  transcriptPath: string,
  sessionId: string,
  startLine: number,
  stateFile: string,
  projectDir: string
): boolean {
  const opcDir = getOpcDir();
  const extractScript = path.join(opcDir, 'scripts', 'core', 'incremental_extract.py');

  if (!fs.existsSync(extractScript)) {
    console.error(`incremental_extract.py not found at ${extractScript}`);
    return false;
  }

  try {
    const child = spawnDetachedHidden('uv', [
      'run', 'python', 'scripts/core/incremental_extract.py',
      '--transcript', transcriptPath,
      '--session-id', sessionId,
      '--start-line', startLine.toString(),
      '--state-file', stateFile,
      '--project-dir', projectDir,
      '--max-learnings', '5',
      '--json'
    ], {
      cwd: opcDir,
      stdio: 'ignore',
      env: { ...process.env, PYTHONPATH: opcDir },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface ExtractDeps {
  launcher?: (a: LaunchArgs) => boolean;
  now?: () => number;
}

export interface LaunchArgs {
  transcriptPath: string;
  sessionId: string;
  startLine: number;
  stateFile: string;
  projectDir: string;
}

const COOLDOWN_MS = 5 * 60 * 1000;

/** Decide, launch and stamp for one PreCompact event. Pure of stdin/stdout. */
export function runPreCompactExtract(
  data: PreCompactInput,
  projectDir: string,
  deps: ExtractDeps = {}
): HookOutput {
  const launcher = deps.launcher ?? ((a: LaunchArgs) =>
    runBackgroundExtraction(a.transcriptPath, a.sessionId, a.startLine, a.stateFile, a.projectDir));
  const now = deps.now ?? Date.now;
  const sessionId = data.session_id;
  const transcriptPath = data.transcript_path;

  // Extraction fires on ALL compact events regardless of trigger type

  // Need transcript path for extraction
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { continue: true, systemMessage: '[PreCompact] No transcript available for extraction' };
  }

  const stateFile = getStateFilePath(projectDir);
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  } catch { /* fail open: the launch still runs, the stamp may not land */ }

  const launchFor = (state: ExtractionStateV2): boolean => launcher({
    transcriptPath,
    sessionId,
    startLine: sessionStartLine(state, sessionId),
    stateFile,
    projectDir,
  });

  // Cooldown check, start line, launch and stamp are ONE read-modify-write under
  // the state lock, so two hooks cannot interleave a read and a stamp. The stamp
  // lands only after a successful launch, so a failed launch starts no cooldown.
  // State is per session: a session never reads another session's line.
  let ran = false;
  let cooling = false;
  let launched = false;
  mutateStateWithLock(stateFile, (current) => {
    ran = true;
    const state = parseState(current);
    if (inCooldown(state, sessionId, now(), COOLDOWN_MS)) {
      cooling = true;
      return null;
    }
    launched = launchFor(state);
    return launched ? JSON.stringify(withLaunchStamp(state, sessionId, now()), null, 2) : null;
  });

  if (!ran) {
    // Lock timeout or unreadable file: fail open as before. Launch without a stamp.
    const state = parseState(readStateOrNull(stateFile));
    if (inCooldown(state, sessionId, now(), COOLDOWN_MS)) cooling = true;
    else launched = launchFor(state);
  }

  if (cooling) {
    return { continue: true, systemMessage: '[PreCompact:L0] Cooldown active, skipping extraction' };
  }

  const message = launched
    ? '[PreCompact:L0] Memory extraction launched (background)'
    : '[PreCompact:L0] Memory extraction unavailable';

  return { continue: true, systemMessage: message };
}

async function main() {
  // Recursion sentinel (07-09 R2, 2026-07-24): the LLM distiller spawned by
  // incremental_extract.py runs a headless claude session with
  // CCV3_DISTILL_CHILD=1. Never extract from that child — extraction ->
  // distiller -> extraction would cascade.
  if (process.env.CCV3_DISTILL_CHILD) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  let data: PreCompactInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  console.log(JSON.stringify(runPreCompactExtract(data, projectDir)));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

if ((process.argv[1] || '').includes('pre-compact-extract')) {
  main().catch(err => {
    console.error('pre-compact-extract error:', err);
    console.log(JSON.stringify({ continue: true }));
  });
}
