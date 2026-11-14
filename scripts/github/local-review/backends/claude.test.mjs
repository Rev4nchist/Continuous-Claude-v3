// Tests of the Claude backend (re-claude-backend). Fake runner only: no test starts claude.
// Run by hand until re-test-globs lands: node --test scripts/github/local-review/backends/claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  run, buildArgs, childEnv, checkClaudeModel, translateStream, servedCheck, buildSettings, escapesTree, findClaude, MAX_TURNS, TOOLS,
} from './claude.mjs';
import { buildTrace } from '../trace.mjs';
import { auditStream } from '../../../eval/review-eval/read-audit.mjs';

const MODEL = 'claude-sonnet-5-5';
const TMP = os.tmpdir();
// The review tree as the engine makes it: <tmpdir>/cursor-review-<id>/tree (read-audit tree-form rule).
const TREE = path.join(TMP, 'cursor-review-abc123', 'tree');
const line = (o) => JSON.stringify(o);
const init = (over = {}) => ({ type: 'system', subtype: 'init', cwd: TREE, model: MODEL, tools: ['Read', 'Grep', 'Glob'], mcp_servers: [], permissionMode: 'dontAsk', session_id: 's1', ...over });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { model: MODEL, content: [{ type: 'tool_use', id, name, input }] }, session_id: 's1' });
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, session_id: 's1' });
const text = (t) => ({ type: 'assistant', message: { model: MODEL, content: [{ type: 'text', text: t }] }, session_id: 's1' });
const ANSWER = 'No problems found.\n```json\n{"findings": []}\n```';
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: ANSWER, session_id: 's1', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [MODEL]: { inputTokens: 10 } }, ...over });
const stream = (...evs) => evs.map(line).join('\n');
const inTree = (rel) => path.join(TREE, rel);

/** A happy stream: Read, Grep and Glob inside the tree, then a clean answer. */
const happy = () => stream(
  init(),
  toolUse('t1', 'Read', { file_path: inTree('.review/PROMPT.md') }), toolResult('t1', '1\tReview this.\n2\tDone.'),
  toolUse('t2', 'Read', { file_path: inTree('src/a.js'), offset: 3, limit: 4 }), toolResult('t2', '3\tx\n4\ty'),
  toolUse('t3', 'Grep', { pattern: 'foo', path: TREE, glob: '*.js' }), toolResult('t3', `${inTree('src/a.js')}`),
  toolUse('t4', 'Glob', { pattern: '**/*.js', path: TREE }), toolResult('t4', `${inTree('src/a.js')}\n${inTree('src/b.js')}`),
  text('done'), result(),
);

// ---------- model gate ----------

test('model: full ids pass; alias, haiku, -fast, auto and empty are refused', () => {
  assert.equal(checkClaudeModel('claude-sonnet-5-5').ok, true);
  assert.equal(checkClaudeModel('claude-opus-5-5').ok, true);
  for (const bad of ['', 'opus', 'sonnet', 'claude-haiku-5-5', 'claude-sonnet-5-5-fast', 'auto', 'AUTO', undefined, null]) {
    assert.equal(checkClaudeModel(bad).ok, false, `should refuse ${bad}`);
  }
});

// ---------- argv ----------

