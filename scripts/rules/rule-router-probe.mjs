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
import { mkdtempSync, readFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(repo, '.claude/hooks/dist/rule-router.mjs');
const RULES = join(repo, '.claude/rules-ondemand');
const state = mkdtempSync(join(tmpdir(), 'rule-router-probe-'));
const log = join(state, 'fires.jsonl');
// The built hook also writes guard-decisions.jsonl; keep the probe's denies out of the real log.
const guardLog = join(state, 'guard-decisions.jsonl');

const hookEnv = (rulesDir) => ({ ...process.env, CLAUDE_RULES_ONDEMAND_DIR: rulesDir, CLAUDE_RULE_ROUTER_STATE_DIR: state, CLAUDE_RULE_ROUTER_LOG: log, CCV3_GUARD_DECISIONS_LOG: guardLog, CLAUDE_AGENT_ID: '' });

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

// A synthetic deny-first rule with no "subagent" key. Since 2026-10-31 the commit style rule is inject, so no real rule is
// deny-first without a subagent block. This one keeps the downgrade covered: the main thread is blocked once, then each
// subagent of that session gets the rule as an inject, not a second block.
const denyDir = mkdtempSync(join(tmpdir(), 'rule-router-denyfirst-'));
writeFileSync(join(denyDir, 'manifest.json'), JSON.stringify({ rules: [{ id: 'probe-deny', files: ['probe-deny.md'], mode: 'deny-first', command: ['^probe-deny-cmd(\\s|$)'] }] }));
writeFileSync(join(denyDir, 'probe-deny.md'), '# probe-deny\nA synthetic rule for the probe.\n');

const bash = (session, command, extra = {}) => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, ...extra });
const ps = (session, command) => ({ session_id: session, tool_name: 'PowerShell', tool_input: { command } });

