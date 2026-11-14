// The Claude backend of the review engine (re-claude-backend): one `claude -p` run, read-only, and its parse.
// Contract (map.md "Backend contract", same as backends/cursor.mjs): run(input, opts) -> { text, traceEvents, exitCode, costTag, run, parsed }.
//   input: { promptPath, reviewDir, model, effort, timeoutMs }. opts: { agent, env, promptArgv, runAgent, now, headless } from the engine;
//   tests also pass { tempRoot, claudePath }. opts.agent is not read: this file finds claude.exe itself (seat Q2, 2026-11-14).
//   opts.headless = { reserve, finish, ledgerPath, cap }: the day-cap functions of scripts/lib/headless.mjs (reserveHeadless, finishHeadless), the
//   ledger file and the cap, injected by the caller (seat ruling 2026-11-14, option B: this file imports nothing outside the reviewer set).
//   No opts.headless, or a bad part of it, is notRun 'headless-ledger: ...' before any spawn: it fails closed and spends nothing.
//   The engine reads only run and parsed. run never rejects on an agent failure; it rejects only on a missing env or runAgent.
//   Every reserved run gets exactly one end row in the headless ledger, whatever fails after the reservation.
// Isolation, prevent and not only detect (seat GO 2026-11-14):
//   --restricted: no user, project or local settings file (a PR can commit .claude/settings*.json), no code-running tool, file tools held to the
//   working folder. --safe-mode: no CLAUDE.md, hooks or MCP servers (it still lists some built-in skills and plugins: rescue-runbook.md:108).
//   --settings adds disableAllHooks, claudeMdExcludes and the permissions: dontAsk, blockReadsOutsideWorkingDirectories, one allow rule
//   Read(<reviewDir>/**), a deny list. cwd = reviewDir. Never --bare (it skips OAuth and bills the API key). The child env has no ANTHROPIC_* var
//   and no var of the parent session. --include-hook-events: a hook that runs anyway shows in the stream, and the translation voids it.
//   The flags are not trusted alone: the init event must show cwd = reviewDir, tools = TOOLS, no MCP server and permission mode dontAsk.
// The engine does not run the read audit, so this file's own checks void a run: any path argument outside reviewDir (absolute elsewhere, a parent
//   segment, a ~ % $ or file: prefix, a UNC or drive-relative form, a segment that ends in a dot or space), any tool other than TOOLS, any unknown
//   event or block, a second init or result line, a subagent event (parent_tool_use_id), and a served model that is not the requested id.
// Trace (seat Q3, option A): the claude stream is translated into the cursor-agent tool_call form, so trace.mjs buildTrace and read-audit.mjs read it
//   unchanged. run.stdout is the translated stream; run.rawStream and traceEvents hold the raw stream and the translated events. The translation is
//   total: nothing it does not know vanishes; it becomes an unknown_<name> call (read-audit voids it as unknown-kind) and a problem.
// Model: full ids only (MODELS). Effort is always high. Spend: the injected day cap and ledger (opts.headless, purpose review-engine).
// MAX_TURNS: 216 = 2 x 108, the highest tool-call count in the 35 saved engine traces under ~/.claude/state/local-review on 2026-11-14
//   (median 34, p90 67); never under 60 (seat Q6). A turn can hold several calls, so 216 turns is at least 216 calls.
// Pinned engine copy: this file is in the reviewer set by the local-review/ folder rule (engine-version.mjs). Its one relative import is
//   cursor-review.mjs, already in the set. Never import scripts/lib/headless.mjs here: the import closure test fails on it.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReviewOutput } from '../../cursor-review.mjs';