test('argv: read-only tools, effort high, no --bare, settings, strict MCP, max turns, prompt last', () => {
  const args = buildArgs({ model: MODEL, promptArgv: ['Read .review/PROMPT.md'], settingsPath: 'C:/t/s.json', mcpPath: 'C:/t/m.json' });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(val('--tools'), TOOLS.join(','));
  assert.deepEqual(TOOLS, ['Read', 'Grep', 'Glob']);
  assert.equal(val('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.equal(val('--model'), MODEL);
  assert.equal(val('--effort'), 'high');
  assert.equal(val('--permission-mode'), 'dontAsk');
  assert.equal(val('--permission-prompts'), 'none');
  assert.ok(args.includes('--restricted'), 'no user, project or local settings file; file tools held to the working folder');
  assert.ok(args.includes('--safe-mode'), 'no CLAUDE.md, hooks, plugins, skills');
  assert.ok(args.includes('--include-hook-events'), 'a hook that runs shows in the stream');
  assert.ok(!args.includes('--setting-sources'), '--restricted already ignores every settings file');
  assert.equal(val('--settings'), 'C:/t/s.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(val('--mcp-config'), 'C:/t/m.json');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(val('--max-turns'), String(MAX_TURNS));
  assert.ok(MAX_TURNS >= 60);
  const disallowed = val('--disallowedTools').split(',');
  for (const t of ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']) assert.ok(disallowed.includes(t), t);
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(args.at(-1), 'Read .review/PROMPT.md');
});

// ---------- settings file ----------

test('settings: hooks off, memory files excluded, reads blocked outside the tree, only a tree-scoped Read allow', () => {
  const s = buildSettings('C:\\Users\\me\\AppData\\Local\\Temp\\cursor-review-x\\tree');
  assert.equal(s.disableAllHooks, true);
  assert.ok(s.claudeMdExcludes.includes('**/CLAUDE.md'));
  assert.equal(s.permissions.defaultMode, 'dontAsk');
  assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
  // Permission rules take //<drive>/... for an absolute Windows path (permissions doc); a bare /path is relative to the settings file.
  assert.deepEqual(s.permissions.allow, ['Read(//c/Users/me/AppData/Local/Temp/cursor-review-x/tree/**)']);
  for (const t of ['Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch']) assert.ok(s.permissions.deny.includes(t), t);
  assert.deepEqual(buildSettings('/tmp/cursor-review-y/tree').permissions.allow, ['Read(//tmp/cursor-review-y/tree/**)']);
});

// ---------- env ----------

test('env: Anthropic credentials and the parent session vars never reach the child', () => {
  const env = childEnv({
    PATH: 'x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_CODE_MESSAGING_SOCKET: 'b', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_CODE_OAUTH_TOKEN: 'o', HOME: 'h',
    ANTHROPIC_BASE_URL: 'u', ANTHROPIC_MODEL: 'm', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', anthropic_api_key: 'lower', CLAUDE_PROJECT_DIR: 'd', CLAUDE_ENV_FILE: 'f',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

// ---------- translation ----------

test('translation: Read, Grep and Glob become Cursor-form calls; the real buildTrace yields filesRead, greps and globs', () => {
  const t = translateStream(happy(), { treeDir: TREE });
  const trace = buildTrace({ raw: t.stdout, treeDir: TREE, runId: 'r', model: MODEL });
  assert.deepEqual(trace.filesRead.map((f) => f.path).sort(), ['.review/PROMPT.md', 'src/a.js']);
  // The range comes from the cat -n numbers of the result (readRange), not from offset + limit.
  assert.deepEqual(trace.filesRead.find((f) => f.path === 'src/a.js').ranges, [[3, 4]]);
  assert.deepEqual(trace.filesRead.find((f) => f.path === '.review/PROMPT.md').ranges, [[1, 2]]);
  assert.equal(trace.greps.length, 1);
  assert.equal(trace.greps[0].pattern, 'foo');
  assert.equal(trace.globs.length, 1);
  assert.equal(trace.globs[0].glob, '**/*.js');
  assert.deepEqual(t.problems, []);
});

test('translation: the real read audit passes a clean translated stream', () => {
  const t = translateStream(happy(), { treeDir: TREE });
  const a = auditStream(t.stdout, { tmpdir: TMP });
  assert.equal(a.verdict, 'pass', JSON.stringify(a.rules));
  assert.equal(a.counts.read, 2);
});

test('translation: a Read outside the tree voids by the audit and sets a problem', () => {
  const outside = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: outside }), toolResult('t1', 'secret'), result());
  const t = translateStream(raw, { treeDir: TREE });
  assert.ok(t.problems.some((p) => /outside the review tree/.test(p)), t.problems.join('; '));
  assert.equal(auditStream(t.stdout, { tmpdir: TMP }).verdict, 'void');
});

test('translation: a Bash or Write tool_use becomes an unknown-kind call that voids', () => {
  for (const name of ['Bash', 'Write', 'mcp__x__y']) {
    const raw = stream(init(), toolUse('t1', name, { command: 'ls' }), toolResult('t1', 'ok'), toolUse('t2', 'Read', { file_path: inTree('a') }), toolResult('t2', '1\tx'), result());
    const t = translateStream(raw, { treeDir: TREE });
    assert.ok(t.problems.some((p) => p.includes(`tool ${name} is not allowed`)), name);
    const a = auditStream(t.stdout, { tmpdir: TMP });
    assert.equal(a.verdict, 'void');
    assert.ok(a.rules.some((r) => (r.rule ?? r) === 'unknown-kind' || String(JSON.stringify(r)).includes('unknown-kind')));
  }
});

test('translation is total: an unknown event type or content block never vanishes; it voids', () => {
  const cases = [
    { type: 'brand_new_event', x: 1 },
    { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', output: 'lane board text' },
    { type: 'system', subtype: 'something_new' },
    { type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'brand_new_block' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'injected' }] } },
  ];
  for (const ev of cases) {
    const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), ev, result());
    const t = translateStream(raw, { treeDir: TREE });
    assert.ok(t.problems.length > 0, `no problem for ${JSON.stringify(ev)}`);
    assert.equal(auditStream(t.stdout, { tmpdir: TMP }).verdict, 'void', JSON.stringify(ev));
  }
});

test('translation: a tool_use with no tool_result still gives a call event', () => {
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), result());
  const t = translateStream(raw, { treeDir: TREE });
  const calls = t.stdout.split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subtype, 'started');
  assert.ok(t.problems.some((p) => /no result/.test(p)));
});