// [name, payload, expected kind, rule ids that must appear, ids that must NOT appear, rulesDir]
const CASES = [
  ['grok exec blocks first time', bash('s1', 'grok exec --sandbox read-only - < p.txt'), 'deny', ['grok'], ['pr-and-commit-style']],
  ['same rule, same session: passes', bash('s1', 'grok exec --sandbox read-only - < p.txt'), 'none', [], []],
  ['env -u prefix still matches', bash('s2', 'env -u OPENAI_API_KEY -u GROK_API_KEY grok exec -'), 'deny', ['grok'], []],
  ['quoted "grok" in a commit message is not grok', bash('s3', 'git commit -m "hand this to grok exec later"'), 'inject', ['pr-and-commit-style'], ['grok']],
  ['a ; inside a quoted message does not start a grok segment', bash('s3b', 'git commit -m "step 1; grok exec later"'), 'inject', ['pr-and-commit-style'], ['grok']],
  ['grok as an argument is not a command', bash('s4', 'ls grok/ && cat notes/grok.md'), 'none', [], []],
  ['echo of a grok command does not fire', bash('s4', 'echo "grok exec"'), 'none', [], []],
  ['commit through git-safe.ps1 with quoted paths', ps('s5', 'pwsh -File "C:\\r\\scripts\\git-safe.ps1" -C C:\\r -c "core.hooksPath=x" commit -F "C:\\m.txt"'), 'inject', ['pr-and-commit-style'], []],
  ['git -C repo commit', bash('s6', 'git -C /c/repo commit -F msg.txt'), 'inject', ['pr-and-commit-style'], []],
  ['PR create via REST: injects the style rule and the review loop, no block', bash('s7', 'gh api repos/o/r/pulls -X POST -f title=x -f head=b'), 'inject', ['pr-and-commit-style', 'pr-review-loop'], []],
  ['REST merge injects the merge workflow', bash('s8', 'gh api repos/o/r/pulls/57/merge -X PUT -f merge_method=merge'), 'inject', ['git-merge'], ['pr-and-commit-style']],
  ['land-pr injects merge + review loop rules', ps('s9', 'pwsh -File scripts/github/land-pr.ps1 -Pr 57'), 'inject', ['git-merge', 'pr-review-loop'], []],
  ['pre-pr.mjs injects the review loop rule (Before you open a PR)', bash('s9b', 'node scripts/github/pre-pr.mjs --body draft.md'), 'inject', ['pr-review-loop'], ['pr-and-commit-style']],
  ['grok-adversary agent blocks', { session_id: 's10', tool_name: 'Agent', tool_input: { subagent_type: 'grok-adversary' } }, 'deny', ['grok'], []],
  ['Task tool name works too', { session_id: 's10b', tool_name: 'Task', tool_input: { subagent_type: 'grok-worker' } }, 'deny', ['grok'], []],
  ['a gate rule (grok) still blocks a subagent after the session had the block', bash('s10', 'grok exec -', { agent_id: 'sub-1' }), 'deny', ['grok'], []],
  ['the commit style rule injects the main thread and the call runs (2026-10-31: no first-call block)', bash('s10d', 'git -C /c/repo commit -F msg.txt'), 'inject', ['pr-and-commit-style'], []],
  ['...and not again on the next commit in that session', bash('s10d', 'git -C /c/repo commit -F msg.txt'), 'none', [], []],
  ['...a subagent of that session gets its own copy',bash('s10d', 'git -C /c/repo commit -F msg.txt', { agent_id: 'sub-1' }), 'inject', ['pr-and-commit-style'], []],
  ['...and so does the next subagent', bash('s10d', 'git -C /c/repo commit -F msg.txt', { agent_id: 'sub-2' }), 'inject', ['pr-and-commit-style'], []],
  ['a deny-first rule with no subagent key blocks the main thread once', bash('s10g', 'probe-deny-cmd'), 'deny', ['probe-deny'], [], denyDir],
  ['...then a subagent of that session gets it injected, not blocked again', bash('s10g', 'probe-deny-cmd', { agent_id: 'sub-1' }), 'inject', ['probe-deny'], [], denyDir],
  ['...and the next subagent gets the inject too', bash('s10g', 'probe-deny-cmd', { agent_id: 'sub-2' }), 'inject', ['probe-deny'], [], denyDir],
  ['spend gate (kie-spend): main thread blocked first', bash('s10e', 'node scripts/kie.mjs still --prompt hero'), 'deny', ['kie-spend'], []],
  ['...a later subagent running the paid call is blocked too, not injected', bash('s10e', 'node scripts/kie.mjs still --prompt hero', { agent_id: 'sub-1' }), 'deny', ['kie-spend'], []],
  ['CMA gate: main thread blocked first', bash('s10f', 'ant sessions list'), 'deny', ['cma'], []],
  ['...a later subagent running a CMA call is blocked too, not injected', bash('s10f', 'ant sessions list', { agent_id: 'sub-1' }), 'deny', ['cma'], []],
  ['...and sees it once, not on every call', bash('s10', 'grok exec -', { agent_id: 'sub-1' }), 'none', [], []],
  ['a subagent that is first in its session still takes the block', bash('s10c', 'grok exec -', { agent_id: 'sub-1' }), 'deny', ['grok'], []],
  ['...the next subagent of that session is blocked too (gate rule)', bash('s10c', 'grok exec -', { agent_id: 'sub-2' }), 'deny', ['grok'], []],
  ['...and the main thread of that session is still blocked once', bash('s10c', 'grok exec -'), 'deny', ['grok'], []],
  ['any Agent spawn injects the delegation rule once', { session_id: 's36', tool_name: 'Agent', tool_input: { subagent_type: 'scout' } }, 'inject', ['delegation'], ['grok']],
  ['...and not again in the same session', { session_id: 's36', tool_name: 'Agent', tool_input: { subagent_type: 'kraken' } }, 'none', [], []],
  ['harness-update skill injects', { session_id: 's11', tool_name: 'Skill', tool_input: { skill: 'harness-update' } }, 'inject', ['harness-update'], []],
  ['Neon MCP tool injects neonctl rule', { session_id: 's12', tool_name: 'mcp__Neon__delete_branch', tool_input: {} }, 'inject', ['neonctl'], []],
  ['psql via docker exec injects the DB rule', bash('s13', 'docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c "SELECT 1"'), 'inject', ['cross-terminal-db'], []],
  ['headless claude -p injects', bash('s14', 'claude -p "hi" --output-format json'), 'inject', ['headless-claude'], []],
  ['CMA API URL blocks', bash('s15', 'curl -s https://api.anthropic.com/v1/sessions -H "x"'), 'deny', ['cma'], []],
  ['CMA call with a key in its header blocks (log checked below)', bash('s15b', 'curl -s -H x-api-key:SECRET-PROBE-123 https://api.anthropic.com/v1/sessions'), 'deny', ['cma'], []],
  ['a rule file that cannot be read: fail open', bash('s18', 'grok exec -'), 'none', [], [], brokenDir],
  ['...and the claim is released, so the rule still shows later', bash('s18', 'grok exec -'), 'deny', ['grok'], []],
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
  // Re-arm (2026-10-03): /compact drops the rule texts from context, so SessionStart with source
  // compact or clear must let the main agent's rules fire again. Subagents and other sessions keep theirs.
  ['re-arm: grok blocks in session r1', bash('r1', 'grok exec -'), 'deny', ['grok'], []],
  ['re-arm: a subagent of r1 is blocked too (gate rule)', bash('r1', 'grok exec -', { agent_id: 'sub-r1' }), 'deny', ['grok'], []],
  ['re-arm: grok blocks in session r2', bash('r2', 'grok exec -'), 'deny', ['grok'], []],
  ['re-arm: SessionStart startup emits nothing', { session_id: 'r1', hook_event_name: 'SessionStart', source: 'startup' }, 'none', [], []],
  ['...and does not re-arm', bash('r1', 'grok exec -'), 'none', [], []],
  ['re-arm: SessionStart compact emits nothing', { session_id: 'r1', hook_event_name: 'SessionStart', source: 'compact' }, 'none', [], []],
  ['...then grok blocks again after /compact', bash('r1', 'grok exec -'), 'deny', ['grok'], []],
  ['...but the subagent of r1 keeps its markers', bash('r1', 'grok exec -', { agent_id: 'sub-r1' }), 'none', [], []],
  ['...and session r2 keeps its markers', bash('r2', 'grok exec -'), 'none', [], []],
  ['re-arm: SessionStart clear re-arms too', { session_id: 'r1', hook_event_name: 'SessionStart', source: 'clear' }, 'none', [], []],
  ['...then grok blocks again after /clear', bash('r1', 'grok exec -'), 'deny', ['grok'], []],
  ['free kie.ai probe does not block', bash('s21', 'node scripts/kie.mjs probe'), 'none', [], []],
  ['a claude-in-chrome tool blocks (deprecated)', { session_id: 's22', tool_name: 'mcp__claude-in-chrome__navigate', tool_input: {} }, 'deny', ['browser-deprecated'], ['browser']],
  ['Playwright MCP injects the browser rule', { session_id: 's23', tool_name: 'mcp__playwright__browser_navigate', tool_input: {} }, 'inject', ['browser'], []],
  ['WebFetch injects opencli-first', { session_id: 's24', tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, 'inject', ['opencli'], []],
  ['playground deploy.py injects the Fabric playbook', bash('s40', 'python docs/playground/deploy.py preflight'), 'inject', ['fabric'], []],
  ['...and not again in the same session', bash('s40', 'python docs/playground/fabric/iq.py graph-check --all'), 'none', [], []],
  ['a quoted Windows path to iq.py injects', ps('s41', 'python "C:\\Users\\x\\Projects\\FourthCompanyBrain\\docs\\playground\\fabric\\iq.py" graph-check'), 'inject', ['fabric'], []],
  ['az rest to the Fabric API injects', bash('s42', 'az rest --method get --url "https://api.fabric.microsoft.com/v1/workspaces" --resource https://api.fabric.microsoft.com'), 'inject', ['fabric'], []],
  ['curl to OneLake injects', bash('s43', 'curl -s -H "Authorization: Bearer $T" "https://onelake.dfs.fabric.microsoft.com/ws/lh/Files?resource=filesystem"'), 'inject', ['fabric'], []],
  ['a Fabric subagent gets its own copy', bash('s40', 'python docs/playground/deploy.py status', { agent_id: 'sub-fabric' }), 'inject', ['fabric'], []],
  ['an echo of a Fabric URL does not claim the playbook', bash('s44', 'echo "az rest --url https://api.fabric.microsoft.com"'), 'none', [], []],
  ['another repo deploy.py is not Fabric', bash('s45', 'python scripts/deploy.py --prod'), 'none', [], []],
  // Skill intake Phase 1 (2026-10-02): the playbook also loads on the Fabric hub skill, sqlcmd to a Fabric host,
  // the Kusto-on-Fabric host and ARM capacity calls. Kusto's rule also loads on /v1/rest/mgmt.
  ['the fabric hub skill injects the playbook', { session_id: 's46', tool_name: 'Skill', tool_input: { skill: 'fabric' } }, 'inject', ['fabric'], []],
  ['a fabric-* skill injects the playbook', { session_id: 's47', tool_name: 'Skill', tool_input: { skill: 'fabric-data-agent' } }, 'inject', ['fabric'], []],
  ['a plugin-qualified fabric skill injects the playbook', { session_id: 's48', tool_name: 'Skill', tool_input: { skill: 'skills-for-fabric:fabric' } }, 'inject', ['fabric'], []],
  ['a skill that only starts with the letters fabric is not Fabric', { session_id: 's49', tool_name: 'Skill', tool_input: { skill: 'fabricate-docs' } }, 'none', [], []],
  ['sqlcmd to a Fabric SQL endpoint injects', bash('s50', 'sqlcmd -S "abc123.datawarehouse.fabric.microsoft.com" -d wh -G -Q "select 1"'), 'inject', ['fabric'], []],
  ['sqlcmd to a local SQL Server is not Fabric', bash('s51', 'sqlcmd -S localhost -d master -Q "select 1"'), 'none', [], []],
  ['az rest to the Fabric Kusto host injects Fabric and Kusto', bash('s52', 'az rest --method post --url "https://q1.z0.kusto.fabric.microsoft.com/v1/rest/mgmt" --body @cmd.json'), 'inject', ['fabric', 'kusto'], []],
  ['curl to a Kusto mgmt endpoint injects Kusto, not Fabric', bash('s53', 'curl -s -X POST -H "Authorization: Bearer $T" "https://c1.westeurope.kusto.windows.net/v1/rest/mgmt" -d @cmd.json'), 'inject', ['kusto'], ['fabric']],
  ['Invoke-RestMethod to the Fabric Kusto host injects Fabric and Kusto', ps('s54', 'Invoke-RestMethod -Method Post -Uri "https://q1.z0.kusto.fabric.microsoft.com/v1/rest/query" -Headers $h'), 'inject', ['fabric', 'kusto'], []],
  ['az rest to an ARM Fabric capacity injects the playbook', bash('s55', 'az rest --method get --url "https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.Fabric/capacities/c1?api-version=2023-11-01"'), 'inject', ['fabric'], []],
  ['az rest to a non-Fabric ARM resource is not Fabric', bash('s56', 'az rest --method get --url "https://management.azure.com/subscriptions/s/providers/Microsoft.Web/sites?api-version=2023-01-01"'), 'none', [], []],
  ['az fabric capacity show injects the playbook', bash('s57', 'az fabric capacity show --capacity-name c1 --resource-group rg'), 'inject', ['fabric'], []],
  ['an echo of a sqlcmd Fabric call does not claim the playbook', bash('s58', 'echo "sqlcmd -S x.datawarehouse.fabric.microsoft.com"'), 'none', [], []],
  // Round 2 (critic on PR #80): spellings and lead-ins the first regexes missed.
  ['$r = Invoke-RestMethod to the Fabric API injects', ps('s60', '$r = Invoke-RestMethod -Uri "https://api.fabric.microsoft.com/v1/workspaces" -Headers $h'), 'inject', ['fabric'], []],
  ['irm to OneLake injects', ps('s61', 'irm -Uri "https://onelake.dfs.fabric.microsoft.com/ws/lh/Files" -Headers $h'), 'inject', ['fabric'], []],
  ['iwr to the Fabric API injects', ps('s62', 'iwr "https://api.fabric.microsoft.com/v1/capacities"'), 'inject', ['fabric'], []],
  ['a lowercase cmdlet injects', ps('s63', 'invoke-restmethod -uri "https://api.fabric.microsoft.com/v1/workspaces"'), 'inject', ['fabric'], []],
  ['a call inside try { } injects', ps('s64', 'try { Invoke-RestMethod -Uri "https://api.fabric.microsoft.com/v1/workspaces" } catch { }'), 'inject', ['fabric'], []],
  ['a host-less az rest ARM path with Microsoft.Fabric injects', bash('s65', 'az rest --method get --url "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Fabric/capacities/c1?api-version=2023-11-01"'), 'inject', ['fabric'], []],
  ['Invoke-AzRestMethod with a Microsoft.Fabric path injects', ps('s66', 'Invoke-AzRestMethod -Path "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Fabric/capacities/c1?api-version=2023-11-01" -Method GET'), 'inject', ['fabric'], []],
  ['az resource on Microsoft.Fabric injects', bash('s67', 'az resource show --ids /subscriptions/s/resourceGroups/rg/providers/Microsoft.Fabric/capacities/c1'), 'inject', ['fabric'], []],
  ['az resource on a non-Fabric type is not Fabric', bash('s68', 'az resource list --resource-type Microsoft.Web/sites'), 'none', [], []],
  ['an Az.Fabric cmdlet injects', ps('s69', 'Get-AzFabricCapacity -ResourceGroupName rg'), 'inject', ['fabric'], []],
  ['a lowercase kusto-host call with $r = injects Kusto', ps('s70', '$r = invoke-restmethod -uri "https://q1.z0.kusto.fabric.microsoft.com/v1/rest/mgmt"'), 'inject', ['kusto'], []],
  ['a hub skill under any plugin prefix injects', { session_id: 's71', tool_name: 'Skill', tool_input: { skill: 'acme:fabric' } }, 'inject', ['fabric'], []],
  ['fabric-ai-* injects', { session_id: 's72', tool_name: 'Skill', tool_input: { skill: 'fabric-ai-functions' } }, 'inject', ['fabric'], []],
  ['any skills-for-fabric:* skill injects', { session_id: 's73', tool_name: 'Skill', tool_input: { skill: 'skills-for-fabric:spark-cli' } }, 'inject', ['fabric'], []],
  ['the fabric.js library skill is not Fabric (pins the decision)', { session_id: 's74', tool_name: 'Skill', tool_input: { skill: 'fabric-js' } }, 'none', [], []],
  // Round 3 (CodeRabbit): only the sqlcmd SERVER argument names the Fabric host.
  ['sqlcmd to local SQL Server with the host name only in the query text is not Fabric', bash('s76', 'sqlcmd -S localhost -d master -Q "select \'fabric.microsoft.com\'"'), 'none', [], []],
  ['sqlcmd -S:<fabric host> injects', bash('s77', 'sqlcmd -S:abc123.datawarehouse.fabric.microsoft.com -d wh -G -Q "select 1"'), 'inject', ['fabric'], []],
  ['sqlcmd --server "tcp:<fabric host>,1433" injects', bash('s78', 'sqlcmd --server "tcp:abc123.database.fabric.microsoft.com,1433" -d db -G -Q "select 1"'), 'inject', ['fabric'], []],
  ['fabric-of-the-app is not Fabric (pins the decision)', { session_id: 's75', tool_name: 'Skill', tool_input: { skill: 'fabric-of-the-app' } }, 'none', [], []],
  // Review M2 (FourthCompanyBrain, 2026-10-04): the other ways a session runs the playground scripts.
  ['uv run python on deploy.py injects', bash('s79', 'uv run python docs/playground/deploy.py preflight'), 'inject', ['fabric'], []],
  ['py -3.12 on iq.py injects', ps('s80', 'py -3.12 docs\\playground\\fabric\\iq.py graph-check'), 'inject', ['fabric'], []],
  ['python -m on the playground package injects', bash('s81', 'python -m docs.playground.deploy status'), 'inject', ['fabric'], []],
  ['cd into the playground, then python deploy.py, injects', ps('s82', 'cd docs/playground; python deploy.py preflight'), 'inject', ['fabric'], []],
  ['Set-Location to a quoted playground path injects', ps('s83', 'Set-Location "C:\\Users\\x\\Projects\\FourthCompanyBrain\\docs\\playground"; python access.py list'), 'inject', ['fabric'], []],
  ['runner_sp.py from any folder injects', ps('s84', 'python runner_sp.py --job nightly'), 'inject', ['fabric'], []],
  ['python3 with a quoted path to access.py injects', bash('s85', 'python3 "docs/playground/access.py" show'), 'inject', ['fabric'], []],
  ['uv run python on another repo deploy.py is not Fabric', bash('s86', 'uv run python scripts/deploy.py --prod'), 'none', [], []],
  ['cd into a folder named playground outside docs is not Fabric', bash('s87', 'cd web/playground && npm test'), 'none', [], []],
  ['an echo of runner_sp.py is not Fabric', bash('s88', 'echo runner_sp.py'), 'none', [], []],
  // Critic round 1 on PR #97: an interpreter by path, uv run flags with a value, interpreter flags, case.
  ['a venv python.exe on deploy.py injects', ps('s89', '.venv\\Scripts\\python.exe docs\\playground\\deploy.py preflight'), 'inject', ['fabric'], []],
  ['& "C:\\Python312\\python.exe" on iq.py injects', ps('s90', '& "C:\\Python312\\python.exe" docs\\playground\\fabric\\iq.py graph-check'), 'inject', ['fabric'], []],
  ['uv run --with x python on deploy.py injects', bash('s91', 'uv run --with httpx python docs/playground/deploy.py status'), 'inject', ['fabric'], []],
  ['python -u on deploy.py injects', bash('s92', 'python -u docs/playground/deploy.py preflight'), 'inject', ['fabric'], []],
  ['Python in capitals on deploy.py injects', ps('s93', 'Python docs/playground/deploy.py preflight'), 'inject', ['fabric'], []],
  // Greptile #155: the router strips npx before it matches, so the install trigger must match the rest.
  ['npx skills add coderabbitai/skills injects the CodeRabbit rule', bash('s94', 'npx skills add coderabbitai/skills'), 'inject', ['coderabbit-cli'], []],
  ['skills add coderabbitai/skills (no npx) injects the CodeRabbit rule', bash('s95', 'skills add coderabbitai/skills -g'), 'inject', ['coderabbit-cli'], []],
  ['npx skills add of another package does not claim the CodeRabbit rule', bash('s96', 'npx skills add vercel-labs/skills'), 'none', [], ['coderabbit-cli']],
  // PR D review C11: a cr-fix.mjs run is a CodeRabbit step of the review loop, so both rules load.
  ['node cr-fix.mjs injects the review loop rule and the CodeRabbit rule', bash('s97', 'node scripts/github/cr-fix.mjs 221 --json'), 'inject', ['pr-review-loop', 'coderabbit-cli'], []],
  // Paid-review policy (Dave, 2026-10-30): a cr-paid.mjs run loads both rules, in a pipeline segment too.
  ['node cr-paid.mjs injects the review loop rule and the CodeRabbit rule', bash('s98', 'node scripts/github/cr-paid.mjs check --pr 225 --json'), 'inject', ['pr-review-loop', 'coderabbit-cli'], []],
  ['cr-paid.mjs after a cd injects both rules', bash('s99', 'cd scripts && node github/cr-paid.mjs record --pr 225 --head abc1234 --files 3'), 'inject', ['pr-review-loop', 'coderabbit-cli'], []],
  // Review-engine program (coord-program-rule): the first claim of a program lane blocks once with the ten rules.
  ['lane.mjs claim of a re- lane blocks once with the review-engine rule', bash('s100', 'node C:/Users/dkhay/.claude/scripts/lane.mjs claim re-land-ledger --note "claimed"'), 'deny', ['review-engine'], []],
  ['unrelated command: nothing', bash('s16', 'git status --short'), 'none', [], []],
  ['missing manifest fails open', bash('s17', 'grok exec -'), 'none', [], [], join(state, 'no-such-dir')],
];

const results = CASES.map(([name, payload, kind, must, mustNot, dir]) => {
  let got;
  try { got = fire(payload, dir); } catch (e) { got = { kind: 'error', text: String(e.message) }; }
  const idsLine = (got.text.match(/\(([^)]*)\)/) || [, ''])[1];
  const ok = got.kind === kind && must.every((id) => idsLine.split(', ').includes(id)) && mustNot.every((id) => !idsLine.split(', ').includes(id));
  return { name, ok, expected: kind, got: got.kind, ids: idsLine };
});

