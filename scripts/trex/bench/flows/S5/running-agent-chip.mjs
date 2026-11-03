import { register } from 'node:module'

await register(new URL('./resolve-ts.mjs', import.meta.url), import.meta.url)
const root = new URL('../../../../../.claude/plugins/ccv3-mods/hooks/agentic-os/', import.meta.url)
const { deriveChip, applyBrief } = await import(new URL('brief.ts', root))
const { tabRows } = await import(new URL('os-tabs-model.ts', root))

const NOW = 1_000_000
const DAY = 24 * 3600_000
const die = (msg) => { console.error(msg); process.exit(1) }
const base = (over = {}) => ({ brief: null, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: NOW, activeAt: NOW, ...over })
const chip = (over) => deriveChip(base(over))
const run = (status) => ({ status })
const saved = (raw, tasks = [], at = NOW) => {
  const out = applyBrief(null, raw, tasks, at)
  if ('error' in out) die(out.error)
  return out.brief
}
const eq = (got, want, msg) => { if (got !== want) die(`${msg}: ${got}`) }

eq(chip({ agentRuns: [run('running')] }), 'working', 'idle while a subagent runs')
eq(chip({ agentRuns: [run('done'), run('running')] }), 'working', 'settled sibling hides a live run')
eq(chip({ agentRuns: [run('done'), run('failed'), run('waiting'), run('pending'), run('idle')] }), 'idle', 'a run that is not running counts as working')
eq(chip({}), 'idle', 'missing agentRuns')
const tasks = [{ id: '1', subject: 'a', status: 'completed' }]
const proved = saved({ proof: { taskId: '1', artifact: 'a' } }, tasks)
eq(chip({ brief: proved, tasks, agentRuns: [] }), 'done', 'proven work with nothing running')
eq(chip({ brief: proved, tasks, agentRuns: [run('running')] }), 'working', 'proven work while an agent runs')
const ask = { ask: [{ kind: 'question', text: 'Which branch?' }] }
eq(chip({ brief: saved(ask), agentRuns: [run('running')] }), 'waiting-on-dave', 'running agent hides a fresh ask')
eq(chip({ brief: saved(ask, [], NOW - DAY), activeAt: NOW - DAY, agentRuns: [run('running')] }), 'working', 'stale ask hides a running agent')
eq(chip({ blocked: true, agentRuns: [run('running')] }), 'blocked', 'running agent clears a refusal')
eq(chip({ brief: saved({ plan: [{ id: 'p', text: 'wait', status: 'blocked' }] }), agentRuns: [run('running')] }), 'blocked', 'running agent hides a blocked step')

const view = (agents) => ({ tasks: [], plan: null, turn: null, step: null, ctx: null, agents, lanes: null, prs: [] })
const text = (agents, name, key) => {
  const state = { view: view(agents), chip: name, brief: null, repo: null, branch: null, worktree: null, costUsd: null, activeAt: null }
  const hit = tabRows('overview', state, NOW, 100, 60).find((one) => one.key === key)
  if (!hit) die(`overview has no ${key}`)
  return [...hit.left, ...(hit.right ?? [])].map((span) => span.text).join('')
}
const scout = (id, status) => ({ id, description: 'map hooks', type: 'scout', status })
const has = (agents, name, key, yes, no, msg) => {
  const line = text(agents, name, key)
  if ((yes && !line.includes(yes)) || (no && line.includes(no))) die(`${msg}: ${line}`)
}
has([scout('a1', 'running')], 'working', 'now', '1 agent running', 'idle', 'NOW while running')
has([scout('a1', 'running')], 'working', 'ov-chip', '1 agent running', 'idle', 'chip row while running')
has([scout('a1', 'running'), scout('a2', 'running')], 'working', 'now', '2 agents running', '', 'plural')
has([], 'idle', 'now', 'idle', 'running', 'NOW with no agent')
has([scout('a1', 'waiting')], 'idle', 'now', 'idle', 'running', 'NOW while waiting')
console.log('CHIP_OK')