test('translation: a denied or failed tool call keeps its error, and the read is not counted as read', () => {
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('gone.js') }), toolResult('t1', 'File does not exist.', true), toolUse('t2', 'Read', { file_path: inTree('a') }), toolResult('t2', '1\tx'), result());
  const t = translateStream(raw, { treeDir: TREE });
  const trace = buildTrace({ raw: t.stdout, treeDir: TREE, runId: 'r', model: MODEL });
  assert.deepEqual(trace.filesRead.map((f) => f.path), ['a']);
  assert.equal(trace.toolErrors.length, 1);
});

test('translation: benign events (thinking, rate limit, thinking tokens) pass without a problem', () => {
  const raw = stream(
    init(), { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 }, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
    toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), result(),
  );
  const t = translateStream(raw, { treeDir: TREE });
  assert.deepEqual(t.problems, []);
  assert.equal(auditStream(t.stdout, { tmpdir: TMP }).verdict, 'pass');
});

test('translation: a line that is not JSON is a problem, never dropped in silence', () => {
  const t = translateStream(`${happy()}\nnot json`, { treeDir: TREE });
  assert.ok(t.problems.some((p) => /not JSON/.test(p)));
});

// ---------- served model ----------

test('served model: modelUsage must hold only the requested id', () => {
  assert.deepEqual(servedCheck(stream(init(), result()), MODEL), { modelVerified: true, modelMismatch: false, served: MODEL });
  const helper = servedCheck(stream(init(), result({ modelUsage: { [MODEL]: {}, 'claude-haiku-5-5': {} } })), MODEL);
  assert.equal(helper.modelMismatch, true);
  assert.equal(helper.modelVerified, false);
  assert.equal(servedCheck(stream(init(), result({ modelUsage: { 'claude-opus-5-5': {} } })), MODEL).modelMismatch, true);
  assert.equal(servedCheck(stream(init({ model: 'claude-opus-5-5' }), result()), MODEL).modelMismatch, true, 'init model must agree too');
  const none = servedCheck(stream(init(), result({ modelUsage: undefined })), MODEL);
  assert.equal(none.modelVerified, false);
});

// ---------- run() with a fake runner ----------