// Parallel tool calls: 6 processes race for the same unseen rule; exactly one may emit it.
const race = await fireParallel(bash('race', 'grok exec -'), 6);
const raceDenies = race.filter((r) => r.kind === 'deny').length;
results.push({ name: '6 parallel calls for one unseen rule: exactly 1 deny', ok: raceDenies === 1, expected: '1 deny', got: `${raceDenies} deny`, ids: '' });
// The fire log must never hold the raw command (it can carry a credential).
const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
results.push({ name: 'fire log never contains command arguments', ok: logText.length > 0 && !logText.includes('SECRET-PROBE-123'), expected: 'no secret', got: logText.includes('SECRET-PROBE-123') ? 'secret logged' : 'clean', ids: '' });

// The log must name the segment that fired, not the first segment (`$R=...` told an audit nothing).
const s35 = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.session === 's35');
results.push({ name: 'fire log names the segment and script that fired', ok: s35?.what === 'pwsh -File land-pr.ps1', expected: 'pwsh -File land-pr.ps1', got: String(s35?.what), ids: '' });
// A credential in the second word (a connection URL) is replaced, and the identity matches the claim key.
const s37 = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.session === 's37-full-session-id');
results.push({ name: 'a URL credential never reaches the log', ok: s37?.what === 'psql <arg>' && !logText.includes('PWPROBE'), expected: 'psql <arg>', got: String(s37?.what), ids: '' });
const rearmRow = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.session === 'r1' && e.kind === 'rearm' && e.source === 'compact');
results.push({ name: 'a re-arm is logged with its source and marker count', ok: rearmRow?.removed === 1 && rearmRow?.what === 'SessionStart compact', expected: 'removed 1, SessionStart compact', got: rearmRow ? `removed ${rearmRow.removed}, ${rearmRow.what}` : 'missing', ids: '' });
results.push({ name: 'the log keeps the full session id and the agent', ok: s37?.agent === 'main', expected: 'full id, agent main', got: s37 ? `${s37.session} / ${s37.agent}` : 'missing', ids: '' });

// A session that sees a rule fire on the wrong call must be told how to record it.
const footer = fire(bash('s38', 'psql -c "select 1"'));
results.push({ name: 'every fired rule carries the record-a-false-fire line', ok: footer.text.includes('rule-router-false-fires.mjs add') && footer.text.includes('--source agent'), expected: 'footer present', got: footer.kind, ids: '' });

const fires = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
const failed = results.filter((r) => !r.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ cases: results.length, failed: failed.length, fires, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.got}${r.ids ? ': ' + r.ids : ''}]`);
  console.log(`\nrule-router probe: ${results.length - failed.length}/${results.length} pass, ${fires} fires logged`);
}
process.exit(failed.length ? 1 : 0);
