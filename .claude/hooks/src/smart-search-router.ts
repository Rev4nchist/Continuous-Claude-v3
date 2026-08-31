/**
 * PreToolUse Hook: Smart Search Router
 *
 * Routes Grep calls to the most token-efficient tool:
 * 1. AST-grep - structural code queries (most efficient)
 * 2. LEANN - semantic/conceptual queries
 * 3. Grep - literal patterns (fallback)
 *
 * Uses TLDR daemon for fast symbol lookups when available.
 */

// A PreToolUse hook must NEVER start a daemon — including the TOCTOU window
// after a successful probe. tryStartDaemon honors this env var, so a dead
// daemon yields 'unavailable' and the Grep proceeds (fail open).
process.env.CCV3_DAEMON_NO_AUTOSTART = '1';

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  queryDaemon,
  queryDaemonSync,
  DaemonResponse,
  trackHookActivityFast,
  probeDaemonFast,
  isDaemonUnreachableCached,
  cacheDaemonUnreachable,
} from './daemon-client.js';
import { logHook } from './shared/session-activity.js';
import { CONTEXT_DIR } from './shared/search-context-path.js';

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: string;
}

interface PreToolUseInput {
  tool_name: string;
  tool_input: GrepInput;
  session_id?: string;
}

type QueryType = 'structural' | 'semantic' | 'literal';

// Search context for TLDR layer routing
interface SearchContext {
  timestamp: number;
  queryType: QueryType;
  pattern: string;
  target: string | null;
  targetType: 'function' | 'class' | 'variable' | 'import' | 'decorator' | 'unknown';
  suggestedLayers: string[];
  definitionLocation?: string;  // Where the symbol is defined
  callers?: string[];           // Cross-file: where the symbol is called/used
}

// CONTEXT_DIR is the search-context handshake dir, shared with tldr-read-enforcer.
// Resolved under os.tmpdir() in ./shared/search-context-path (QW-02).

function storeSearchContext(sessionId: string, context: SearchContext): void {
  try {
    if (!existsSync(CONTEXT_DIR)) {
      mkdirSync(CONTEXT_DIR, { recursive: true });
    }
    writeFileSync(
      `${CONTEXT_DIR}/${sessionId}.json`,
      JSON.stringify(context, null, 2)
    );
  } catch {
    // Ignore errors - context storage is best-effort
  }
}

// TLDR-based symbol lookup via daemon (faster than spawning CLI)
interface TLDRSearchResult {
  file: string;
  line: number;
  content: string;
}

/**
 * Search using TLDR daemon with ripgrep fallback.
 * Uses daemon when available, falls back to ripgrep when indexing/unavailable.
 */
async function tldrSearch(pattern: string, projectDir: string = '.'): Promise<TLDRSearchResult[]> {
  try {
    // Try daemon first — async socket, not queryDaemonSync (which spawns a
    // PowerShell process per query on Windows; remediation §2)
    const response = await queryDaemon({ cmd: 'search', pattern }, projectDir);

    // If daemon is indexing or unavailable, fall back to ripgrep
    if (response.indexing || response.status === 'unavailable') {
      return ripgrepFallback(pattern, projectDir);
    }

    // Parse successful daemon response
    if (response.status === 'ok' && response.results) {
      return response.results as TLDRSearchResult[];
    }

    return [];
  } catch {
    // Fall back to ripgrep on any error
    return ripgrepFallback(pattern, projectDir);
  }
}

/**
 * Build the ripgrep argv. Injection-safe by construction (ST-08 slice /
 * D2b-10 / GAP4-01): the model-controlled `pattern` is passed via `-e <pattern>`
 * so a leading-dash pattern is treated as a literal search pattern, never a flag
 * (Codex #1), and `--` terminates flag parsing before the path operand. Consumed
 * by spawnSync(..., {shell:false}) so no shell ever interprets metacharacters.
 */
export function buildRipgrepArgs(pattern: string, projectDir: string): string[] {
  return [
    '-e', pattern,
    '--type', 'py',
    '--line-number',
    '--max-count', '10',
    '--', projectDir,
  ];
}

/**
 * Ripgrep fallback for when daemon is unavailable.
 */
