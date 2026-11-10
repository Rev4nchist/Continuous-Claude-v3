/**
 * lane-context prints the session label ("<name> #sid8") for self and peers.
 *
 * Failure list, one test each:
 *   L1  self prints "You are session <sid8>" or a bare uuid instead of the label
 *   L2  a peer with no lane is dropped, or printed without "holds no lane"
 *   L3  a peer name is not read from its identity file
 *   L4  an unread lane update names its sender by bare hex
 *   L5  the peers query went back to an inner join (laneless peers vanish)
 *   L6  the peers query lost its order (lane holders first, newest heartbeat) or its LIMIT 10
 *   L7  a cut list hides how many sessions were cut
 *
 * The database is a stub: it answers by query text. The live SQL is covered by
 * scripts/coordination probes, not here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queries: string[] = [];
let peerTotal: number | undefined;
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'bbbbbbbb-0000-4000-8000-000000000002';
const P2 = 'cccccccc-0000-4000-8000-000000000003';

vi.mock('pg', () => ({
  Client: class {
    on() { return this; }
    async connect() {}
    async end() {}
    async query(sql: string) {
      queries.push(sql);
      if (/FROM sessions s/.test(sql)) {
        return { rows: [
          { sid: P1, lanes: 'review-eval', scopes: 'src/a', total: peerTotal ?? 2 },
          { sid: P2, lanes: null, scopes: null, total: peerTotal ?? 2 },
        ] };
      }
      if (/FROM agentic_os\.lane_event e\b/.test(sql)) {
        return { rows: [{ id: 7, occurred_at: '', lane_id: null, kind: 'note', session_id: P1, to_session_id: null, body: 'hello' }] };
      }
      return { rows: [] };
    }
  },
}));

import { runLaneContext } from '../lane-context.js';
import { writeIdentity } from '../shared/session-identity.js';

let dir: string;
const saved = {
  id: process.env.CCV3_IDENTITY_DIR, db: process.env.DATABASE_URL,
  reg: process.env.LANE_REGISTRY_PATH, cache: process.env.LANE_BOARD_CACHE, ep: process.env.CLAUDE_CODE_ENTRYPOINT,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lc-ident-'));
  process.env.CCV3_IDENTITY_DIR = dir;
  process.env.DATABASE_URL = 'postgres://stub@127.0.0.1:1/stub';
  // Hermetic board: the hook resolves its board from the registry, so give it one that covers the test cwd.
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ projects: [{ name: 'CCv3', key: 'continuous-claude', path: process.cwd(), status: 'active' }] }));
  process.env.LANE_REGISTRY_PATH = join(dir, 'registry.json');
  process.env.LANE_BOARD_CACHE = '0';
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  queries.length = 0;
  peerTotal = undefined;
});
afterEach(() => {
  if (saved.id === undefined) delete process.env.CCV3_IDENTITY_DIR; else process.env.CCV3_IDENTITY_DIR = saved.id;
  if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db;
  if (saved.reg === undefined) delete process.env.LANE_REGISTRY_PATH; else process.env.LANE_REGISTRY_PATH = saved.reg;
  if (saved.cache === undefined) delete process.env.LANE_BOARD_CACHE; else process.env.LANE_BOARD_CACHE = saved.cache;
  if (saved.ep === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = saved.ep;
  rmSync(dir, { recursive: true, force: true });
});

async function start(extra: object = {}): Promise<string> {
  const out = (await runLaneContext(JSON.stringify({
    session_id: ME, hook_event_name: 'SessionStart', ...extra,
  }))) as { hookSpecificOutput: { additionalContext: string } };
  return out.hookSpecificOutput.additionalContext;
}

describe('lane-context labels', () => {
  it('L1: self is the label, from session_title', async () => {
    expect(await start({ session_title: 'trex' })).toContain('You are trex #aaaaaaaa.');
  });

  it('L1: self falls back to the identity file, then to #sid8 alone', async () => {
    expect(await start()).toContain('You are #aaaaaaaa.');
    writeIdentity(ME, { name: 'filed' });
    expect(await start()).toContain('You are filed #aaaaaaaa.');
  });

  it('L2+L3: peers carry their label; a peer with no lane says so', async () => {
    writeIdentity(P1, { name: 'review' });
    const text = await start();
    expect(text).toContain('review #bbbbbbbb holds review-eval');
    expect(text).toContain('#cccccccc holds no lane');
  });

  it('L4: an unread update names its sender by label', async () => {
    writeIdentity(P1, { name: 'review' });
    expect(await start()).toContain('- review #bbbbbbbb note: hello');
  });

  it('L5: the peers query is a LEFT JOIN on lanes', async () => {
    await start();
    expect(queries.find((q) => /FROM sessions s/.test(q))).toMatch(/LEFT JOIN agentic_os\.lane/);
  });

  it('L6: the peers query puts lane holders first, then the newest heartbeat, and stops at 10', async () => {
    await start();
    const q = queries.find((x) => /FROM sessions s/.test(x)) ?? '';
    expect(q).toMatch(/ORDER BY\s*\(count\(l\.id\) > 0\) DESC,\s*max\(GREATEST\(s\.last_heartbeat, s\.last_activity_at\)\) DESC/);
    expect(q).toMatch(/LIMIT 10\s*$/);
  });

  it('L7: a cut list says how many sessions are not shown; a full list says nothing', async () => {
    peerTotal = 13;
    expect(await start()).toContain('+11 more sessions');
    peerTotal = undefined;
    expect(await start()).not.toContain('more sessions');
  });
});
