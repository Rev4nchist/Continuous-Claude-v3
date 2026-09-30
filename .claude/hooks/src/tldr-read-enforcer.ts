/**
 * TLDR Read Enforcer Hook - BLOCKING VERSION (DAEMON)
 *
 * Intercepts Read tool calls for code files and BLOCKS with TLDR context.
 * Instead of reading whole large files, returns structured L1 AST context.
 *
 * Savings are measured, not folklore — see the break-even table at the size
 * threshold below and `scripts/hooks/tldr-savings-probe.mjs`. The saving is
 * monotonic in file size: small files LOSE tokens, large files win.
 *
 * Fail-open contract (remediation 2026-08-30): this hook must never deny on a
 * degraded result. Daemon unreachable → allow the read immediately. A
 * PreToolUse hook must never start a daemon.
 */

// A PreToolUse hook must NEVER start a daemon — not even in the TOCTOU window
// where the fast probe succeeded and the daemon then exited before a query.
// tryStartDaemon honors this env var after its fast liveness checks, so a
// dead daemon yields 'unavailable' (fail open) instead of a blocking spawn.
process.env.CCV3_DAEMON_NO_AUTOSTART = '1';

import { readFileSync, existsSync, statSync, unlinkSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import {
  extractDaemon,
  contextDaemon,
  cfgDaemon,
  dfgDaemon,
  sliceDaemon,
  probeDaemonFast,
  isDaemonUnreachableCached,
  cacheDaemonUnreachable,
} from './daemon-client';
import { CONTEXT_DIR } from './shared/search-context-path.js';

// Search context from smart-search-router
interface SearchContext {
  timestamp: number;
  queryType: 'structural' | 'semantic' | 'literal';
  pattern: string;
  target: string | null;
  targetType: 'function' | 'class' | 'variable' | 'import' | 'decorator' | 'unknown';
  suggestedLayers: string[];
  definitionLocation?: string;  // Where the symbol is defined
  callers?: string[];           // Cross-file: where the symbol is called/used
}

// CONTEXT_DIR is the search-context handshake dir, shared with smart-search-router.
// Resolved under os.tmpdir() in ./shared/search-context-path (QW-02).
const CONTEXT_MAX_AGE_MS = 30000; // 30 seconds backstop TTL (not the primary defence)

/**
 * Read search context from smart-search-router — with exact-path match and
 * consume-once semantics (remediation §5).
 *
 * The handshake is a single file keyed by session_id, and SUBAGENTS SHARE THE
 * PARENT'S session_id — so parallel subagents contend for one file. Two rules
 * neutralize the cross-talk without redesigning the transport:
 *  - Exact-path match: a context whose definitionLocation does not correspond
 *    to the file being read is ignored (a wrong targeted summary is worse than
 *    a generic correct one — fall back to structure mode).
 *  - Consume-once: the context file is deleted on successful use, so a stale
 *    entry cannot be replayed by a second agent inside the TTL.
 */
function getSearchContext(sessionId: string, filePath: string): SearchContext | null {
  try {
    const contextPath = `${CONTEXT_DIR}/${sessionId}.json`;
    if (!existsSync(contextPath)) return null;

    const context: SearchContext = JSON.parse(readFileSync(contextPath, 'utf-8'));

    // Backstop TTL
    if (Date.now() - context.timestamp > CONTEXT_MAX_AGE_MS) {
      return null;
    }

    // Exact-path match: only trust a targeted context when its definition
    // location names the file actually being read. No location = no way to
    // verify correspondence = ignore (structure mode is the safe default).
    if (!contextMatchesFile(context.definitionLocation, filePath)) {
      return null;
    }

    // Consume-once: this context now belongs to this read.
    try { unlinkSync(contextPath); } catch { /* best-effort */ }

    return context;
  } catch {
    return null;
  }
}

/**
 * Full normalized-path comparison, not basename `includes` — a basename match
 * accepts `my-index.ts` for `index.ts` and any same-named file in another
 * directory, which is exactly the cross-talk the exact-path rule exists to
 * stop. `definitionLocation` is `path:line` (possibly relative); strip only a
 * TRAILING `:digits` (Windows drive colons stay), normalize separators and
 * case, and require equality or a `/`-boundary suffix match in either
 * direction (one side may be relative).
 */
export function contextMatchesFile(defLoc: string | undefined, filePath: string): boolean {
  if (!defLoc) return false;
  const defPath = defLoc.replace(/:\d+$/, '');
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const a = norm(defPath);
  const b = norm(filePath);
  if (!a || !b) return false;
  return a === b || b.endsWith('/' + a) || a.endsWith('/' + b);
}

// Fail-open daemon probe (remediation §1): probeDaemonFast in daemon-client —
// a direct socket connect with a short timeout plus a shared negative cache.
// Deliberately NOT pingDaemon: pingDaemon → queryDaemon → isDaemonReachable →
// tryStartDaemon, the exact slow path (spawn + up-to-10s wait) the fail-open
// exists to avoid. A PreToolUse hook must never start a daemon.

interface HookInput {
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
    limit?: number;
    offset?: number;
  };
  cwd: string;
  transcript_path?: string;  // Path to conversation JSONL
}

