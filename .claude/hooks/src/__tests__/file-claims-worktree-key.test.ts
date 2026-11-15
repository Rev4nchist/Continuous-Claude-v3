/**
 * file-claims -> the key it hands to resolveFileClaim (card coord-file-claims-worktree-key).
 *
 * Ways it can fail (one test each):
 *  1. An edit in a worktree and the same repo path in the primary give two keys (no conflict).
 *  2. A session whose cwd is repo A, editing repo B, keys by cwd (blind to a session in repo B).
 *  3. The same relative path in two different repos gets one key (false conflict).
 *  4. A file outside any repo loses today's key (raw path, cwd project).
 *  5. The deny message shows another session's absolute path instead of the repo-relative path.
 *
 * The hook runs main() on import and reads stdin, so the test mocks the DB call and fd 0, then
 * imports the real module and records the arguments of resolveFileClaim. Real temp repos and a
 * real `git worktree add`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const seen = vi.hoisted(() => ({
  calls: [] as Array<{ filePath: string; project: string }>,
  decision: { outcome: 'granted' } as Record<string, unknown>,
  payload: '',
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string, project: string) => {
    seen.calls.push({ filePath, project });
    return seen.decision;
  },
}));
// Card coord-file-guard-named-file: a deny asks the lane table for a hint; no test reaches a real database.
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => null }));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

let root: string;
let savedLog: string | undefined;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}
function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(dir, 'src', 'x.ts'), 'x');
  return dir;
}

async function runHook(cwd: string, filePath: string, session = 's1'): Promise<Record<string, unknown>> {
  seen.payload = JSON.stringify({ tool_name: 'Edit', session_id: session, cwd, tool_input: { file_path: filePath } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const printed = JSON.parse(String(out.mock.calls[0][0]));
  out.mockRestore();
  return printed;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-key-')));
  seen.calls = [];
  seen.decision = { outcome: 'granted' };
  savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
});
afterEach(() => {
  if (savedLog === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
  else process.env.CCV3_GUARD_DECISIONS_LOG = savedLog;
  rmSync(root, { recursive: true, force: true });
});

describe('file-claims key', () => {
  it('1. hands the same key for a worktree edit and a primary edit of one repo path', async () => {
    const a = makeRepo('a');
    const wt = join(root, 'a-wt');
    git(a, 'worktree', 'add', '-q', wt, '-b', 'a-wt');
    await runHook(a, join(a, 'src', 'x.ts'), 's-primary');
    await runHook(wt, join(wt, 'src', 'x.ts'), 's-worktree');
    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[1]).toEqual(seen.calls[0]);
    expect(seen.calls[0].filePath).toBe('src/x.ts');
  });

  it('2. keys by the file repo when cwd is another repo', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    await runHook(a, join(b, 'src', 'x.ts'), 's-cwd-a');
    await runHook(b, join(b, 'src', 'x.ts'), 's-cwd-b');
    expect(seen.calls[0]).toEqual(seen.calls[1]);
  });

  it('3. keeps the same relative path in two repos apart', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    await runHook(a, join(a, 'src', 'x.ts'));
    await runHook(b, join(b, 'src', 'x.ts'));
    expect(seen.calls[0].filePath).toBe(seen.calls[1].filePath);
    expect(seen.calls[0].project).not.toBe(seen.calls[1].project);
  });

  it('4. keeps today key (raw path, cwd project) for a file outside any repo', async () => {
    const a = makeRepo('a');
    const loose = join(root, 'loose');
    mkdirSync(loose);
    const file = join(loose, 'z.ts');
    writeFileSync(file, 'z');
    await runHook(a, file);
    expect(seen.calls[0].filePath).toBe(file);
    expect(seen.calls[0].project).toBe(
      (await import('../shared/session-id.js')).canonicalProject(a),
    );
  });

  it('6. resolves a relative file_path against the payload cwd, not the hook process cwd', async () => {
    const a = makeRepo('a');
    await runHook(a, join('src', 'x.ts'));
    expect(seen.calls[0].filePath).toBe('src/x.ts');
    expect(seen.calls[0].project).toBe(
      (await import('../shared/session-id.js')).canonicalProject(a),
    );
  });

  it('5. names the holder and the repo-relative path in the deny, not an absolute path', async () => {
    const a = makeRepo('a');
    seen.decision = { outcome: 'blocked', holder: 'sess-holder', leaseClass: 'file' };
    const printed = await runHook(a, join(a, 'src', 'x.ts'));
    const text = JSON.stringify(printed);
    expect(text).toContain('deny');
    expect(text).toContain('sess-holder');
    expect(text).toContain('src/x.ts');
    expect(text).not.toContain(root.replace(/\\/g, '/'));
    expect(text).not.toContain(root.replace(/\\/g, '\\\\'));
  });
});
