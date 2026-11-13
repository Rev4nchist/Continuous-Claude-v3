/**
 * Row 3 (O3.1): a shell write to a file another live session holds must be stopped or warned.
 *
 * Gap: file-claims covers Edit and Write only. Session A claims a file with an Edit payload. Session B
 * then writes the same file through Bash (`echo x > <file>`) and through PowerShell
 * (`Set-Content -LiteralPath '<file>' -Value x`). The BUILT hook (dist/file-claims.mjs) is fed each payload.
 *
 * A hook has TWO gates and the row checks both (every-surface rule):
 *   (i)  the runtime gate: the hook's own tool_name check (.claude/hooks/src/file-claims.ts:72) must let
 *        Bash and PowerShell through and answer deny or a "[WARN]" message for B.
 *   (ii) the registration: .claude/settings.json.template must register file-claims on a PreToolUse
 *        matcher that covers Bash and PowerShell. Today the matcher is "Edit|Write" (template line 293).
 *        The matcher is read by parsing the JSON, not by a text search.
 *
 * PASS  = both Bash and PowerShell answers are deny or warn, AND the matcher covers both tools.
 * FAIL  = any of those is false. The reason names each failing gate. A fix to the runtime gate alone
 *         stays FAIL until the registration matcher is widened too.
 * ERROR = the harness cannot say. Cases: the positive control fails (an Edit by B on the same file
 *         must be denied), the hook stdout is not JSON or the hook exits non-zero, the hook failed open
 *         ("[WARN] Coordination DB unreachable"), the hook printed a crash marker on stderr (a crash
 *         prints {"result":"continue"} and exits 0), A has no file_claims row after its Edit, the
 *         negative control fails (a Bash or PowerShell write by B to a file nobody holds must get a plain
 *         continue; a hook that stops every shell call would otherwise print PASS), a child wrote a real
 *         file outside the sandbox, or the template cannot be parsed or holds no file-claims registration
 *         under PreToolUse.
 *
 * All paths in the payloads use forward slashes, in the claim and in both commands, so a FAIL shows the
 * gap and never a spelling difference. Each path is quoted in its command, so a temp folder with a space
 * or an apostrophe cannot make a correct parser miss the target.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessError, PATHS, runNode, insertSession, track, result, snapshotRealHome, diffRealHome } from './lib.mjs';

export const meta = {
  id: '3',
  title: 'A shell write to a file another live session holds is stopped or warned',
  rule: 'O3.1: file claims cover every tool that can write a file. Gap today: file-claims covers Edit and Write only.',
};

const fwd = (p) => String(p).replace(/\\/g, '/');
const CONTROL_NAME = 'an Edit by B on the file A holds is denied, and a shell write by B to a free file continues';

// What the hook prints on stderr when it crashed or failed open. A crash still prints {"result":"continue"}
// and exits 0 (file-claims.ts:208-211), so stdout alone cannot tell a crash from "the hook ignores shells".
const CRASH_RE = /\[file-claims\] (?:unexpected error|coordination degraded)|\b(?:UnhandledPromiseRejection|TypeError|ReferenceError|SyntaxError)\b|ERR_MODULE_NOT_FOUND|Cannot find module/;

/** One path as a single bash word: single quotes, and each apostrophe closed, escaped and reopened. */
const bashQuote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
/** One path as a single PowerShell literal: single quotes, each apostrophe doubled. */
const psQuote = (p) => `'${String(p).replace(/'/g, "''")}'`;

/** A fault of the harness or its control. run() turns it into an ERROR row, never a FAIL. */
class Fault extends Error {}

// ---------------------------------------------------------------- calling the built hook

const payload = (tool, sessionId, cwd, input) => JSON.stringify({ tool_name: tool, session_id: sessionId, cwd, tool_input: input });

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

function callHook(ctx, hook, body) {
  const r = runNode(hook, [], { env: ctx.env, input: body });
  return { ...r, ...classify(r), text: r.out.trim() };
}

/** A hook answer the harness cannot trust: unusable output, or a fail-open. */
function requireUsable(call, what) {
  if (call.kind === 'bad') throw new Fault(`${what}: ${call.note}. stderr: ${call.err.trim().slice(0, 200)}`);
  if (call.kind === 'unreachable') throw new Fault(`${what}: the hook failed open (${call.note}). The scratch database was not reachable by the hook.`);
}

