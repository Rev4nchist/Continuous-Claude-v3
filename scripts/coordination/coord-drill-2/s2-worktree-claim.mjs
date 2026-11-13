/**
 * Row 2 (O3.6 / O3.1): a git worktree of the same repo must not edit a file another live session holds.
 *
 * Setup: a throwaway git repo inside the sandbox (checkout 1) and a linked worktree of it. Session A
 * edits src/x.ts in checkout 1. Session B edits src/x.ts in the worktree. Both calls go through the BUILT
 * file-claims hook (dist/file-claims.mjs), fed a real PreToolUse payload on stdin, against the scratch
 * database. Nothing touches the real repo.
 *
 * PASS  = B gets a deny that names session A (the deny text holds the holder's session id).
 * FAIL  = B gets a plain continue (or an "[INFO]" takeover message): the two paths are two claim keys.
 *         A "[WARN]" answer is the BREAK-GLASS takeover (B was let through): it is an ERROR, never a PASS.
 *         A new hook that keys A's claim by a raw path (fallback key), or a stale build (src has resolveClaimKey,
 *         dist not), is an ERROR too: it would look like a regression.
 * ERROR = the harness cannot say. Cases: the positive control fails (a second session in ONE checkout
 *         must be denied), the hook stdout is not JSON or the hook exits non-zero, the hook failed open
 *         ("[WARN] Coordination DB unreachable"), A has no file_claims row after its call, the hook
 *         printed a crash marker on stderr (a crash prints {"result":"continue"} and exits 0), B got a
 *         plain continue but has no file_claims row of its own, A and B hold different project keys
 *         (the one-repo premise is broken), or a child wrote a real file outside the sandbox.
 *
 * Why the hook output alone is not enough: a granted claim and a silent fail-open both print
 * {"result":"continue"} (.claude/hooks/src/file-claims.ts:192 and :182-185). So the row also reads
 * file_claims for A and, when B continues, for B.
 *
 * Three probes run, each in its own fresh repo with its own session ids, so one run never blocks another:
 *   id '2'       the hook of the checkout under test (PATHS.HOOK_DIST). This is the verdict row. It is counted
 *                by the ratchet (expected.json). Since PR 536 (merge e17eda1c, claims keyed by the file's own
 *                repo) the expected verdict is PASS. On a checkout that does not hold that merge the dist is the
 *                old hook and the row says FAIL; evidence.hasResolveClaimKey tells which hook ran.
 *   id '2-old'   INFO. The hook as it was before PR 536 (git rev 900124e6). The drill writes it into the
 *                per-run sandbox folder (never into the repo or the real home) and runs it the same way.
 *                Expected FAIL: it shows the gap that row 2 now closes. Not in expected.json, so the ratchet
 *                never counts it. It prints its own verdict (seat condition C4).
 *   id '2-cross' INFO. The same hook as row 2. Session B has its cwd in a worktree of ONE repo and edits a file
 *                in a worktree of ANOTHER repo, which session A holds through that repo's main checkout. The key
 *                is by the file's own repo, so the expected verdict is deny (PASS). Not in expected.json.
 * The --new-file-claims flag is gone (here and in run.mjs): row 2 reads the hook of the checkout under test.
 * Each probe is caught on its own: an error in one gives an ERROR row for that probe and the others still run.
 * A hook crash, or an old hook that cannot be read from git, is an ERROR row, never PASS or FAIL.
 * The cross probe skips the same-project-key check: its premise is that cwd and file name different repos.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { HarnessError, PATHS, assertNotAborted, runNode, insertSession, track, result, snapshotRealHome, diffRealHome } from './lib.mjs';

export const meta = {
  id: '2',
  title: 'A worktree of the same repo cannot edit a file another live session holds',
  rule: 'O3.6/O3.1: the claim key is the file in the repo, not the spelling of its path, so checkout 1 and a worktree share one claim.',
};

const fwd = (p) => String(p).replace(/\\/g, '/');

// What the hook prints on stderr when it crashed or failed open. A crash still prints {"result":"continue"}
// and exits 0 (file-claims.ts:208-211), so stdout alone cannot tell a crash from a grant.
const CRASH_RE = /\[file-claims\] (?:unexpected error|coordination degraded)|\b(?:UnhandledPromiseRejection|TypeError|ReferenceError|SyntaxError)\b|ERR_MODULE_NOT_FOUND|Cannot find module/;

/** A fault of the harness or its control. probeHook turns it into an ERROR row, never a FAIL. */
class Fault extends Error {}