function ripgrepFallback(pattern: string, projectDir: string): TLDRSearchResult[] {
  try {
    // ST-08 slice (D2b-10/GAP4-01): argv spawn with shell:false. The prior
    // execSync(`rg "${escaped}" ...`) interpolated a model-controlled pattern
    // into a shell command string with only naive `"`/`$` escaping — a real
    // RCE surface. spawnSync hands every token to rg verbatim with no shell.
    const result = spawnSync('rg', buildRipgrepArgs(pattern, projectDir), {
      encoding: 'utf-8',
      timeout: 3000,
      shell: false,
    });
    // rg exits 0=match, 1=no-match, 2=error; treat anything non-zero (or no
    // output) as "no results", matching the prior catch-on-throw behavior.
    if (result.status !== 0 || !result.stdout) return [];
    // Parse ripgrep output: file:line:content
    return result.stdout.trim().split('\n').filter(l => l).slice(0, 10).map(line => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (match) {
        return { file: match[1], line: parseInt(match[2], 10), content: match[3] };
      }
      return { file: line, line: 0, content: '' };
    });
  } catch {
    return [];
  }
}

/**
 * Semantic search using TLDR daemon embeddings.
 * Returns relevant code snippets for natural language queries.
 */
interface SemanticResult {
  file: string;
  function: string;
  score: number;
  snippet?: string;
}

interface SemanticSearchResult {
  results: SemanticResult[];
  status: 'ok' | 'no_index' | 'daemon_unavailable' | 'indexing' | 'error';
}

function checkSemanticIndexExists(projectDir: string): boolean {
  const indexPath = join(projectDir, '.tldr', 'cache', 'semantic', 'index.faiss');
  return existsSync(indexPath);
}

function tldrSemantic(query: string, projectDir: string = '.'): SemanticSearchResult {
  // First check if index exists
  if (!checkSemanticIndexExists(projectDir)) {
    return { results: [], status: 'no_index' };
  }

  try {
    const response = queryDaemonSync({ cmd: 'semantic', query, k: 5 }, projectDir);

    if (response.indexing) {
      return { results: [], status: 'indexing' };
    }

    if (response.status === 'unavailable') {
      return { results: [], status: 'daemon_unavailable' };
    }

    if (response.status === 'ok' && response.results) {
      return { results: response.results as SemanticResult[], status: 'ok' };
    }

    return { results: [], status: 'ok' };  // Empty results but working
  } catch {
    return { results: [], status: 'error' };
  }
}

/**
 * Get callers of a function using TLDR daemon.
 */
async function tldrImpact(funcName: string, projectDir: string = '.'): Promise<string[]> {
  try {
    const response = await queryDaemon({ cmd: 'impact', func: funcName }, projectDir);

    // Skip if indexing or unavailable
    if (response.indexing || response.status === 'unavailable') {
      return [];
    }

    // Parse callers from response
    if (response.status === 'ok' && response.callers) {
      return response.callers.map((c: any) => `${c.file}:${c.line}`);
    }

    return [];
  } catch {
    return [];
  }
}

async function lookupCallers(pattern: string): Promise<string[]> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  return (await tldrImpact(pattern, projectDir)).slice(0, 20);
}

async function lookupSymbol(pattern: string): Promise<{ type: SearchContext['targetType']; location: string } | null> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';

  // Try function first (most common)
  const funcResults = await tldrSearch(`def ${pattern}`, projectDir);
  if (funcResults.length > 0) {
    return {
      type: 'function',
      location: `${funcResults[0].file}:${funcResults[0].line}`,
    };
  }

  // Try class
  const classResults = await tldrSearch(`class ${pattern}`, projectDir);
  if (classResults.length > 0) {
    return {
      type: 'class',
      location: `${classResults[0].file}:${classResults[0].line}`,
    };
  }

  // Try variable (SCREAMING_CASE assignment)
  if (/^[A-Z][A-Z0-9_]+$/.test(pattern)) {
    const varResults = await tldrSearch(`${pattern} =`, projectDir);
    if (varResults.length > 0) {
      return {
        type: 'variable',
        location: `${varResults[0].file}:${varResults[0].line}`,
      };
    }
  }

  return null;
}

// Verb prefixes AND standalone verbs that indicate a function (not a variable)
// Prefixes: get_, set_, is_, has_, etc.
// Standalone: poll, call, exec, sync, etc. (common method names that are single verbs)
const FUNCTION_VERB_PREFIXES = /^(get|set|is|has|do|can|create|update|delete|fetch|load|save|read|write|parse|build|make|init|setup|run|start|stop|handle|process|validate|check|find|search|filter|sort|map|reduce|transform|convert|format|render|display|show|hide|enable|disable|add|remove|insert|append|push|pop|clear|reset|close|open|connect|disconnect|send|receive|emit|on_|async_|_get|_set|_is|_has|_do|_create|_update|_delete|_fetch|_load|_save|_read|_write|_parse|_build|_make|_init|_setup|_run|_handle|_process|_validate|_check|_find|poll|call|exec|execute|invoke|apply|bind|dispatch|trigger|fire|notify|broadcast|publish|subscribe|unsubscribe|listen|watch|observe|register|unregister|mount|unmount|attach|detach|flush|dump|log|warn|error|debug|trace|print|throw|raise|assert|test|mock|stub|spy|wait|sleep|delay|retry|abort|cancel|pause|resume|refresh|reload|rerun|revert|rollback|commit|merge|split|join|clone|copy|move|swap|toggle|flip|increment|decrement|next|prev|first|last|peek|drain|consume|produce|yield|spawn|fork|join|kill|terminate|shutdown|cleanup|destroy|dispose|release|acquire|lock|unlock|enter|exit|begin|end|finalize)(_|$)/;