// Transcript analysis removed - use Bayesian inference (search-router) instead of retrospective prediction
// See: 2026-01-11 discussion - P(intent | current action) >> P(intent | past words)

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

// Code file extensions that should use TLDR
const CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx',
  '.go', '.rs',
]);

// Files that should always be allowed (bypass TLDR)
const ALLOWED_PATTERNS = [
  /\.json$/, /\.yaml$/, /\.yml$/, /\.toml$/, /\.md$/, /\.txt$/,
  /\.env/, /\.gitignore$/, /Makefile$/, /Dockerfile$/,
  /requirements\.txt$/, /package\.json$/, /tsconfig\.json$/, /pyproject\.toml$/,
  // Allow test files (need full context for implementation)
  /test_.*\.py$/, /.*_test\.py$/, /.*\.test\.(ts|js)$/, /.*\.spec\.(ts|js)$/,
  // Allow hooks/skills (we edit these) - cross-platform path separators
  /\.claude[/\\]hooks[/\\]/, /\.claude[/\\]skills[/\\]/,
  /init-db\.sql$/, /migrations[/\\]/,
];

const ALLOWED_DIRS = ['/tmp/', 'node_modules/', '.venv/', '__pycache__/', '\\tmp\\'];

// Size floor for interception (remediation §3). Below this, TLDR overhead
// exceeds the saving. Measured break-even (138 interceptions, this repo,
// 2026-07-29 — net token effect by raw-file-size bucket; NOTE the smallest
// bucket is 3–5KB: files under 3000B were never intercepted under the prior
// policy, so they contribute no observations):
//   3–5KB   : net LOSS  (~-10k tokens across bucket)
//   5–8KB   : ~break-even
//   8–50KB  : net win
//   >50KB   : win 5-for-5
// 8000B keeps +183.7k tok across 82 cases vs +173.8k across 133 at 3000B —
// more saving, 51 fewer interceptions. Empirical fit to THIS repo's size
// distribution; re-derive rather than inherit (tldr-savings-probe.mjs).
const MIN_INTERCEPT_BYTES = 8000;

// Content-sufficiency floor (remediation §1). Symbol count alone is a weak
// proxy — a header-only payload once passed the old `results.length > 3`
// check and produced a one-function-name deny for a 12.7KB file.
const MIN_INJECTED_CHARS = 200;

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(extname(filePath));
}

function isAllowedFile(filePath: string): boolean {
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  for (const dir of ALLOWED_DIRS) {
    if (filePath.includes(dir)) return true;
  }
  return false;
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath);
  const langMap: Record<string, string> = {
    '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.go': 'go', '.rs': 'rust',
  };
  return langMap[ext] || 'python';
}

