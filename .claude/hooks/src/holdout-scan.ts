/**
 * holdout-scan (PreToolUse, card coord-holdout-scan-warn, seat ruling 2026-11-15): warns when a tool input holds a holdout id of the
 * review-engine eval before it leaves (a command, a message, a published page, a file write). WARN ONLY: it never denies or asks.
 *
 * Ids: the push gate list (shared/holdout-ids.ts, read from the primary checkout on every call; about 2 ms, no cache, so no file ever
 * holds the ids). Matcher: countIdsIn (a short PR number counts only after #, PR, pull/...), plus a sha prefix of 7 or more hex.
 * The warning line and the log row hold a count, the tool and a time. Never an id, never the matched text, never a slice of the input.
 * A failed list read gives a warning that the scan is off (seat Q3: differs from the scope text, a broken list must not stop every tool).
 * Off switch: holdoutScan.off = true in review-router.config.json. The staged diff at commit is commit-preflight's (seat Q2).
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { countIdsIn, loadHoldoutIds } from './shared/holdout-ids.js';
import { primaryRepo } from './shared/lane-board.js';
import { routerFlag } from './shared/router-config.js';

export const SCAN_TOOLS = new Set(['Bash', 'PowerShell', 'SendMessage', 'Artifact', 'Write', 'Edit', 'NotebookEdit']);
/** The most bytes read from a file named by a tool input (a published page). A larger file says its tail was not scanned. */
export const FILE_READ_LIMIT = 1024 * 1024;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
/** Where ids belong: a write there is not a leak. */
const EXEMPT = [/\/scripts\/eval\/review-eval\/gold\//i, /\/\.claude\/state\/review-engine\//i, /\/2026-11-01-pr-review-dataset\.json$/i];

type Env = Record<string, string | undefined>;
interface HookInput { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }
interface Deps { env?: Env; logPath?: string; now?: () => string }
interface Output { hookSpecificOutput: { hookEventName: 'PreToolUse'; additionalContext: string } }
interface Scanned { text: string; tailBytes: number }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const fwd = (p: string): string => p.replace(/\\/g, '/');

/** The first FILE_READ_LIMIT bytes of a file, and how many bytes were left unread. An unreadable file gives no text. */
function readCapped(path: string): Scanned {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, FILE_READ_LIMIT));
    readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8'), tailBytes: Math.max(0, size - FILE_READ_LIMIT) };
  } catch {
    return { text: '', tailBytes: 0 };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The outgoing text of one tool input, or null when the call sends nothing out (another tool, a read action, an exempt write). */
export function outgoingText(tool: string, input: Record<string, unknown>): Scanned | null {
  if (!SCAN_TOOLS.has(tool)) return null;
  if (WRITE_TOOLS.has(tool) && EXEMPT.some((re) => re.test(fwd(str(input.file_path) || str(input.notebook_path))))) return null;
  switch (tool) {
    case 'Bash': case 'PowerShell': return { text: str(input.command), tailBytes: 0 };
    case 'SendMessage': return { text: str(input.message), tailBytes: 0 };
    case 'Write': return { text: str(input.content), tailBytes: 0 };
    case 'Edit': return { text: str(input.new_string), tailBytes: 0 };
    case 'NotebookEdit': return { text: str(input.new_source), tailBytes: 0 };
    default: return artifactText(input);
  }
}

/** A publish (the default action) sends its page, its title and its description. Every other action reads or lists. */
function artifactText(input: Record<string, unknown>): Scanned | null {
  const action = str(input.action) || 'publish';
  if (action !== 'publish' || input.asset === true) return null;
  const page = str(input.file_path) ? readCapped(str(input.file_path)) : { text: '', tailBytes: 0 };
  return { text: [page.text, str(input.title), str(input.description)].join('\n'), tailBytes: page.tailBytes };
}

const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi;

/** Holdout ids in the text: countIdsIn for the digit ids and keys, plus each sha that a hex run of 7 or more is a prefix of. */
export function countHits(text: string, ids: string[]): { count: number; bare: number } {
  const shas = ids.filter((id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id));
  const rest = ids.filter((id) => !shas.includes(id));
  const runs = [...text.matchAll(HEX_RUN)].map((m) => m[0].toLowerCase());
  const shaHits = shas.filter((s) => runs.some((r) => s.toLowerCase().startsWith(r))).length;
  const counted = countIdsIn(text, rest);
  const bareDigits = rest.filter((id) => /^\d{3,}$/.test(id) && new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text)).length;
  return { count: counted + shaHits, bare: Math.max(0, bareDigits - counted) };
}

function warnText(tool: string, count: number, tailBytes: number): string | null {
  const ids = `${count} holdout id${count === 1 ? '' : 's'}`;
  if (tailBytes > 0) return `holdout-scan: ${ids} in the first 1 MiB of this ${tool} input; the rest (${tailBytes} bytes) was not scanned. Remove any holdout id before it leaves (count only).`;
  if (count === 0) return null;
  return `holdout-scan: ${ids} in this ${tool} input. Remove them before it leaves (count only, warn mode).`;
}

function writeLog(logPath: string, row: Record<string, unknown>): void {
  try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, `${JSON.stringify(row)}\n`); } catch { /* a log failure never blocks a tool */ }
}

const wrap = (text: string): Output => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

/** One hook call: { output } is the JSON to print, or null for silence. Never throws. */
export function scanInput(data: HookInput, deps: Deps = {}): { output: Output | null } {
  const env = deps.env ?? process.env;
  const home = env.CCV3_USER_HOME || homedir();
  const logPath = deps.logPath ?? join(home, '.claude', 'logs', 'holdout-scan.jsonl');
  const now = deps.now ?? (() => new Date().toISOString());
  const tool = str(data.tool_name);
  const out = outgoingText(tool, data.tool_input ?? {});
  if (!out) return { output: null };
  const readFile = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  if (routerFlag(data.cwd || process.cwd(), readFile, home, 'holdoutScan', 'off')) return { output: null };
  let ids: string[];
  try { ids = loadHoldoutIds(primaryRepo(env)); } catch {
    writeLog(logPath, { ts: now(), tool, error: 'list', mode: 'warn' });
    return { output: wrap('holdout-scan off: the holdout id list could not be read; this input was not scanned (warn mode).') };
  }
  const { count, bare } = countHits(out.text, ids);
  if (count > 0 || bare > 0) writeLog(logPath, { ts: now(), tool, count, bare, mode: 'warn' });
  const text = warnText(tool, count, out.tailBytes);
  return { output: text ? wrap(text) : null };
}

function main(): void {
  let data: HookInput = {};
  try { data = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput; } catch { return; }
  const { output } = scanInput(data);
  if (output) console.log(JSON.stringify(output));
}

if (process.argv[1] && /holdout-scan\.(mjs|ts|js)$/.test(process.argv[1])) main();
