/**
 * Post-Edit Diagnostics Hook
 *
 * Runs shift-left diagnostics after file edits.
 * - Python: Queries TLDR daemon for pyright + ruff diagnostics
 * - TypeScript/JavaScript: Runs tsc -p <nearest tsconfig.json> --noEmit
 * Provides early feedback before tests run.
 */

import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, relative, resolve } from 'path';
import { queryDaemonSync, trackHookActivitySync } from './lib/daemon-client.js';
import { mutateBus, addFileInPlay } from './shared/context-bus.js';
import {
  classifyExtension,
  findNearestTsconfig,
  formatTsDiagnostics,
  isSolutionStyleTsconfig,
  parseTscOutput,
} from './shared/ts-diagnostics.js';

/** tsc gets this long; the registration timeout (60 s) leaves room for startup and telemetry. */
const TSC_TIMEOUT_MS = 45000;
/** Room for a large error cascade; formatTsDiagnostics caps what reaches Claude. */
const TSC_MAX_BUFFER = 64 * 1024 * 1024;

interface HookInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
  };
  tool_result?: {
    success?: boolean;
  };
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

/**
 * Record the just-edited file on the L2 context bus (WS-2 Phase B.4a) so the
 * recall path (B.3) can bias on load-bearing files. This is a SIDE EFFECT layered
 * on top of the hook's diagnostics behavior -- it MUST NOT change or block the
 * hook's output. mutateBus is fail-open and honors CCV3_BUS_OFF + the 200ms lock
 * cap (a contended-out write is LOGGED by mutateBus as bus_write_dropped, not
 * silent -- review F4); we additionally wrap the call so a throwing bus write is
 * swallowed and never surfaces in the diagnostics path.
 *
 * Role: `edited` ONLY. A type-check failure is deliberately NOT marked
 * `test_failed` (review F6) -- that role is reserved for a real test-runner; a
 * type error on an edited file is already captured by the `edited` role.
 *
 * turn_added is stamped from the bus's current_turn (best-effort: if the
 * per-prompt turn bump was itself dropped under contention, a freshly-edited file
 * can read one turn stale -- a bounded, fail-safe over-estimate, review F2).
 *
 * @param filePath The edited file (load-bearing).
 */
export function recordBusFilesInPlay(filePath: string): void {
  try {
    mutateBus(undefined, (b) => {
      addFileInPlay(b, { path: filePath, role: 'edited', turn_added: b.current_turn ?? 0 });
    });
  } catch {
    // Fail-open: a bus write must never break or block the diagnostics hook.
  }
}

/**
 * Resolve the tsc invocation as a direct Node entrypoint call (D2e-02).
 *
 * `spawnSync('tsc', ...)` resolves to `tsc.cmd` on Windows, and modern Node
 * refuses to spawn a `.cmd`/`.bat` shim without `shell: true` (CVE-2024-27980
 * hardening) -- it returns `status: null` / EINVAL, which the hook then treats
 * as "tsc not found" and the entire TS/JS diagnostics path silently dies on the
 * primary platform. Instead we locate the typescript package's JS entrypoint
 * (`node_modules/typescript/bin/tsc` -- a `require('../lib/tsc.js')` shim) and
 * run it as `node <tsc> --noEmit --pretty false`, keeping args as an ARRAY with
 * NO shell (so spaced/drive-letter paths stay safe). Mirrors the proven
 * codegraph `node <npm-shim.js>` pattern (see windows-platform.md).
 *
 * Resolution is deterministic and dependency-free: it probes the project's own
 * node_modules and the hooks' bundled node_modules. Returns null when typescript
 * is not installed in either location; the caller treats null like "tsc not
 * found" and skips diagnostics (the bus `edited` write still happens upstream).
 *
 * Search order: the CCV3_TSC override (path to a tsc JS entry, e.g. a scratch TS 7 install),
 * then `node_modules/typescript` in startDir and each parent up to stopDir, then the hooks'
 * own bundled copy under stopDir. So each project uses the typescript it installed.
 *
 * @param startDir Folder to start the search in (the tsconfig's folder).
 * @param stopDir Highest folder to search (the project root). Defaults to startDir.
 * @returns `{ command: process.execPath, args: [tscJsPath, ...flags] }` or null.
 */