async function extractTarget(
  pattern: string,
  daemonUp: boolean
): Promise<{ target: string | null; targetType: SearchContext['targetType'] }> {
  // 1. Try AST-based symbol index first (100% accurate if indexed).
  // Gated on the fast probe: when the daemon is down, a lookup would pay the
  // tryStartDaemon spawn path just to fail — heuristics below cover it.
  const indexed = daemonUp ? await lookupSymbol(pattern) : null;
  if (indexed) {
    return { target: pattern, targetType: indexed.type };
  }

  // 2. Fall back to heuristics for unindexed patterns
  // Explicit keywords first
  const classMatch = pattern.match(/^class\s+(\w+)/);
  if (classMatch) return { target: classMatch[1], targetType: 'class' };

  const defMatch = pattern.match(/^(?:async\s+)?def\s+(\w+)/);
  if (defMatch) return { target: defMatch[1], targetType: 'function' };

  const functionMatch = pattern.match(/^(?:async\s+)?function\s+(\w+)/);
  if (functionMatch) return { target: functionMatch[1], targetType: 'function' };

  const decoratorMatch = pattern.match(/^@(\w+)/);
  if (decoratorMatch) return { target: decoratorMatch[1], targetType: 'decorator' };

  const importMatch = pattern.match(/^(?:import|from)\s+(\w+)/);
  if (importMatch) return { target: importMatch[1], targetType: 'import' };

  // Self/this attribute access (handle escaped dots too: self\._data)
  const attrMatch = pattern.match(/(?:self|this)(?:\.|\\\.|\\\.\s*)(\w+)/);
  if (attrMatch) {
    const attr = attrMatch[1];
    // Check if it looks like a method (verb prefix) or variable
    if (FUNCTION_VERB_PREFIXES.test(attr)) {
      return { target: attr, targetType: 'function' };
    }
    return { target: attr, targetType: 'variable' };
  }

  // Python dunder handling
  if (/^__[a-z][a-z0-9_]*__$/.test(pattern)) {
    // Module-level dunder VARIABLES (not methods)
    const moduleVars = ['__all__', '__version__', '__author__', '__doc__', '__file__', '__name__', '__package__', '__path__', '__cached__', '__loader__', '__spec__', '__builtins__', '__dict__', '__module__', '__slots__', '__annotations__'];
    if (moduleVars.includes(pattern)) {
      return { target: pattern, targetType: 'variable' };
    }
    // All other dunders are methods (e.g., __init__, __str__, __repr__, __eq__)
    return { target: pattern, targetType: 'function' };
  }

  // SCREAMING_CASE = constant (variable)
  if (/^[A-Z][A-Z0-9_]+$/.test(pattern)) return { target: pattern, targetType: 'variable' };

  // PascalCase = class
  if (/^[A-Z][a-zA-Z0-9]+$/.test(pattern)) return { target: pattern, targetType: 'class' };

  // snake_case with verb prefix = function
  if (/^_?[a-z][a-z0-9_]*$/.test(pattern) && FUNCTION_VERB_PREFIXES.test(pattern)) {
    return { target: pattern, targetType: 'function' };
  }

  // snake_case WITHOUT verb prefix = variable (e.g., _pool, cpu_percent, data_source)
  if (/^_?[a-z][a-z0-9_]*$/.test(pattern)) {
    return { target: pattern, targetType: 'variable' };
  }

  // camelCase with verb prefix = function (e.g., handleClick, useState, fetchData)
  const camelCaseVerbPattern = /^(get|set|is|has|do|can|use|create|update|delete|fetch|load|save|read|write|parse|build|make|init|setup|run|start|stop|handle|process|validate|check|find|search|filter|sort|map|reduce|transform|convert|format|render|display|show|hide|enable|disable|add|remove|insert|append|push|pop|clear|reset|close|open|connect|disconnect|send|receive|emit|on|async|poll|call|exec|execute|invoke|apply|bind|dispatch|trigger|fire|notify|broadcast|publish|subscribe|watch|observe|register|mount|attach|flush|dump|log|warn|error|debug|print|throw|assert|test|mock|wait|sleep|retry|abort|cancel|pause|resume|refresh|reload|revert|commit|merge|clone|copy|move|toggle|spawn|fork|kill|terminate|shutdown|cleanup|destroy|dispose|release|acquire|lock|unlock|enter|exit|begin|end)[A-Z]/;
  if (camelCaseVerbPattern.test(pattern)) {
    return { target: pattern, targetType: 'function' };
  }

  // camelCase WITHOUT verb prefix = variable (e.g., sessionId, userData, configOptions)
  if (/^[a-z][a-zA-Z0-9]*$/.test(pattern) && /[A-Z]/.test(pattern)) {
    return { target: pattern, targetType: 'variable' };
  }

  // Fallback: extract any identifier
  const identMatch = pattern.match(/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/);
  if (identMatch) return { target: identMatch[1], targetType: 'unknown' };

  return { target: null, targetType: 'unknown' };
}

