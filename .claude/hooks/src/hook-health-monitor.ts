/**
 * hook-health-monitor.ts — SessionStart hook
 *
 * Validates all registered hooks are healthy at session start.
 * Checks that dist files exist and are not stale (src newer than dist).
 * Reports broken/stale hooks with specific fix commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { emitBraintrustScore } from './shared/braintrust-score.js';
import { resolveBraintrustSpanId } from './shared/braintrust-span.js';

// ============================================
// Types
// ============================================

export interface HookFileInfo {
  distPath: string;
  srcPath: string;
  hookEvent: string;
  hookName: string;
  matcher?: string;
}

export interface HookHealthResult {
  hookName: string;
  status: 'healthy' | 'missing' | 'stale';
  hookEvent: string;
}

interface HookEntry {
  type?: string;
  command?: string;
  /**
   * Live settings.json registers most hooks as
   * {"command":"node","args":["C:/.../dist/foo.mjs"]}. Without this field the
   * parser saw only "node", matched no .mjs, and reported ZERO hooks -- see
   * parseHookCommands.
   */
  args?: string[];
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface SettingsJson {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface SessionStartInput {
  type?: string;
  source?: string;
  session_id?: string;
}

// ============================================
// Core Logic (exported for testing)
// ============================================

/**
 * Parse settings.json to extract all hook dist file references.
 * Only extracts commands that reference .mjs files inside a hooks/dist/ directory.
 * Deduplicates by dist path.
 */
export function parseHookCommands(settings: SettingsJson): HookFileInfo[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') {
    return [];
  }

  const seen = new Set<string>();
  const results: HookFileInfo[] = [];

  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group.hooks || !Array.isArray(group.hooks)) continue;

      for (const hook of group.hooks) {
        if (hook.type !== 'command' || !hook.command) continue;

        // Join command + args BEFORE matching.
        //
        // This is the fault fixed in ee29181, found here again on 2026-07-28 --
        // third occurrence in this codebase. Live settings.json uses
        // {"command":"node","args":[path]} for 80 of 86 entries, so reading
        // `command` alone yields the literal string "node", matches no .mjs,
        // and produces an EMPTY hook list. This function returned [] on every
        // real session, so main() took its `hookFiles.length === 0` early
        // return: the hook health monitor has been checking ZERO hooks and
        // reporting a clean continue, and `hook_health_ratio` never emitted.
        const commandLine = [hook.command, ...(hook.args || [])].join(' ');
        const distPath = extractDistPath(commandLine);
        if (!distPath) continue;

        // Deduplicate
        if (seen.has(distPath)) continue;
        seen.add(distPath);

        const hookName = path.basename(distPath, '.mjs');
        const srcPath = deriveSrcPath(distPath);

        results.push({
          distPath,
          srcPath,
          hookEvent: eventName,
          hookName,
          matcher: group.matcher,
        });
      }
    }
  }

  return results;
}

/**
 * Extract the dist file path from a hook command string.
 * Only matches "node <path>" where path ends in .mjs and is inside a hooks/dist/ directory.
 * Returns null for non-file commands (python, inline scripts, plugins, etc.)
 */
function extractDistPath(command: string): string | null {
  // Match: node <path-to-hooks/dist/something.mjs>
  // The path must contain hooks/dist/ to distinguish from plugin commands
  const match = command.match(/^node\s+(.+\.mjs)\s*$/);
  if (!match) return null;

  let filePath = match[1].trim();

  // Must be in a hooks/dist/ directory
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.includes('hooks/dist/')) return null;

  // Expand leading ~/ or ~\ to the user's home directory so existsSync resolves correctly
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    filePath = path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

/**
 * Derive the corresponding .ts source path from a .mjs dist path.
 * Converts hooks/dist/name.mjs -> hooks/src/name.ts
 */
function deriveSrcPath(distPath: string): string {
  const normalized = distPath.replace(/\\/g, '/');
  const srcPath = normalized
    .replace('/hooks/dist/', '/hooks/src/')
    .replace(/\.mjs$/, '.ts');
  return srcPath;
}

/**
 * Check the health of a single hook by examining its dist and src files.
 *
 * Returns:
 * - 'healthy': dist exists and is not stale (or no src to compare)
 * - 'missing': dist file does not exist
 * - 'stale': dist exists but src is newer (needs rebuild)
 */
export function checkHookHealth(hookInfo: HookFileInfo): HookHealthResult {
  const { distPath, srcPath, hookEvent, hookName } = hookInfo;

  // Check if dist file exists
  if (!fs.existsSync(distPath)) {
    return { hookName, status: 'missing', hookEvent };
  }

  // Check if src file exists for staleness comparison
  if (!fs.existsSync(srcPath)) {
    // Dist exists but no src (plugin or external) - consider healthy
    return { hookName, status: 'healthy', hookEvent };
  }

  // Compare mtimes: if src is newer than dist, build is stale
  const distMtime = fs.statSync(distPath).mtime.getTime();
  const srcMtime = fs.statSync(srcPath).mtime.getTime();

  if (srcMtime > distMtime) {
    return { hookName, status: 'stale', hookEvent };
  }

  return { hookName, status: 'healthy', hookEvent };
}

