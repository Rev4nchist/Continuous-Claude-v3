/**
 * PreToolUse Hook - Enforce file locking for conflict prevention, for every tool that writes a file.
 *
 * Group A (the tool names the path): Edit, Write, NotebookEdit, Desktop Commander write_file, edit_block,
 * move_file. Same claim and deny for each path.
 * Group B (shell text): Bash, PowerShell, Desktop Commander start_process and interact_with_process. The text
 * is matched against the claims other live sessions hold (shared/write-targets.ts). A shell call never makes a
 * claim. Card coord-file-claims-all-writers, rule O3.1.
 *
 * This hook:
 * 1. Checks if another ACTIVE session has claimed the file
 * 2. BLOCKS edits if there's an active conflict (session heartbeat < 5 min old)
 * 3. Allows and claims if no conflict or other session is stale
 *
 * Part of the coordination layer architecture (Phase 3).
 */

import { readFileSync } from 'fs';
import { isAbsolute, relative, resolve as resolvePath } from 'path';
import { resolveFileClaim, listBlockingClaims } from './shared/db-utils-pg.js';
import { resolveSessionId, canonicalProject } from './shared/session-id.js';
import { resolveClaimKey, resolveRepoContext, listWorktreeTops } from './shared/claim-target.js';
import { directWritePaths, classifyShellText, type HeldClaim } from './shared/write-targets.js';
import { readShellCommand } from './shared/shell-tools.js';
import { isEngineHost } from './shared/engine-host.js';
import { firstWarning } from './shared/claim-warned.js';
import type { PreToolUseInput, HookOutput } from './shared/types.js';
import { logGuardDecision } from './shared/guard-log.js';

// Stale session threshold (5 minutes). This is only ONE HALF of the reclamation
// rule -- the lease must ALSO have expired. See resolveFileClaim.
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Break-glass: take the claim even when the two-condition rule refuses.
 *
 * This exists because reclamation is now strictly more conservative, and the
 * harness lease is an hour. If a session dies without releasing (crash, killed
 * terminal, the MSYS fork storm) its claim on a hook file is genuinely held for
 * up to 60 minutes, and there has to be a way through that is not "wait it out"
 * or "hand-edit the database".
 *
 * It is NOT silent: a forced takeover writes a `claim_break_glass` event, which
 * is a distinct kind precisely so it cannot hide inside the ordinary takeover
 * count. Pulling the handle leaves a mark.
 */
const BREAK_GLASS = process.env.COORDINATION_BREAK_GLASS === '1';

/**
 * "4 minutes" / "38 seconds" — how long until an instant, or null if it has
 * already passed.
 *
 * Returning null rather than "now" for an elapsed deadline is deliberate. An
 * earlier version returned the string "now", which is truthy, so a caller
 * testing the result for truthiness rendered "runs for another now" — wrong
 * grammar and, worse, wrong information: in the expired-lease case the wait is
 * not over, it is governed by something else entirely.
 */
