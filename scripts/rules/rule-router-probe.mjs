#!/usr/bin/env node
/**
 * rule-router-probe.mjs -- end-to-end check of the built rule-router hook.
 *
 * Pipes real PreToolUse payloads into .claude/hooks/dist/rule-router.mjs with the REPO manifest
 * (.claude/rules-ondemand) and a throwaway state dir, and checks what the hook emits. Each case is a
 * way the router could misfire: quoted text, env/cmd prefixes, dedupe, subagents, skills, MCP
 * tools, a missing manifest. Build first: `npm run build` in .claude/hooks.
 *
 * Usage: node scripts/rules/rule-router-probe.mjs [--json]    exit 1 on any failed case
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(repo, '.claude/hooks/dist/rule-router.mjs');
const RULES = join(repo, '.claude/rules-ondemand');
const state = mkdtempSync(join(tmpdir(), 'rule-router-probe-'));
const log = join(state, 'fires.jsonl');

const hookEnv = (rulesDir) => ({ ...process.env, CLAUDE_RULES_ONDEMAND_DIR: rulesDir, CLAUDE_RULE_ROUTER_STATE_DIR: state, CLAUDE_RULE_ROUTER_LOG: log, CLAUDE_AGENT_ID: '' });

function parse(out) {
  const j = JSON.parse(out.trim() || '{}');
  const h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { kind: 'deny', text: h.permissionDecisionReason };
  if (h.additionalContext) return { kind: 'inject', text: h.additionalContext };
  return { kind: 'none', text: '' };
}

function fire(payload, rulesDir = RULES) {
  return parse(execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: hookEnv(rulesDir) }));
}

/** The same call from N processes at once, as parallel tool calls do. Resolves to their decisions. */
function fireParallel(payload, n) {
  return Promise.all(Array.from({ length: n }, () => new Promise((res) => {
    const c = spawn('node', [HOOK], { env: hookEnv(RULES) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => res(parse(out)));
    c.stdin.end(JSON.stringify(payload));
  })));
}

// A rules dir whose manifest names files that are missing, to prove a failed read releases the claim.
const brokenDir = mkdtempSync(join(tmpdir(), 'rule-router-broken-'));
copyFileSync(join(RULES, 'manifest.json'), join(brokenDir, 'manifest.json'));

const bash = (session, command, extra = {}) => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, ...extra });
const ps = (session, command) => ({ session_id: session, tool_name: 'PowerShell', tool_input: { command } });