function harness(over = {}) {
  const dir = mkdtempSync(path.join(TMP, 'claude-backend-test-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const tempRoot = path.join(dir, 'tmp');
  mkdirSync(tempRoot);
  const calls = [];
  const runAgent = over.runAgent ?? (async (spec) => { calls.push(spec); return { status: 0, stdout: happy(), stderr: '', timedOut: false, durationMs: 5 }; });
  const opts = { agent: null, env: { PATH: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'x' }, promptArgv: ['Read .review/PROMPT.md'], runAgent, now: () => Date.parse('2026-11-14T12:00:00Z'), ledgerPath: ledger, tempRoot, claudePath: 'C:/fake/claude.exe', ...over.opts };
  const input = { promptPath: inTree('.review/PROMPT.md'), reviewDir: TREE, model: MODEL, effort: null, timeoutMs: 1000, ...over.input };
  return { dir, ledger, tempRoot, calls, opts, input, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const ledgerRows = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('run: a clean run parses, verifies the model, and returns the contract fields', async () => {
  const h = harness();
  try {
    const out = await run(h.input, h.opts);
    assert.equal(out.parsed.ok, true, out.parsed.problems.join('; '));
    assert.equal(out.parsed.modelVerified, true);
    assert.equal(out.parsed.modelMismatch, false);
    assert.equal(out.costTag, 'claude');
    assert.equal(out.exitCode, 0);
    assert.ok(Array.isArray(out.traceEvents) && out.traceEvents.length > 0);
    assert.equal(out.run.rawStream, happy());
    assert.notEqual(out.run.stdout, happy(), 'run.stdout is the translated stream');
    const spec = h.calls[0];
    assert.equal(spec.cwd, TREE);
    assert.equal(spec.command, 'C:/fake/claude.exe');
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spec.env.CLAUDE_CODE_SESSION_ID, undefined);
    const rows = ledgerRows(h.ledger);
    assert.deepEqual(rows.map((r) => r.phase), ['start', 'end']);
    assert.equal(rows[0].purpose, 'review-engine');
  } finally { h.done(); }
});

test('run: one spawn argument only (a second one changes the Grok gate)', async () => {
  let n = -1;
  const h = harness({ runAgent: async (...a) => { n = a.length; return { status: 0, stdout: happy(), stderr: '', timedOut: false }; } });
  try { await run(h.input, h.opts); assert.equal(n, 1); } finally { h.done(); }
});

test('run: a refused model or effort spawns nothing and writes no ledger row', async () => {
  for (const over of [{ input: { model: 'opus' } }, { input: { model: 'claude-haiku-5-5' } }, { input: { effort: 'low' } }]) {
    const h = harness(over);
    try {
      const out = await run(h.input, h.opts);
      assert.equal(h.calls.length, 0);
      assert.equal(out.parsed.ok, false);
      assert.equal(out.parsed.notRun, true);
      assert.ok(out.run.error);
      assert.deepEqual(ledgerRows(h.ledger), []);
    } finally { h.done(); }
  }
});

test('run: at the headless day cap nothing spawns, the run is notRun, and no new row is written', async () => {
  const h = harness();
  try {
    const day = Date.parse('2026-11-14T12:00:00Z');
    writeFileSync(h.ledger, `${line({ ts: new Date(day - 1000).toISOString(), phase: 'start', id: 'x1' })}\n`);
    const out = await run(h.input, { ...h.opts, cap: 1 });
    assert.equal(h.calls.length, 0);
    assert.equal(out.parsed.notRun, true);
    assert.equal(out.run.error, 'headless-cap');
    assert.equal(ledgerRows(h.ledger).length, 1);
  } finally { h.done(); }
});

test('run: a runAgent throw is a run with error set; run does not reject', async () => {
  const h = harness({ runAgent: async () => { throw new Error('spawn ENOENT'); } });
  try {
    const out = await run(h.input, h.opts);
    assert.match(out.run.error, /ENOENT/);
    assert.equal(out.parsed.ok, false);
    assert.equal(ledgerRows(h.ledger).at(-1).phase, 'end');
  } finally { h.done(); }
});

test('run: rejects with no env or no runAgent, before any ledger row', async () => {
  const h = harness();
  try {
    await assert.rejects(run(h.input, { ...h.opts, env: undefined }), /env/);
    await assert.rejects(run(h.input, { ...h.opts, runAgent: undefined }), /runAgent/);
    assert.deepEqual(ledgerRows(h.ledger), []);
  } finally { h.done(); }
});

test('run: a haiku helper in modelUsage voids the run as a model mismatch', async () => {
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), result({ modelUsage: { [MODEL]: {}, 'claude-haiku-5-5': {} } }));
  const h = harness({ runAgent: async () => ({ status: 0, stdout: raw, stderr: '', timedOut: false }) });
  try {
    const out = await run(h.input, h.opts);
    assert.equal(out.parsed.modelMismatch, true);
  } finally { h.done(); }
});

test('run: a forbidden tool in the stream makes parsed not ok', async () => {
  const raw = stream(init(), toolUse('t1', 'Bash', { command: 'type C:\\x' }), toolResult('t1', 'x'), result());
  const h = harness({ runAgent: async () => ({ status: 0, stdout: raw, stderr: '', timedOut: false }) });
  try {
    const out = await run(h.input, h.opts);
    assert.equal(out.parsed.ok, false);
    assert.ok(out.parsed.problems.some((p) => p.includes('tool Bash is not allowed')));
  } finally { h.done(); }
});

test('run: max turns hit is an error, not ok', async () => {
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), result({ subtype: 'error_max_turns', is_error: true, result: '' }));
  const h = harness({ runAgent: async () => ({ status: 0, stdout: raw, stderr: '', timedOut: false }) });
  try { assert.equal((await run(h.input, h.opts)).parsed.ok, false); } finally { h.done(); }
});

