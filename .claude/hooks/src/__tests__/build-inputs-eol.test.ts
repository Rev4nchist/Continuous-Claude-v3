import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/.build-inputs.json is written with LF by scripts/write-build-inputs.mjs and committed as LF.
// With core.autocrlf=true and no .gitattributes rule, a checkout writes it as CRLF. The next build
// writes LF again, and `git status` shows the file as modified (index stat size differs) until
// someone runs `git add`. That breaks the pre-pr git:clean gate. A rule that pins the file to LF
// makes the checkout and the writer agree.
const here = dirname(fileURLToPath(import.meta.url));
const hooksRoot = resolve(here, '..', '..');
const repoRoot = resolve(hooksRoot, '..', '..');
const writer = join(hooksRoot, 'scripts', 'write-build-inputs.mjs');
const INPUTS = '.claude/hooks/dist/.build-inputs.json';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('dist/.build-inputs.json line endings', () => {
  it('stays clean in git status after a CRLF-converting checkout and a rebuild', () => {
    const repo = mkdtempSync(join(tmpdir(), 'build-inputs-eol-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'core.autocrlf', 'true');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'test');
      copyFileSync(join(repoRoot, '.gitattributes'), join(repo, '.gitattributes'));

      const tempHooks = join(repo, '.claude', 'hooks');
      mkdirSync(join(tempHooks, 'src'), { recursive: true });
      writeFileSync(join(tempHooks, 'src', 'a.ts'), 'export const a = 1;\n');
      // The writer needs the esbuild metafile (item 14: no metafile = exit 1). Committed here so git status stays clean.
      writeFileSync(join(tempHooks, '.build-meta.json'), JSON.stringify({ inputs: { 'src/a.ts': {} }, outputs: {} }));
      execFileSync('node', [writer, tempHooks]);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');

      // A fresh checkout: remove the file, then restore it through the autocrlf and attribute filters.
      rmSync(join(repo, INPUTS));
      git(repo, 'checkout', 'HEAD', '--', INPUTS);
      execFileSync('node', [writer, tempHooks]);

      expect(readFileSync(join(repo, INPUTS), 'utf8')).not.toContain('\r');
      expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
