/**
 * probe-boards -- temp project folders plus a temp registry, for the lane board probes.
 *
 * makeBoards('zz-pbprobe', ['a', 'b']) makes <tmp>/proj-a and <tmp>/proj-b, and a registry
 * file with the keys zz-pbprobe-a and zz-pbprobe-b. lane.mjs reads that registry through
 * LANE_REGISTRY_PATH (see laneEnv). The registry never holds a continuous-claude entry unless
 * the caller adds one with `extra`.
 *
 * Nothing here touches a database or the real registry.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeRoot } from './lane-board.mjs';

/**
 * @param {string} prefix  board key prefix; each board key is `${prefix}-${suffix}`
 * @param {string[]} suffixes
 * @param {Array<{name: string, key: string, path: string}>} [extra] more registry entries
 */
export function makeBoards(prefix, suffixes, extra = []) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const boards = {};
  for (const s of suffixes) {
    const dir = path.join(tmp, `proj-${s}`);
    fs.mkdirSync(dir, { recursive: true });
    boards[s] = { key: `${prefix}-${s}`, dir, norm: normalizeRoot(dir) };
  }
  const registry = path.join(tmp, 'registry.json');
  const entry = (name, key, p) => ({ name, key, path: String(p).replace(/\\/g, '/'), status: 'active' });
  fs.writeFileSync(registry, JSON.stringify({
    version: '1.0',
    projects: [...Object.values(boards).map((b) => entry(b.key, b.key, b.dir)), ...extra],
  }));
  return {
    tmp, boards, registry,
    /** An empty identity dir, so a probe never reads the real ~/.claude/state/identity. */
    identityDir: (() => { const d = path.join(tmp, 'ids'); fs.mkdirSync(d); return d; })(),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * The env for a lane.mjs child: the target database in all three variables, the temp
 * registry, no board override and no inherited session id.
 */
export function laneEnv(url, b, extra = {}) {
  const env = { ...process.env };
  for (const k of ['LANE_PROJECT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  return {
    ...env,
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    LANE_REGISTRY_PATH: b.registry, CCV3_IDENTITY_DIR: b.identityDir,
    // `project register` refuses a second board until the live hook sets lane.client_version (PR2). Probes only.
    LANE_SKIP_HOOK_PRECHECK: '1',
    ...extra,
  };
}