function suggestLayers(targetType: SearchContext['targetType'], queryType: QueryType): string[] {
  switch (targetType) {
    case 'function': return ['ast', 'call_graph', 'cfg'];
    case 'class': return ['ast', 'call_graph'];
    case 'variable': return ['ast', 'dfg'];
    case 'import': return ['ast'];
    case 'decorator': return ['ast', 'call_graph'];
    default:
      return queryType === 'semantic' ? ['ast', 'call_graph', 'cfg'] : ['ast', 'call_graph'];
  }
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * True when the Grep call is explicitly scoped (path/glob/type set) — the
 * caller has already localized the search, so routing away would drop that
 * scoping. Exported for tests.
 */
export function isScopedCall(toolInput: GrepInput): boolean {
  return Boolean(toolInput.path || toolInput.glob || toolInput.type);
}

/**
 * Classifies query type for optimal tool routing. Exported for tests.
 */
export function classifyQuery(pattern: string): QueryType {
  // LITERAL FIRST (bug fix 2026-07-25): a pattern carrying regex machinery
  // (escapes, char classes, alternation) is a hand-written ripgrep regex —
  // exactly what native Grep handles best and what ast-grep patterns can NOT
  // express. This check used to run AFTER the structural check, so e.g.
  // `main\(\)` or `LearningResult \{` got denied as "structural" and rerouted.
  if (pattern.includes('\\') || pattern.includes('[') || pattern.includes('|')) {
    return 'literal';
  }

  // STRUCTURAL: Code patterns that AST-grep handles best
  const structuralPatterns = [
    /^(class|function|def|async def|const|let|var|interface|type|export)\s+\w+/,
    /^(import|from|require)\s/,
    /^\w+\s*\([^)]*\)/, // function calls
    /^async\s+(function|def)/,
    /\$\w+/, // AST-grep metavariables
    /^@\w+/, // decorators
  ];

  if (structuralPatterns.some(p => p.test(pattern))) {
    return 'structural';
  }

  // Exact identifier patterns (CamelCase, snake_case, SCREAMING_CASE)
  if (/^[A-Z][a-zA-Z0-9]*$/.test(pattern) || /^[a-z_][a-z0-9_]*$/.test(pattern) || /^[A-Z_][A-Z0-9_]*$/.test(pattern)) {
    return 'literal';
  }

  // File paths
  if (pattern.includes('/') || /\.(ts|py|js|go|rs|md)/.test(pattern)) {
    return 'literal';
  }

  // Short patterns (1-2 words, no question words) are likely literal
  const words = pattern.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 2 && !/^(how|what|where|why|when|find|show|list)/i.test(pattern)) {
    return 'literal';
  }

  // SEMANTIC: Natural language, questions, conceptual
  const semanticPatterns = [
    /^(how|what|where|why|when|which)\s/i,
    /\?$/,
    /^(find|show|list|get|explain)\s+(all|the|every|any)/i,
    /works?$/i,
    /^.*\s+(implementation|architecture|flow|pattern|logic|system)$/i,
  ];

  if (semanticPatterns.some(p => p.test(pattern))) {
    return 'semantic';
  }

  // 3+ words without code indicators → likely semantic
  if (words.length >= 3) {
    return 'semantic';
  }

  return 'literal';
}

// LEANN functions removed - TLDR cross-file covers this use case

