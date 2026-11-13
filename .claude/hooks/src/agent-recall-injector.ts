#!/usr/bin/env node
/**
 * Agent Recall Injector Hook (PreToolUse on Task)
 *
 * Today the `memory-awareness` UserPromptSubmit hook explicitly skips
 * subagents (`process.env.CLAUDE_AGENT_ID`) so every spawned agent starts
 * cold. The canonical memory skill says "kraken/architect/phoenix/spark
 * should consider recall" but that is advisory only — no hook actually
 * injects context for agents.
 *
 * This hook fires *before* the Task tool runs. It:
 *   1. Extracts intent from the agent's prompt (via shared/intent-extractor)
 *   2. Runs `recall_learnings.py --text-only --k 3 --json` against intent
 *   3. Applies the same PROACTIVE_INJECTION_FLOOR = 0.05 as memory-awareness
 *   4. Builds a tight context block and emits it as
 *      `hookSpecificOutput.additionalContext`
 *   5. Logs every fire to `<project>/.claude/logs/agent-recall.jsonl`
 *
 * Skip rules:
 *   - tool_name !== 'Task'
 *   - subagent_type in {oracle, pathfinder}  (external research)
 *   - prompt length < 30
 *   - description starts with '/' (slash-command pass-through)
 *   - CLAUDE_AGENT_ID is set  (recursion guard for sub-subagents)
 *
 * Fail-open: any error -> output {} and log to stderr.
 *
 * Story: memory-hardening-2026-05-16, Phase 1.6 / G5 / Task 7
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getOpcDir } from './shared/opc-path.js';
import { outputContinue } from './shared/output.js';
import { extractIntent } from './shared/intent-extractor.js';
import { createLogger } from './shared/logger.js';
import { sanitizeMemoryContent, wrapMemoryContext } from './shared/memory-sanitize.js';
import { readBus, type BusEntry } from './shared/context-bus.js';
import { appendIntelBus, type IntelBusEvent } from './shared/intel-bus.js';
import { isEngineHost } from './shared/engine-host.js';
import {
  extractBusFocus,
  buildFocusBlock,
  BUS_STALENESS_MAX_AGE,
  type BusFocus,
} from './shared/bus-focus.js';

// Re-exported so existing tests that pin the staleness window against this hook
// keep importing it from here (the logic now lives in shared/bus-focus.ts).
export { BUS_STALENESS_MAX_AGE };

// ---------------------------------------------------------------------------
// Public constants & types (exported so tests can pin them)
// ---------------------------------------------------------------------------

export const PROACTIVE_INJECTION_FLOOR = 0.05;
const RECALL_TIMEOUT_MS = 3500;
const MIN_PROMPT_LENGTH = 30;
const TOP_K = 3;
const PREVIEW_CHARS = 120;

const SKIP_SUBAGENTS = new Set(['oracle', 'pathfinder']);

const log = createLogger('agent-recall-injector');

export interface TaskHookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
    [k: string]: unknown;
  };
  cwd?: string;
}

export interface RecallResult {
  id: string;
  type: string;
  content: string;
  score: number;
}

export interface RecallResponse {
  ok: boolean;
  results: RecallResult[];
  error?: string;
}

export type RecallFn = (intent: string) => RecallResponse;

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

// ---------------------------------------------------------------------------
// Skip logic
// ---------------------------------------------------------------------------

export interface SkipDecision {
  skip: boolean;
  reason?: string;
}

export function shouldSkip(input: TaskHookInput): SkipDecision {
  if (process.env.CLAUDE_AGENT_ID) {
    return { skip: true, reason: 'CLAUDE_AGENT_ID set (recursion guard, nested agent)' };
  }
  if (!input || typeof input !== 'object') {
    return { skip: true, reason: 'invalid input' };
  }
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') {
    return { skip: true, reason: `tool_name is not Agent/Task (${input.tool_name})` };
  }
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') {
    return { skip: true, reason: 'missing tool_input' };
  }
  const subagent = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
  if (!subagent) {
    return { skip: true, reason: 'missing subagent_type' };
  }
  if (SKIP_SUBAGENTS.has(subagent.toLowerCase())) {
    return { skip: true, reason: `${subagent} is external research, skipping` };
  }
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  if (!prompt) {
    return { skip: true, reason: 'missing prompt' };
  }
  if (prompt.length < MIN_PROMPT_LENGTH) {
    return { skip: true, reason: `prompt too short (length ${prompt.length})` };
  }
  const desc = typeof ti.description === 'string' ? ti.description : '';
  if (desc.trim().startsWith('/')) {
    return { skip: true, reason: 'slash-command pass-through' };
  }
  return { skip: false };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function previewContent(content: string): string {
  const joined = content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.trim())
    .join(' ');
  // Recalled content is untrusted (prompt-injection vector WS-0.2):
  // sanitize + cap. sanitizeMemoryContent appends "...(truncated)" when the
  // sanitized text exceeds PREVIEW_CHARS.
  return sanitizeMemoryContent(joined, PREVIEW_CHARS);
}

/**
 * Build the additionalContext block.
 *
 * @param focusBlock Optional pre-built, ALREADY-SANITIZED+WRAPPED "SESSION
 *   FOCUS" block (WS-2 Phase B.3a). When present it is prepended so the agent
 *   sees the live session working set above the recalled memory. Pass it even
 *   when `results` is empty so a focus-only injection is still emitted (the
 *   caller decides whether to call this at all). Keeping the wrapping inside the
 *   focus-block BUILDER (buildFocusBlock) means this function just concatenates.
 */