/**
 * Choose TLDR mode based on context signals.
 *
 * Simple logic: trust search-router, otherwise use structure.
 * - 'structure': Just function/class names - default
 * - 'context': Entry point focused - when search found target
 * - 'extract': Full AST dump - when advanced analysis needed
 */
type TldrMode = 'structure' | 'context' | 'extract';

function chooseTldrMode(
  target: string | null,
  layers: string[],
  contextSource: string
): { mode: TldrMode; reason: string } {
  // Only trust targets from search-router (it actually searched for them)
  // contextSource format: "function: func_name" or "class: ClassName"
  const fromSearchRouter = contextSource.startsWith('function:') || contextSource.startsWith('class:');
  if (target && fromSearchRouter) {
    return { mode: 'context', reason: `search: ${target}` };
  }

  // If advanced layers explicitly requested (cfg, dfg, pdg), use extract
  if (layers.some(l => ['cfg', 'dfg', 'pdg'].includes(l))) {
    return { mode: 'extract', reason: 'flow analysis' };
  }

  // Default: structure for navigation
  return { mode: 'structure', reason: 'navigation' };
}

/** A daemon convenience-wrapper result is a failure when it carries a non-ok
 *  status field (the wrappers return `response.result || response`). */
function daemonOk(res: any): boolean {
  return !!res && !(typeof res === 'object' && typeof res.status === 'string' && res.status !== 'ok');
}

