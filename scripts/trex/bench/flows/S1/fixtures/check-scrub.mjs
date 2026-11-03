import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 10 && dir; i += 1, dir = dirname(dir)) {
    if (existsSync(join(dir, 'apps/agentic-os/src/server/sources/state-files.ts'))) return dir;
  }
  return null;
}

const root = findRoot(process.cwd()) ?? findRoot(dirname(fileURLToPath(import.meta.url)));
if (!root) process.exit(1);

const dir = await mkdtemp(join(tmpdir(), 'trex-s1-'));
process.env.AGENTIC_OS_STATE_DIR = dir;
const id = 'abcdef1234567890abcdef1234567890';
const token = `ghp_${'A'.repeat(36)}`;
const win = (name) => `C:\\Users\\${name}`;
const snap = {
  sessionId: id,
  at: 1700000000000,
  repo: '/home/repouser9/repo-leaf',
  branch: 'main',
  worktree: `${win('leafuser9')}\\wt-leaf`,
  brief: {
    goal: 'Move logs from /var/log/varlog9 to S3',
    ask: [{ text: `Should I delete ${win('winpath9')}\\cache or keep it?`, recommend: 'Keep C:\\tmp\\rectoken9.txt, then stop.' }],
    proofs: [{ id: 'p1', subject: 'prove it', kind: 'plan', artifact: `E2E saved at ${win('someone9')}\\secret\\file.txt` }],
    decisions: [{ text: `kept the file at ${win('decuser9')}\\notes.txt`, by: 'dave', at: 1700000000000 }],
  },
  step: { tool: 'Bash', label: 'git -C /c/Users/posixpath9/proj status', startedAt: 1700000000000 },
  prs: [{ pr: 4321, state: `${win('prsuser9')}\\x ${token}` }],
};

try {
  await writeFile(join(dir, `${id}.json`), JSON.stringify(snap));
  const href = pathToFileURL(join(root, 'apps/agentic-os/src/server/sources/state-files.ts')).href;
  const { readStateFiles } = await import(href);
  const one = (await readStateFiles()).snapshots.find((row) => row.sessionId === id);
  if (!one) process.exit(1);
  const ask = one.brief?.ask?.[0] ?? {};
  console.log(JSON.stringify({
    goal: one.brief?.goal ?? null,
    ask: ask.text ?? null,
    recommend: ask.recommend ?? null,
    decision: one.brief?.decisions?.[0]?.text ?? null,
    artifact: one.brief?.proofs?.[0]?.artifact ?? null,
    step: one.step?.label ?? null,
    worktree: one.worktree ?? null,
    repo: one.repo ?? null,
    pr: one.prs?.[0] ?? null,
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
