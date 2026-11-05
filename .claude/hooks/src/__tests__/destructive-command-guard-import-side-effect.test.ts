/**
 * Importing destructive-command-guard outside vitest must not run main().
 *
 * A harness that bundles src/destructive-command-guard.ts with esbuild and imports classifyDestructive
 * would, with only a VITEST check, read stdin, fail JSON.parse and write kind:error rows to the real
 * guard-decisions.jsonl. Same defect as package-install-guard (fixed in #330). These tests run the
 * bundles in a child process with VITEST removed and the decision log redirected to a temp file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hooksDir = fileURLToPath(new URL('../../', import.meta.url));
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";

let tmp = '';
let importBundle = '';
let entryBundle = '';

function bundle(contents: string, sourcefile: string, outFile: string): void {
  const out = buildSync({
    stdin: { contents, resolveDir: hooksDir, loader: 'ts', sourcefile },
    bundle: true, platform: 'node', format: 'esm', write: false, preserveSymlinks: true,
    external: ['better-sqlite3'],
    banner: { js: BANNER },
  });
  writeFileSync(outFile, out.outputFiles[0].text);
}

function run(file: string, input: string, logName: string) {
  const log = join(tmp, logName);
  const env: NodeJS.ProcessEnv = { ...process.env, CCV3_GUARD_DECISIONS_LOG: log };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  const res = spawnSync(process.execPath, [file], { input, encoding: 'utf8', timeout: 20000, env });
  const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { res, rows, lines: res.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dcg-import-'));
  importBundle = join(tmp, 'classify-bundle.mjs');
  bundle(
    [
      `import { classifyDestructive } from './src/destructive-command-guard.ts';`,
      `console.log(JSON.stringify({ classified: typeof classifyDestructive }));`,
    ].join('\n'),
    'import-entry.ts',
    importBundle,
  );
  // The real entry: the bundle file carries the hook's own name, as dist/destructive-command-guard.mjs does.
  entryBundle = join(tmp, 'destructive-command-guard.mjs');
  bundle(`import './src/destructive-command-guard.ts';`, 'real-entry.ts', entryBundle);
});

describe('destructive-command-guard import side effect', () => {
  it('importing destructive-command-guard outside vitest runs no main() and logs no crash', () => {
    for (const [label, input] of [['empty stdin', ''], ['raw command text', 'git reset --hard']] as const) {
      const { res, rows, lines } = run(importBundle, input, `import-${label.replace(/\W/g, '-')}.jsonl`);
      expect(res.status, `${label}: exit`).toBe(0);
      expect(rows.filter((r) => r.kind === 'error'), `${label}: error rows`).toEqual([]);
      expect(lines.filter((l) => l === '{}'), `${label}: fail-open output from main()`).toEqual([]);
      expect(lines.at(-1), `${label}: harness output`).toBe('{"classified":"function"}');
    }
  });

  it('the real entry point still runs main() and prints a decision', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD~1' },
      session_id: 'import-side-effect-test',
      cwd: hooksDir,
    });
    const { res, rows, lines } = run(entryBundle, payload, 'entry.jsonl');
    expect(res.status).toBe(0);
    expect(rows.filter((r) => r.kind === 'error')).toEqual([]);
    expect(lines.join('\n')).toContain('permissionDecision');
  });
});
