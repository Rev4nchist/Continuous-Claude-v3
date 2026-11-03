import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from './ts-loader.mjs';

registerHooks({ resolve });

const dir = join(tmpdir(), `trex-s13-${process.pid}`);
await mkdir(dir, { recursive: true });
process.env.AGENTIC_OS_STATE_DIR = dir;
const A = 'aaaa1111';
const B = 'bbbb2222';
const C = 'cccc3333';
const E = 'eeee4444';
const Q = 'qqqq5555';

async function put(id, at, repo, prs, mtime) {
  const path = join(dir, `${id}.json`);
  await writeFile(path, JSON.stringify({ sessionId: id, at, repo, branch: 'e2e', prs }));
  if (mtime) await utimes(path, mtime, mtime);
}

await put(A, 1000, 'Rev4nchist/continuous-claude', [
  { pr: 200, state: 'PENDING' }, { pr: 88, state: 'PENDING' },
  { pr: 61, state: 'CLOSED' }, { pr: 77, state: 'READY' },
], 5000);
await put(B, 2000, 'continuous-claude', [
  { pr: 200, state: 'REVIEWED' }, { pr: 88, state: 'READY' }, { pr: 55, state: null },
  { pr: 30, state: 'LIMITED' }, { pr: 77, state: 'PENDING' },
], 1000);
await put(C, 1500, '$HOME/clients/acme-client-x/app', [{ pr: 200, state: 'PENDING' }]);
await put(E, 1600, 'clients\\acme-client-x\\widget', [{ pr: 12, state: 'PROOF' }]);
await put(Q, 3000, 'quiet-repo', [{ pr: 999, state: 'LIMITED' }]);

const root = new URL('../../../../../apps/agentic-os/src/server/', import.meta.url);
const { readStateFiles } = await import(new URL('sources/state-files.ts', root).href);
const { getFleetSessions } = await import(new URL('queries/fleet-sessions.ts', root).href);
const session = (id) => ({
  id, shortId: id, projectKey: null, projectDisplayName: null, rawProject: 'e2e',
  workingOn: null, heartbeatSecondsAgo: 1, activitySecondsAgo: 1, liveSecondsAgo: 1,
  startedSecondsAgo: 10, endedSecondsAgo: null, endReason: null,
});
const fleet = await getFleetSessions(
  { windowMinutes: 15, sessions: [B, A, C, E].map(session), recentlyEnded: [], truncated: false },
  await readStateFiles(),
  1_700_000_000_000,
);
process.stdout.write(JSON.stringify(fleet.prs.map((row) => ({
  key: row.key, repo: row.repo, pr: row.pr, state: row.state,
  sessions: row.sessions.map((item) => item.id),
}))));
