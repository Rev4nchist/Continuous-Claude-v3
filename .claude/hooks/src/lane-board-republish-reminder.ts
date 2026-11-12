#!/usr/bin/env node
/**
 * Lane Board Republish Reminder Hook
 *
 * A lane board page is a snapshot of one board. render-board.mjs writes it; only the agent's Artifact tool
 * can publish it. The default board (continuous-claude) has a phone page from artifacts.json; any other board
 * has one only when its project-registry entry carries `laneArtifact` (boardArtifact). When a session
 * changes the lane DB through lane.mjs, this hook:
 *   1. renders the board's page itself, in the background (auto-render, debounced 20 s per board), and
 *   2. for a board WITH a phone page, marks the change as pending. It no longer tells the session to publish:
 *      the account allows 200 Artifact publishes per UTC day, so lane-board-stop-gate asks when one is due.
 *
 * Hook: PostToolUse, matcher Bash|PowerShell|Artifact (settings.json.template).
 * State: <pending dir>/<pendingKey(session, board)>.json = {since, verbs, board, v?, askAt?, stopBlocked?}
 *   `v: 2` is the shape marker. A new file gets it; a rewrite keeps what the file had. The Stop gate applies its
 *   50-verb rule only to a file with no marker.
 *   (shared/lane-board-pending.ts; `<session>.json` on the default board, `<session>@<board>.json` elsewhere)
 *   - an ask verb (claim, release, done, park): write state with askAt = now and without stopBlocked (a new
 *     batch for the Stop gate). An ask verb emits the reminder when the file's verb list holds no ask verb
 *     yet: the page is out of date, the Stop gate asks for the publish, do not publish before it asks.
 *     An ask verb on a list that holds one is silent.
 *   - any other changing verb (say, note, add, state, ...): update the verb list, keep askAt and stopBlocked,
 *     stay silent. The file stays until an accepted publish clears it. A file with an ask verb and no askAt
 *     (written before askAt existed) gets askAt = its file time, so the rewrite does not move its change time.
 *   - Artifact call: only an ACCEPTED PAGE PUBLISH of a board page deletes that board's state (action `publish`
 *     or no action; not read, list, open, pin or delete; not `asset: true`; not a failed call). The default
 *     board clears on its artifact id in the url or its publish_from file name. A non-default board clears
 *     only on an exact match of the url's artifact id with its registry laneArtifact id (never on a file name).
 *   - a board with no phone page: no pending file; one render-only line per session per hour
 * Never blocks. Any error: no output, exit 0.
 *
 * Publish budget (file format and helpers: lane-board-stop-gate.ts, which this hook imports):
 *   <pending dir>/budget/<session uuid>.json. Every accepted Artifact page publish of the session adds 1 to `n`
 *   of the UTC day: any url. An asset upload adds nothing. A page publish whose url id is the artifact id of a board page
 *   also sets pages[id] = now, with or without a pending file for that board. A publish by file name with no
 *   url is a new artifact: it clears as before and sets no stamp. Only tool_name `Artifact` counts
 *   (`ArtifactData` also reaches this hook). A session id that is not a uuid writes no budget file. Any error
 *   in the budget code is swallowed. A refused publish gives no PostToolUse event, so nothing sets `limit`.
 *   A subagent's Artifact call reaches this hook with the parent session id (77 of 77 calls in the transcripts
 *   of 2026-11-07 to 2026-11-11), so it counts in the parent's file.
 *
 * The board of a change comes, as in lane.mjs, from `--project x` / `LANE_PROJECT=x` in the command, else from
 * payload.cwd through the registry, else (note|state|release|done|park only) from the board of the lane the caller
 * owns: main() looks that up (ownedLaneBoard, one read-only query, only in that case). A cwd with no board and no
 * other answer is not a lane change: lane.mjs refused it.
 *
 * A command whose env prefix (or `$env:`) points lane.mjs at another database or registry
 * (CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL, LANE_REGISTRY_PATH) is not a live lane change.
 *
 * Auto-render: leading edge at once, plus one trailing render when a change lands inside the 20 s window (a child
 * sleeps the rest of the window), so the page always reflects the last change. The child runs in the primary
 * checkout and gets an absolute output file first, because a render-board.mjs without --project support reads
 * argv[2] as the output file.
 *
 * Seams (tests and E2E MUST set them): LANE_BOARD_PENDING_DIR (state dir), LANE_RENDER_SCRIPT (render script
 * path), LANE_BOARD_AUTORENDER=0 (no render). The default render script is the primary checkout's
 * render-board.mjs.
 *
 * Failure evidence: a failing Bash call arrives as PostToolUseFailure, not PostToolUse (see
 * shared/tool-error.ts and .claude/cache/e2e/2026-10-06-correct-posttooluse-bash.json), so this
 * PostToolUse registration already skips most failures. The is_error / exit-code checks are a
 * second guard for payloads that do carry them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';
// The gate file holds the budget helpers. Its main() runs only under its own file name, so this import is safe.
import { ASK_VERBS, PENDING_SHAPE, VERB_CAP, holdsAskVerb, updateBudget, type AskPending } from './lane-board-stop-gate.js';
import { DEFAULT_BOARD, artifactIdOf, boardArtifact, loadRegistry, pendingKey, primaryRepo, resolveBoard } from './shared/lane-board.js';
import { listPending, pendingDir, pendingFile, readPending } from './shared/lane-board-pending.js';
import { maskQuoted } from './shared/mask-quotes.js';
import { detectToolError, exitCodeOf } from './shared/tool-error.js';

/** lane.mjs verbs that change the lane DB. Read-only verbs (board, next, inbox, ...) are absent. */
export const CHANGING_VERBS = new Set([
  'claim',
  'release',
  'done',
  'note',
  'say',
  'add',
  'apply-kanban',
  'adopt',
  'state',
  'seed',
  'park',
]);

