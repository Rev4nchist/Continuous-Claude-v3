/**
 * The tools that run a shell command on this machine, and the tool_input field that holds the
 * command text. Shared by destructive-command-guard and package-install-guard (F07, 2026-11-03).
 *
 * Two gates: the PreToolUse matchers in settings.json.template must match every name here.
 * Guard: hook-matcher-runtime-consistency.test.ts.
 *
 * Not listed: Vercel run_session_command (runs in a remote sandbox, not on this machine) and
 * claude-in-chrome javascript_tool (page JavaScript, not a shell).
 */

export type Dialect = 'Bash' | 'PowerShell';

interface ShellTool {
  field: string;
  dialects: Dialect[];
  /** A missing or non-string field is unreadable. Bash and PowerShell keep the old passthrough. */
  failClosed: boolean;
}

const BOTH: Dialect[] = ['Bash', 'PowerShell'];

/**
 * desktop-commander picks its shell at run time (`shell` argument or its defaultShell config),
 * so its text is classified under both dialects. This adds no lexer rules.
 */
export const SHELL_TOOLS: ReadonlyMap<string, ShellTool> = new Map([
  ['Bash', { field: 'command', dialects: ['Bash'], failClosed: false }],
  ['PowerShell', { field: 'command', dialects: ['PowerShell'], failClosed: false }],
  ['mcp__plugin_desktop-commander_desktop-commander__start_process', { field: 'command', dialects: BOTH, failClosed: true }],
  ['mcp__plugin_desktop-commander_desktop-commander__interact_with_process', { field: 'input', dialects: BOTH, failClosed: true }],
]);

export type ShellCommand =
  | { kind: 'not-shell' }
  | { kind: 'unreadable'; tool: string; field: string }
  | { kind: 'command'; tool: string; text: string; dialects: Dialect[] };

/**
 * Read the command text of a tool call. A fail-closed tool whose field is not a string is
 * `unreadable`, and the caller must not allow it. An empty string is a command with nothing to run.
 */
export function readShellCommand(input: { tool_name?: string; tool?: string; tool_input?: unknown }): ShellCommand {
  const tool = input.tool_name || input.tool;
  const spec = tool ? SHELL_TOOLS.get(tool) : undefined;
  if (!tool || !spec) return { kind: 'not-shell' };
  const toolInput = input.tool_input;
  const text = toolInput && typeof toolInput === 'object'
    ? (toolInput as Record<string, unknown>)[spec.field]
    : undefined;
  if (typeof text !== 'string') {
    return spec.failClosed ? { kind: 'unreadable', tool, field: spec.field } : { kind: 'command', tool, text: '', dialects: spec.dialects };
  }
  return { kind: 'command', tool, text, dialects: spec.dialects };
}

/** True for a tool whose shell may be cmd.exe, chosen at run time (Desktop Commander). */
export function mayRunUnderCmd(tool: string | undefined): boolean {
  return !!tool && tool.startsWith('mcp__plugin_desktop-commander_');
}

/** Classifier dialects for a tool name. An unlisted name keeps the old Bash default. */
export function dialectsFor(tool: string | undefined): Dialect[] {
  return (tool && SHELL_TOOLS.get(tool)?.dialects) || ['Bash'];
}