export const MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']);
export const EFFORT = 'high';
export const TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
export const DENIED = Object.freeze(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill']);
export const MAX_TURNS = 216;
export const PURPOSE = 'review-engine';
const CLAUDE_MD_EXCLUDES = Object.freeze(['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**']);
const DROP_ENV = /^(ANTHROPIC_.*|CLAUDE_CODE_.*|CLAUDECODE|CLAUDE_PID|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE)$/i;
// System events that carry nothing the trace needs and no text from outside the run. Every other subtype (a hook event too) voids.
const BENIGN_SYSTEM = new Set(['thinking_tokens']);
// The rate-limit statuses of a run that went ahead: "allowed" (seen in the 2026-11-14 smoke) and "allowed_warning" (near the limit).
const RATE_LIMIT_OK = new Set(['allowed', 'allowed_warning']);
const PATH_PREFIX = /^(?:[~%$]|file:)/i;
const UNC = /^[\\/]{2}/;
const DRIVE_REL = /^[A-Za-z]:(?![\\/])/;

const fwd = (p) => String(p).replace(/\\/g, '/');
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** { ok: true, model } or { ok: false, reason }. Only the full ids in MODELS: an alias, a haiku, a -fast or auto id is refused. */
export function checkClaudeModel(model) {
  if (typeof model === 'string' && MODELS.includes(model)) return { ok: true, model };
  return { ok: false, reason: `model ${JSON.stringify(model ?? null)} is refused for the Claude backend: use ${MODELS.join(' or ')} (never an alias, haiku, -fast or auto)` };
}

/** A copy of the env with no ANTHROPIC_* var and no var of the parent Claude session (any letter case). */
export function childEnv(base) {
  return Object.fromEntries(Object.entries(base ?? {}).filter(([k]) => !DROP_ENV.test(k)));
}

/** A folder as a permission-rule path: //c/Users/... for a Windows drive path, //tmp/... for a POSIX one (a bare /path is relative to the settings file). */
function rulePath(dir) {
  const s = fwd(dir).replace(/\/+$/, '');
  const m = /^([A-Za-z]):\/?(.*)$/.exec(s);
  if (m) return `//${m[1].toLowerCase()}/${m[2]}`;
  return s.startsWith('/') ? `/${s}` : s;
}

/** The --settings object for one run. */
export function buildSettings(reviewDir) {
  return {
    disableAllHooks: true,
    claudeMdExcludes: [...CLAUDE_MD_EXCLUDES],
    permissions: { defaultMode: 'dontAsk', blockReadsOutsideWorkingDirectories: true, allow: [`Read(${rulePath(reviewDir)}/**)`], deny: [...DENIED] },
  };
}

/** The claude argv. The prompt (promptArgv: one string that says to read the prompt file) is last. */
export function buildArgs({ model, promptArgv, settingsPath, mcpPath }) {
  return [
    '-p', '--restricted', '--safe-mode', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--model', model, '--effort', EFFORT, '--tools', TOOLS.join(','), '--disallowedTools', DENIED.join(','),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', fwd(settingsPath),
    '--strict-mcp-config', '--mcp-config', fwd(mcpPath), '--no-session-persistence', '--max-turns', String(MAX_TURNS),
    ...promptArgv,
  ];
}

/** claude.exe (claude on POSIX) in an ABSOLUTE folder of the PATH of env, spawned with no shell. A relative or empty entry is skipped. null when none. */
export function findClaude(env, platform = process.platform) {
  const names = platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/**
 * True when a path or glob argument can reach outside treeDir. Conservative: a parent segment voids even when it resolves inside,
 * because Windows trims a segment's trailing dots and spaces and the check never touches the disk.
 */
export function escapesTree(value, treeDir) {
  const s = String(value);
  if (s === '') return false;
  if (PATH_PREFIX.test(s) || UNC.test(s) || DRIVE_REL.test(s)) return true;
  for (const seg of s.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (/^[. ]+$/.test(seg) || /[. ]$/.test(seg)) return true; // .., '.. ', '...', 'name.' and 'name ' (Windows trims them)
  }
  if (/[{}]/.test(s) && s.includes('..')) return true;
  if (!path.isAbsolute(s)) return false; // relative with no parent segment: under the cwd, which is treeDir
  const rel = path.relative(path.resolve(treeDir), path.resolve(s));
  return rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

// ---------- the stream ----------

/** The lines of a stream, parsed once: { o } for an object, { bad } for anything else. */
function parseLines(raw) {
  return String(raw ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => {
    try { const o = JSON.parse(l); return isObject(o) ? { o } : { bad: l }; } catch { return { bad: l }; }
  });
}

const blocksOf = (ev) => {
  const c = ev.message?.content;
  if (Array.isArray(c)) return c;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : null;
};
const safeKind = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '_') || 'unknown';
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The Cursor-form body of a Read, Grep or Glob call: { key, args }. */
function callBody(name, input) {
  if (name === 'Read') return { key: 'readToolCall', args: drop({ path: input.file_path, offset: input.offset, limit: input.limit }) };
  if (name === 'Grep') return { key: 'grepToolCall', args: drop({ ...input }) };
  return { key: 'globToolCall', args: drop({ globPattern: input.pattern, targetDirectory: input.path }) };
}

/** The path and glob arguments a call can reach with. */
const reachOf = (name, args) => (name === 'Read' ? [args.path] : name === 'Grep' ? [args.path, args.glob] : [args.globPattern, args.targetDirectory]).filter((v) => v !== undefined);

/** The cat -n line numbers of a Read result: [first, last] or null. */
function readRangeOf(text) {
  const nums = [...text.matchAll(/^\s*(\d+)\t/gm)].map((m) => Number(m[1]));
  return nums.length ? { startLine: nums[0], endLine: nums.at(-1) } : null;
}

function successOf(name, text) {
  if (name === 'Read') { const rr = readRangeOf(text); return rr ? { content: text, readRange: rr } : { content: text }; }
  if (name === 'Glob') return { files: text.split(/\r?\n/).filter((x) => x.trim() !== '') };
  return { content: text };
}

/** The init event must show the isolation took effect. A list of problems. */
function initProblems(inits, treeDir) {
  if (inits.length !== 1) return [`the stream has ${inits.length} init events, not 1`];
  const i = inits[0];
  const p = [];
  if (typeof i.cwd !== 'string' || path.relative(path.resolve(treeDir), path.resolve(i.cwd)) !== '') p.push('the init cwd is not the review tree');
  const tools = Array.isArray(i.tools) ? i.tools.map(String).sort() : null;
  if (!tools || tools.join(',') !== [...TOOLS].sort().join(',')) p.push(`the init tools are not exactly ${TOOLS.join(', ')}`);
  if (!Array.isArray(i.mcp_servers) || i.mcp_servers.length > 0) p.push('the init lists an MCP server');
  if (i.permissionMode !== 'dontAsk') p.push(`the init permission mode is ${JSON.stringify(i.permissionMode ?? null)}, not dontAsk`);
  return p;
}

/**
 * Translates a claude stream-json run into the cursor-agent event form.
 * { stdout, events, problems, inits, results, initFacts }. Total: nothing is dropped. An unknown event, block or tool becomes an
 * unknown_<name> tool_call (read-audit voids it as unknown-kind) and a problem.
 */
export function translateStream(raw, { treeDir }) {
  const out = [];
  const problems = [];
  const open = new Map();
  const seenIds = new Set();
  const inits = [];
  const results = [];
  let n = 0;
  const unknown = (kind, why) => {
    problems.push(why);
    out.push({ type: 'tool_call', subtype: 'completed', call_id: `unknown-${n += 1}`, tool_call: { [`unknown_${safeKind(kind)}ToolCall`]: { args: {} } } });
  };
  const assistantBlock = (b) => {
    if (b?.type === 'text') { out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: String(b.text ?? '') }] } }); return; }
    if (b?.type === 'thinking' || b?.type === 'redacted_thinking') { out.push({ type: 'thinking', subtype: 'completed' }); return; }
    if (b?.type !== 'tool_use') { unknown(`block_${b?.type}`, `an assistant block ${JSON.stringify(String(b?.type))} is not allowed in a review run`); return; }
    if (!TOOLS.includes(b.name)) { unknown(b.name, `tool ${b.name} is not allowed in a review run`); return; }
    const id = String(b.id);
    if (seenIds.has(id)) { unknown(`dup_${b.name}`, `tool call id ${id} appears twice`); return; }
    seenIds.add(id);
    if (!isObject(b.input)) problems.push(`tool ${b.name} has no input object`);
    const { key, args } = callBody(b.name, isObject(b.input) ? b.input : {});
    for (const v of reachOf(b.name, args)) if (escapesTree(v, treeDir)) problems.push(`tool ${b.name} reached a path outside the review tree`);
    open.set(id, { name: b.name, key, args });
    out.push({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { [key]: { args } } });
  };
  const userBlock = (b) => {
    const call = b?.type === 'tool_result' ? open.get(String(b.tool_use_id)) : null;
    if (!call) { unknown(`user_${b?.type}`, b?.type === 'tool_result' ? 'a tool result has no open tool call' : 'a user message in the stream (text from outside the prompt)'); return; }
    open.delete(String(b.tool_use_id));
    const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
    if (parts.some((p) => p?.type !== 'text')) problems.push(`a ${call.name} result holds a part that is not text`);
    const textOut = parts.map((p) => (p?.type === 'text' ? String(p.text ?? '') : '')).join('');
    const res = b.is_error === true ? { error: textOut } : { success: successOf(call.name, textOut) };
    out.push({ type: 'tool_call', subtype: 'completed', call_id: String(b.tool_use_id), tool_call: { [call.key]: { args: call.args, result: res } } });
  };
  for (const item of parseLines(raw)) {
    if (item.bad !== undefined) { problems.push('a stream line is not JSON'); out.push({ type: 'unparsable' }); continue; }
    const ev = item.o;
    if (ev.parent_tool_use_id !== undefined && ev.parent_tool_use_id !== null) { unknown(`sub_${ev.type}`, 'a subagent event (parent_tool_use_id) in a review run'); continue; }
    if (ev.type === 'result') {
      results.push(ev);
      if (results.length > 1) unknown('result_extra', 'the stream has a second result line');
      else out.push(ev);
      continue;
    }
    if (ev.type === 'system') {
      if (ev.subtype === 'init') { inits.push(ev); out.push(ev); } else if (BENIGN_SYSTEM.has(ev.subtype)) out.push(ev);
      else unknown(`system_${ev.subtype}`, `a system event ${JSON.stringify(String(ev.subtype))} is not allowed in a review run`);
      continue;
    }
    if (ev.type === 'rate_limit_event') {
      // Only the notice's own status counts (overageStatus is "rejected" whenever overage is off). A run that was not allowed,
      // or a notice with no status, never ends ok.
      const status = isObject(ev.rate_limit_info) ? ev.rate_limit_info.status : undefined;
      if (!RATE_LIMIT_OK.has(status)) problems.push(`a rate-limit notice with status ${JSON.stringify(status ?? null)} is not allowed in a review run`);
      out.push({ type: 'system', subtype: 'rate_limit_event', rate_limit_info: ev.rate_limit_info ?? null });
      continue;
    }
    if (ev.type === 'assistant' || ev.type === 'user') {
      const blocks = blocksOf(ev);
      if (!blocks) { unknown(`${ev.type}_shape`, `an ${ev.type} event has no content list`); continue; }
      for (const b of blocks) (ev.type === 'assistant' ? assistantBlock : userBlock)(b);
      continue;
    }
    unknown(`event_${ev.type}`, `an event of type ${JSON.stringify(String(ev.type))} is not allowed in a review run`);
  }
  for (const [, c] of open) problems.push(`tool call ${c.name} had no result`);
  problems.push(...initProblems(inits, treeDir));
  const i = inits[0] ?? {};
  const count = (v) => (Array.isArray(v) ? v.length : null);
  const initFacts = { model: i.model ?? null, tools: i.tools ?? null, mcpServers: count(i.mcp_servers), skills: count(i.skills), plugins: count(i.plugins), agents: count(i.agents), slashCommands: count(i.slash_commands), permissionMode: i.permissionMode ?? null, apiKeySource: i.apiKeySource ?? null };
  return { stdout: out.map((e) => JSON.stringify(e)).join('\n'), events: out, problems, inits, results, initFacts };
}

