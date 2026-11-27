/**
 * Card coord-guard-deny-floor, true floor (Dave 11-27, seat ruling 10:01 and 10:03). src/main-floor/ must be main's own decision-gate.ts and every local module it imports, at one commit
 * of main (the manifest names it), and nothing else. Each copy, with its listed edits taken out again, must equal main's text (sha256 of the LF text). The edits are:
 *   - import paths (the five libs of scripts/github/lib are copied into main-floor/lib, so their import path changes);
 *   - decision-gate.ts only: the import of guard-log becomes two no-op writers, and the auto-run block at the end becomes a one-line comment plus an export that keeps main() used.
 * A byte of any other difference, a file the manifest does not name, or an import that leaves main-floor fails here. When the commit is in the local repo, each copy is also compared
 * with `git show <commit>:<path>` directly.
 * Change that breaks it: any hand edit of a copy (a fix, a rename, a reformat), a copy of another commit, or a new file in the folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const FLOOR = join(HERE, '..', 'main-floor').replace(/\\/g, '/');
const ROOT = join(HERE, '..', '..', '..', '..').replace(/\\/g, '/');
type Edit = { find: string; replace: string };
type Entry = { main: string; copy: string; sha256Main: string; edits: Edit[] };
const MANIFEST = JSON.parse(readFileSync(`${FLOOR}/MANIFEST.json`, 'utf8')) as { ref: string; files: Entry[] };
const lf = (t: string): string => t.replace(/\r\n/g, '\n');
const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const LIB_IMPORT_FIND = /^'(?:\.\.\/)+scripts\/github\/lib\/[a-z-]+\.mjs'$/;
const LIB_IMPORT_REPLACE = /^'(?:\.\/lib|\.\.\/lib)\/[a-z-]+\.mjs'$/;
const GUARD_FIND = "import { logGuardDecision, logGuardError } from './shared/guard-log.js';";
const AUTO_FIND_START = '// Auto-run only as a hook; VITEST imports the pure functions above.\nif (!process.env.VITEST) {';
const AUTO_REPLACE = '// main-floor: the auto-run block of main is removed (the floor is imported, never run as a hook)\nexport { main as floorMainNeverCalled };\n';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
}

describe('main-floor is main plus the listed edits', () => {
  it('the manifest names the commit and every file of the folder, and the folder holds no other file', () => {
    expect(MANIFEST.ref).toMatch(/^[0-9a-f]{40}$/);
    const named = new Set(MANIFEST.files.map((f) => `${FLOOR}/${f.copy}`).concat([`${FLOOR}/MANIFEST.json`]));
    const onDisk = walk(FLOOR);
    expect(onDisk.filter((p) => !named.has(p)), 'a file that the manifest does not name').toEqual([]);
    expect([...named].filter((p) => !onDisk.includes(p)), 'a manifest file that is missing').toEqual([]);
    expect(MANIFEST.files.some((f) => f.copy === 'decision-gate.ts')).toBe(true);
  });

  it.each(MANIFEST.files.map((f) => [f.copy, f] as const))('%s equals main with its edits taken out', (_name, f) => {
    let text = lf(readFileSync(`${FLOOR}/${f.copy}`, 'utf8'));
    for (const e of [...f.edits].reverse()) {
      expect(text.split(e.replace).length - 1, `${f.copy}: the edit text must occur exactly once`).toBe(1);
      text = text.replace(e.replace, () => e.find);
    }
    expect(sha(text), `${f.copy} differs from main ${MANIFEST.ref.slice(0, 8)}:${f.main} by more than the listed edits`).toBe(f.sha256Main);
  });

  it('every listed edit is one of the three allowed kinds', () => {
    for (const f of MANIFEST.files) {
      for (const e of f.edits) {
        const lib = LIB_IMPORT_FIND.test(e.find) && LIB_IMPORT_REPLACE.test(e.replace);
        const guard = f.copy === 'decision-gate.ts' && e.find === GUARD_FIND && /^const logGuardDecision = \(\.\.\._args: unknown\[\]\): void => undefined;.*\nconst logGuardError = \(\.\.\._args: unknown\[\]\): void => undefined;[^\n]*$/.test(e.replace);
        const auto = f.copy === 'decision-gate.ts' && e.find.startsWith(AUTO_FIND_START) && e.replace === AUTO_REPLACE;
        expect(lib || guard || auto, `${f.copy}: an edit of another kind: ${e.find.slice(0, 60)}`).toBe(true);
      }
    }
    const gate = MANIFEST.files.find((f) => f.copy === 'decision-gate.ts') as Entry;
    expect(gate.edits.filter((e) => e.find === GUARD_FIND)).toHaveLength(1);
    expect(gate.edits.filter((e) => e.find.startsWith(AUTO_FIND_START))).toHaveLength(1);
  });

  it('the copy writes no guard log and does not run as a hook', () => {
    const gate = lf(readFileSync(`${FLOOR}/decision-gate.ts`, 'utf8'));
    expect(gate).not.toMatch(/from '\.\/shared\/guard-log\.js'/);
    expect(gate).not.toMatch(/^\s*main\(\)\.catch/m);
    expect(gate).toMatch(/^const logGuardDecision = \(\.\.\._args: unknown\[\]\): void => undefined;/m);
    expect(gate).toMatch(/^const logGuardError = \(\.\.\._args: unknown\[\]\): void => undefined;/m);
  });

  it('no import of the copy leaves the folder or reaches a module of this head', () => {
    for (const f of MANIFEST.files.filter((x) => /\.(ts|mjs)$/.test(x.copy))) {
      const text = lf(readFileSync(`${FLOOR}/${f.copy}`, 'utf8'));
      const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
      for (const s of specs) {
        const target = posix.normalize(posix.join(posix.dirname(`${FLOOR}/${f.copy}`), s));
        expect(target.startsWith(`${FLOOR}/`), `${f.copy} imports ${s}, which leaves main-floor`).toBe(true);
        const cands = [target, target.replace(/\.js$/, '.ts')];
        expect(cands.some((c) => existsSync(c)), `${f.copy} imports ${s}, which does not exist in main-floor`).toBe(true);
      }
    }
  });

  it('where the commit is in the local repo, each copy also equals git show of main with the same edits', () => {
    const has = spawnSync('git', ['cat-file', '-e', `${MANIFEST.ref}^{commit}`], { cwd: ROOT }).status === 0;
    if (!has) return; // a shallow CI checkout: the manifest hash above is the proof
    for (const f of MANIFEST.files) {
      const r = spawnSync('git', ['show', `${MANIFEST.ref}:${f.main}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
      expect(r.status, `git show ${f.main}`).toBe(0);
      let text = lf(r.stdout);
      for (const e of f.edits) text = text.replace(e.find, () => e.replace);
      expect(lf(readFileSync(`${FLOOR}/${f.copy}`, 'utf8')) === text, `${f.copy} differs from git show main with the listed edits`).toBe(true);
    }
  });
});