test('run: the temp config folder is removed after a run, also after a failure', async () => {
  for (const runAgent of [async () => ({ status: 0, stdout: happy(), stderr: '', timedOut: false }), async () => { throw new Error('boom'); }, async () => ({ status: 1, stdout: '', stderr: 'x', timedOut: true })]) {
    let seen = null;
    const h = harness({ runAgent: async (spec) => { const a = spec.args; seen = path.dirname(a[a.indexOf('--settings') + 1]); assert.ok(existsSync(seen)); return runAgent(spec); } });
    try {
      await run(h.input, h.opts);
      assert.ok(seen && !existsSync(seen), 'config folder removed');
    } finally { h.done(); }
  }
});

// ---------- critic round 1 (2026-11-14): one test per finding ----------

test('path check: every way out of the tree is caught; plain tree paths pass', () => {
  const outside = [
    path.join(TMP, 'cursor-review-abc123', 'tree2', 'x.js'), path.join(os.homedir(), '.ssh', 'id_rsa'), '../x.js', 'src/../../x', '~/.ssh/id_rsa',
    '%USERPROFILE%\\x', '$HOME/x', 'file:///c:/x', '\\\\server\\share\\x', '//server/share/x', 'D:x', `${TREE}\\.. \\secret`, 'src/name.', 'src/name ',
    '{src,..}/x', 'C:/Users/**', '/', '/etc/passwd',
  ];
  for (const p of outside) assert.equal(escapesTree(p, TREE), true, p);
  for (const p of [inTree('src/a.js'), 'src/a.js', './src/a.js', '**/*.js', 'src/**/*.{js,ts}', TREE, TREE.toUpperCase()]) assert.equal(escapesTree(p, TREE), false, p);
});

test('path check: a Glob pattern or a Grep glob that climbs out voids the run', () => {
  for (const ev of [toolUse('t1', 'Glob', { pattern: 'C:/Users/dkhay/.ssh/*' }), toolUse('t1', 'Glob', { pattern: '../../**' }), toolUse('t1', 'Grep', { pattern: 'x', glob: '../**' }), toolUse('t1', 'Grep', { pattern: 'x', path: path.join(TMP, 'other') })]) {
    const t = translateStream(stream(init(), ev, toolResult('t1', ''), result()), { treeDir: TREE });
    assert.ok(t.problems.some((p) => /outside the review tree/.test(p)), JSON.stringify(ev));
  }
});

test('translation: a disallowed tool named read, grep or glob never becomes a valid call kind', () => {
  const t = translateStream(stream(init(), toolUse('t1', 'read', { file_path: inTree('a') }), toolResult('t1', 'x'), result()), { treeDir: TREE });
  assert.ok(t.problems.some((p) => p.includes('tool read is not allowed')));
  const call = t.events.find((e) => e.type === 'tool_call');
  assert.ok(Object.keys(call.tool_call)[0].startsWith('unknown_'));
  assert.equal(auditStream(t.stdout, { tmpdir: TMP }).verdict, 'void');
});

test('translation: odd stream shapes never vanish', () => {
  const cases = {
    'assistant with no message': { type: 'assistant' },
    'content as an object': { type: 'assistant', message: { content: { type: 'text', text: 'x' } } },
    'a subagent event': { ...toolUse('t9', 'Read', { file_path: inTree('a') }), parent_tool_use_id: 'toolu_x' },
    'a tool result before its tool use': toolResult('t7', 'early'),
    'a second result line': result(),
    'a second init': init(),
  };
  for (const [name, ev] of Object.entries(cases)) {
    const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), ev, result());
    const t = translateStream(raw, { treeDir: TREE });
    assert.ok(t.problems.length > 0, name);
  }
});