// ---------------------------------------------------------------------------
// Phase 3a (story braintrust-scoring): hook_health_ratio score payload.
//
// Emits once per SessionStart. The score is registered_count / total_dist_count
// where:
//   * total_dist_count = how many distinct hook commands settings.json points
//     at (i.e. the registered hook count -- equivalent to results.length).
//   * registered_count = how many of those dist files actually exist on disk
//     (status === 'healthy' OR 'stale'; both mean the file is registered AND
//     present, just stale needs a rebuild).
//
// Returns null when:
//   * No hooks are registered (denominator 0 -- no signal to emit)
//   * No spanId is available (no parent span to attach to)
//
// Metadata: { registered, total, missing_list: [up to 10 missing names] }.
// ---------------------------------------------------------------------------

export interface HookHealthScoreInput {
  results: HookHealthResult[];
  spanId: string;
}

/**
 * Build the emit payload for hook_health_ratio. Pure -- exported for tests.
 */
export function buildHookHealthRatioPayload(
  input: HookHealthScoreInput,
): { spanId: string; scores: Record<string, number>; metadata: Record<string, unknown> } | null {
  const { results, spanId } = input;
  if (!spanId || spanId.length === 0) return null;
  const total = results.length;
  if (total === 0) return null;
  // "Registered" here means the file exists on disk (healthy or stale).
  // Missing is the only "broken" state -- the dist file is absent.
  const missing = results.filter((r) => r.status === 'missing');
  const registered = total - missing.length;
  const ratio = registered / total;
  // Cap the missing list at 10 names to keep metadata bounded.
  const missingList = missing.slice(0, 10).map((r) => r.hookName);
  return {
    spanId,
    scores: {
      hook_health_ratio: ratio,
    },
    metadata: {
      registered,
      total,
      missing_list: missingList,
      hook: 'hook-health-monitor',
    },
  };
}

/**
 * Format the health check results into a human-readable report.
 */
export function formatHealthReport(results: HookHealthResult[]): string {
  if (results.length === 0) {
    return 'Hook Health: No hooks registered';
  }

  const healthy = results.filter(r => r.status === 'healthy');
  const issues = results.filter(r => r.status !== 'healthy');

  if (issues.length === 0) {
    return `Hook Health: All ${results.length} hooks healthy`;
  }

  const lines: string[] = [];
  const issueWord = issues.length === 1 ? 'issue' : 'issues';
  lines.push(`Hook Health: ${healthy.length}/${results.length} healthy, ${issues.length} ${issueWord} found`);

  for (const issue of issues) {
    if (issue.status === 'missing') {
      lines.push(`- MISSING: ${issue.hookName}.mjs (fix: npm run build)`);
    } else if (issue.status === 'stale') {
      lines.push(`- STALE: ${issue.hookName}.mjs (src newer than dist, fix: npm run build)`);
    }
  }

  return lines.join('\n');
}

// ============================================
// Main entry point (SessionStart hook)
// ============================================

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  let input: SessionStartInput;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: 'unknown' };
  } catch {
    input = { session_id: 'unknown' };
  }

  try {
    // Determine settings.json path
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const settingsPath = path.join(userProfile, '.claude', 'settings.json');

    if (!fs.existsSync(settingsPath)) {
      // No settings.json - nothing to check
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }

    let settings: SettingsJson;
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // Malformed settings.json - skip health check
      console.error('hook-health-monitor: Could not parse settings.json');
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }

    // Parse all hook commands from settings
    const hookFiles = parseHookCommands(settings);

    if (hookFiles.length === 0) {
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }

    // Check health of each hook
    const results = hookFiles.map(hf => checkHookHealth(hf));

    // Phase 3a: emit hook_health_ratio score (once per session-start). The
    // helper is fail-open; we additionally wrap in try/catch so any unexpected
    // failure can't block the health-report context injection below.
    try {
      // BRAINTRUST_SESSION_ID is set NOWHERE -- process env, ~/.claude/.env and
      // the settings.json env block were all checked on 2026-07-28. So that
      // branch was always empty, and the fallback was worse than useless: a
      // Claude Code session id is NOT a Braintrust span id, so this posted
      // feedback against an id that does not exist as a span. Harmless only
      // while the emit was disabled by the .env gate; the moment that gate was
      // fixed it would have become a stream of bogus writes.
      const spanId = resolveBraintrustSpanId(input.session_id || '');
      const payload = buildHookHealthRatioPayload({ results, spanId });
      if (payload) {
        await emitBraintrustScore(payload); // eslint-disable-line @typescript-eslint/no-floating-promises
      }
    } catch {
      /* fail-open: never let score emission break the hook */
    }

    // Format the report
    const report = formatHealthReport(results);

    // Only inject context if there are issues (keep startup quiet when healthy)
    const hasIssues = results.some(r => r.status !== 'healthy');

    const output: Record<string, unknown> = { result: 'continue' };

    if (hasIssues) {
      output.hookSpecificOutput = {
        hookEventName: 'SessionStart',
        additionalContext: report,
      };
      // Also log to stderr for visibility
      console.error(report);
    } else {
      // Healthy - brief stderr note, no context injection
      console.error(`Hook Health: All ${results.length} hooks healthy`);
    }

    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(`hook-health-monitor error: ${err}`);
    console.log(JSON.stringify({ result: 'continue' }));
  }
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ result: 'continue' }));
  });
}
