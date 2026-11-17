/**
 * holdout-scan (PreToolUse, card coord-holdout-scan-warn, seat ruling 2026-11-15): warns when a tool input holds a holdout id of the
 * review-engine eval before it leaves (a command, a message, a published page, a file write). WARN ONLY: it never denies or asks.
 *
 * Ids: the holdout ids of the push gate list (shared/holdout-ids.ts) and the gold ids (shared/gold-ids.ts: shas, and PR numbers of 4 digits or more;
 * card coord-content-scan-followups, item gold ids), read from the primary checkout on every scanned call (about 1 MB of gold files, no cache, so no
 * file ever holds the ids). The push gate and commit-preflight keep the holdout ids only. Matcher: countIdsIn (a short PR number counts only after
 * #, PR, pull/...; a sha prefix of 7 or more hex), shared with the gate. A write into any answer-key path is exempt (the gold files hold their ids).
 * The warning line and the log row hold a count, the tool and a time. Never an id, never the matched text, never a slice of the input.
 * A failed list read gives a warning that the scan is off (seat Q3: differs from the scope text, a broken list must not stop every tool).
 * Off switch: holdoutScan.off = true in review-router.config.json. The staged diff at commit is commit-preflight's (seat Q2).
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, posix } from 'path';
import { answerKeyHitsOf } from './shared/answer-paths-door.js';
import { loadListedIds } from './shared/gold-ids.js';
import { countIdsIn } from './shared/holdout-ids.js';
import { primaryRepo } from './shared/lane-board.js';
import { routerFlag } from './shared/router-config.js';

export const SCAN_TOOLS = new Set(['Bash', 'PowerShell', 'SendMessage', 'Artifact', 'Write', 'Edit', 'NotebookEdit']);
/** The most bytes read from a file named by a tool input (a published page). A larger file says its tail was not scanned. */
export const FILE_READ_LIMIT = 1024 * 1024;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
/** Where ids belong: a write there is not a leak. A write into any answer-key path (the gold store included) is exempt too: isAnswerKeyPath. */
const EXEMPT = [/\/\.claude\/state\/review-engine\//i, /\/2026-11-01-pr-review-dataset\.json$/i];

type Env = Record<string, string | undefined>;
interface HookInput { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; session_id?: string }
/** repoRoot (tests): the primary checkout lookup; default primaryRepo. It may throw: the hook then warns that the scan is off. */
interface Deps { env?: Env; logPath?: string; now?: () => string; repoRoot?: (env: Env) => string }
interface Output { hookSpecificOutput: { hookEventName: 'PreToolUse'; additionalContext: string } }
interface Scanned { text: string; tailBytes: number }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const fwd = (p: string): string => p.replace(/\\/g, '/');

/**
 * An answer-key path in any spelling (absolute, a worktree copy, backslashes): the matcher of answer-key.mjs, the one list of those paths, tried on
 * each tail of the path (the globs are repo-relative). The gold files hold the gold ids by design, so a write there never warns.
 */
export function isAnswerKeyPath(p: string): boolean {
  const segments = posix.normalize(fwd(p)).split('/'); // normalized first: a ".." path through an answer-key folder is not an answer-key path
  for (let i = 0; i < segments.length; i++) if (answerKeyHitsOf([segments.slice(i).join('/')]).length > 0) return true;
  return false;
}

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
  if (WRITE_TOOLS.has(tool)) {
    const raw = fwd(str(input.file_path) || str(input.notebook_path));
    // ".." is resolved before the exempt list is tried; isAnswerKeyPath resolves it itself.
    if (EXEMPT.some((re) => re.test(posix.normalize(raw))) || isAnswerKeyPath(raw)) return null;
  }
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

/**
 * Holdout ids in the text: countIdsIn, the one matcher of the push gate, commit-preflight and this hook (card
 * coord-decision-gate-round3-content-scan, seat S-Q1). It holds the sha prefix rule (seat R1). `bare`: digit ids that stand in the text with no
 * context word (not counted, reported as a hint).
 */
export function countHits(text: string, ids: string[]): { count: number; bare: number } {
  const rest = ids.filter((id) => !(/^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id)));
  const counted = countIdsIn(text, ids);
  const bareDigits = rest.filter((id) => /^\d{3,}$/.test(id) && new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text)).length;
  return { count: counted, bare: Math.max(0, bareDigits - countIdsIn(text, rest)) };
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

/** True only the first time this session hits an unreadable list (seat R2): a marker file per session id, written only then. */
function firstOffInSession(home: string, sessionId: string): boolean {
  const dir = join(home, '.claude', 'state', 'holdout-scan');
  const marker = join(dir, `${(sessionId || 'no-session').replace(/[^A-Za-z0-9-]/g, '_')}.off`);
  try {
    if (existsSync(marker)) return false;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, '');
  } catch { /* an unwritable marker means the warning may repeat; never block */ }
  return true;
}

/** True when the cwd is the primary checkout or below it (its worktrees): the log splits false fires of other repos (seat S1). */
const inCcv3 = (cwd: string, rootOf: () => string): boolean => {
  try {
    const root = fwd(rootOf()).toLowerCase();
    const dir = fwd(cwd).toLowerCase().replace(/\/+$/, '');
    return dir === root || dir.startsWith(`${root}/`);
  } catch {
    return false; // a lookup that throws must not stop the tool (seat read of 9cda80b1)
  }
};

const wrap = (text: string): Output => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

/** One hook call: { output } is the JSON to print, or null for silence. Never throws. */
export function scanInput(data: HookInput, deps: Deps = {}): { output: Output | null } {
  const env = deps.env ?? process.env;
  const home = env.CCV3_USER_HOME || homedir();
  const logPath = deps.logPath ?? join(home, '.claude', 'logs', 'holdout-scan.jsonl');
  const now = deps.now ?? (() => new Date().toISOString());
  const tool = str(data.tool_name);
  const cwd = data.cwd || process.cwd();
  const out = outgoingText(tool, data.tool_input ?? {});
  if (!out) return { output: null };
  const rootOf = deps.repoRoot ? () => deps.repoRoot!(env) : () => primaryRepo(env);
  const ccv3 = inCcv3(cwd, rootOf);
  const readFile = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  if (routerFlag(cwd, readFile, home, 'holdoutScan', 'off')) return { output: null };
  let ids: string[];
  try { ids = loadListedIds(rootOf()); } catch {
    writeLog(logPath, { ts: now(), tool, error: 'list', mode: 'warn', ccv3 });
    if (!firstOffInSession(home, str(data.session_id))) return { output: null };
    return { output: wrap('holdout-scan off: the holdout id list could not be read; this input was not scanned (warn mode).') };
  }
  const { count, bare } = countHits(out.text, ids);
  if (count > 0 || bare > 0) writeLog(logPath, { ts: now(), tool, count, bare, mode: 'warn', ccv3 });
  const text = warnText(tool, count, out.tailBytes);
  return { output: text ? wrap(text) : null };
}

function main(): void {
  let data: HookInput = {};
  try { data = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput; } catch { return; }
  try {
    const { output } = scanInput(data);
    if (output) console.log(JSON.stringify(output));
  } catch { /* warn-only hook: a bug here must never stop a tool */ }
}

if (process.argv[1] && /holdout-scan\.(mjs|ts|js)$/.test(process.argv[1])) main();
