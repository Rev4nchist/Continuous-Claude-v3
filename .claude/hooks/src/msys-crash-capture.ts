/**
 * msys-crash-capture -- PostToolUse hook (matcher: Bash|PowerShell).
 *
 * The unified MSYS fork-storm event log for the Bash-tool lane (see
 * .claude/docs/windows/platform-notes.md, "FIXED 2026-08-19"). Writes one row
 * per Bash/PowerShell call to ~/.claude/logs/msys-events.jsonl:
 *   success -> {ts, lane:"bash-tool", tool, ok:1}   (the DENOMINATOR)
 *   crash   -> {ts, lane:"bash-tool", tool, ok:0, signature, exit_code,
 *               command (redacted), cwd, session_id, msys_alive_after,
 *               msys_names_after}
 * msys_alive_after is sampled AFTER the failure -- a lower bound, never a
 * count at crash time. The log is capped at MSYS_EVENT_LOG_MAX_BYTES (5 MiB
 * default) and rotates to .1, keeping one previous generation.
 *
 * PROVENANCE: this source was reconstructed 2026-08-31 (harness-security lane)
 * from the live compiled bundle ~/.claude/hooks/dist/msys-crash-capture.mjs,
 * which had run registered since 2026-08-19 with no committed source anywhere
 * (registration-reconcile finding: no-committed-code). The original bundle is
 * archived at docs/harness-strategy/artifacts/2026-08-31-live-dist/. Behavior
 * is verified equivalent by stdin/stdout/exit-code diff against that bundle.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

const MSYS_SIGNATURES = [
  /fatal error - add_item/i,
  /cygheap base mismatch/i,
  /unable to remap/i,
  /couldn't allocate heap/i,
];

const LOG_PATH =
  process.env.MSYS_EVENT_LOG || join(homedir(), '.claude', 'logs', 'msys-events.jsonl');

export function responseText(resp: unknown): string {
  if (resp === null || resp === undefined) return '';
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>;
    const parts = [o.output, o.stdout, o.stderr, o.error, o.content].filter(
      (v): v is string => typeof v === 'string',
    );
    if (parts.length) return parts.join('\n');
  }
  try {
    return JSON.stringify(resp ?? '');
  } catch {
    return '';
  }
}

export function isMsysCrash(responseTxt: string, command: string): boolean {
  if (!MSYS_SIGNATURES.some((re) => re.test(responseTxt))) return false;
  // A command that merely TALKS about the signatures (greps this log, edits
  // the platform doc) is not a crash -- the signature text is in its payload.
  const cmd = command || '';
  if (/add_item|cygheap|msys-events|msys-crash|windows-platform/i.test(cmd)) return false;
  return true;
}

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

export function redactCommand(cmd: string): string {
  if (!cmd) return '';
  return cmd
    .replace(/(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1<redacted>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function msysCensus(): { count: number | null; names: string[] } {
  try {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (!localAppData) return { count: null, names: [] };
    const gitRoot = join(localAppData, 'Programs', 'Git');
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$g='${gitRoot}'; (Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($g,'OrdinalIgnoreCase') } | Select-Object -ExpandProperty Name) -join ','`,
      ],
      { encoding: 'utf8', timeout: 5e3, windowsHide: true },
    );
    if (ps.status !== 0) return { count: null, names: [] };
    const names = (ps.stdout || '')
      .trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { count: names.length, names };
  } catch {
    return { count: null, names: [] };
  }
}

const MAX_BYTES = Number(process.env.MSYS_EVENT_LOG_MAX_BYTES) || 5 * 1024 * 1024;

export function rotateIfNeeded(path: string, maxBytes: number = MAX_BYTES): boolean {
  try {
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, path + '.1');
    return true;
  } catch {
    return false;
  }
}

function append(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    rotateIfNeeded(LOG_PATH);
    appendFileSync(LOG_PATH, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // Telemetry must never break the tool call.
  }
}

export function main(): void {
  const raw = readFileSync(0, 'utf8');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log('{}');
    return;
  }
  const tool = (input.tool_name as string) || '';
  if (tool !== 'Bash' && tool !== 'PowerShell') {
    console.log('{}');
    return;
  }
  const command = ((input.tool_input as Record<string, unknown>)?.command as string) || '';
  const text = responseText(input.tool_response);
  const crashed = isMsysCrash(text, command);
  const ts = new Date().toISOString();
  if (!crashed) {
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
    signature: (text.match(/fatal error - [a-z_]+|cygheap base mismatch|unable to remap/i) || [
      '',
    ])[0],
    exit_code: exitCodeOf(input.tool_response),
    command: redactCommand(command),
    cwd: (input.cwd as string) || null,
    session_id: (input.session_id as string) || null,
    // Sampled AFTER the failure -- a lower bound, not a count at crash time.
    msys_alive_after: census.count,
    msys_names_after: census.names,
  });
  console.log('{}');
}

// Import guard: tests import the exported functions without running main().
if ((process.argv[1] || '').includes('msys-crash-capture')) {
  try {
    main();
  } catch {
    console.log('{}');
  }
}