export function resolveTscCommand(
  startDir: string,
  stopDir: string = startDir,
): { command: string; args: string[] } | null {
  const candidates: string[] = [];
  if (process.env.CCV3_TSC) candidates.push(process.env.CCV3_TSC);
  const stop = resolve(stopDir);
  let dir = resolve(startDir);
  for (;;) {
    candidates.push(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'));
    const parent = dirname(dir);
    if (dir === stop || parent === dir || relative(stop, dir).startsWith('..')) break;
    dir = parent;
  }
  candidates.push(join(stop, '.claude', 'hooks', 'node_modules', 'typescript', 'bin', 'tsc'));
  if (process.env.CCV3_TSC) {
    // An explicit override must not silently fall back to another compiler.
    candidates.length = 1;
  }
  for (const tscPath of candidates) {
    try {
      if (existsSync(tscPath)) {
        return {
          command: process.execPath,
          args: [tscPath, '--noEmit', '--pretty', 'false'],
        };
      }
    } catch {
      // Fail-open: probing the filesystem must never throw into the hook path.
    }
  }
  return null;
}

async function main() {
  const input: HookInput = JSON.parse(readFileSync(0, 'utf-8'));

  // Only run on Edit and Write operations
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') {
    console.log('{}');
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    console.log('{}');
    return;
  }

  // Language-aware routing (case-insensitive; other code languages have no checker yet).
  const kind = classifyExtension(filePath);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (kind === 'python') {
    // Python path: query TLDR daemon for pyright + ruff diagnostics
    runPythonDiagnostics(filePath, projectDir);
  } else if (kind === 'ts' || kind === 'js') {
    runTscDiagnostics(filePath, projectDir, kind);
  } else {
    console.log('{}');
  }
}

/** Run Python diagnostics via TLDR daemon (pyright + ruff) */
function runPythonDiagnostics(filePath: string, projectDir: string): void {
  // WS-2 Phase B.4a (D2e-08): record the edited file on the bus with role
  // `edited` ONLY, BEFORE any early-return, so the `edited` role lands even when
  // the daemon is unavailable. (A type error is NOT a test failure -- `test_failed`
  // is reserved for a real test runner; session-2 review#6.) Fail-open; does not
  // affect the diagnostics output below.
  recordBusFilesInPlay(filePath);

  try {
    const response = queryDaemonSync(
      { cmd: 'diagnostics', file: filePath },
      projectDir
    );

    // If daemon is unavailable or no errors, silently succeed
    if (response.status === 'unavailable' || response.error) {
      console.log('{}');
      return;
    }

    // Handle both direct response and summary-wrapped response formats
    const summary = (response as any).summary || response;
    const typeErrors = summary.type_errors || 0;
    const lintIssues = summary.lint_errors || summary.lint_issues || 0;
    const errors = response.errors || [];

    // Track hook activity
    trackHookActivitySync('post-edit-diagnostics', projectDir, true, {
      edits_analyzed: 1,
      type_errors: typeErrors,
      lint_issues: lintIssues,
    });

    // (bus `edited` write moved to the top of this function -- D2e-08.)

    // No errors - silent success
    if (typeErrors === 0 && lintIssues === 0) {
      console.log('{}');
      return;
    }

    // Build error summary
    const lines: string[] = [];
    lines.push(`Diagnostics: ${typeErrors} type errors, ${lintIssues} lint issues`);

    const maxPreviews = 5;
    const previews = errors.slice(0, maxPreviews);

    for (const err of previews) {
      const location = err.column
        ? `${err.file}:${err.line}:${err.column}`
        : `${err.file}:${err.line}`;
      lines.push(`   - ${location}: ${err.message}`);
    }

    if (errors.length > maxPreviews) {
      const remaining = errors.length - maxPreviews;
      lines.push(`   ... and ${remaining} more`);
    }

    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n')
      }
    };
    console.log(JSON.stringify(output));
  } catch {
    // Daemon error - silently ignore (graceful degradation)
    console.log('{}');
  }
}

/** Print a PostToolUse note for Claude, or `{}` when there is nothing to say. */
function emit(note: string | null): void {
  if (!note) {
    console.log('{}');
    return;
  }
  const output: HookOutput = {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note },
  };
  console.log(JSON.stringify(output));
}

/** Telemetry for the TS path. Never starts the TLDR daemon (that costs ~10 s). */
function trackTs(projectDir: string, ok: boolean, metrics: Record<string, number>): void {
  process.env.CCV3_DAEMON_NO_AUTOSTART = '1';
  trackHookActivitySync('post-edit-diagnostics', projectDir, ok, { edits_analyzed: 1, ...metrics });
}