async function getTldrContext(
  filePath: string,
  language: string,
  layers: string[] = ['ast', 'call_graph'],
  target: string | null = null,
  sessionId: string | null = null,
  contextSource: string = 'default'
): Promise<string | null> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const fileName = basename(filePath);
  const results: string[] = [];

  // Choose optimal TLDR mode
  const { mode, reason } = chooseTldrMode(target, layers, contextSource);

  try {
    // Header with mode indicator
    results.push(`# ${fileName}`);
    results.push(`Language: ${language}`);
    results.push(`Mode: ${mode} (${reason})`);
    results.push('');

    // MODE: context - focused on target function
    if (mode === 'context' && target) {
      const contextResp = await contextDaemon(projectDir, target, language, 2);
      if (daemonOk(contextResp)) {
        results.push('## Focused Context');
        results.push(typeof contextResp === 'string'
          ? contextResp
          : JSON.stringify(contextResp, null, 2));
        results.push('');
        results.push('---');
        results.push('To see more: Read with offset/limit, or ask about specific functions');
        return results.join('\n');
      }
      // Fall through to extract if context fails
    }

    // MODE: structure - just names
    // Note: use 'extract' for single files (structure is for directories)
    if (mode === 'structure') {
      const info = await extractDaemon(filePath, projectDir, sessionId || undefined);
      if (info) {
        results.push('## Structure (names only)');
        if (info.functions?.length > 0) {
          results.push('### Functions');
          for (const fn of info.functions.slice(0, 30)) {
            const params = fn.params ? `(${fn.params.slice(0, 3).join(', ')}${fn.params.length > 3 ? '...' : ''})` : '()';
            results.push(`  ${fn.name}${params}  [line ${fn.line_number || fn.line || '?'}]`);
            // Add first line of docstring for context (addresses premortem tiger)
            if (fn.docstring) {
              const firstLine = fn.docstring.split('\n')[0].trim().slice(0, 80);
              results.push(`    # ${firstLine}`);
            }
          }
        }
        if (info.classes?.length > 0) {
          results.push('### Classes');
          for (const cls of info.classes.slice(0, 20)) {
            const methods = cls.methods?.slice(0, 5).map((m: { name: string }) => m.name).join(', ') || '';
            results.push(`  ${cls.name}  [line ${cls.line_number || cls.line || '?'}]`);
            // Add first line of class docstring
            if (cls.docstring) {
              const firstLine = cls.docstring.split('\n')[0].trim().slice(0, 80);
              results.push(`    # ${firstLine}`);
            }
            if (methods) results.push(`    methods: ${methods}${cls.methods?.length > 5 ? '...' : ''}`);
          }
        }
        results.push('');
        results.push('---');
        results.push('To see full code: Read with limit=100 (or offset=N limit=M for specific lines)');
        return results.join('\n');
      }
      // Fall through to extract if failed
    }

    // MODE: extract - full AST - fallback and for editing
    // L1/L2: Extract file info (AST + Call Graph) using daemon
    // Pass session ID for token tracking (P7)
    if (layers.includes('ast') || layers.includes('call_graph') || mode === 'extract') {
      const info = await extractDaemon(filePath, projectDir, sessionId || undefined);

      if (info) {
        // Functions
        if (info.functions && info.functions.length > 0) {
          results.push('## Functions');
          for (const fn of info.functions) {
            const params = fn.params ? fn.params.join(', ') : '';
            const ret = fn.return_type ? ` -> ${fn.return_type}` : '';
            results.push(`  ${fn.name}(${params})${ret}  [line ${fn.line_number || fn.line}]`);
            if (fn.docstring) {
              const doc = fn.docstring.substring(0, 100).replace(/\n/g, ' ');
              results.push(`    # ${doc}`);
            }
          }
        }

        // Classes
        if (info.classes && info.classes.length > 0) {
          results.push('');
          results.push('## Classes');
          for (const cls of info.classes) {
            results.push(`  class ${cls.name}  [line ${cls.line_number || cls.line}]`);
            if (cls.methods) {
              for (const m of cls.methods.slice(0, 10)) {
                results.push(`    .${m.name}()`);
              }
            }
          }
        }

        // Call Graph
        if (layers.includes('call_graph') && info.call_graph && info.call_graph.calls) {
          results.push('');
          results.push('## Call Graph');
          const entries = Object.entries(info.call_graph.calls).slice(0, 15);
          for (const [caller, callees] of entries) {
            results.push(`  ${caller} -> ${callees}`);
          }
        }
      }
    }

    // L3: CFG (Control Flow Graph)
    if (layers.includes('cfg')) {
      const funcName = target || 'main';
      const cfg = await cfgDaemon(filePath, funcName, projectDir, language);

      if (daemonOk(cfg)) {
        results.push('');
        results.push(`## CFG: ${funcName}`);
        results.push(`  Blocks: ${cfg.num_blocks || 'N/A'}, Cyclomatic: ${cfg.cyclomatic_complexity || 'N/A'}`);
        if (cfg.blocks && Array.isArray(cfg.blocks)) {
          for (const b of cfg.blocks.slice(0, 8)) {
            results.push(`    Block ${b.id}: lines ${b.start_line}-${b.end_line} (${b.block_type})`);
          }
        }
      }
    }

    // L4: DFG (Data Flow Graph)
    if (layers.includes('dfg')) {
      const funcName = target || 'main';
      const dfg = await dfgDaemon(filePath, funcName, projectDir, language);

      if (daemonOk(dfg)) {
        results.push('');
        results.push(`## DFG: ${funcName}`);
        if (dfg.definitions && dfg.definitions.length > 0) {
          results.push('  Definitions:');
          for (const d of dfg.definitions.slice(0, 10)) {
            results.push(`    ${d.var_name} @ line ${d.line}`);
          }
        }
        if (dfg.uses && dfg.uses.length > 0) {
          results.push('  Uses:');
          for (const u of dfg.uses.slice(0, 8)) {
            results.push(`    ${u.var_name} @ line ${u.line}`);
          }
        }
      }
    }

    // L5: PDG (Program Dependency Graph) via slice
    if (layers.includes('pdg')) {
      const funcName = target || 'main';
      const sliceResp = await sliceDaemon(filePath, funcName, 10, projectDir, 'backward');

      if (sliceResp && sliceResp.status === 'ok' && sliceResp.result) {
        const slice = sliceResp.result;
        results.push('');
        results.push(`## PDG: ${funcName}`);
        if (slice.lines && slice.lines.length > 0) {
          results.push(`  Slice lines: ${slice.lines.length}`);
        }
        if (slice.variables && slice.variables.length > 0) {
          results.push(`  Variables: ${slice.variables.join(', ')}`);
        }
      }
    }

    return results.length > 3 ? results.join('\n') : null;  // > 3 means we have more than just header
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read-outcome log (plan 2026-09-30, T2). Every Read the hook sees is recorded
// in {project}/.tldr/stats/hook_activity.jsonl, the file the TLDR daemon's
// HookStatsStore writes and reads. Rows keep that format (hook_name,
// invocations, successes, failures, metrics, timestamp) and add top-level
// `outcome`, `reason`, `duration_ms`, `count`; the daemon ignores unknown
// top-level keys and sums `metrics`, so old aggregates keep working.
//
// Why the hook writes the file itself: the daemon is the only other writer,
// and a fail_open event happens exactly when the daemon is down. A daemon
// `track` call could never log it (and cost a socket round trip per deny).
//
// Log volume: deny and fail_open are rare and carry the net-saving inputs, so
// each gets its own row. `allow` (prefilter: non-code, allowlisted or
// offset/limit reads) and `below_threshold` are the bulk of all Reads, so they
// are COUNTED: a small counter file keeps n and summed ms per outcome, and one
// aggregate row is appended per BATCH_FLUSH_AT events. Concurrent hook
// processes can lose an increment (read-modify-write, no lock); the counts are
// approximate by design. A project with no `.tldr` dir gets no logging and no
// new directory. duration_ms is measured inside the hook (process start-up is
// not included).
// ---------------------------------------------------------------------------

export type ReadOutcome = 'allow' | 'deny' | 'fail_open' | 'below_threshold';

export interface ReadLogEvent {
  outcome: ReadOutcome;
  reason: string;
  duration_ms: number;
  bytes_raw?: number;
  bytes_injected?: number;
  layers_returned?: number;
}

export const BATCH_FLUSH_AT = 25;
const HOOK_NAME = 'tldr-read-enforcer';
const COUNTER_FILE = 'tldr-read-enforcer.counts.json';

type CounterState = Record<string, { n: number; ms: number }>;

const cleanMs = (ms: number): number =>
  Number.isFinite(ms) && ms > 0 ? Math.round(ms * 10) / 10 : 0;

/** One hook_activity.jsonl row. `count` > 1 means a batched aggregate. */
export function buildLogRow(ev: ReadLogEvent, count = 1, now: Date = new Date()): Record<string, unknown> {
  const ms = cleanMs(ev.duration_ms);
  const isError = ev.outcome === 'fail_open' && ev.reason === 'error';
  const metrics: Record<string, number> = {
    reads_seen: count,
    [`outcome_${ev.outcome}`]: count,
    duration_ms: ms,
  };
  if (ev.outcome === 'deny') {
    // Same metrics the pre-T2 daemon `track` call carried (net-savings inputs).
    metrics.reads_intercepted = 1;
    metrics.layers_returned = ev.layers_returned ?? 0;
    metrics.bytes_raw = ev.bytes_raw ?? 0;
    metrics.bytes_injected = ev.bytes_injected ?? 0;
  }
  return {
    hook_name: HOOK_NAME,
    invocations: count,
    successes: isError ? 0 : count,
    failures: isError ? count : 0,
    metrics,
    outcome: ev.outcome,
    reason: ev.reason,
    duration_ms: ms,
    count,
    timestamp: now.toISOString(),
  };
}

/** Pure counter step. A corrupt `state` is treated as empty. */
export function bumpCounter(
  state: CounterState | null | undefined,
  key: string,
  ms: number,
  flushAt: number = BATCH_FLUSH_AT,
): { state: CounterState; flush: { key: string; n: number; ms: number } | null } {
  const next: CounterState = {};
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    for (const [k, v] of Object.entries(state)) {
      if (v && typeof v.n === 'number' && typeof v.ms === 'number') next[k] = { n: v.n, ms: v.ms };
    }
  }
  const cur = next[key] || { n: 0, ms: 0 };
  const n = cur.n + 1;
  const total = Math.round((cur.ms + cleanMs(ms)) * 10) / 10;
  if (n >= flushAt) {
    delete next[key];
    return { state: next, flush: { key, n, ms: total } };
  }
  next[key] = { n, ms: total };
  return { state: next, flush: null };
}