// [name, payload, expected kind, rule ids that must appear, ids that must NOT appear, rulesDir]
const CASES = [
  ['codex exec blocks first time', bash('s1', 'codex exec --sandbox read-only - < p.txt'), 'deny', ['codex'], ['pr-and-commit-style']],
  ['same rule, same session: passes', bash('s1', 'codex exec --sandbox read-only - < p.txt'), 'none', [], []],
  ['env -u prefix still matches', bash('s2', 'env -u OPENAI_API_KEY -u CODEX_API_KEY codex exec -'), 'deny', ['codex'], []],
  ['quoted "codex" in a commit message is not codex', bash('s3', 'git commit -m "hand this to codex exec later"'), 'deny', ['pr-and-commit-style'], ['codex']],
  ['a ; inside a quoted message does not start a codex segment', bash('s3b', 'git commit -m "step 1; codex exec later"'), 'deny', ['pr-and-commit-style'], ['codex']],
  ['codex as an argument is not a command', bash('s4', 'ls codex/ && cat notes/codex.md'), 'none', [], []],
  ['echo of a codex command does not fire', bash('s4', 'echo "codex exec"'), 'none', [], []],
  ['commit through git-safe.ps1 with quoted paths', ps('s5', 'pwsh -File "C:\\r\\scripts\\git-safe.ps1" -C C:\\r -c "core.hooksPath=x" commit -F "C:\\m.txt"'), 'deny', ['pr-and-commit-style'], []],
  ['git -C repo commit', bash('s6', 'git -C /c/repo commit -F msg.txt'), 'deny', ['pr-and-commit-style'], []],
  ['PR create via REST: block for style, plus the CodeRabbit loop', bash('s7', 'gh api repos/o/r/pulls -X POST -f title=x -f head=b'), 'deny', ['pr-and-commit-style', 'pr-coderabbit-loop'], []],
  ['REST merge injects the merge workflow', bash('s8', 'gh api repos/o/r/pulls/57/merge -X PUT -f merge_method=merge'), 'inject', ['git-merge'], ['pr-and-commit-style']],
  ['land-pr injects merge + CodeRabbit rules', ps('s9', 'pwsh -File scripts/github/land-pr.ps1 -Pr 57'), 'inject', ['git-merge', 'pr-coderabbit-loop'], []],
  ['codex-adversary agent blocks', { session_id: 's10', tool_name: 'Agent', tool_input: { subagent_type: 'codex-adversary' } }, 'deny', ['codex'], []],
  ['Task tool name works too', { session_id: 's10b', tool_name: 'Task', tool_input: { subagent_type: 'grok-worker' } }, 'deny', ['grok'], []],
  ['a subagent gets its own copy', bash('s10', 'codex exec -', { agent_id: 'sub-1' }), 'deny', ['codex'], []],
  ['harness-update skill injects', { session_id: 's11', tool_name: 'Skill', tool_input: { skill: 'harness-update' } }, 'inject', ['harness-update'], []],
  ['Neon MCP tool injects neonctl rule', { session_id: 's12', tool_name: 'mcp__Neon__delete_branch', tool_input: {} }, 'inject', ['neonctl'], []],
  ['psql via docker exec injects the DB rule', bash('s13', 'docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c "SELECT 1"'), 'inject', ['cross-terminal-db'], []],
  ['headless claude -p injects', bash('s14', 'claude -p "hi" --output-format json'), 'inject', ['headless-claude'], []],
  ['CMA API URL blocks', bash('s15', 'curl -s https://api.anthropic.com/v1/sessions -H "x"'), 'deny', ['cma'], []],
  ['CMA call with a key in its header blocks (log checked below)', bash('s15b', 'curl -s -H x-api-key:SECRET-PROBE-123 https://api.anthropic.com/v1/sessions'), 'deny', ['cma'], []],
  ['a rule file that cannot be read: fail open', bash('s18', 'codex exec -'), 'none', [], [], brokenDir],
  ['...and the claim is released, so the rule still shows later', bash('s18', 'codex exec -'), 'deny', ['codex'], []],
  ['design skill injects design-work', { session_id: 's20', tool_name: 'Skill', tool_input: { skill: 'frontend-design:frontend-design' } }, 'inject', ['design'], ['kie-spend']],
  ['paid kie.ai still blocks', bash('s20', 'node "C:/x/scroll-craft/scripts/kie.mjs" still --prompt hero'), 'deny', ['kie-spend'], []],
  ['an echo of a kie command does not claim the spend rule', bash('s25', 'echo "kie.mjs still"'), 'none', [], []],
  ['...so the real paid run after it still blocks', bash('s25', 'node scripts/kie.mjs shot --still hero.png'), 'deny', ['kie-spend'], []],
  ['an echo of the CMA URL does not claim the CMA rule', bash('s26', 'echo "curl https://api.anthropic.com/v1/sessions"'), 'none', [], []],
  ['...so the real CMA call after it still blocks', bash('s26', 'curl -s https://api.anthropic.com/v1/sessions'), 'deny', ['cma'], []],
  ['a quoted docker path with exec postgres injects the DB rule', ps('s27', '& "C:\\Program Files\\Docker\\docker.exe" exec continuous-claude-postgres psql -c "SELECT 1"'), 'inject', ['cross-terminal-db'], []],
  ['a kie command inside a # comment does not claim the rule', bash('s28', 'echo ok # ; node scripts/kie.mjs still --prompt hero'), 'none', [], []],
  ['...so the real paid run after it still blocks', bash('s28', 'node scripts/kie.mjs still --prompt hero'), 'deny', ['kie-spend'], []],
  ['a URL fragment # is not a comment', bash('s29', 'curl -s https://api.anthropic.com/v1/sessions#x'), 'deny', ['cma'], []],
  ['a paid run inside $(...) blocks', bash('s30', 'echo "$(node scripts/kie.mjs still --prompt hero)"'), 'deny', ['kie-spend'], []],
  ['a paid run inside backticks blocks', bash('s31', 'echo `node scripts/kie.mjs shot a.png`'), 'deny', ['kie-spend'], []],
  ['a paid run inside bash -c blocks', bash('s32', 'bash -c "node scripts/kie.mjs still --prompt hero"'), 'deny', ['kie-spend'], []],
  ['PowerShell $(...) subexpression blocks', ps('s33', '$r = $(node scripts/kie.mjs still --prompt hero)'), 'deny', ['kie-spend'], []],
  ['single-quoted $(...) is literal text: nothing', bash('s34', "echo '$(node scripts/kie.mjs still)'"), 'none', [], []],
  ['a trigger in the second segment fires (log checked below)', ps('s35', "$R='C:\\r'; pwsh -File scripts/github/land-pr.ps1 -Pr 1"), 'inject', ['git-merge'], []],
  ['psql with a credential in its URL injects (log checked below)', bash('s37-full-session-id', 'psql postgresql://claude:PWPROBE@localhost:5432/db -c "select 1"'), 'inject', ['cross-terminal-db'], []],
  ['free kie.ai probe does not block', bash('s21', 'node scripts/kie.mjs probe'), 'none', [], []],
  ['a claude-in-chrome tool blocks (deprecated)', { session_id: 's22', tool_name: 'mcp__claude-in-chrome__navigate', tool_input: {} }, 'deny', ['browser-deprecated'], ['browser']],
  ['Playwright MCP injects the browser rule', { session_id: 's23', tool_name: 'mcp__playwright__browser_navigate', tool_input: {} }, 'inject', ['browser'], []],
  ['WebFetch injects opencli-first', { session_id: 's24', tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, 'inject', ['opencli'], []],
  ['unrelated command: nothing', bash('s16', 'git status --short'), 'none', [], []],
  ['missing manifest fails open', bash('s17', 'codex exec -'), 'none', [], [], join(state, 'no-such-dir')],
];

const results = CASES.map(([name, payload, kind, must, mustNot, dir]) => {
  let got;
  try { got = fire(payload, dir); } catch (e) { got = { kind: 'error', text: String(e.message) }; }
  const idsLine = (got.text.match(/\(([^)]*)\)/) || [, ''])[1];
  const ok = got.kind === kind && must.every((id) => idsLine.split(', ').includes(id)) && mustNot.every((id) => !idsLine.split(', ').includes(id));
  return { name, ok, expected: kind, got: got.kind, ids: idsLine };
});