/** Run TypeScript/JavaScript diagnostics via tsc -p <nearest tsconfig> --noEmit */
function runTscDiagnostics(filePath: string, projectDir: string, kind: 'ts' | 'js'): void {
  // WS-2 Phase B.4a (D2e-08): record the edited file on the bus with role
  // `edited` ONLY, BEFORE any early-return, so the `edited` role lands even when
  // tsc is unresolvable / fails to start. (A type error is NOT a test failure --
  // `test_failed` is reserved for a real test runner; session-2 review#6.)
  // Fail-open; does not affect the diagnostics output below.
  recordBusFilesInPlay(filePath);
  const started = Date.now();
  const ms = () => Date.now() - started;

  try {
    // The project that owns the edited file, not CLAUDE_PROJECT_DIR (root cause of the
    // 2026-11-05 silent no-op: no tsconfig at the CCv3 root, so tsc printed its help).
    const tsconfig = findNearestTsconfig(filePath, projectDir);
    if (!tsconfig) {
      trackTs(projectDir, false, { skipped_no_tsconfig: 1, duration_ms: ms() });
      // Plain JS outside any TS project is normal; a TS file with no tsconfig is not.
      emit(kind === 'ts' ? `TypeScript check skipped: no tsconfig.json found above ${filePath}.` : null);
      return;
    }
    if (isSolutionStyleTsconfig(tsconfig)) {
      trackTs(projectDir, false, { skipped_solution_style: 1, duration_ms: ms() });
      emit(`TypeScript check skipped: ${tsconfig} only lists project references. Run tsc -b for that project.`);
      return;
    }

    // D2e-02: invoke tsc as a direct Node entrypoint (`node <typescript/bin/tsc>`),
    // NOT the `tsc`/`tsc.cmd` shim -- the shim returns status:null/EINVAL on modern
    // Node (Windows CVE-2024-27980 hardening) and silently kills this path.
    const tsconfigDir = dirname(tsconfig);
    const tsc = resolveTscCommand(tsconfigDir, projectDir);
    if (!tsc) {
      trackTs(projectDir, false, { no_compiler: 1, duration_ms: ms() });
      emit(`TypeScript check did not run: no typescript compiler found for ${tsconfig}.`);
      return;
    }

    // Safe: the command is process.execPath, args are an array with no shell, and tsconfig is an
    // absolute path found on disk (it cannot start with '-'). Dave approved this suppression 2026-11-05.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const result = spawnSync(tsc.command, [...tsc.args, '-p', tsconfig], {
      cwd: tsconfigDir,
      timeout: TSC_TIMEOUT_MS,
      // A broken core type can print tens of thousands of errors; the 1 MiB default kills tsc.
      maxBuffer: TSC_MAX_BUFFER,
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (result.error || result.status === null) {
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      trackTs(projectDir, false, { tsc_failed: 1, timed_out: timedOut ? 1 : 0, duration_ms: ms() });
      emit(`TypeScript check did not run: ${timedOut ? `timed out after ${TSC_TIMEOUT_MS / 1000} s` : 'tsc failed to start'} (${tsconfig}).`);
      return;
    }

    const stdout = result.stdout || '';
    const diagnostics = parseTscOutput(stdout);
    if (diagnostics.length === 0 && result.status !== 0) {
      // tsc failed without file diagnostics (bad tsconfig, unknown option, help text).
      const head = (stdout + (result.stderr || '')).trim().split(/\r?\n/).slice(0, 3).join(' | ');
      trackTs(projectDir, false, { tsc_failed: 1, duration_ms: ms() });
      emit(`TypeScript check did not run cleanly (exit ${result.status}, ${tsconfig}): ${head.slice(0, 500)}`);
      return;
    }

    const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
    trackTs(projectDir, true, {
      type_errors: errorCount,
      lint_issues: diagnostics.length - errorCount,
      duration_ms: ms(),
    });
    if (diagnostics.length === 0) {
      emit(null);
      return;
    }
    const label = relative(projectDir, tsconfig).replace(/\\/g, '/') || 'tsconfig.json';
    emit(formatTsDiagnostics(diagnostics, filePath, tsconfigDir, label));
  } catch (e) {
    emit(`TypeScript check did not run: ${(e as Error)?.message ?? 'internal error'}.`);
  }
}

// Only run main() when executed directly (not when imported by tests). Tests
// import this module to unit-test recordBusFilesInPlay without driving stdin;
// vitest does not invoke the bundle as an entry point. The production dist is
// invoked by node as `post-edit-diagnostics.mjs`, so this stays true at runtime.
// (Idiom mirrored from agent-recall-injector.ts.)
const isDirectInvocation = (() => {
  try {
    const arg1 = process.argv[1] || '';
    return (
      arg1.endsWith('post-edit-diagnostics.mjs') ||
      arg1.endsWith('post-edit-diagnostics.js') ||
      arg1.endsWith('post-edit-diagnostics.ts')
    );
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch(() => console.log('{}'));
}

// Re-export the entry-detection flag so the guard above is resilient to
// bundler path-mangling (no-op for runtime).
export const __isDirectInvocation = isDirectInvocation;