function humanizeUntil(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  return mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`;
}

/**
 * Main entry point for the PreToolUse:Edit|Write hook.
 * Enforces file locking - blocks edits when another active session has the file.
 */
export async function main(): Promise<void> {
  // Read hook input from stdin
  let input: PreToolUseInput;
  try {
    const stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as PreToolUseInput;
  } catch {
    // If we can't read input, continue silently
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Group A: the tool names the path (Edit, Write, NotebookEdit, three Desktop Commander tools).
  const direct = directWritePaths(input);
  if (direct !== null) {
    await mainDirect(input, direct);
    return;
  }
  // Group B: shell text. Any other tool is none of our business.
  const cmd = readShellCommand(input);
  if (cmd.kind === 'not-shell') {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }
  // A review-agent run (cursor-agent) gets no hook text from the shell branch, and nothing is read or
  // written for it (seat word 2026-11-13: hook text that reaches the review agent voids a run).
  // The exact-path branch above keeps its deny: a write by name is the same claim as before.
  // This import is an exception to ruling C3 in shared/engine-host.ts ("no deny guard imports it"),
  // made by the seat for the SHELL branch only (2026-11-13 10:55 CST). The comment there is not edited:
  // a change to engine-host.ts would change the build inputs of every hook that imports it.
  if (isEngineHost(input)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }
  await mainShell(input, cmd);
}

/** Group A: one claim per named path. The first deny wins; else the first takeover message. */
async function mainDirect(input: PreToolUseInput, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }
  const sessionId = resolveSessionId(input.session_id);
  let keep: any = { result: 'continue' };
  for (const filePath of paths) {
    const r = await claimOne(input, filePath, sessionId);
    if (r.denied) {
      keep = r.output;
      break;
    }
    if (!keep.message && r.output.message) keep = r.output;
  }
  console.log(JSON.stringify(keep));
}

/** The deny output of a shell call that would write a held file. */
function shellDeny(input: PreToolUseInput, filePath: string, holder: string): any {
  const reason = `⚠️ FILE CONFLICT BLOCKED

This command writes "${filePath}", which is held by session ${holder}.
The claim is live: their lease runs, or that session is still alive.

Coordinate with that session, or work on something else.
To override deliberately: set COORDINATION_BREAK_GLASS=1 (it is logged).`;
  logGuardDecision('file-claims', input, 'deny', `file-conflict-shell: held by ${holder}`);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** The spellings of one held file that shell text can use. */
function formsOf(top: string, cwd: string, filePath: string): string[] {
  const full = `${top}/${filePath}`;
  const forms = new Set<string>([full]);
  const drive = /^([a-z]):\/(.*)$/i.exec(full);
  if (drive) forms.add(`/${drive[1].toLowerCase()}/${drive[2]}`);
  // The cwd-relative spelling, only for a file under the cwd. A bare repo-relative name is NOT added
  // for other folders: `src/a.ts` run from a different repo is another file.
  const rel = relative(cwd, full).replace(/\\/g, '/');
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) forms.add(rel);
  return [...forms];
}

/** Group B: shell text against the claims other sessions hold. Never makes a claim. */
async function mainShell(input: PreToolUseInput, cmd: ReturnType<typeof readShellCommand>): Promise<void> {
  const cont = { result: 'continue' };
  if (cmd.kind === 'unreadable') {
    // The command text of a Desktop Commander shell call cannot be read: do not guess, stop it.
    logGuardDecision('file-claims', input, 'deny', 'unreadable-command');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `file-claims cannot read the "${cmd.field}" of ${cmd.tool}, so it cannot check the files this call writes. Send the command as text.`,
      },
    }));
    return;
  }
  if (cmd.kind !== 'command' || !cmd.text.trim()) {
    console.log(JSON.stringify(cont));
    return;
  }
  const cwd = resolvePath(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  // The cwd repo may be none (a shell started outside any repo) or another repo than the file's:
  // a command can name a file by absolute path. So the query covers every project.
  const ctx = resolveRepoContext(cwd);
  const sessionId = resolveSessionId(input.session_id);
  // Database down: continue with NO text (a warning on every shell call would bury the banner).
  const { claims, degraded } = await listBlockingClaims(sessionId, STALE_THRESHOLD_MS);
  if (degraded || claims.length === 0) {
    console.log(JSON.stringify(cont));
    return;
  }
  const tops = new Map<string, string[]>();
  const topsOf = (project: string): string[] => {
    let t = tops.get(project);
    if (!t) {
      // The project key is the primary checkout's top folder (lower case). Its worktrees come from .git/worktrees.
      t = [...new Set([...(ctx && ctx.project === project ? [ctx.top] : []), project, ...listWorktreeTops(project)])];
      tops.set(project, t);
    }
    return t;
  };
  const held: HeldClaim[] = claims.map((c) => ({
    filePath: c.filePath,
    holder: c.sessionId,
    // A stored absolute path (a cache file: its key is the raw path) is its own spelling. A repo-relative
    // path is NOT a spelling by itself: `src/a.ts` in another repo is another file.
    forms: [...new Set([...(isAbsolute(c.filePath) || /^[a-z]:[\\/]/i.test(c.filePath) ? [c.filePath] : []), ...topsOf(c.project).flatMap((top) => formsOf(top, cwd, c.filePath))])],
  }));
  const verdict = classifyShellText(cmd.text, held, FOLDS_CASE);
  if (verdict.kind === 'deny' && !BREAK_GLASS) {
    console.log(JSON.stringify(shellDeny(input, verdict.filePath, verdict.holder ?? 'another session')));
    return;
  }
  if (verdict.kind === 'deny') {
    logGuardDecision('file-claims', input, 'override', `break-glass: shell write to a file held by ${verdict.holder}`);
    console.log(JSON.stringify({ result: 'continue', message: `[WARN] BREAK-GLASS: this command writes "${verdict.filePath}", held by session ${verdict.holder}. This was logged.` }));
    return;
  }
  if (verdict.kind === 'mention' && firstWarning(sessionId, verdict.filePath)) {
    console.log(JSON.stringify({
      result: 'continue',
      message: `[WARN] "${verdict.filePath}" is held by session ${verdict.holder}. This command names it but shows no write, so it is not stopped. This warning shows once per file.`,
    }));
    return;
  }
  console.log(JSON.stringify(cont));
}

/** One claim for one path: the Edit and Write logic, unchanged. */
async function claimOne(input: PreToolUseInput, filePath: string, sessionId: string): Promise<{ output: any; denied: boolean }> {
  // Claim under the SAME identity heartbeat registers, so isSessionActive() can
  // actually find the owner alive. (sessionId is resolved once by the caller.)

  // Key by the FILE's own repo: repo-relative path plus the repo's common git dir. Two worktrees
  // of one repo then claim the same key, and a session in repo A editing repo B meets a session
  // in repo B. Reads files only (no git process). The cases that keep the old key (raw path and
  // the project of cwd, which still needs git) are listed in shared/claim-target.ts. A stored row
  // with an absolute path (a live session that started before this change) is not seen by the new
  // key until it expires.
  const key = resolveClaimKey(filePath, { cwd: input.cwd });
  const claimPath = key ? key.filePath : filePath;
  const project = key ? key.project : canonicalProject(input.cwd);

  // One statement decides and claims, and logs the conflict in the same
  // transaction. This used to be three round trips (check -> is-holder-alive ->
  // claim) with a race in each gap; the worst was that two sessions racing for
  // an UNCLAIMED file were BOTH told to go ahead. See resolveFileClaim.
  const decision = await resolveFileClaim(
    claimPath, project, sessionId, STALE_THRESHOLD_MS, input.tool_name,
    { breakGlass: BREAK_GLASS },
  );

  // Messages name the repo-relative path. A file outside any repo keeps the bare file name, so a
  // message never shows another session's absolute path.
  const fileName = key ? key.filePath : filePath.split(/[/\\]/).pop() || filePath;
  let output: any;

  switch (decision.outcome) {
    case 'blocked': {
      // Say how long, and say WHY. The old message promised the lock releases
      // "when that session's heartbeat goes stale (5 min)", which is no longer
      // true and was never the whole rule -- reclamation needs the lease to have
      // expired as well. Telling someone to wait 5 minutes for something that
      // will not happen for an hour is worse than saying nothing.
      // WHICH half of the rule is holding the file determines what the person
      // is actually waiting for, and they are completely different waits:
      //
      //   lease still live  -> a deadline, and renewing pushes it out
      //   lease expired but holder alive -> NOT a deadline at all. It clears
      //     when the holder goes quiet, which no clock can predict.
      //
      // Collapsing these was a real bug: the elapsed-deadline case rendered
      // "runs for another now", which is both broken English and a promise that
      // the wait is over when it has not started.
      const waitFor = humanizeUntil(decision.holderExpiresAt);
      let leaseLine: string;
      if (decision.leaseExpired) {
        leaseLine =
          `Their ${decision.leaseClass} lease has already lapsed, but that session is still\n` +
          `alive, so the file is not free. It comes back when they stop heartbeating\n` +
          `for ${Math.round(STALE_THRESHOLD_MS / 60000)} minutes — there is no fixed deadline for that.`;
      } else if (waitFor) {
        leaseLine =
          `Their ${decision.leaseClass} lease runs for another ${waitFor}, and it renews\n` +
          `every time they touch the file.`;
      } else {
        leaseLine =
          `Their ${decision.leaseClass} lease is still live, and it renews every time they\n` +
          `touch the file.`;
      }

      const blockMessage = `⚠️ FILE CONFLICT BLOCKED

"${fileName}" is held by session ${decision.holder}

${leaseLine}
Reclaiming needs BOTH an expired lease AND a holder that has stopped
heartbeating, so an idle-but-alive session is never preempted.

Coordinate with that session, or work on something else.
To override deliberately: set COORDINATION_BREAK_GLASS=1 (it is logged).`;

      logGuardDecision('file-claims', input, 'deny', `file-conflict: held by ${decision.holder}`);
      output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: blockMessage,
        },
      };
      break;
    }

    case 'takeover':
      // A forced takeover overrides the lock rule: leave a guard-log record next to the
      // claim_break_glass event. The DB result decides, not the env flag.
      if (decision.breakGlass) {
        logGuardDecision('file-claims', input, 'override', `break-glass: forced takeover from ${decision.holder}`);
      }
      // Custody changed hands, so somebody else may have edited this file since
      // anyone last looked at it. The fence transition is the evidence, and it
      // is worth putting in front of the model rather than only in the DB.
      output = {
        result: 'continue',
        message: decision.breakGlass
          ? `[WARN] BREAK-GLASS: forced the lock for "${fileName}" away from session ${decision.holder}, whose lease was still valid. This was logged. Re-read the file before writing.`
          : `[INFO] Took over the expired lock for "${fileName}" from inactive session ${decision.holder} (lease ${decision.priorFence} -> ${decision.fence}). They may have changed it -- re-read before writing.`,
      };
      break;

    case 'degraded':
      // We did not learn that the file is free -- we failed to ask. The edit is
      // still permitted (a stopped container must not brick editing) but this
      // path used to be indistinguishable from "no conflict", which is how a
      // broken lock looked healthy for the whole life of this arc.
      console.error('[file-claims] coordination degraded, permitting edit unchecked');
      output = {
        result: 'continue',
        message: '[WARN] Coordination DB unreachable - file conflict NOT checked for this edit',
      };
      break;

    default:
      // granted | renewed -- the ordinary path, deliberately silent and
      // deliberately unlogged. One event row per successful Edit is how
      // file_claims accumulated 8,170 dead rows.
      output = { result: 'continue' };
  }

  // A conflict that could not be written down is worth saying out loud: the
  // decision still stands, but the evidence for it is gone.
  if (decision.eventRecorded === false) {
    console.error('[file-claims] conflict occurred but the event was not recorded');
  }

  return { output, denied: decision.outcome === 'blocked' };
}

// Run if executed directly. A PreToolUse hook MUST emit exactly one decision on
// stdout, so an unexpected rejection has to be converted into an explicit
// continue rather than being allowed to reach the default unhandled-rejection
// handler, which would exit non-zero having printed nothing.
main().catch((err) => {
  console.error('[file-claims] unexpected error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
