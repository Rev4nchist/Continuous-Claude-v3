/**
 * msys-crash-capture — PostToolUse (Bash|PowerShell)
 *
 * WHY THIS EXISTS
 *
 * The MSYS fork-storm investigation has never converged, and the reason is not
 * analysis effort — it is that we do not record the failures. `git-safe.ps1`
 * writes a row only when a crash happens inside a git commit/push it wrapped.
 * Every other MSYS death is recorded nowhere: on 2026-08-17 two Bash-tool
 * crashes (a `grep` and a background launch, both exit 5) left no trace in any
 * log, and on 2026-07-29 two parallel `claude -p` deaths — the most
 * concurrency-shaped evidence of that day — went unrecorded for the same reason.
 *
 * A hypothesis tested only against a log that cannot see most of its own events
 * is unfalsifiable. This hook closes that gap: EVERY lane, EVERY crash, plus a
 * denominator so crash RATE (not just crash count) is measurable. Without a
 * denominator, "crashes cluster in windows" cannot be distinguished from
 * "activity clusters in windows".
 *
 * Verified 2026-08-19: the Claude Code Bash tool runs real MSYS on this machine
 * (`uname -a` -> MINGW64_NT-10.0-26200 ... 3.5.7 ... Msys), so this lane is
 * genuinely exposed. It is not WSL.
 *
 * WHAT IT DOES NOT COVER, deliberately stated rather than assumed:
 *   - The HANG mode. If the tool call times out, PostToolUse may not fire at
 *     all. Absence of a row is NOT evidence of absence of a hang.
 *   - Concurrency AT crash time. This hook runs after the cohort has already
 *     died, so `msys_alive` here is a lower bound. `git-safe.ps1` has the same
 *     limitation and its many `bash_alive=0` rows are not evidence against a
 *     concurrency cause.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

/** Signatures of an MSYS runtime init failure. Narrow on purpose. */
const MSYS_SIGNATURES = [
  /fatal error - add_item/i,
  /cygheap base mismatch/i,
  /unable to remap/i,
  /couldn't allocate heap/i,
];

const LOG_PATH =
  process.env.MSYS_EVENT_LOG || join(homedir(), '.claude', 'logs', 'msys-events.jsonl');

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; description?: string };
  tool_response?: unknown;
  cwd?: string;
  session_id?: string;
}

/**
 * Flatten tool_response to text. The shape is NOT stable across tools, so this
 * mirrors the defensive ladder already used in git-commit-roadmap.ts:465-473
 * and ends in a stringify catch-all so stderr is never missed.
 */
export function responseText(resp: unknown): string {
  if (resp === null || resp === undefined) return '';
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>;
    const parts = [o.output, o.stdout, o.stderr, o.error, o.content]
      .filter((v): v is string => typeof v === 'string');
    if (parts.length) return parts.join('\n');
  }
  try { return JSON.stringify(resp ?? ''); } catch { return ''; }
}

/**
 * True when the text carries an MSYS init failure.
 *
 * The false-positive that matters is a command that READS the signature rather
 * than suffering it — grepping this very log, or the rule file that documents
 * the string. That is not hypothetical: it is exactly the trap that produced
 * four bogus "proof of injection" hits in the tldr investigation, where hits
 * were counted instead of classified. So the command text is checked too.
 */
export function isMsysCrash(responseTxt: string, command: string): boolean {
  if (!MSYS_SIGNATURES.some((re) => re.test(responseTxt))) return false;
  const cmd = command || '';
  // The command is itself looking at crash text -> the match is data, not an event.
  if (/add_item|cygheap|msys-events|msys-crash|windows-platform/i.test(cmd)) return false;
  return true;
}

/** Best-effort exit code. Shape varies; never throw over it. */
function exitCodeOf(resp: unknown): number | null {
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>;
    for (const k of ['exit_code', 'exitCode', 'code', 'status']) {
      if (typeof o[k] === 'number') return o[k] as number;
    }
    if (o.is_error === true) return -1;
  }
  return null;
}