async function claimsOf(ctx, ids) {
  return ctx.pg(async (c) => (await c.query(
    `SELECT file_path, project, session_id FROM public.file_claims
      WHERE session_id = ANY($1::text[]) ORDER BY claimed_at, file_path`, [ids])).rows);
}

// ---------------------------------------------------------------- registration gate

/** Does a settings matcher let this tool name in? Empty and "*" match everything; else a whole-name pattern. */
function matcherCovers(matcher, tool) {
  if (matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    throw new Fault(`the matcher "${matcher}" is not a valid pattern`);
  }
}

/** The matcher of every PreToolUse entry that runs file-claims, read from the parsed template. */
function fileClaimsMatchers() {
  const file = path.join(PATHS.REPO, '.claude', 'settings.json.template');
  let tpl;
  try {
    tpl = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Fault(`cannot parse ${fwd(file)}: ${e.message}`);
  }
  const entries = tpl?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) throw new Fault('settings.json.template has no hooks.PreToolUse list');
  const found = [];
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      // Whole-token match: a command string is split on spaces, quotes are stripped; each arg is one token.
      const tokens = [
        ...(typeof h.command === 'string' ? h.command.split(/\s+/) : []),
        ...(Array.isArray(h.args) ? h.args : []),
      ].filter((x) => typeof x === 'string').map((x) => x.replace(/^["']|["']$/g, ''));
      if (tokens.some((t) => /[\\/]file-claims\.mjs$/.test(t))) found.push(entry.matcher ?? '');
    }
  }
  if (found.length === 0) throw new Fault('settings.json.template has no PreToolUse entry that runs file-claims (check the parser before trusting a FAIL)');
  return found;
}

// ---------------------------------------------------------------- scenario

/** Set up the claim and run the control. Returns what the two shell calls need. */
async function setup(ctx, hook, ev) {
  const dir = path.join(ctx.sandbox.dir, 's3');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const file = fwd(path.join(dir, 'src', 'f.ts'));
  fs.writeFileSync(file, 'export const f = 1;\n');
  const ids = { a: `drill-${ctx.runId}-s3-a`, b: `drill-${ctx.runId}-s3-b` };
  track(ctx, 'session', ids.a);
  track(ctx, 'session', ids.b);
  track(ctx, 'file', file);
  const cwd = fwd(dir);
  // Both sessions are live (heartbeat now), so the held claim is never reclaimed as stale.
  await ctx.pg(async (c) => {
    await insertSession(c, ids.a, cwd.toLowerCase());
    await insertSession(c, ids.b, cwd.toLowerCase());
  });
  const a = callHook(ctx, hook, payload('Edit', ids.a, cwd, { file_path: file, old_string: 'a', new_string: 'b' }));
  ev.aEditStdout = a.text;
  requireUsable(a, 'session A edit');
  const mine = await claimsOf(ctx, [ids.a]);
  if (!mine.some((r) => /src\/f\.ts$/i.test(fwd(r.file_path)))) {
    throw new Fault(`no file_claims row for A after A's Edit (hook said: ${a.kind}). A silent fail-open looks the same as a grant.`);
  }
  const ctl = callHook(ctx, hook, payload('Edit', ids.b, cwd, { file_path: file, old_string: 'a', new_string: 'b' }));
  ev.controlBEditStdout = ctl.text;
  requireUsable(ctl, 'control, session B edit');
  if (ctl.kind !== 'deny') throw new Fault(`control: an Edit by B on a file A holds was not denied (hook said: ${ctl.kind}). The hook or the setup is broken.`);
  return { ids, file, cwd, dir };
}

const bashCommand = (file) => `echo x > ${bashQuote(file)}`;
const psCommand = (file) => `Set-Content -LiteralPath ${psQuote(file)} -Value x`;

/**
 * Negative control: a shell write by B to a file NOBODY holds must get a plain continue. A hook that stops or
 * warns on every Bash or PowerShell call would pass the claimed-file check for the wrong reason. A fixed hook
 * may write a claim row for B here; that still prints continue.
 */