/** Tools this hook accepts. Must match the settings.json.template matcher. */
const HOOK_TOOLS = new Set(['Bash', 'PowerShell', 'Artifact']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/** Auto-render debounce, per board. */
export const RENDER_DEBOUNCE_MS = 20_000;
/** The render-only line is said at most once per session and board per hour. */
const RENDER_ONLY_EVERY_MS = 60 * 60_000;

type Env = Record<string, string | undefined>;

export type Action = 'remind' | 'mark' | 'clear' | 'render' | 'none';

export interface Decision {
  action: Action;
  verb?: string;
  board?: string;
  message?: string;
}

const NONE: Decision = { action: 'none' };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export const stateDir = pendingDir;
export const stateFile = pendingFile;

/** Short sentences, no publish steps: the Stop gate gives them when a publish is due. */
function reminder(verb: string, board: string): string {
  return (
    `Lane DB changed (lane.mjs ${verb}) on board ${board}. The lane board page is out of date. ` +
    `The Stop gate asks for a publish when one is due. Do not publish before it asks. ` +
    `The kanban-sync step 7 and a milestone portal refresh still publish.`
  );
}

function renderOnly(verb: string, board: string): string {
  return (
    `Lane DB changed (lane.mjs ${verb}) on board ${board}. This board has no phone page: the local page ` +
    `is re-rendered automatically, within 20 s of the last change (render-only). Nothing to publish.`
  );
}

// ---- command parsing ----

/** Value-taking global flags of lane.mjs. Every other `--flag` before the verb is a bare switch. */
const VALUE_FLAGS = 'project|as|agent';
const GLOBAL_FLAGS =
  `(?:\\s+(?:--(?:${VALUE_FLAGS})=\\S+|--(?:${VALUE_FLAGS})\\s+[^\\s;&|()]+|--(?!(?:${VALUE_FLAGS})\\b)[\\w-]+))*`;
const LANE_RE = new RegExp(
  `^[(\\s]*(?:&\\s+)?((?:\\w+=\\S+\\s+)*)node(?:\\.exe)?(?:\\s+--?[\\w-]+(?:=\\S+)?)*\\s+(?:[^\\s;&|()]*[\\\\/])?lane\\.mjs${GLOBAL_FLAGS}\\s+([a-z][a-z-]*)`,
);

export interface LaneChange {
  verb: string;
  /** `--project` / `LANE_PROJECT` named in the command, else null (the board then comes from the cwd). */
  project: string | null;
  /** First positional after the verb (the lane id of `note|state|release|done`), else null. */
  laneId: string | null;
  /** `--as <session id>` (the owner lane.mjs acts as), else null. */
  as: string | null;
}

/**
 * lane.mjs verbs keyed on the lane OWNER: with no board for the cwd they use the board of the lane the caller
 * owns (projectForOwnedLane in lane.mjs). Every other verb needs a cwd board or --project.
 */
export const OWNER_KEYED_VERBS = new Set(['note', 'state', 'release', 'done', 'park']);

/**
 * An assignment that points lane.mjs at ANOTHER database or registry: the command then changes a scratch
 * lane DB, not the live one, and no live board page is stale. Seen in a bash prefix (`X=1 node lane.mjs`),
 * after `export`, or as `$env:X = ...` in PowerShell. Runs on text with quoted strings masked.
 */
const OTHER_DB_ASSIGN = /(?<![\w-])(?:CONTINUOUS_CLAUDE_DB_URL|DATABASE_URL|OPC_POSTGRES_URL|LANE_REGISTRY_PATH)\s*=/;

/** The lane id after the verb: the first token that is neither a flag nor the value of a value-taking flag. */
function laneIdAfterVerb(rest: string): string | null {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      if (!t.includes('=') && new RegExp(`^--(?:${VALUE_FLAGS})$`).test(t)) i++;
      continue;
    }
    return /^[A-Za-z0-9][\w.-]*$/.test(t) ? t : null;
  }
  return null;
}