function getAstGrepSuggestion(pattern: string, lang: string = 'python'): string {
  // Convert natural language to AST-grep pattern hints
  const suggestions: Record<string, string> = {
    'function': `def $FUNC($$$):`,
    'async': `async def $FUNC($$$):`,
    'class': `class $NAME:`,
    'import': `import $MODULE`,
    'decorator': `@$DECORATOR`,
  };

  for (const [keyword, astPattern] of Object.entries(suggestions)) {
    if (pattern.toLowerCase().includes(keyword)) {
      return astPattern;
    }
  }
  return `$PATTERN($$$)`;
}

async function main() {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // Malformed JSON - exit silently
    console.log('{}');
    return;
  }

  // Only intercept Grep tool
  if (input.tool_name !== 'Grep') {
    console.log('{}');
    return;
  }

  // Validate tool_input exists and has required fields
  if (!input.tool_input || typeof input.tool_input.pattern !== 'string') {
    console.log('{}');
    return;
  }

  const pattern = input.tool_input.pattern;
  const sessionId = input.session_id || 'default';

  // Scoped-call pass-through (bug fix 2026-07-25, flagged in the 2026-07-24
  // Serena-evaluation handoff): when the caller explicitly narrows the search
  // with `path`, `glob`, or `type`, the search is already LOCALIZED — denying
  // it and suggesting ast-grep/TLDR silently DROPS that scoping (the reroute
  // text never carried the path), degrading a targeted lookup into a
  // project-wide one. Explicit scope = the model knows where to look; let
  // native Grep do its job.
  if (isScopedCall(input.tool_input)) {
    try { logHook(sessionId, 'smart-search-router'); } catch { /* never break */ }
    await trackHookActivityFast('smart-search-router', process.env.CLAUDE_PROJECT_DIR || '.', true, {
      queries_routed: 1, scoped_passthrough: 1,
    });
    console.log('{}');
    return;
  }

  const queryType = classifyQuery(pattern);

  // Log hook activation (fires whenever a Grep is intercepted for routing)
  try { logHook(sessionId, 'smart-search-router'); } catch { /* never break */ }

  // One fast reachability probe gates every daemon lookup below (remediation
  // §1/§2): daemon down → skip lookups entirely, cache the verdict for
  // parallel subagents, and fall back to heuristics.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  let daemonUp = false;
  if (!isDaemonUnreachableCached(projectDir)) {
    daemonUp = await probeDaemonFast(projectDir);
    if (!daemonUp) cacheDaemonUnreachable(projectDir);
  }

  // Extract target and store context for downstream hooks (tldr-read-enforcer)
  const { target, targetType } = await extractTarget(pattern, daemonUp);
  const layers = suggestLayers(targetType, queryType);

  // Look up cross-file info from indexes
  const symbolInfo = (target && daemonUp) ? await lookupSymbol(target) : null;
  const callers = (target && daemonUp) ? await lookupCallers(target) : [];

  storeSearchContext(sessionId, {
    timestamp: Date.now(),
    queryType,
    pattern,
    target,
    targetType,
    suggestedLayers: layers,
    definitionLocation: symbolInfo?.location,
    callers: callers.slice(0, 20),  // Limit to 20 callers for token efficiency
  });

  // LITERAL: Pass through to Grep (native tool handles literal patterns best)
  if (queryType === 'literal') {
    await trackHookActivityFast('smart-search-router', projectDir, true, {
      queries_routed: 1, literal_queries: 1,
    });

    // Allow Grep to handle literal patterns natively — no redirect
    console.log('{}');
    return;
  }

  // STRUCTURAL: track and allow. The deny-and-redirect behavior was removed
  // 2026-08-30 per docs/harness-strategy/2026-07-29-tldr-remediation-plan.md §5:
  // 0/16 adoption, and the semantic index it steered toward was months stale.
  // The search context stored above still routes downstream (tldr-read-enforcer).
  if (queryType === 'structural') {
    await trackHookActivityFast('smart-search-router', projectDir, true, {
      queries_routed: 1, structural_queries: 1,
    });
    console.log('{}');
    return;
  }

  // SEMANTIC: track and allow (same remediation §5). No semantic query is run —
  // computing results only to discard them would re-pay the daemon latency.
  await trackHookActivityFast('smart-search-router', projectDir, true, {
    queries_routed: 1, semantic_queries: 1,
  });
  console.log('{}');
}

// Guard the on-import auto-run so unit tests can import the exported helpers
// (classifyQuery/isScopedCall/buildRipgrepArgs) without main() consuming stdin.
// Matches the guard used by sibling hooks (e.g. memory-awareness, QW-06).
if (!process.env.VITEST) {
  main().catch(console.error);
}
