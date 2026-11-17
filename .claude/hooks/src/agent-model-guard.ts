#!/usr/bin/env node
/**
 * Agent name hint (PreToolUse:Task, fires on the Agent tool). A hint, never a gate.
 *
 * Claude Code rejects an unknown agent type itself (probe 2026-11-17, no hooks loaded:
 * "Agent type 'no-such-agent-xyz' not found. Available agents: ..."). So this hook never denies and
 * never approves: it prints no permissionDecision, and the normal permission flow decides.
 *
 * What it adds:
 * - "Did you mean: X?" as additionalContext when an unknown name is 2 edits or fewer from a custom agent.
 * - A warn row in the guard log for a name it cannot find (a typo, or a new Claude Code built-in: the drift signal).
 * - A hint and a warn row when an agent file in an agents dir has the name of a built-in (it shadows the built-in).
 *
 * Lookup order: <cwd>/.claude/agents, $CLAUDE_PROJECT_DIR/.claude/agents, ~/.claude/agents.
 * Plugin agents (name contains ':') pass with no flag. Any fs error other than "not found" fails open with no flag.
 *
 * Until 2026-11-17 this hook denied any name missing from a static built-in list and from the agents dirs. The
 * list went stale (web-fetch and fork were missing), and every logged deny was a wrong deny of a built-in.
 * The filename `agent-model-guard` is a historical misnomer: the hook never chose models.
 */

import { readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';

interface TaskInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
}

/**
 * Always an allow. `unknown`: the name was not found (warn row). `shadow`: the file that may shadow a built-in
 * (warn row). `error`: an fs error made the lookup fail open (error row); never set together with `unknown`.
 */
export interface Decision {
  allow: true;
  hint?: string;
  unknown?: true;
  shadow?: string;
  error?: unknown;
}

export interface DecideEnv {
  home: string;
  projectDir?: string;
}

/** Claude Code built-in agent types. A name missing here is still allowed: it only gets a warn row. */
export const BUILTIN_AGENTS = new Set([
  'Bash',
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
  'claude',
  'web-fetch',
  'fork',
]);

/** Most edits between a typed name and a custom agent for a "did you mean" hint. */
const HINT_MAX_EDITS = 2;
/** Shortest typed name that gets a hint; a shorter one matches too much. */
const HINT_MIN_LENGTH = 4;
/** Longest typed agent name that goes back into model context (same cut as the log row). */
const NAME_MAX = 60;
/** Longest path that goes back into model context. */
const PATH_MAX = 200;

/** Text for model context: control characters removed, then cut to `max` characters. */
export function contextText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return clean.length > max ? clean.slice(0, max) + '...' : clean;
}

/** A path for model context: the home dir as ~, then contextText. */
export function contextPath(path: string, home: string): string {
  const norm = path.replace(/\\/g, '/');
  const homeNorm = home.replace(/\\/g, '/').replace(/\/+$/, '');
  const short = homeNorm && norm.toLowerCase().startsWith(homeNorm.toLowerCase() + '/') ? '~' + norm.slice(homeNorm.length) : norm;
  return contextText(short, PATH_MAX);
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/** The hook output: {} for a plain allow, additionalContext for a hint. Never a permissionDecision. */
export function buildOutput(decision: Decision): object {
  if (!decision.hint) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.hint } };
}