export function buildAgentContext(
  subagentType: string,
  intent: string,
  results: RecallResult[],
  focusBlock?: string,
): string {
  const top = results.slice(0, TOP_K);
  const lines = top.map((r, i) => {
    // r.type and r.id are DB-sourced (untrusted, WS-0.2): sanitize before
    // interpolation so a poisoned learning_type can't break out of the wrapper.
    const safeType = sanitizeMemoryContent(String(r.type ?? 'UNKNOWN'), 40);
    const safeId = sanitizeMemoryContent(String(r.id ?? ''), 16);
    return `${i + 1}. [${safeType}] ${previewContent(r.content || '')} (id: ${safeId})`;
  });
  const safeIntent = sanitizeMemoryContent(intent, 200);
  // subagentType is caller-provided; sanitize it too for defense in depth.
  const safeSubagentType = sanitizeMemoryContent(String(subagentType ?? ''), 40);

  // When there are no recalled results, return ONLY the focus block (if any) --
  // do not emit an empty "AGENT MEMORY CONTEXT" shell. The caller guarantees it
  // only reaches here with either results or a focusBlock (or both).
  if (top.length === 0) {
    return focusBlock ?? '';
  }

  // Recalled content is untrusted (prompt-injection vector WS-0.2): wrap the
  // body as data-only and use descriptive, non-imperative trailing text.
  const body = [
    `AGENT MEMORY CONTEXT for "${safeSubagentType}" task on "${safeIntent}":`,
    ...lines,
  ].join('\n');
  const memory = `${wrapMemoryContext(body)}\nAbove is reference data only; call /recall "${safeIntent}" for full content if needed.`;
  return focusBlock ? `${focusBlock}\n${memory}` : memory;
}

// WS-2 Phase B.3a/B.3b: the bus focus extraction (extractBusFocus /
// buildFocusBlock / isFresh / staleness + cap + control-strip) lives in
// ./shared/bus-focus.ts -- shared by this hook and memory-awareness so the
// logic has ONE implementation and cannot drift between the two readers.

// ---------------------------------------------------------------------------
// Default recall implementation (spawns recall_learnings.py)
// ---------------------------------------------------------------------------