/** Redact a command down to something safe and still diagnostic. */
export function redactCommand(cmd: string): string {
  if (!cmd) return '';
  return cmd
    .replace(/(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * Count live MSYS processes. Enumerates BY PATH, not by process name: a name
 * allowlist misses most of them — `reap.ps1` uses `Get-Process bash` and so
 * reported "no bash processes running" while two `sh.exe` drove a 31-minute
 * docker build. Only runs on the crash path, so the spawn cost is rare.
 */
function msysCensus(): { count: number | null; names: string[] } {
  try {
    // Built with path.join so NO backslash literal appears in this source.
    // A heredoc silently un-doubled them once, turning '\Programs\Git' into
    // ProgramsGit -- a census that would have returned 0 forever, silently.
    const localAppData = process.env.LOCALAPPDATA || '';
    if (!localAppData) return { count: null, names: [] };
    const gitRoot = join(localAppData, 'Programs', 'Git');
    const ps = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `$g='${gitRoot}'; ` +
       "(Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($g,'OrdinalIgnoreCase') } | " +
       "Select-Object -ExpandProperty Name) -join ','"],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    if (ps.status !== 0) return { count: null, names: [] };
    const names = (ps.stdout || '').trim().split(',').map((s) => s.trim()).filter(Boolean);
    return { count: names.length, names };
  } catch {
    return { count: null, names: [] };
  }
}

/**
 * Size cap for the live log, matching the intel-bus precedent
 * (CCV3_INTEL_BUS_MAX_BYTES). 5 MiB is roughly 85k rows -- months of data at
 * this machine's call volume.
 */
const MAX_BYTES = Number(process.env.MSYS_EVENT_LOG_MAX_BYTES) || 5 * 1024 * 1024;

/**
 * Rotate the live log once it reaches the cap, keeping one previous generation.
 *
 * This exists because the DENOMINATOR makes the log high-volume: a row per
 * Bash/PowerShell call, not just per crash. An append-only telemetry file with
 * no cap is a known way to lose days on this machine -- the Braintrust spool
 * reached a single 516 MiB record that could then neither be flushed nor
 * shrunk. Bounding at WRITE time is what fixed that, so it is what is used here.
 *
 * Exported for test. Returns true when a rotation happened.
 */
export function rotateIfNeeded(path: string, maxBytes: number = MAX_BYTES): boolean {
  try {
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, path + '.1'); // clobbers the previous generation, by design
    return true;
  } catch {
    return false; // missing file, or a peer rotated first -- both fine
  }
}

function append(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    rotateIfNeeded(LOG_PATH);
    appendFileSync(LOG_PATH, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    /* telemetry is best-effort; never break the tool call */
  }
}

export function main(): void {
  const raw = readFileSync(0, 'utf8');
  let input: HookInput;
  try { input = JSON.parse(raw); } catch { console.log('{}'); return; }

  const tool = input.tool_name || '';
  if (tool !== 'Bash' && tool !== 'PowerShell') { console.log('{}'); return; }

  const command = input.tool_input?.command || '';
  const text = responseText(input.tool_response);
  const crashed = isMsysCrash(text, command);
  const ts = new Date().toISOString();

  if (!crashed) {
    // DENOMINATOR. One minimal row per invocation (~60 bytes). Without this,
    // crash COUNT clustering cannot be told apart from activity clustering --
    // the exact flaw in the standing "crashes come in windows" claim.
    append({ ts, lane: 'bash-tool', tool, ok: 1 });
    console.log('{}');
    return;
  }

  const census = msysCensus();
  append({
    ts,
    lane: 'bash-tool',
    tool,
    ok: 0,
    signature: (text.match(/fatal error - [a-z_]+|cygheap base mismatch|unable to remap/i) || [''])[0],
    exit_code: exitCodeOf(input.tool_response),
    command: redactCommand(command),
    cwd: input.cwd || null,
    session_id: input.session_id || null,
    // Sampled AFTER the failure -- a lower bound, not a count at crash time.
    msys_alive_after: census.count,
    msys_names_after: census.names,
  });
  console.log('{}');
}

if ((process.argv[1] || '').includes('msys-crash-capture')) {
  try { main(); } catch { console.log('{}'); }
}