/**
 * The first state-changing lane.mjs call in a command, or null.
 *
 * A quoted path to lane.mjs is unquoted first. Then quoted text is masked, so a commit message
 * that mentions "lane.mjs done" never counts. `node` must start the command (after an optional PowerShell
 * call operator or an env prefix), so `echo node lane.mjs done` is not a run. Global flags may sit between
 * lane.mjs and the verb (`--project x`, `--as id`, `--json`, `--agent t`). A segment (split on
 * `; & | newline`) with --dry-run is a plan, not a change.
 */
export function laneChange(command: string, tool: string): LaneChange | null {
  const unquoted = command.replace(/(["'])([^"'\n]*lane\.mjs)\1/g, '$2');
  const masked = maskQuoted(unquoted, tool);
  if (OTHER_DB_ASSIGN.test(masked)) return null; // aimed at a scratch database: not a live lane change
  for (const segment of masked.split(/[;&|\n]+/)) {
    if (/--dry-run\b/.test(segment)) continue;
    const m = segment.match(LANE_RE);
    if (!m || !CHANGING_VERBS.has(m[2])) continue;
    const flag = /--project(?:=|\s+)([A-Za-z0-9][\w-]*)/.exec(segment)?.[1];
    const envPrefix = /(?:^|\s)LANE_PROJECT=([A-Za-z0-9][\w-]*)/.exec(m[1])?.[1];
    const psEnv = /\$env:LANE_PROJECT\s*=\s*['"]?([A-Za-z0-9][\w-]*)/i.exec(command)?.[1];
    const as = /--as(?:=|\s+)([^\s;&|()]+)/.exec(segment)?.[1] ?? null;
    return {
      verb: m[2],
      project: flag ?? envPrefix ?? psEnv ?? null,
      laneId: laneIdAfterVerb(segment.slice(m[0].length)),
      as,
    };
  }
  return null;
}

/** The first state-changing lane.mjs verb a command runs, or null. */
export function laneChangeVerb(command: string, tool: string): string | null {
  return laneChange(command, tool)?.verb ?? null;
}

function failed(data: Record<string, unknown>): boolean {
  if (data.hook_event_name === 'PostToolUseFailure') return true;
  const resp = data.tool_response;
  if (detectToolError(resp)) return true;
  const code = exitCodeOf(resp);
  return code !== null && code !== 0;
}

const cwdOf = (payload: Record<string, unknown>): string =>
  typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

/** The board of the cwd with no flag (what lane.mjs softBoard() answers), or null. Throws nothing. */
function cwdBoard(payload: Record<string, unknown>, env: Env): string | null {
  try {
    return resolveBoard(cwdOf(payload), { headlessOk: true, env })?.key ?? null;
  } catch {
    return null;
  }
}

/**
 * The board a Bash/PowerShell lane change belongs to, or null.
 *
 * Order, as in lane.mjs: --project / LANE_PROJECT, then the cwd's board, then (note|state|release|done only) the
 * board of the lane the caller owns. `ownedBoard` is that last answer, looked up by the IO layer
 * (ownedLaneBoard); null when no lookup was needed or it failed, which leaves a cwd with no board as no change.
 */
function boardOfChange(payload: Record<string, unknown>, lc: LaneChange, env: Env, ownedBoard: string | null): string | null {
  try {
    if (lc.project) return resolveBoard(cwdOf(payload), { cli: true, projectFlag: lc.project, env })?.key ?? null;
  } catch {
    return null; // unknown board: lane.mjs refused the command
  }
  return cwdBoard(payload, env) ?? (OWNER_KEYED_VERBS.has(lc.verb) ? ownedBoard : null);
}

/**
 * The board whose page this Artifact call published, or null.
 *
 * Any non-default board is checked first and matches ONLY when the id of a strict `https://claude.ai/artifact/<id>`
 * url equals its artifact id exactly: its file name (`lane-board-<key>.html`) says nothing, because a publish of
 * that file to the wrong url must not clear it. Only then does the default board match, as before: the artifact
 * id inside the url, or the publish_from file name. So a non-default id that contains the default id clears its
 * own board, and the answer does not depend on `boards` order.
 */
function publishedBoard(input: Record<string, unknown>, boards: string[], env: Env): string | null {
  const url = typeof input.url === 'string' ? input.url : '';
  const urlId = artifactIdOf(url);
  // Non-default boards first, on an EXACT id match: a non-default id that contains the default id
  // (RtrTNV...zidX) must not fall into the default board's substring check below.
  if (urlId !== null) {
    for (const b of boards) {
      if (b !== DEFAULT_BOARD && boardArtifact(b, { env })?.id === urlId) return b;
    }
  }
  if (!boards.includes(DEFAULT_BOARD)) return null;
  const a = boardArtifact(DEFAULT_BOARD, { env });
  if (!a) return null;
  // A strict url names exactly one page: compare ids, so another board's longer id cannot match here by substring.
  if (url && (urlId !== null ? urlId === a.id : url.includes(a.id))) return DEFAULT_BOARD;
  const file = typeof input.file_path === 'string' ? input.file_path.replace(/\\/g, '/').toLowerCase() : '';
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base && base === a.publishFrom.toLowerCase() ? DEFAULT_BOARD : null;
}

/**
 * True for an Artifact call that publishes: action `publish` or no action. A read, list, open, pin, unpin,
 * delete or quickstart is not a publish. An asset upload is not a page publish: it clears nothing and is not counted.
 */
function isPublish(input: Record<string, unknown>): boolean {
  return input.action === undefined || input.action === null || input.action === 'publish';
}

const isPagePublish = (input: Record<string, unknown>): boolean => isPublish(input) && input.asset !== true;

/**
 * Pure decision. `pending` = the board's pending file already holds an ask verb: a boolean, or a function of
 * the board (a session has one batch per board). `candidates` are the boards an Artifact publish may clear
 * (default: the default board).
 *
 * A verb outside the ask verbs gives `mark` with no message. An ask verb gives `remind` when the pending file
 * holds no earlier ask verb, else `mark`. An Artifact call gives `clear` only for a page publish of a board page.
 */
export function decide(
  payload: unknown,
  pending: boolean | ((board: string) => boolean),
  env: Env = process.env,
  candidates: string[] = [DEFAULT_BOARD],
  ownedBoard: string | null = null,
): Decision {
  if (!isObj(payload)) return NONE;
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !HOOK_TOOLS.has(tool)) return NONE;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return NONE;
  const input = payload.tool_input;
  if (!isObj(input) || failed(payload)) return NONE;

  if (tool === 'Artifact') {
    const board = isPagePublish(input) ? publishedBoard(input, candidates, env) : null;
    return board ? { action: 'clear', board } : NONE;
  }

  if (!COMMAND_TOOLS.has(tool) || typeof input.command !== 'string') return NONE;
  const lc = laneChange(input.command, tool);
  if (!lc) return NONE;
  const board = boardOfChange(payload, lc, env, ownedBoard);
  if (!board) return NONE;

  const artifact = boardArtifact(board, { env });
  if (!artifact) return { action: 'render', verb: lc.verb, board, message: renderOnly(lc.verb, board) };
  const mark: Decision = { action: 'mark', verb: lc.verb, board };
  if (!ASK_VERBS.has(lc.verb)) return mark;
  const asked = typeof pending === 'function' ? pending(board) : pending;
  return asked ? mark : { action: 'remind', verb: lc.verb, board, message: reminder(lc.verb, board) };
}

// ---- thin IO ----

export interface Deps {
  spawn?: typeof spawnDetachedHidden;
  now?: number;
  /** The board of the lane the caller owns (see ownedLaneBoard). Used only when the cwd has no board. */
  ownedBoard?: string | null;
}

const safeFile = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The page render-board.mjs writes by default for a board, as an absolute path in the primary checkout.
 * Same rule as defaultOut() in scripts/coordination/render-board-args.mjs (a test compares them). null for a
 * key that is not a plain board key: a bad key never reaches a file name.
 */
export function boardPageFile(board: string, env: Env = process.env): string | null {
  if (!BOARD_KEY_RE.test(board)) return null;
  return `${primaryRepo(env)}/${board === DEFAULT_BOARD ? 'lane-board.html' : `lane-board-${board}.html`}`;
}

/**
 * Body of the trailing-render child (`node -e`). argv: [node, waitMs, ...render args]. It sleeps the rest of
 * the debounce window, then runs the render once. Plain `node -e` source: no shell, no quoting.
 */
export const DELAYED_RENDER_SRC =
  "const{spawnSync}=require('child_process');" +
  'const a=process.argv.slice(1);' +
  "setTimeout(()=>{try{spawnSync(process.execPath,a.slice(1),{stdio:'ignore',windowsHide:true})}catch{}},Number(a[0])||0);";

interface RenderStamp { ts?: number; trailing?: boolean }

/**
 * Render the board page in the background. Never throws.
 *
 * Leading edge: the first change after a quiet window renders at once and stamps the time.
 * Trailing edge: a change INSIDE the window sets `trailing` on the stamp and starts one child that sleeps the
 * rest of the window, then renders. Later changes in the same window see `trailing` and stay out. So the page
 * always reflects the last change, within RENDER_DEBOUNCE_MS, with at most two renders per window.
 *
 * The child runs in the primary checkout with an absolute output path as the first argument: a render-board.mjs
 * that predates --project reads argv[2] as the output file, so a relative `--project` would become a file name
 * in the session's folder.
 */
function autoRender(board: string, env: Env, deps: Deps): boolean {
  try {
    if (env.LANE_BOARD_AUTORENDER === '0') return false;
    const out = boardPageFile(board, env);
    if (!out) return false;
    const now = deps.now ?? Date.now();
    const stamp = path.join(pendingDir(env), `.render-${safeFile(board)}.json`);
    const prev = (readPending(stamp) as RenderStamp | null) ?? {};
    const last = Number(prev.ts) || 0;
    const age = now - last;
    const inWindow = age >= 0 && age < RENDER_DEBOUNCE_MS;
    if (inWindow && prev.trailing) return false;
    // Stamp BEFORE the spawn: a second hook that starts now sees the stamp and stays out.
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify(inWindow ? { ts: last, trailing: true } : { ts: now }));
    const script = env.LANE_RENDER_SCRIPT || `${primaryRepo(env)}/scripts/coordination/render-board.mjs`;
    const render = [script, out, '--project', board];
    const args = inWindow ? ['-e', DELAYED_RENDER_SRC, String(RENDER_DEBOUNCE_MS - age), ...render] : render;
    const child = (deps.spawn ?? spawnDetachedHidden)(process.execPath, args, { stdio: 'ignore', cwd: primaryRepo(env) });
    child.on?.('error', () => undefined);
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/** True once per (session, board) per hour: the render-only line is information, not a nag. */
function shouldSayRenderOnly(sid: string, board: string, env: Env, now: number): boolean {
  try {
    const marker = path.join(pendingDir(env), `.said-${safeFile(pendingKey(sid, board))}.json`);
    const last = Number((readPending(marker) as { ts?: number } | null)?.ts) || 0;
    if (now - last < RENDER_ONLY_EVERY_MS) return false;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ ts: now }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The board whose phone page has this artifact id, or null. Looks at the default board and at every registry
 * entry with a laneArtifact, so a board with no pending file of this session is found too.
 */
function boardOfPage(id: string, env: Env): string | null {
  if (boardArtifact(DEFAULT_BOARD, { env })?.id === id) return DEFAULT_BOARD;
  for (const e of loadRegistry({ env })) {
    if (artifactIdOf(e.artifact) === id && boardArtifact(e.key, { env })?.id === id) return e.key;
  }
  return null;
}

/**
 * Count an accepted Artifact page publish in the session's budget file: n += 1 for the UTC day, and
 * pages[id] = now when the url is the exact url of a board page. An asset upload adds nothing: the server
 * limit counts page publishes only (2026-11-11: it tripped at 200 of them). A publish with no url
 * makes a new artifact, so it sets no stamp. Never throws: the hook then behaves as it did before the budget.
 */
function countPublish(payload: unknown, sid: string, env: Env, now: number): void {
  try {
    if (!isObj(payload) || payload.tool_name !== 'Artifact') return;
    const input = payload.tool_input;
    if (!isObj(input) || !isPagePublish(input) || failed(payload)) return;
    const id = typeof input.url === 'string' ? artifactIdOf(input.url) : null;
    const page = id !== null && boardOfPage(id, env) !== null ? id : null;
    updateBudget(sid, env, now, (b) => {
      b.n += 1;
      if (page !== null) b.pages[page] = now;
    });
  } catch {
    // the budget is best effort
  }
}

/**
 * The askAt to keep when a verb that is not an ask verb rewrites the file. A file from before askAt existed
 * (an ask verb in the list, no askAt) gets its file time: the rewrite moves that time, and the Stop gate
 * would read the old claim as a new change and ask again for a claim a publish already shows.
 */
function keptAskAt(file: string, prev: AskPending | null): number | undefined {
  if (typeof prev?.askAt === 'number') return prev.askAt;
  if (!holdsAskVerb(prev)) return undefined;
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return undefined;
  }
}

/**
 * Add the verb to the board's pending file. An ask verb sets askAt = now and drops stopBlocked: a new batch
 * for the Stop gate. Any other verb keeps both, so a say or a note after a block does not ask again.
 */
function writePending(file: string, board: string, verb: string, now: number): void {
  const prev = readPending(file) as AskPending | null;
  const verbs = [...(prev?.verbs ?? []), verb].slice(-VERB_CAP);
  const askAt = ASK_VERBS.has(verb) ? undefined : keptAskAt(file, prev);
  const kept = {
    ...(askAt !== undefined ? { askAt } : {}),
    ...(prev?.stopBlocked === true ? { stopBlocked: true } : {}),
  };
  const ask = ASK_VERBS.has(verb) ? { askAt: now } : kept;
  // The marker goes on a new file only. An old-shape file stays old: its list may have lost an ask verb.
  const shape = prev === null || prev.v === PENDING_SHAPE ? { v: PENDING_SHAPE } : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ since: prev?.since ?? new Date().toISOString(), verbs, board, ...shape, ...ask }));
}

/** Decide, then do the file work and the render. Returns the hook output (null for silence). */
export function handle(payload: unknown, env: Env = process.env, deps: Deps = {}): { output: object | null; decision: Decision } {
  const sid = isObj(payload) && typeof payload.session_id === 'string' ? payload.session_id : '';
  const now = deps.now ?? Date.now();
  // Before decide(): a publish to a url that is no board page gives `none` and still counts.
  countPublish(payload, sid, env, now);
  const candidates = sid ? [...new Set([DEFAULT_BOARD, ...listPending(sid, env).map((e) => e.board)])] : [DEFAULT_BOARD];
  const d = decide(payload, (b) => holdsAskVerb(readPending(pendingFile(sid, b, env))), env, candidates, deps.ownedBoard ?? null);
  const none = { output: null, decision: d };
  if (d.action === 'none' || !d.board) return none;

  if (d.action === 'clear') {
    fs.rmSync(pendingFile(sid, d.board, env), { force: true });
    return none;
  }

  if (d.action === 'remind' || d.action === 'mark') writePending(pendingFile(sid, d.board, env), d.board, d.verb as string, now);

  autoRender(d.board, env, deps);

  const speak = d.action === 'remind' || (d.action === 'render' && shouldSayRenderOnly(sid, d.board, env, now));
  if (!speak) return none;
  return {
    output: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: d.message } },
    decision: d,
  };
}