// ---------------------------------------------------------------- git (throwaway repo only)

/**
 * Run git with an argv array and no shell. Identity is passed by -c flags, so no identity config is needed.
 * HOME and USERPROFILE are the sandbox home (ctx.env), so the real global git config is not read; the
 * system config still is. After a timeout abort it refuses: a scenario that kept running must not use the removed sandbox.
 */
export function git(ctx, cwd, args) {
  assertNotAborted('git');
  const flags = [
    '-c', 'user.name=coord-drill', '-c', 'user.email=coord-drill@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${fwd(path.join(ctx.sandbox.dir, 'no-hooks'))}`,
  ];
  const r = spawnSync('git', [...flags, ...args], { cwd, env: ctx.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.error) throw new HarnessError(`could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new HarnessError(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

/** A repo with one commit and a linked worktree. Both hold src/x.ts and src/ctl.ts. Returns the two folders. */
export function makeRepo(ctx, label) {
  assertNotAborted('makeRepo');
  const root = path.join(ctx.sandbox.dir, `s2-${label}`);
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(ctx.sandbox.dir, 'no-hooks'), { recursive: true });
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(main, 'src', 'ctl.ts'), 'export const ctl = 1;\n');
  git(ctx, main, ['init', '-q']);
  git(ctx, main, ['add', '-A']);
  git(ctx, main, ['commit', '-q', '-m', 'drill: one commit']);
  git(ctx, main, ['worktree', 'add', '-q', '-b', `drill-wt-${label}`, wt]);
  return { main, wt };
}

// ---------------------------------------------------------------- calling the built hook

const editPayload = (sessionId, cwd, file) => JSON.stringify({
  tool_name: 'Edit', session_id: sessionId, cwd,
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
});

/** What the hook said: deny, warn, unreachable (failed open), info, continue, or bad (not usable output). */
function classify(r) {
  if (r.code !== 0) return { kind: 'bad', note: `hook exit code ${r.code}` };
  if (CRASH_RE.test(r.err)) return { kind: 'bad', note: 'hook wrote a crash marker on stderr (a crash still prints continue)' };
  let o;
  try { o = JSON.parse(r.out.trim()); } catch { return { kind: 'bad', note: 'hook stdout is not JSON' }; }
  if (o?.hookSpecificOutput?.permissionDecision === 'deny') return { kind: 'deny', note: '' };
  const msg = typeof o?.message === 'string' ? o.message : '';
  if (/Coordination DB unreachable/.test(msg)) return { kind: 'unreachable', note: msg };
  if (msg.startsWith('[WARN]')) return { kind: 'warn', note: msg };
  if (msg) return { kind: 'info', note: msg };
  if (o?.result === 'continue') return { kind: 'continue', note: '' };
  return { kind: 'bad', note: 'hook stdout has an unknown shape' };
}

function callHook(ctx, hook, payload) {
  // cwd in the sandbox: a cwd-relative write by the hook (the old blob too) lands there, never in the repo.
  const r = runNode(hook, [], { env: ctx.env, input: payload, cwd: ctx.sandbox.dir });
  return { ...r, ...classify(r), text: r.out.trim() };
}

/** A hook answer the harness cannot trust: unusable output, or a fail-open. */
function requireUsable(call, what) {
  if (call.kind === 'bad') throw new Fault(`${what}: ${call.note}. stderr: ${call.err.trim().slice(0, 200)}`);
  if (call.kind === 'unreachable') throw new Fault(`${what}: the hook failed open (${call.note}). The scratch database was not reachable by the hook.`);
}

async function claimsOf(ctx, ids) {
  const rows = await ctx.pg(async (c) => (await c.query(
    `SELECT file_path, project, session_id FROM public.file_claims
      WHERE session_id = ANY($1::text[]) ORDER BY claimed_at, file_path`, [ids])).rows);
  // The hook stores a file in a repo as the repo-relative key with the repo's project, not as the absolute path that
  // track(ctx, 'file') holds. The live zero check needs the pair as stored, or it cannot match this run's rows.
  for (const r of rows) track(ctx, 'claim', { project: r.project, file: r.file_path });
  return rows;
}

// ---------------------------------------------------------------- one hook, one fresh repo

/** Positive control: a second session in ONE checkout must be denied. Without this a PASS or FAIL means nothing. */
function controlStep(ctx, hook, repo, ids, ev) {
  const file = path.join(repo.main, 'src', 'ctl.ts');
  track(ctx, 'file', file);
  const a = callHook(ctx, hook, editPayload(ids.a, repo.main, file));
  ev.controlA = a.text;
  requireUsable(a, 'control, session A');
  const b = callHook(ctx, hook, editPayload(ids.b, repo.main, file));
  ev.controlB = b.text;
  requireUsable(b, 'control, session B');
  if (b.kind !== 'deny') throw new Fault(`control: B edited a file A just claimed in the SAME checkout and was not denied (hook said: ${b.kind}). The hook or the setup is broken.`);
  if (!b.text.includes(ids.a)) throw new Fault('control: the deny does not name session A; it was a deny for another reason.');
}

/**
 * A edits in checkout 1, B edits the same repo path in the worktree. Returns B's answer.
 * cross: B's cwd is in a worktree of ANOTHER repo (bCwd), while its file is in the worktree of the first repo.
 */
async function testStep(ctx, hook, repo, ids, ev, { bCwd = repo.wt, cross = false } = {}) {
  const fileA = path.join(repo.main, 'src', 'x.ts');
  const fileB = path.join(repo.wt, 'src', 'x.ts');
  track(ctx, 'file', fileA);
  track(ctx, 'file', fileB);
  const a = callHook(ctx, hook, editPayload(ids.a, repo.main, fileA));
  ev.aStdout = a.text;
  requireUsable(a, 'session A');
  if (a.kind === 'deny') throw new Fault('session A was denied on a fresh file: the setup is broken.');
  const mine = await claimsOf(ctx, [ids.a]);
  const aRow = mine.find((r) => /src\/x\.ts$/i.test(fwd(r.file_path)));
  if (!aRow) {
    throw new Fault(`no file_claims row for A after A's call (hook said: ${a.kind}). A silent fail-open looks the same as a grant.`);
  }
  // The PR 536 hook keys a claim by the repo-relative path. A raw path here means resolveClaimKey returned null
  // (a setup fault, claim-target.ts) and the hook fell back to the old key: a FAIL would then test the setup.
  if (ev.hasResolveClaimKey && fwd(aRow.file_path) !== 'src/x.ts') {
    throw new Fault(`the claim key fell back to the raw path ('${fwd(aRow.file_path)}', expected 'src/x.ts'): resolveClaimKey could not resolve the repo.`);
  }
  const b = callHook(ctx, hook, editPayload(ids.b, bCwd, fileB));
  ev.bStdout = b.text;
  if (b.err.trim()) ev.bStderr = b.err.trim().slice(0, 300);
  requireUsable(b, 'session B');
  await requireBRow(ctx, ids, aRow, b, cross);
  return b;
}

/**
 * B's answer must be one the hook really decided. A plain continue or an info message needs B's own claim row
 * on src/x.ts: a crash or a silent fail-open prints continue and writes no row. Whenever B has a row, its
 * project key must equal A's: the row tests ONE repo, and canonicalProject falls back to a cwd form after a
 * git timeout (session-id.ts:194-204), which would make two projects and a false FAIL.
 * cross: the premise is the reverse (B's cwd is in another repo), so the project check is skipped.
 */
async function requireBRow(ctx, ids, aRow, b, cross = false) {
  if (b.kind === 'warn') throw new Fault(`B got a [WARN] answer (${b.note.slice(0, 120)}): the BREAK-GLASS takeover let B through. COORDINATION_BREAK_GLASS must not reach the child.`);
  if (b.kind === 'deny' && !b.text.includes(ids.a)) throw new Fault('B was denied, but the deny does not name session A: it was a deny for another reason.');
  const bRow = (await claimsOf(ctx, [ids.b])).find((r) => /src\/x\.ts$/i.test(fwd(r.file_path)));
  if ((b.kind === 'continue' || b.kind === 'info') && !bRow) {
    throw new Fault(`B got '${b.kind}' but has no file_claims row of its own: the hook crashed or failed open. A grant writes a row.`);
  }
  if (!cross && bRow && bRow.project !== aRow.project) {
    throw new Fault(`A and B hold different project keys ('${aRow.project}' and '${bRow.project}'): the two checkouts did not resolve to one repo. The row would test the harness, not the hook.`);
  }
}

function errorRow(spec, ev, message) {
  return result({
    id: spec.id, title: spec.title, rule: meta.rule, verdict: 'ERROR',
    reason: `harness fault: ${message}`,
    control: { name: 'second session in the same checkout is denied', ok: false, detail: message },
    evidence: ev,
  });
}

/**
 * One probe, caught on its own: any error becomes an ERROR row for this probe, so the other probe still runs.
 * After the probe, a real-home snapshot diff turns any real file this probe's children wrote into an ERROR row.
 */
async function probeHook(ctx, spec) {
  const ev = { hook: spec.hook ? fwd(spec.hook) : '(not resolved yet)' };
  const ids = { a: `drill-${ctx.runId}-s2-${spec.label}-a`, b: `drill-${ctx.runId}-s2-${spec.label}-b` };
  let row;
  let before;
  try {
    before = snapshotRealHome();
    row = await probeHookInner(ctx, spec, ids, ev);
  } catch (e) {
    row = errorRow(spec, ev, `${e?.name ?? 'Error'}: ${e?.message ?? e}`);
  }
  try {
    const markers = [ctx.runId, ctx.sandbox.boardKey, path.basename(ctx.sandbox.dir), ids.a, ids.b];
    const writes = before ? diffRealHome(before, markers) : [];
    if (writes.length) row = errorRow(spec, { ...ev, realHomeWrites: writes }, `a child wrote a real file outside the sandbox: ${writes.join('; ')}`);
  } catch (e) {
    row = errorRow(spec, ev, `the real-home check failed: ${e?.message ?? e}`);
  }
  return row;
}

async function probeHookInner(ctx, spec, ids, ev) {
  try {
    const hook = spec.prepare ? spec.prepare(ctx) : spec.hook;
    if (!hook || !fs.existsSync(hook)) throw new Fault(`built hook not found: ${fwd(hook)} (run npm run build in .claude/hooks)`);
    ev.hook = fwd(hook);
    ev.hasResolveClaimKey = hookText(hook).includes('resolveClaimKey'); // true: the hook of PR 536; false: the old hook
    if (spec.checkBuild && !ev.hasResolveClaimKey) {
      const src = path.join(PATHS.REPO, '.claude', 'hooks', 'src', 'file-claims.ts');
      if (fs.existsSync(src) && hookText(src).includes('resolveClaimKey')) {
        throw new Fault(`stale build: ${fwd(src)} has resolveClaimKey and the dist does not. Run npm run build in .claude/hooks.`);
      }
    }
    const repo = makeRepo(ctx, spec.label);
    // cross: a second repo. Session B has its cwd in that repo's worktree, so its cwd repo is not the file's repo.
    const other = spec.cross ? makeRepo(ctx, `${spec.label}x`) : null;
    track(ctx, 'session', ids.a);
    track(ctx, 'session', ids.b);
    // Both sessions are live (heartbeat now), so a held claim is never reclaimed as stale.
    await ctx.pg(async (c) => {
      await insertSession(c, ids.a, fwd(repo.main).toLowerCase());
      await insertSession(c, ids.b, fwd((other ?? repo).wt).toLowerCase());
    });
    controlStep(ctx, hook, repo, ids, ev);
    const b = await testStep(ctx, hook, repo, ids, ev, other ? { bCwd: other.wt, cross: true } : {});
    ev.fileClaims = await claimsOf(ctx, [ids.a, ids.b]);
    return verdictRow(spec, b, ev);
  } catch (e) {
    if (e instanceof Fault) return errorRow(spec, ev, e.message);
    throw e;
  }
}

const hookText = (file) => fs.readFileSync(file, 'utf8');

function verdictRow(spec, b, ev) {
  const pass = b.kind === 'deny'; // requireBRow already made a warn, and a deny that does not name A, a Fault
  const verdict = pass ? 'PASS' : 'FAIL';
  const where = spec.cross
    ? 'B, with its cwd in a worktree of another repo, edited a file in this repo\'s worktree'
    : 'B, in the worktree, edited src/x.ts';
  const reason = (pass
    ? `${where}, was stopped on a file A holds in checkout 1 (hook said: ${b.kind}).`
    : `${where} while live session A held it in checkout 1, and the hook said: ${b.kind}. The two paths are two claims.`)
    + (spec.expect && spec.expect !== verdict ? ` NOTE: this info row was expected to be ${spec.expect}.` : '');
  return result({
    id: spec.id, title: spec.title, rule: meta.rule, verdict, reason,
    control: { name: 'second session in the same checkout is denied', ok: true, detail: 'B got a deny on a file A claimed in one checkout' },
    evidence: ev,
  });
}

// ---------------------------------------------------------------- the old hook (row 2-old)

// The built hook as it was before PR 536. Read with git from the checkout's own history; never taken from the repo tree.
const OLD_HOOK_REV = '900124e6';
const OLD_HOOK_PATH = '.claude/hooks/dist/file-claims.mjs';

/** The module names a built hook imports with a static `import ... from "x"`. */
const staticImports = (text) => [...text.matchAll(/^import\b[^;\n]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]);

/**
 * Write the old built hook into this run's sandbox folder and return its path. Never touches the repo or the real home.
 * Any fault is a Fault, so the 2-old probe gives an ERROR row. A static import of a non-built-in module is a Fault too:
 * NODE_PATH does not apply to an ES module import, and the sandbox folder has no node_modules above it.
 */
export function extractOldHook(ctx) {
  assertNotAborted('extractOldHook');
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  const r = spawnSync('git', ['-C', PATHS.REPO, 'show', `${OLD_HOOK_REV}:${OLD_HOOK_PATH}`],
    { env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Fault(`old hook: could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new Fault(`old hook: git show ${OLD_HOOK_REV}:${OLD_HOOK_PATH} failed (exit ${r.status}): ${String(r.stderr ?? '').trim().split('\n')[0]}`);
  const text = Buffer.from(r.stdout).toString('utf8');
  if (!text.includes('resolveFileClaim')) throw new Fault(`old hook: ${OLD_HOOK_REV} does not hold a built file-claims hook (no resolveFileClaim)`);
  if (text.includes('resolveClaimKey')) throw new Fault(`old hook: ${OLD_HOOK_REV} already holds the PR 536 claim key; it is not the old hook`);
  const extra = staticImports(text).filter((m) => !builtinModules.includes(m.replace(/^node:/, '')));
  if (extra.length) throw new Fault(`old hook: it imports a package (${extra.join(', ')}); it is not self-contained`);
  // Database setup (holder read of the blob, 2026-11-13): it reads only DB_URL_VARS (CONTINUOUS_CLAUDE_DB_URL,
  // DATABASE_URL, OPC_POSTGRES_URL), which childEnv sets to the scratch url. A url with credentials in the text
  // would be a built-in live default: refuse it. ('postgres://base' is pg's parse base and has no '@'.)
  if (!/DB_URL_VARS\s*=\s*\[\s*"CONTINUOUS_CLAUDE_DB_URL"/.test(text)) throw new Fault('old hook: its database url setup is not the DB_URL_VARS list that the drill sandboxes');
  if (/postgres(?:ql)?:\/\/[^"'\s]*@/.test(text)) throw new Fault('old hook: it holds a literal database url with credentials; it could reach a live database');
  const dir = path.join(ctx.sandbox.dir, 's2-old-hook');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'file-claims.mjs');
  fs.writeFileSync(file, r.stdout);
  return file;
}

// ---------------------------------------------------------------- scenario entry

export async function run(ctx) {
  const current = path.join(PATHS.HOOK_DIST, 'file-claims.mjs');
  const specs = [
    { id: '2', label: 'cur', title: meta.title, hook: current, checkBuild: true },
    { id: '2-old', label: 'old', title: `${meta.title} (OLD hook ${OLD_HOOK_REV}, info, expected FAIL)`, prepare: extractOldHook, expect: 'FAIL' },
    { id: '2-cross', label: 'cross', title: `${meta.title} (cwd in one repo, file in another repo's worktree, info, expected PASS)`, hook: current, cross: true, expect: 'PASS' },
  ];
  const rows = [];
  for (const spec of specs) rows.push(await probeHook(ctx, spec));
  return rows;
}
