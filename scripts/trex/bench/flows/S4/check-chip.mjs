import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const fail = (m) => { console.error(m); process.exit(1) }
let dir = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(dir, '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts'))) {
  const parent = dirname(dir)
  if (parent === dir) fail('repo root not found')
  dir = parent
}
const briefUrl = pathToFileURL(join(dir, '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts'))
const { deriveChip, applyBrief } = await import(briefUrl.href)
const { tabRows } = await import(new URL('./os-tabs-model.ts', briefUrl))
const NOW = 1_000_000
const DAY = 24 * 3600_000
const briefOf = (raw, tasks = []) => {
  const made = applyBrief(null, raw, tasks, NOW)
  if ('error' in made) fail(made.error)
  return made.brief
}
const task = { id: '1', subject: 'ship the pane', status: 'completed' }
const proven = briefOf({ proof: { taskId: '1', artifact: 'notes/pane.txt' } }, [task])
const ask = briefOf({ ask: [{ kind: 'question', text: 'Which branch?' }] })
const chip = (over = {}) => deriveChip({ brief: null, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: NOW, activeAt: NOW, ...over })
const eq = (n, g, w) => { if (g !== w) fail(`${n}: ${g} !== ${w}`) }
const R = (s) => ({ status: s })
eq('quiet', chip(), 'idle')
eq('running', chip({ agentRuns: [R('running')] }), 'working')
eq('mixed', chip({ agentRuns: [R('done'), R('running')] }), 'working')
eq('settled', chip({ agentRuns: [R('done'), R('failed')] }), 'idle')
eq('waiting', chip({ agentRuns: [R('waiting')] }), 'idle')
eq('proven', chip({ brief: proven, tasks: [task] }), 'done')
eq('proven-live', chip({ brief: proven, tasks: [task], agentRuns: [R('running')] }), 'working')
eq('proven-settled', chip({ brief: proven, tasks: [task], agentRuns: [R('done')] }), 'done')
eq('ask-beats-run', chip({ brief: ask, agentRuns: [R('running')] }), 'waiting-on-dave')
eq('stale-ask-yields', chip({ brief: ask, now: NOW + DAY, activeAt: NOW, agentRuns: [R('running')] }), 'working')
eq('block-beats-run', chip({ blocked: true, agentRuns: [R('running')] }), 'blocked')
eq('turn', chip({ turnActive: true }), 'working')
eq('tool', chip({ toolRunning: true }), 'working')
const agent = (id, status) => ({ id, description: 'map hooks', type: 'scout', status })
const pane = (agents, turn = null) => tabRows('overview', { view: { tasks: [], plan: null, turn, step: null, ctx: null, agents, lanes: null, prs: [] }, chip: agents.some((a) => a.status === 'running') ? 'working' : 'idle', brief: null, repo: null, branch: null, worktree: null, costUsd: null, activeAt: null }, NOW, 100, 60)
const text = (rows, key) => {
  const row = rows.find((r) => r.key === key)
  if (!row) fail(`missing ${key}`)
  return `${row.left.map((s) => s.text).join('')} ${row.right ? row.right.map((s) => s.text).join('') : ''}`.trim()
}
const live = text(pane([agent('a1', 'running')]), 'now')
const chipRow = text(pane([agent('a1', 'running')]), 'ov-chip')
const two = text(pane([agent('a1', 'running'), agent('a2', 'running')]), 'now')
const parked = text(pane([agent('a1', 'waiting')]), 'now')
const thinking = text(pane([agent('a1', 'running')], { id: 't1', startedAt: NOW - 5000 }), 'now')
if (/idle/.test(live) || !/1 agent running/.test(live)) fail(`NOW while running: ${live}`)
if (!chipRow.includes('WORKING') || /idle/i.test(chipRow)) fail(`chip row: ${chipRow}`)
if (!/2 agents running/.test(two)) fail(`plural: ${two}`)
if (!/idle/.test(parked) || /running/.test(parked)) fail(`waiting NOW: ${parked}`)
if (/agent/.test(thinking) || !/thinking/.test(thinking)) fail(`main turn NOW: ${thinking}`)
console.log('CHIP_OK')