export type OwnedRun = (sql: string, params: unknown[]) => Promise<Array<{ project_key?: unknown }>>;

/**
 * The board an owner-keyed event just landed on: my latest event on that lane id. lane.mjs logs every
 * note/state/release/done with the board it resolved (the owned lane's board when the cwd has none), and
 * `done` / `release` clear owner_session_id, so the lane row cannot answer after the command ran. Read only.
 */
const OWNED_BOARD_SQL =
  'SELECT project_key FROM agentic_os.lane_event WHERE lane_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT 1';

/** Hook budget is 3 s (settings.json.template): connect 1 s + query 1 s. `pg` loads only here, so a plain Bash call pays nothing. */
const LOOKUP_TIMEOUT_MS = 1000;
const DB_URL_VARS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'] as const;

const defaultOwnedRun: OwnedRun = async (sql, params) => {
  const url = DB_URL_VARS.map((n) => process.env[n]?.trim()).find(Boolean);
  if (!url) return [];
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: LOOKUP_TIMEOUT_MS, query_timeout: LOOKUP_TIMEOUT_MS });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Only for a note|state|release|done|park in a cwd with no board and no --project: lane.mjs then falls back to the
 * board of the lane the caller owns (projectForOwnedLane), so the reminder must too. Returns that board, or null
 * when no lookup applies or it fails (fail open: the change is then not seen, as before the fallback existed).
 * Connects to the database only in that one case.
 */