/** Agent directories in lookup order, deduplicated. Only absolute paths are used. */
export function agentDirs(cwd: unknown, env: DecideEnv): string[] {
  const roots = [typeof cwd === 'string' ? cwd : undefined, env.projectDir];
  const dirs: string[] = [];
  for (const root of roots) {
    if (root && isAbsolute(root)) dirs.push(join(root, '.claude', 'agents'));
  }
  dirs.push(join(env.home, '.claude', 'agents'));
  const seen = new Set<string>();
  return dirs.filter(d => {
    // Keep case: on a case-sensitive filesystem /work/app and /work/App are different dirs.
    // On Windows a case-only duplicate costs one extra existsSync, nothing more.
    const key = d.replace(/\\/g, '/');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** true/false for found/not found. Throws on any other fs error (caller fails open). */
function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

function listAgents(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Custom agents within HINT_MAX_EDITS of the typed name, case-insensitive, nearest first. No substring rule.
 * A name that differs only in case (Scout for scout) is a candidate at distance 0.
 */
function findSimilarAgents(agentType: string, available: string[]): string[] {
  const lower = agentType.toLowerCase();
  if (lower.length < HINT_MIN_LENGTH) return [];
  return available
    .filter(a => a !== agentType)
    .map(a => ({ a, d: levenshteinDistance(lower, a.toLowerCase()) }))
    .filter(x => x.d <= HINT_MAX_EDITS)
    .sort((x, y) => x.d - y.d || x.a.localeCompare(y.a))
    .slice(0, 3)
    .map(x => x.a);
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/** The first agent file, in lookup order, whose name equals the built-in name case-insensitively. */
function findShadow(builtin: string, dirs: string[]): string | undefined {
  const lower = builtin.toLowerCase();
  for (const dir of dirs) {
    const hit = listAgents(dir).find(name => name.toLowerCase() === lower);
    if (hit) return join(dir, `${hit}.md`);
  }
  return undefined;
}

/**
 * The check matches file names. Claude Code may key an agent by its frontmatter `name:` instead, so the hint
 * says "may be overridden", not "is overridden".
 */
function decideBuiltin(agentType: string, dirs: string[], home: string): Decision {
  const shadow = findShadow(agentType, dirs);
  if (!shadow) return { allow: true };
  return {
    allow: true,
    shadow,
    hint: `${agentType} may be overridden by ${contextPath(shadow, home)}; its tools may differ from the built-in.`,
  };
}

/** Pure decision. Always allows. Sets `unknown` only on the not-found path, never on the fs-error path. */
export function decide(input: TaskInput, env: DecideEnv): Decision {
  if (input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') return { allow: true };
  const agentType = input.tool_input?.subagent_type;
  if (typeof agentType !== 'string' || !agentType) return { allow: true };
  if (agentType.includes(':')) return { allow: true };

  try {
    const dirs = agentDirs(input.cwd, env);
    if (BUILTIN_AGENTS.has(agentType)) return decideBuiltin(agentType, dirs, env.home);
    // A name with a path separator or ".." never names a file in an agents dir.
    const safeName = !/[\\/]|\.\./.test(agentType);
    if (safeName) {
      for (const dir of dirs) {
        // Exact case only: NTFS would also find Scout.md for "scout", and a case-only match is a typo.
        if (fileExists(join(dir, `${agentType}.md`)) && listAgents(dir).includes(agentType)) return { allow: true };
      }
    }
    const similar = safeName ? findSimilarAgents(agentType, [...new Set(dirs.flatMap(listAgents))]) : [];
    if (similar.length === 0) return { allow: true, unknown: true };
    const shown = contextText(agentType, NAME_MAX);
    return { allow: true, unknown: true, hint: `Agent "${shown}" is not a custom agent. Did you mean: ${similar.join(', ')}?` };
  } catch (e) {
    return { allow: true, error: e };
  }
}

function main(): void {
  let input: TaskInput;
  try {
    input = JSON.parse(readStdin());
  } catch {
    console.log('{}');
    return;
  }
  const decision = decide(input, { home: homedir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  const name = String(input.tool_input?.subagent_type).slice(0, 60);
  if (decision.error !== undefined) logGuardError('agent-model-guard', decision.error);
  if (decision.unknown) logGuardDecision('agent-model-guard', input, 'warn', `agent-unknown: ${name}`);
  if (decision.shadow) logGuardDecision('agent-model-guard', input, 'warn', `builtin-shadowed: ${name}`);
  console.log(JSON.stringify(buildOutput(decision)));
}

// Entry only when this file is the process entrypoint, so a test can import decide() safely.
function isDirectRun(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    main();
  } catch (e) {
    logGuardError('agent-model-guard', e);
    console.log('{}');
  }
}