function servedFrom(inits, results, model) {
  const initModels = inits.map((e) => e.model).filter((m) => typeof m === 'string');
  const keys = results.flatMap((r) => (isObject(r.modelUsage) ? Object.keys(r.modelUsage) : []));
  const mismatch = keys.some((x) => x !== model) || initModels.some((m) => m !== model);
  const verified = !mismatch && inits.length === 1 && initModels.length === 1 && results.length === 1 && keys.length > 0;
  return { modelVerified: verified, modelMismatch: mismatch, served: keys.length ? [...new Set(keys)].join(',') : null };
}

/** The served model: every init model and every modelUsage key must equal the requested id; verified needs one init and one result with usage. */
export function servedCheck(raw, model) {
  const lines = parseLines(raw).map((x) => x.o).filter(Boolean);
  return servedFrom(lines.filter((e) => e.type === 'system' && e.subtype === 'init'), lines.filter((e) => e.type === 'result'), model);
}

// ---------- the run ----------

function failedParse(problem) {
  return { ok: false, isError: false, format: 'none', findings: [], clean: false, problems: [problem], usage: null, sessionId: null, durationMs: null, modelVerified: false, modelMismatch: false, text: '' };
}

function notRun(reason) {
  return {
    text: '', traceEvents: null, exitCode: null, costTag: 'claude',
    run: { status: null, stdout: '', stderr: '', timedOut: false, error: reason, notStarted: true, durationMs: 0, toolStats: null },
    parsed: { ...failedParse(reason), notRun: true },
  };
}