function negativeControl(ctx, hook, s, ev) {
  const free = fwd(path.join(s.dir, 'src', 'free.ts'));
  fs.writeFileSync(free, 'export const free = 1;\n');
  track(ctx, 'file', free);
  const calls = [
    ['Bash', bashCommand(free), 'negBashStdout'],
    ['PowerShell', psCommand(free), 'negPowershellStdout'],
  ];
  for (const [tool, command, key] of calls) {
    const c = callHook(ctx, hook, payload(tool, s.ids.b, s.cwd, { command }));
    ev[key] = c.text;
    requireUsable(c, `negative control, ${tool} write by B to a free file`);
    if (c.kind !== 'continue') {
      throw new Fault(`negative control: a ${tool} write by B to a file nobody holds was not a plain continue (hook said: ${c.kind}). A hook that stops every ${tool} call would print PASS for the wrong reason.`);
    }
  }
}

function shellCalls(ctx, hook, s, ev) {
  negativeControl(ctx, hook, s, ev);
  const bash = callHook(ctx, hook, payload('Bash', s.ids.b, s.cwd, { command: bashCommand(s.file) }));
  ev.bashStdout = bash.text;
  requireUsable(bash, 'Bash call by B');
  const ps = callHook(ctx, hook, payload('PowerShell', s.ids.b, s.cwd, { command: psCommand(s.file) }));
  ev.powershellStdout = ps.text;
  requireUsable(ps, 'PowerShell call by B');
  return { bash, ps };
}

/** The sentence for each gate that fails. Empty list means PASS. */
function failingGates({ bash, ps }, matchers) {
  const gaps = [];
  const stops = (c) => c.kind === 'deny' || c.kind === 'warn';
  if (!stops(bash)) gaps.push(`runtime gate: file-claims.mjs let B's Bash write through (hook said: ${bash.kind}); it only checks Edit and Write`);
  if (!stops(ps)) gaps.push(`runtime gate: file-claims.mjs let B's PowerShell write through (hook said: ${ps.kind}); it only checks Edit and Write`);
  const missing = ['Bash', 'PowerShell'].filter((t) => !matchers.some((m) => matcherCovers(m, t)));
  if (missing.length) gaps.push(`registration gate: the settings.json.template matcher "${matchers.join('", "')}" does not cover ${missing.join(' and ')}`);
  return gaps;
}

function errorRow(ev, message) {
  return result({
    id: meta.id, title: meta.title, rule: meta.rule, verdict: 'ERROR',
    reason: `harness fault: ${message}`,
    control: { name: CONTROL_NAME, ok: false, detail: message },
    evidence: ev,
  });
}

export async function run(ctx) {
  const hook = path.join(PATHS.HOOK_DIST, 'file-claims.mjs');
  if (!fs.existsSync(hook)) throw new HarnessError(`built hook not found: ${hook} (run npm run build in .claude/hooks)`);
  const ev = { hook: fwd(hook) };
  const before = snapshotRealHome();
  let row = await verdictRow(ctx, hook, ev);
  // A real file written outside the sandbox makes the row ERROR, whatever the verdict was.
  try {
    const markers = [
      ctx.runId, ctx.sandbox.boardKey, path.basename(ctx.sandbox.dir),
      `drill-${ctx.runId}-s3-a`, `drill-${ctx.runId}-s3-b`,
    ];
    const writes = diffRealHome(before, markers);
    if (writes.length) row = errorRow({ ...ev, realHomeWrites: writes }, `a child wrote a real file outside the sandbox: ${writes.join('; ')}`);
  } catch (e) {
    row = errorRow(ev, `the real-home check failed: ${e?.message ?? e}`);
  }
  return row;
}

async function verdictRow(ctx, hook, ev) {
  try {
    const s = await setup(ctx, hook, ev);
    const calls = shellCalls(ctx, hook, s, ev);
    const matchers = fileClaimsMatchers();
    ev.matcher = matchers.length === 1 ? matchers[0] : matchers;
    ev.fileClaims = await claimsOf(ctx, [s.ids.a, s.ids.b]);
    const gaps = failingGates(calls, matchers);
    return result({
      id: meta.id, title: meta.title, rule: meta.rule,
      verdict: gaps.length === 0 ? 'PASS' : 'FAIL',
      reason: gaps.length === 0
        ? 'B was stopped or warned on both shell tools, and the matcher covers Bash and PowerShell.'
        : gaps.join('; '),
      control: { name: CONTROL_NAME, ok: true, detail: 'B got a deny on an Edit of the file A holds, and a plain continue on a shell write to a free file' },
      evidence: ev,
    });
  } catch (e) {
    if (e instanceof Fault) return errorRow(ev, e.message);
    throw e;
  }
}