/** Best-effort: never throws, never creates `.tldr`. */
export function recordRead(projectDir: string, ev: ReadLogEvent): void {
  try {
    const tldrDir = join(projectDir, '.tldr');
    if (!existsSync(tldrDir)) return;
    const statsDir = join(tldrDir, 'stats');
    mkdirSync(statsDir, { recursive: true });
    const logFile = join(statsDir, 'hook_activity.jsonl');

    if (ev.outcome === 'deny' || ev.outcome === 'fail_open') {
      appendFileSync(logFile, JSON.stringify(buildLogRow(ev)) + '\n');
      return;
    }

    const counterFile = join(statsDir, COUNTER_FILE);
    let state: CounterState = {};
    try { state = JSON.parse(readFileSync(counterFile, 'utf-8')); } catch { /* missing or corrupt: start over */ }
    const key = `${ev.outcome}|${ev.reason}`;
    const { state: next, flush } = bumpCounter(state, key, ev.duration_ms);
    writeFileSync(counterFile, JSON.stringify(next));
    if (flush) {
      const [outcome, reason] = flush.key.split('|');
      const row = buildLogRow({ outcome: outcome as ReadOutcome, reason, duration_ms: flush.ms }, flush.n);
      appendFileSync(logFile, JSON.stringify(row) + '\n');
    }
  } catch {
    // Logging must never change what the hook returns.
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

const START = performance.now();

async function main() {
  const input: HookInput = JSON.parse(readStdin());

  if (input.tool_name !== 'Read') {
    console.log('{}');
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Log the outcome, then print. Exactly one stdout write per path, unchanged.
  const finish = (stdout: string, ev: Omit<ReadLogEvent, 'duration_ms'>): void => {
    recordRead(projectDir, { ...ev, duration_ms: performance.now() - START });
    console.log(stdout);
  };
  const allow = (outcome: ReadOutcome, reason: string): void => finish('{}', { outcome, reason });

  const filePath = input.tool_input.file_path || '';

  // Allow non-code files
  if (!isCodeFile(filePath)) return allow('allow', 'prefilter');

  // Allow explicitly permitted files
  if (isAllowedFile(filePath)) return allow('allow', 'prefilter');

  // If requesting specific lines (offset/limit), allow - they know what they want
  if (input.tool_input.offset || (input.tool_input.limit && input.tool_input.limit < 100)) {
    return allow('allow', 'prefilter');
  }

  // Small files: TLDR overhead not worth it, just read directly (see the
  // measured break-even table at MIN_INTERCEPT_BYTES)
  let rawBytes = 0;
  try {
    const stats = statSync(filePath);
    rawBytes = stats.size;
    if (stats.size < MIN_INTERCEPT_BYTES) return allow('below_threshold', 'below_threshold');
  } catch {
    // File doesn't exist or can't stat, let Read handle the error
    return allow('allow', 'stat_error');
  }

  // FAIL-OPEN GATE (remediation §1): if the daemon is unreachable, allow the
  // read immediately. Never attempt TLDR work, never start a daemon.
  if (isDaemonUnreachableCached(projectDir)) return allow('fail_open', 'daemon_unreachable_cached');
  const reachable = await probeDaemonFast(projectDir);
  if (!reachable) {
    cacheDaemonUnreachable(projectDir);
    return allow('fail_open', 'daemon_unreachable');
  }

  // Get TLDR context instead of raw file
  const language = detectLanguage(filePath);

  // Try to detect intent from multiple sources (in priority order)
  let layers = ['ast', 'call_graph'];  // Default layers
  let target: string | null = null;
  let contextSource = 'default';

  // Check for search context from smart-search-router (Bayesian: P(intent | current action)).
  // Exact-path matched + consume-once — see getSearchContext.
  const searchContext = getSearchContext(input.session_id, filePath);
  if (searchContext) {
    layers = searchContext.suggestedLayers;
    target = searchContext.target;
    contextSource = `${searchContext.targetType}: ${searchContext.target}`;
  }
  // No transcript analysis - retrospective prediction is epistemically weak
  // Default layers (ast, call_graph) used when no search context

  const tldrContext = await getTldrContext(filePath, language, layers, target, input.session_id, contextSource);

  // Content-sufficiency floor (remediation §1): deny only on a summary that is
  // plausibly better than the raw file. Require a minimum injected size AND —
  // when a search target exists — that the summary actually contains it.
  if (!tldrContext || tldrContext.length < MIN_INJECTED_CHARS) return allow('fail_open', 'summary_insufficient');
  if (target && !tldrContext.includes(target)) return allow('fail_open', 'target_not_in_summary');

  // Format layer names for display
  const layerNames = layers.map(l => {
    switch(l) {
      case 'ast': return 'L1:AST';
      case 'call_graph': return 'L2:CallGraph';
      case 'cfg': return 'L3:CFG';
      case 'dfg': return 'L4:DFG';
      case 'pdg': return 'L5:PDG';
      default: return l;
    }
  }).join(' + ');

  // Format cross-file usage (L6) if available
  let crossFileSection = '';
  if (searchContext?.callers && searchContext.callers.length > 0) {
    const callerLines = searchContext.callers.slice(0, 10).map(c => {
      // Format: /full/path/file.py:123 → file.py:123
      const parts = c.split('/');
      const fileAndLine = parts[parts.length - 1];
      const dir = parts.length > 2 ? parts[parts.length - 2] : '';
      return `  ${dir ? dir + '/' : ''}${fileAndLine}`;
    });
    crossFileSection = `
## Cross-File Usage (${searchContext.callers.length} refs)
${callerLines.join('\n')}${searchContext.callers.length > 10 ? `\n  ... and ${searchContext.callers.length - 10} more` : ''}
`;
  }

  // Add definition location if different from current file
  let definitionSection = '';
  if (searchContext?.definitionLocation && !searchContext.definitionLocation.includes(basename(filePath))) {
    definitionSection = `\n📍 Defined at: ${searchContext.definitionLocation}\n`;
  }

  // BLOCK the read and return TLDR context. The bypass that actually works is
  // offset/limit (Read requires an absolute path, so "Read <basename>" was
  // never followable advice) — lead with it.
  const reasonText = `📊 TLDR Context (${layerNames}):
${searchContext ? `🔗 Context: ${contextSource}` : ''}${definitionSection}

${tldrContext}${crossFileSection}
---
To read the code itself, re-issue the Read with offset/limit (e.g. offset=1 limit=200).
Test files and .claude/hooks|skills paths bypass this hook entirely.`;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonText,
    }
  };

  // Net-savings inputs (remediation §7) ride on the deny row.
  finish(JSON.stringify(output), {
    outcome: 'deny',
    reason: 'summary_injected',
    layers_returned: layers.length,
    bytes_raw: rawBytes,
    bytes_injected: reasonText.length,
  });
}

// Async exit discipline: exactly one stdout JSON write per path; any throw
// allows the read; no un-awaited work remains when main settles. Run only when
// this file is the hook entry point, so tests can import the log helpers.
if (process.argv[1] && process.argv[1].includes('tldr-read-enforcer')) {
  main().catch((err) => {
    console.error(`TLDR enforcer error: ${err.message}`);
    recordRead(process.env.CLAUDE_PROJECT_DIR || process.cwd(), {
      outcome: 'fail_open',
      reason: 'error',
      duration_ms: performance.now() - START,
    });
    console.log('{}');
  });
}