const errorRun = (message, durationMs) => ({ status: null, stdout: '', stderr: '', timedOut: false, error: message, durationMs });

/** The parse of a finished run: { out, served }. */
function finishRun(result, { reviewDir, model }, extraProblems) {
  const raw = String(result.stdout ?? '');
  const t = translateStream(raw, { treeDir: reviewDir });
  const parsed = parseReviewOutput(t.stdout, { expectModel: model });
  const served = servedFrom(t.inits, t.results, model);
  parsed.modelVerified = served.modelVerified;
  parsed.modelMismatch = served.modelMismatch;
  const problems = [...t.problems, ...extraProblems];
  if (!served.modelVerified && !served.modelMismatch && raw !== '') problems.push(`the served model is not verified as ${model}`);
  if (problems.length > 0) { parsed.problems = [...parsed.problems, ...problems]; parsed.ok = false; }
  const out = { text: parsed.text, traceEvents: t.events, exitCode: result.status ?? null, costTag: 'claude', run: { ...result, toolStats: null, stdout: t.stdout, rawStream: raw, initFacts: t.initFacts }, parsed };
  return { out, served };
}

/** The reason opts.headless cannot be used, or null. Absent is 'none'. */
export function headlessProblem(h) {
  if (h === undefined || h === null) return 'none';
  if (typeof h !== 'object') return 'headless is not an object';
  if (typeof h.reserve !== 'function') return 'reserve is not a function';
  if (typeof h.finish !== 'function') return 'finish is not a function';
  if (typeof h.ledgerPath !== 'string' || h.ledgerPath === '') return 'ledgerPath is not a path';
  if (!Number.isInteger(h.cap) || h.cap < 1) return 'cap is not a positive integer';
  return null;
}