export async function ownedLaneBoard(payload: unknown, env: Env = process.env, run: OwnedRun = defaultOwnedRun): Promise<string | null> {
  try {
    if (!isObj(payload) || typeof payload.tool_name !== 'string' || !COMMAND_TOOLS.has(payload.tool_name)) return null;
    const input = payload.tool_input;
    if (!isObj(input) || typeof input.command !== 'string' || failed(payload)) return null;
    const lc = laneChange(input.command, payload.tool_name);
    if (!lc || lc.project || !lc.laneId || !OWNER_KEYED_VERBS.has(lc.verb)) return null;
    if (cwdBoard(payload, env)) return null;
    const me = lc.as ?? (typeof payload.session_id === 'string' ? payload.session_id : '');
    if (!me) return null;
    const key = (await run(OWNED_BOARD_SQL, [lc.laneId, me]))[0]?.project_key;
    return typeof key === 'string' && BOARD_KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) return;
  const payload: unknown = JSON.parse(input);
  const { output } = handle(payload, process.env, { ownedBoard: await ownedLaneBoard(payload) });
  if (output) console.log(JSON.stringify(output));
}

// Basename check, as in lane-board-stop-gate.ts: main() runs only when this file is the script node started.
if (!process.env.VITEST && /(^|[\\/])lane-board-republish-reminder\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch(() => {
    // Fail open: no output, exit 0.
  });
}

export { main };
