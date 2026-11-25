/**
 * coord-guard-shell-parser PR A, commit 3: the built coderabbit guard reads dist/sh-syntax.wasm, dist/sh-syntax-wasm_exec.cjs and
 * dist/shell-ast-walk.ps1 at run time (~/.claude/hooks has no node_modules/sh-syntax). scripts/copy-parser-assets.mjs puts them there.
 *
 * Failure list (one test each):
 *   A1 the committed dist copy of a file differs from its source (a stale copy: the wasm, the exec glue or the walker)
 *   A2 the build manifest does not hash the walker, so an edit of src/shell-ast-walk.ps1 without a rebuild looks fresh
 *   A3 the copy script writes a file that differs from its source, or one of the three is missing
 *   A4 a missing source does not stop the build (exit 0): a dist without it would fail closed on every review text
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hooksRoot = resolve(here, '..', '..');
const script = join(hooksRoot, 'scripts', 'copy-parser-assets.mjs');
const shPkgDir = dirname(createRequire(join(hooksRoot, 'package.json')).resolve('sh-syntax/package.json'));
const text = (file: string): string => readFileSync(file).toString('utf8').replace(/\r/g, '');

describe('the committed dist copies match their sources', () => {
  it('A1 sh-syntax.wasm is the wasm of the pinned sh-syntax package, byte for byte', () => {
    expect(readFileSync(join(hooksRoot, 'dist', 'sh-syntax.wasm')).equals(readFileSync(join(shPkgDir, 'main.wasm')))).toBe(true);
  });

  it('A1 sh-syntax-wasm_exec.cjs is the package glue file (line endings aside)', () => {
    expect(text(join(hooksRoot, 'dist', 'sh-syntax-wasm_exec.cjs'))).toBe(text(join(shPkgDir, 'vendors', 'wasm_exec.cjs')));
  });

  it('A1 shell-ast-walk.ps1 in dist is the walker of src (line endings aside)', () => {
    expect(text(join(hooksRoot, 'dist', 'shell-ast-walk.ps1'))).toBe(text(join(hooksRoot, 'src', 'shell-ast-walk.ps1')));
  });

  it('A2 the build manifest hashes the walker, with the same CR-stripped hash as every other external input', () => {
    const manifest = JSON.parse(readFileSync(join(hooksRoot, 'dist', '.build-inputs.json'), 'utf8'));
    const entry = manifest.external['.claude/hooks/src/shell-ast-walk.ps1'];
    expect(entry?.sha256).toBe(createHash('sha256').update(text(join(hooksRoot, 'src', 'shell-ast-walk.ps1'))).digest('hex'));
  });
});

describe('scripts/copy-parser-assets.mjs', () => {
  function root(withSources: boolean): string {
    const r = mkdtempSync(join(tmpdir(), 'copy-parser-assets-'));
    writeFileSync(join(r, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
    mkdirSync(join(r, 'src'), { recursive: true });
    mkdirSync(join(r, 'node_modules', 'sh-syntax', 'vendors'), { recursive: true });
    writeFileSync(join(r, 'node_modules', 'sh-syntax', 'package.json'), '{"name":"sh-syntax","version":"0.8.1"}\n');
    if (withSources) {
      writeFileSync(join(r, 'node_modules', 'sh-syntax', 'main.wasm'), Buffer.from([0, 97, 115, 109, 0, 1, 255, 0]));
      writeFileSync(join(r, 'node_modules', 'sh-syntax', 'vendors', 'wasm_exec.cjs'), 'glue\n');
      writeFileSync(join(r, 'src', 'shell-ast-walk.ps1'), 'walker\n');
    }
    return r;
  }

  it('A3 copies all three files, the wasm byte for byte', () => {
    const r = root(true);
    try {
      const run = spawnSync('node', [script, r], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(readFileSync(join(r, 'dist', 'sh-syntax.wasm')).equals(Buffer.from([0, 97, 115, 109, 0, 1, 255, 0]))).toBe(true);
      expect(readFileSync(join(r, 'dist', 'sh-syntax-wasm_exec.cjs'), 'utf8')).toBe('glue\n');
      expect(readFileSync(join(r, 'dist', 'shell-ast-walk.ps1'), 'utf8')).toBe('walker\n');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('A4 a missing source stops the build with exit 1 and names the file', () => {
    const r = root(false);
    try {
      const run = spawnSync('node', [script, r], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/source missing/);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