export async function run({ reviewDir, model, effort, timeoutMs }, opts = {}) {
  const { env, promptArgv, runAgent, now = Date.now } = opts;
  if (!env || typeof env !== 'object') throw new TypeError('backends/claude run: opts.env is required (buildEngineEnv)');
  if (typeof runAgent !== 'function') throw new TypeError('backends/claude run: opts.runAgent is required');
  const gate = checkClaudeModel(model);
  if (!gate.ok) return notRun(gate.reason);
  if (effort !== null && effort !== undefined && effort !== EFFORT) return notRun(`effort ${JSON.stringify(effort)} is refused: the Claude backend runs at ${EFFORT} only`);
  const hlBad = headlessProblem(opts.headless);
  if (hlBad) return notRun(`headless-ledger: ${hlBad}`);
  const { reserve, finish, ledgerPath, cap } = opts.headless;
  const command = opts.claudePath ?? findClaude(env);
  if (!command) return notRun('no-claude: claude.exe not found in an absolute PATH folder');
  let reserved;
  try { reserved = reserve(ledgerPath, { purpose: PURPOSE, model, sessionId: null }, { now, cap }); } catch (err) { return notRun(`headless-ledger: ${errText(err)}`); }
  if (!reserved || typeof reserved !== 'object') return notRun('headless-ledger: reserve returned no result');
  if (!reserved.ok) return notRun(reserved.reason === 'cap' ? 'headless-cap' : `headless-${reserved.reason}`);

  // From here on every path ends in one finish call.
  const t0 = now();
  const extra = [];
  let result;
  let cfgDir = null;
  try {
    cfgDir = mkdtempSync(path.join(opts.tempRoot ?? os.tmpdir(), 'claude-backend-'));
    const settingsPath = path.join(cfgDir, 'settings.json');
    const mcpPath = path.join(cfgDir, 'mcp.json');
    writeFileSync(settingsPath, JSON.stringify(buildSettings(reviewDir)));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    const spec = { command, args: buildArgs({ model, promptArgv: promptArgv ?? [], settingsPath, mcpPath }), cwd: reviewDir, timeoutMs, env: childEnv(env) };
    // One argument only: a second one would set the grok gate env of runAgent (as backends/cursor.mjs).
    const r = await runAgent(spec);
    result = isObject(r) ? r : errorRun('runAgent returned no result', now() - t0);
  } catch (err) {
    result = errorRun(errText(err), now() - t0);
  } finally {
    if (cfgDir) {
      try { rmSync(cfgDir, { recursive: true, force: true, maxRetries: 3 }); } catch (err) { extra.push(`the temp config folder was not removed: ${errText(err)}`); }
    }
  }
  let out;
  let served = { served: null };
  try {
    ({ out, served } = finishRun(result, { reviewDir, model }, extra));
  } catch (err) {
    out = { text: '', traceEvents: null, exitCode: result.status ?? null, costTag: 'claude', run: { ...result, toolStats: null }, parsed: failedParse(`the run output could not be read: ${errText(err)}`) };
  } finally {
    try {
      finish(ledgerPath, reserved.id, {
        exit: result.status ?? null, durationMs: result.durationMs ?? null, timedOut: Boolean(result.timedOut), servedModel: served.served, keyStripped: true,
        ...(result.error ? { error: String(result.error).slice(0, 300) } : {}),
      }, { now });
    } catch { /* the end row is best effort: the start row already counts against the cap */ }
  }
  return out;
}
