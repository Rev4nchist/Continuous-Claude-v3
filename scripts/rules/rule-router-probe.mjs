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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(repo, '.claude/hooks/dist/rule-router.mjs');
const RULES = join(repo, '.claude/rules-ondemand');
const state = mkdtempSync(join(tmpdir(), 'rule-router-probe-'));
const log = join(state, 'fires.jsonl');

function fire(payload, rulesDir = RULES) {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_RULES_ONDEMAND_DIR: rulesDir, CLAUDE_RULE_ROUTER_STATE_DIR: state, CLAUDE_RULE_ROUTER_LOG: log, CLAUDE_AGENT_ID: '' },
  }).trim();
  const j = JSON.parse(out || '{}');
  const h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { kind: 'deny', text: h.permissionDecisionReason };
  if (h.additionalContext) return { kind: 'inject', text: h.additionalContext };
  return { kind: 'none', text: '' };
}

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

const fires = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
const failed = results.filter((r) => !r.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ cases: results.length, failed: failed.length, fires, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.got}${r.ids ? ': ' + r.ids : ''}]`);
  console.log(`\nrule-router probe: ${results.length - failed.length}/${results.length} pass, ${fires} fires logged`);
}
process.exit(failed.length ? 1 : 0);
