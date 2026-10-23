/**
 * Post-Edit Diagnostics Hook
 *
 * Runs shift-left diagnostics after file edits.
 * - Python: Queries TLDR daemon for pyright + ruff diagnostics
 * - TypeScript/JavaScript: Runs tsc --noEmit directly
 * Provides early feedback before tests run.
 */

import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { queryDaemonSync, trackHookActivitySync } from './lib/daemon-client.js';
import { mutateBus, addFileInPlay } from './shared/context-bus.js';

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
 * @param projectDir Project root the diagnostics run against.
 * @returns `{ command: process.execPath, args: [tscJsPath, ...flags] }` or null.
 */
export function resolveTscCommand(
  projectDir: string,
): { command: string; args: string[] } | null {
  const candidates = [
    join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(projectDir, '.claude', 'hooks', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
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

  // Code file extensions we care about
  const codeExtensions = [
    // Python (has linters: pyright + ruff)
    '.py', '.pyx', '.pyi',
    // TypeScript/JavaScript (has linter: tsc --noEmit)
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    // Go (TODO: add go vet)
    '.go',
    // Rust (TODO: add clippy)
    '.rs',
    // Java
    '.java',
    // C/C++
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh',
    // Ruby
    '.rb',
    // C#
    '.cs',
  ];

  const ext = filePath.substring(filePath.lastIndexOf('.'));

  // Skip non-code files entirely
  if (!codeExtensions.includes(ext)) {
    console.log('{}');
    return;
  }

  // Language-aware routing
  const pythonExtensions = ['.py', '.pyx', '.pyi'];
  const tsJsExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (pythonExtensions.includes(ext)) {
    // Python path: query TLDR daemon for pyright + ruff diagnostics
    runPythonDiagnostics(filePath, projectDir);
  } else if (tsJsExtensions.includes(ext)) {
    // TypeScript/JavaScript path: run tsc --noEmit directly
    runTscDiagnostics(filePath, projectDir);
  } else {
    // Other code extensions: no linter configured yet
    console.log('{}');
  }
}

/** Run Python diagnostics via TLDR daemon (pyright + ruff) */
function runPythonDiagnostics(filePath: string, projectDir: string): void {
  // WS-2 Phase B.4a (D2e-08): record the edited file on the bus with role
  // `edited` ONLY, BEFORE any early-return, so the `edited` role lands even when
  // the daemon is unavailable. (A type error is NOT a test failure -- `test_failed`
  // is reserved for a real test runner; session-2 Codex#6.) Fail-open; does not
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

/** Regex for parsing tsc --noEmit --pretty false output lines */
const TSC_LINE_REGEX = /^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/;

interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: number;
  message: string;
}

/** Parse tsc --pretty false output into structured diagnostics */
function parseTscOutput(stdout: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(TSC_LINE_REGEX);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as 'error' | 'warning',
        code: parseInt(match[5], 10),
        message: match[6],
      });
    }
  }
  return diagnostics;
}

/** Run TypeScript/JavaScript diagnostics via tsc --noEmit */
function runTscDiagnostics(filePath: string, projectDir: string): void {
  // WS-2 Phase B.4a (D2e-08): record the edited file on the bus with role
  // `edited` ONLY, BEFORE any early-return, so the `edited` role lands even when
  // tsc is unresolvable / fails to start. (A type error is NOT a test failure --
  // `test_failed` is reserved for a real test runner; session-2 Codex#6.)
  // Fail-open; does not affect the diagnostics output below.
  recordBusFilesInPlay(filePath);

  try {
    // D2e-02: invoke tsc as a direct Node entrypoint (`node <typescript/bin/tsc>`),
    // NOT the `tsc`/`tsc.cmd` shim -- the shim returns status:null/EINVAL on modern
    // Node (Windows CVE-2024-27980 hardening) and silently kills this path.
    const tsc = resolveTscCommand(projectDir);
    if (!tsc) {
      // typescript not installed for this project - skip (bus write already done).
      console.log('{}');
      return;
    }

    const result = spawnSync(tsc.command, tsc.args, {
      cwd: projectDir,
      timeout: 30000,
      encoding: 'utf-8',
      windowsHide: true,
    });

    // tsc process error or could not start - silently skip
    if (result.error || result.status === null) {
      console.log('{}');
      return;
    }

    // Parse tsc output (tsc returns non-zero on type errors, which is expected)
    const diagnostics = parseTscOutput(result.stdout || '');

    const errorCount = diagnostics.filter(d => d.severity === 'error').length;
    const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

    // Track hook activity
    trackHookActivitySync('post-edit-diagnostics', projectDir, true, {
      edits_analyzed: 1,
      type_errors: errorCount,
      lint_issues: warningCount,
    });

    // (bus `edited` write moved to the top of this function -- D2e-08.)

    // No diagnostics - silent success
    if (diagnostics.length === 0) {
      console.log('{}');
      return;
    }

    // Build error summary
    const lines: string[] = [];
    lines.push(`Diagnostics: ${errorCount} type errors, ${warningCount} warnings`);

    const maxPreviews = 5;
    const previews = diagnostics.slice(0, maxPreviews);

    for (const d of previews) {
      lines.push(`   - ${d.file}:${d.line}:${d.column}: ${d.message}`);
    }

    if (diagnostics.length > maxPreviews) {
      const remaining = diagnostics.length - maxPreviews;
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
    // tsc error - silently ignore (graceful degradation)
    console.log('{}');
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