// Parallel tool calls: 6 processes race for the same unseen rule; exactly one may emit it.
const race = await fireParallel(bash('race', 'codex exec -'), 6);
const raceDenies = race.filter((r) => r.kind === 'deny').length;
results.push({ name: '6 parallel calls for one unseen rule: exactly 1 deny', ok: raceDenies === 1, expected: '1 deny', got: `${raceDenies} deny`, ids: '' });
// The fire log must never hold the raw command (it can carry a credential).
const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
results.push({ name: 'fire log never contains command arguments', ok: logText.length > 0 && !logText.includes('SECRET-PROBE-123'), expected: 'no secret', got: logText.includes('SECRET-PROBE-123') ? 'secret logged' : 'clean', ids: '' });

// The log must name the segment that fired, not the first segment (`$R=...` told an audit nothing).
const s35 = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.session === 's35');
results.push({ name: 'fire log names the segment that fired', ok: s35?.what === 'pwsh -File', expected: 'pwsh -File', got: String(s35?.what), ids: '' });
// A credential in the second word (a connection URL) is replaced, and the identity matches the claim key.
const s37 = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.session === 's37-full-session-id');
results.push({ name: 'a URL credential never reaches the log', ok: s37?.what === 'psql <arg>' && !logText.includes('PWPROBE'), expected: 'psql <arg>', got: String(s37?.what), ids: '' });
results.push({ name: 'the log keeps the full session id and the agent', ok: s37?.agent === 'main', expected: 'full id, agent main', got: s37 ? `${s37.session} / ${s37.agent}` : 'missing', ids: '' });

const fires = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
const failed = results.filter((r) => !r.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ cases: results.length, failed: failed.length, fires, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.got}${r.ids ? ': ' + r.ids : ''}]`);
  console.log(`\nrule-router probe: ${results.length - failed.length}/${results.length} pass, ${fires} fires logged`);
}
process.exit(failed.length ? 1 : 0);