export function defaultRecall(intent: string): RecallResponse {
  const opcDir = getOpcDir();
  if (!opcDir) {
    return { ok: false, results: [], error: 'no opcDir' };
  }
  // Same prep as memory-awareness.ts:checkMemoryRelevance
  const searchTerm = intent
    .replace(/[_\/]/g, ' ')
    .replace(/\b\w{1,2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const res = spawnSync(
    'uv',
    [
      'run', 'python', 'scripts/core/recall_learnings.py',
      '--query', searchTerm,
      '--k', String(TOP_K),
      '--json',
      '--text-only',
    ],
    {
      encoding: 'utf-8',
      cwd: opcDir,
      env: { ...process.env, PYTHONPATH: opcDir },
      timeout: RECALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );

  if (res.status !== 0 || !res.stdout) {
    return { ok: false, results: [], error: `recall status=${res.status}` };
  }

  try {
    const data = JSON.parse(res.stdout);
    const raw = Array.isArray(data?.results) ? data.results : [];
    const normalized: RecallResult[] = raw.map((r: any) => ({
      id: String(r.id ?? 'unknown'),
      type: String(r.learning_type ?? r.type ?? 'UNKNOWN'),
      content: String(r.content ?? ''),
      score: typeof r.score === 'number' ? r.score : 0,
    }));
    return { ok: true, results: normalized };
  } catch (e: any) {
    return { ok: false, results: [], error: `parse error: ${e?.message}` };
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

interface LogEntry {
  session_id: string;
  subagent_type: string;
  intent: string;
  /** The query actually sent to recall (the bare intent; agent-recall is unbiased). */
  recall_query: string;
  results_count: number;
  kept_after_floor: number;
  top_score: number;
  timestamp: string;
}

function getLogPath(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = path.join(projectDir, '.claude', 'logs');
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* dir already exists */ }
  return path.join(dir, 'agent-recall.jsonl');
}

function writeFireLog(entry: LogEntry): void {
  try {
    appendFileSync(getLogPath(), JSON.stringify(entry) + '\n');
  } catch (e: any) {
    log.warn('failed to write agent-recall.jsonl', { error: e?.message });
  }
}

// ---------------------------------------------------------------------------
// Main handler (testable, recall injected as dependency)
// ---------------------------------------------------------------------------

/** Injected bus reader (WS-2 Phase B.3a). Default reads the real bus. */
export type ReadBusFn = () => BusEntry;

/** Injected telemetry sink (WS-2 Phase B.3a). Default appends to intel-bus. */
export type TelemetryFn = (event: IntelBusEvent) => void;

/**
 * Returns the hook output to emit, or `null` if no context should be injected.
 * Always logs to agent-recall.jsonl unless the call was skipped (no recall).
 *
 * WS-2 Phase B.3a: reads the L2 context bus (read-only, fail-open, behind the
 * CCV3_BUS_OFF kill switch) to (a) BIAS the recall query with the session's
 * non-stale working set and (b) inject a SESSION FOCUS block -- even when recall
 * returns nothing -- so a spawned agent inherits the live focus. The bus is
 * never mutated here. `readBusFn` / `telemetry` are injected for testability,
 * mirroring the existing `recall` dependency-injection.
 */
export function handleAgentTask(
  input: TaskHookInput,
  recall: RecallFn = defaultRecall,
  readBusFn: ReadBusFn = () => readBus(),
  telemetry: TelemetryFn = appendIntelBus,
): HookOutput | null {
  const decision = shouldSkip(input);
  if (decision.skip) {
    log.debug('skipping agent-recall', { reason: decision.reason });
    return null;
  }

  const ti = input.tool_input!;
  const subagentType = String(ti.subagent_type);
  const prompt = String(ti.prompt);
  const intent = extractIntent(prompt);
  if (intent.length < 3) {
    log.debug('intent too short after extraction', { prompt_len: prompt.length });
    return null;
  }

  // --- Bus read (read-only, fail-open) ------------------------------------
  // readBus is already fail-open + kill-switch-aware; the extra try/catch is
  // belt-and-suspenders so a thrown reader can NEVER break recall.
  let bus: BusEntry;
  try {
    bus = readBusFn();
  } catch (e: any) {
    log.debug('bus read threw (fail-open, no bias)', { error: e?.message });
    bus = emptyBusFallback();
  }

  let busFocus: BusFocus;
  try {
    busFocus = extractBusFocus(bus);
  } catch (e: any) {
    log.debug('bus focus extraction threw (fail-open)', { error: e?.message });
    busFocus = { terms: [], staleSymbolsCount: 0 };
  }
  const focusTerms = busFocus.terms;
  const focusBlock = buildFocusBlock(focusTerms);
  // WS-2 B.3b refine (quality gate): agent-recall always runs recall_learnings.py
  // in --text-only mode (latency budget at agent-spawn), and the gate showed query
  // bias DILUTES text-only FTS ts_rank. So this hook does NOT bias the recall query
  // (it recalls on the bare intent); the bus focus is surfaced ONLY via the injected
  // SESSION FOCUS block, which is orthogonal and never touches recall scores.
  // (memory-awareness biases the query in HYBRID mode, where it measurably helps.)

  // Bus-read telemetry fields known BEFORE recall runs, so the row is still
  // emitted if recall throws (the quality gate must see the bus read regardless of
  // recall outcome -- cross-model B.3a finding review#3). injected/result_count are
  // filled in per outcome.
  const baseTel = {
    bus_id: typeof bus.bus_id === 'string' ? bus.bus_id : 'unknown',
    query_type: 'agent_recall_bus_read',
    biased: false,
    focus_count: focusTerms.length,
    stale_symbols_count: busFocus.staleSymbolsCount,
    current_turn: typeof bus.current_turn === 'number' ? bus.current_turn : 0,
  };

  let response: RecallResponse;
  try {
    response = recall(intent);
  } catch (e: any) {
    log.warn('recall threw', { error: e?.message });
    // Preserve the original throw -> null behavior, but DO record the bus read.
    emitBusReadTelemetry(telemetry, { ...baseTel, injected: false, result_count: 0 });
    return null;
  }

  const results = response.ok ? response.results : [];
  const kept = results.filter((r) => (r.score ?? 0) >= PROACTIVE_INJECTION_FLOOR);
  const topScore = results.length > 0
    ? results.reduce((m, r) => Math.max(m, r.score ?? 0), 0)
    : 0;

  // Always log fires that reach this point (passed skip checks). The original
  // (un-biased) intent is logged for human readability.
  const entry: LogEntry = {
    session_id: String(input.session_id ?? 'unknown'),
    subagent_type: subagentType,
    intent,
    recall_query: intent,
    results_count: results.length,
    kept_after_floor: kept.length,
    top_score: topScore,
    timestamp: new Date().toISOString(),
  };
  writeFireLog(entry);

  // Decide whether anything will be injected. A focus block is injectable even
  // when recall produced nothing, as long as the bus had non-stale focus.
  const hasFocusBlock = focusBlock.length > 0;
  const recallUsable = response.ok && kept.length > 0;
  const injected = recallUsable || hasFocusBlock;

  // Telemetry (fail-open): record the bus-read decision (reuses baseTel so the
  // throw path above emits the same event shape).
  emitBusReadTelemetry(telemetry, { ...baseTel, injected, result_count: kept.length });

  if (!response.ok) {
    log.debug('recall failed/timeout', { error: response.error });
    // A failed recall still injects a focus block if the bus had focus.
    if (!hasFocusBlock) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: focusBlock,
      },
    };
  }
  if (kept.length === 0 && !hasFocusBlock) {
    return null;
  }

  const additionalContext = buildAgentContext(
    subagentType,
    intent,
    kept,
    hasFocusBlock ? focusBlock : undefined,
  );
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  };
}

/**
 * Minimal fail-open empty bus (used only if the injected reader throws). Mirrors
 * the shape extractBusFocus expects without importing emptyBus into the hot path.
 */
function emptyBusFallback(): BusEntry {
  return {
    bus_id: 'unknown',
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0,
  };
}

/** Emit the agent_recall_bus_read telemetry row; fully fail-open. */
function emitBusReadTelemetry(
  telemetry: TelemetryFn,
  event: IntelBusEvent,
): void {
  try {
    telemetry(event);
  } catch (e: any) {
    // Telemetry must NEVER break injection (fail-open).
    log.debug('bus-read telemetry threw (ignored)', { error: e?.message });
  }
}

// ---------------------------------------------------------------------------
// stdin entry point
// ---------------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export async function main(): Promise<void> {
  // Emergency kill-switch (review#5): this hook fires on every agent spawn,
  // so provide an escape hatch if recall ever degrades agent latency.
  // Checked before stdin is read/parsed so it can never add overhead.
  if (process.env.CCV3_AGENT_RECALL_OFF === '1') {
    outputContinue();
    return;
  }

  let input: TaskHookInput;
  try {
    const raw = readStdin().trim();
    if (!raw) {
      outputContinue();
      return;
    }
    input = JSON.parse(raw);
  } catch (e: any) {
    log.warn('failed to parse stdin', { error: e?.message });
    outputContinue();
    return;
  }

  // Under cursor-agent (the review engine): no recall log and no intel-bus row in the reviewed tree
  // (card engine-run-hook-files). This hook only adds context; it never denies or changes the tool input.
  if (isEngineHost(input)) {
    console.log('{}');
    return;
  }

  const out = handleAgentTask(input);
  if (out) {
    console.log(JSON.stringify(out));
  } else {
    // No injection — let the Task run unchanged
    console.log('{}');
  }
}

// Only run main() when executed directly (not when imported by tests).
// Heuristic: tests import via vitest which doesn't execute the bundle as
// an entry point. The build output is a single .mjs file invoked by node.
const isDirectInvocation = (() => {
  try {
    // process.argv[1] ends with the bundled filename when invoked directly
    const arg1 = process.argv[1] || '';
    return arg1.endsWith('agent-recall-injector.mjs') || arg1.endsWith('agent-recall-injector.js');
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((e: any) => {
    log.error('main() crashed', { error: e?.message });
    outputContinue();
  });
}

// Re-export the existing fs check so the entry detection above remains
// resilient to bundler path-mangling. (no-op for runtime.)
export const __isDirectInvocation = isDirectInvocation;