test('translation: a duplicate tool_use id, a non-text result part and a null input are problems', () => {
  const dup = translateStream(stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolUse('t1', 'Read', { file_path: inTree('b') }), toolResult('t1', '1\tx'), result()), { treeDir: TREE });
  assert.ok(dup.problems.some((p) => /appears twice/.test(p)));
  const img = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }] }] } };
  assert.ok(translateStream(stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), img, result()), { treeDir: TREE }).problems.some((p) => /not text/.test(p)));
  const nul = translateStream(stream(init(), toolUse('t1', 'Read', null), toolResult('t1', 'x'), result()), { treeDir: TREE });
  assert.ok(nul.problems.some((p) => /no input object/.test(p)));
});

test('init check: wrong cwd, extra tool, an MCP server, another permission mode, or no init each give a problem', () => {
  const bad = [init({ cwd: path.join(TMP, 'elsewhere') }), init({ tools: ['Read', 'Grep', 'Glob', 'Bash'] }), init({ mcp_servers: [{ name: 'x' }] }), init({ permissionMode: 'default' })];
  for (const i of bad) {
    const t = translateStream(stream(i, toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), result()), { treeDir: TREE });
    assert.ok(t.problems.some((p) => /init/.test(p)), JSON.stringify(i));
  }
  assert.ok(translateStream(stream(result()), { treeDir: TREE }).problems.some((p) => /0 init events/.test(p)));
  assert.deepEqual(translateStream(happy(), { treeDir: TREE }).problems, []);
});

test('run: a stream with no modelUsage is not verified and the run is not ok', async () => {
  const raw = stream(init(), toolUse('t1', 'Read', { file_path: inTree('a') }), toolResult('t1', '1\tx'), result({ modelUsage: undefined }));
  const h = harness({ runAgent: async () => ({ status: 0, stdout: raw, stderr: '', timedOut: false }) });
  try {
    const out = await run(h.input, h.opts);
    assert.equal(out.parsed.modelVerified, false);
    assert.equal(out.parsed.ok, false);
    assert.ok(out.parsed.problems.some((p) => /not verified/.test(p)));
  } finally { h.done(); }
});

test('run: the settings file the child gets is buildSettings(reviewDir)', async () => {
  let settings = null;
  const h = harness({ runAgent: async (spec) => { settings = JSON.parse(readFileSync(spec.args[spec.args.indexOf('--settings') + 1], 'utf8')); return { status: 0, stdout: happy(), stderr: '', timedOut: false }; } });
  try { await run(h.input, h.opts); assert.deepEqual(settings, buildSettings(TREE)); } finally { h.done(); }
});

test('run: no claude.exe in an absolute PATH folder is notRun before any ledger row; relative PATH entries are skipped', async () => {
  const dir = mkdtempSync(path.join(TMP, 'claude-path-'));
  try {
    writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    assert.equal(findClaude({ PATH: ['', '.', 'relative', dir].join(path.delimiter) }), path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    const prev = process.cwd();
    process.chdir(dir);
    try { assert.equal(findClaude({ PATH: ['', '.'].join(path.delimiter) }), null); } finally { process.chdir(prev); }
    const h = harness();
    try {
      const out = await run(h.input, { ...h.opts, claudePath: undefined, env: { PATH: 'relative-only' } });
      assert.equal(out.parsed.notRun, true);
      assert.match(out.run.error, /no-claude/);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(ledgerRows(h.ledger), []);
    } finally { h.done(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run: every failure after the reservation still writes one end row and never rejects', async () => {
  const cases = {
    'missing tempRoot': { opts: { tempRoot: path.join(TMP, 'no-such-folder-claude-backend', 'x') } },
    'runAgent throws undefined': { runAgent: async () => { throw undefined; } }, // eslint-disable-line no-throw-literal
    'runAgent resolves undefined': { runAgent: async () => undefined },
  };
  for (const [name, over] of Object.entries(cases)) {
    const h = harness(over);
    try {
      const out = await run(h.input, h.opts);
      assert.ok(out.run.error, name);
      assert.equal(out.parsed.ok, false, name);
      assert.deepEqual(ledgerRows(h.ledger).map((r) => r.phase), ['start', 'end'], name);
    } finally { h.done(); }
  }
});

test('run: toolStats is null (the runAgent tracker reads only the Cursor form)', async () => {
  const h = harness({ runAgent: async () => ({ status: 0, stdout: happy(), stderr: '', timedOut: false, toolStats: { toolCalls: 0 } }) });
  try { assert.equal((await run(h.input, h.opts)).run.toolStats, null); } finally { h.done(); }
});
