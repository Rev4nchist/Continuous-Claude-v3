/**
 * release-claim: a holder frees ONE file claim early (card coord-file-claim-release-one).
 *
 *   node ~/.claude/hooks/dist/release-claim.mjs [--list] <path>...
 *
 * NOT a hook: it is not registered in settings.json. esbuild builds it with the others, so it ships in
 * dist. Session id: CLAUDE_CODE_SESSION_ID, else COORDINATION_SESSION_ID.
 *
 * Exit: 0 every path freed (or --list ok), 4 refused (not the holder, ambiguous, or not held),
 * 2 usage, 1 database down. Output names the caller's OWN rows only; a refusal names the holder label only.
 */
import { listOwnClaims, releaseOwnClaim, type ClaimRow, type ReleaseResult } from './shared/claim-release.js';

export interface Out {
  log(line: string): void;
  err(line: string): void;
}

const USAGE = 'usage: release-claim [--list] <path>...';
const DB_DOWN = 'release-claim: database unavailable, nothing was changed';

const sessionIdOf = (env: Record<string, string | undefined>): string =>
  (env.CLAUDE_CODE_SESSION_ID || '').trim() || (env.COORDINATION_SESSION_ID || '').trim();

const rowLine = (r: ClaimRow): string => `  ${r.file_path}  [${r.project}]`;

function describe(r: ReleaseResult): string[] {
  switch (r.outcome) {
    case 'freed': return [`freed: ${r.file}`];
    case 'none': return [`not held by anyone: ${r.typed}`];
    case 'not-holder': return [`held by another session (${r.heldBy}), not freed: ${r.typed}`];
    case 'ambiguous': return [`ambiguous, nothing freed: ${r.typed} fits ${r.rows.length} of your claims. Type one exactly:`, ...r.rows.map(rowLine)];
    default: return [];
  }
}

async function listCommand(sessionId: string, out: Out): Promise<number> {
  const { rows, degraded } = await listOwnClaims(sessionId);
  if (degraded) return (out.err(DB_DOWN), 1);
  out.log(rows.length ? `claims held by this session (${rows.length}):` : 'this session holds no file claims');
  rows.forEach((r) => out.log(rowLine(r)));
  return 0;
}

async function releaseCommand(sessionId: string, paths: string[], cwd: string, out: Out): Promise<number> {
  const results = await releaseOwnClaim(sessionId, paths, cwd, 'one-file');
  if (results.some((r) => r.outcome === 'degraded')) return (out.err(DB_DOWN), 1);
  results.forEach((r) => describe(r).forEach((line) => out.log(line)));
  return results.every((r) => r.outcome === 'freed') ? 0 : 4;
}

/** The whole CLI. Returns the exit code; prints through `out`. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  out: Out,
): Promise<number> {
  const list = argv.includes('--list');
  const paths = argv.filter((a) => a !== '--list');
  const badFlag = paths.some((a) => a.startsWith('--'));
  const sessionId = sessionIdOf(env);
  if (badFlag || (list ? paths.length > 0 : paths.length === 0)) return (out.err(USAGE), 2);
  if (!sessionId) return (out.err('release-claim: no session id (set CLAUDE_CODE_SESSION_ID or COORDINATION_SESSION_ID)'), 2);
  return list ? listCommand(sessionId, out) : releaseCommand(sessionId, paths, cwd, out);
}

// Run only as the entry file. VITEST and a bundle that imports `run` must not start it.
if (!process.env.VITEST && /(^|[\\/])release-claim\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  run(process.argv.slice(2), process.env, process.cwd(), { log: console.log, err: console.error })
    .then((code) => { process.exitCode = code; })
    .catch(() => { console.error(DB_DOWN); process.exitCode = 1; });
}
