import { describe, expect, test } from 'claude-code/testing'

import {
  JOURNAL_MAX_BYTES,
  LABEL_MAX,
  PHASE_MAX,
  journalPath,
  parseJournal,
  parseRunFile,
  projectSlug,
  runFilePath,
  workflowFeed,
} from '../hooks/agentic-os/journal-model'

// The workflow journal behind the Swarm tab (design 4b, Dave 2026-10-30): hooks/agentic-os/journal-model.ts, pure, no engine.
//   parseJournal(text, runId)       journal.jsonl -> WorkflowFeed | null
//   parseRunFile(text, runId)       workflows/wf_<id>.json (written when the run ends) -> { name, total } | null
//   workflowFeed(runId, journal, runFile)   both texts, either may be null -> WorkflowFeed | null
//   projectSlug, journalPath, runFilePath   where the two files live
//
// Contract, measured on the real files of 2026-10-30 (the design assumed the wf json shape for the journal; it is wrong):
//   - journal.jsonl is one JSON object per line: `{type:'launched'}`, `{type:'started', key, agentId, label, phase}` and
//     `{type:'result', key, agentId, result, toolsUsed}`. It holds no run id, no workflow name, no phase index and no total.
//   - So the run id comes from the folder name, the phase index is the order of first appearance of a phase title (from 1), the total is null,
//     and the name is null. The current phase is the highest index seen. Only `started` lines are read, and only agentId, label and phase.
//   - The run file adds the name (`workflowName`) and the phase total (`phases.length`). Its `workflowProgress` entries hold the prompt and
//     result previews: they are never read.
//
// Ways the parser can fail, one test each:
// J1 bad JSON, or a line that is not an object, makes the feed null or throws; one bad line hides the good ones around it
// J2 a run id that is not `wf_<id>` (empty, a path, not a string), or a run file of another run, is taken
// J3 a started line missing its agentId, label or phase, or an unsafe agent id (`__proto__`), breaks the feed or pollutes the record
// J4 a text over the size cap is parsed
// J5 a prompt or result preview, a result, a key or the tools used reach the feed
// J6 no journal and no run file make a feed, or a path leaves the project folder (a session or run id with `..`), or the slug rule is wrong
// J7 the phase index is not the order of first appearance from 1, the total is invented, or the current phase is not the highest seen
// J8 a label is not stored by agent id, keeps a secret, or is not clipped
// J9 the run file gives a wrong name or total, a secret survives in the name, or it makes a phase out of nothing

const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const KEY = 'k'.repeat(67)

const jl = (...lines: unknown[]): string => lines.map(one => JSON.stringify(one)).join('\n') + '\n'
const started = (agentId: string, label: string, phase: string, extra: Record<string, unknown> = {}) => ({ type: 'started', key: KEY, agentId, label, phase, ...extra })
const result = (agentId: string, extra: Record<string, unknown> = {}) => ({ type: 'result', key: KEY, agentId, result: { ok: true }, toolsUsed: ['Read'], ...extra })

/** The shape of a real two-phase run: two agents in One, one in Two. */
const REAL = jl(
  { type: 'launched' },
  started('ad988de746e788bc6', 'probe-one-0', 'One'),
  started('a7ff789132b6b731f', 'probe-one-1', 'One'),
  result('ad988de746e788bc6'),
  result('a7ff789132b6b731f'),
  started('a4607619f3368de34', 'probe-two', 'Two'),
  result('a4607619f3368de34'),
)

describe('journal model', () => {
  test('J7 the phase index counts the phase titles in order of first appearance from 1; the current phase is the highest; the total stays null', () => {
    const feed = parseJournal(REAL, 'wf_1772dc8b-fcd')
    expect(feed).not.toBeNull()
    expect(feed?.runId).toBe('wf_1772dc8b-fcd')
    expect(feed?.agentPhases).toEqual({ ad988de746e788bc6: 1, a7ff789132b6b731f: 1, a4607619f3368de34: 2 })
    expect(feed?.phase).toEqual({ index: 2, total: null, title: 'Two' })
    expect(feed?.name).toBeNull()
  })

  test('J7 a phase title that comes back later keeps its first index, and the current phase is still the highest', () => {
    const feed = parseJournal(jl(started('a1', 'm', 'Map'), started('a2', 'j', 'Judge'), started('a3', 'm2', 'Map')), 'wf_1')
    expect(feed?.agentPhases).toEqual({ a1: 1, a2: 2, a3: 1 })
    expect(feed?.phase).toEqual({ index: 2, total: null, title: 'Judge' })
  })

  test('J8 each label is stored under its agent id; two agents with one label stay apart; a retry of an agent id keeps the last label', () => {
    const feed = parseJournal(jl(started('a1', 'same', 'One'), started('a2', 'same', 'One'), started('a3', 'first', 'One'), started('a3', 'retry', 'One')), 'wf_1')
    expect(feed?.labels).toEqual({ a1: 'same', a2: 'same', a3: 'retry' })
  })

  test('J8 a label with a secret is redacted before it is clipped, and a 5,000-character label or phase is clipped', () => {
    const feed = parseJournal(jl(started('a1', `x ${SECRET}`, `p ${SECRET}`), started('a2', 'L'.repeat(5000), 'P'.repeat(5000))), 'wf_1')
    const text = JSON.stringify(feed)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('a'.repeat(20))
    expect(feed?.labels.a2?.length).toBeLessThanOrEqual(LABEL_MAX)
    expect(feed?.labels.a2?.endsWith('…')).toBe(true)
    expect(feed?.phase?.title?.length).toBeLessThanOrEqual(PHASE_MAX)
  })

  test('J8 a label with a line break or a control character reads as one line', () => {
    const feed = parseJournal(jl(started('a1', 'two\nlines\u0007here', 'One')), 'wf_1')
    expect(feed?.labels.a1).toBe('two lines here')
  })

  test('J1 bad JSON, a half line, and lines that are not objects make no feed, and never throw', () => {
    for (const text of ['', '\n\n', 'not json', '{"type":', '[1,2]\nnull\n7\n"x"\n', '{']) expect(parseJournal(text, 'wf_1'), JSON.stringify(text)).toBeNull()
  })

  test('J1 a bad line between good ones is skipped: the good lines still count', () => {
    const feed = parseJournal(`${JSON.stringify(started('a1', 'one', 'One'))}\nnot json\n[]\nnull\n${JSON.stringify(started('a2', 'two', 'Two'))}\n{"type":`, 'wf_1')
    expect(feed?.labels).toEqual({ a1: 'one', a2: 'two' })
    expect(feed?.phase?.index).toBe(2)
  })

  test('J1 a journal with no started line (only launched and results) makes no feed', () => {
    expect(parseJournal(jl({ type: 'launched' }, result('a1')), 'wf_1')).toBeNull()
  })

  test('J2 a run id that is not wf_<id> is refused, so no feed is made for it', () => {
    for (const bad of ['', 'x', 'wf_', '../../etc/passwd', 'wf_../x', 'wf_a/b', 'wf_a\\b', ' wf_1', 'wf_1 ', 'WF_1', 'wf_' + 'a'.repeat(100)]) expect(parseJournal(REAL, bad), bad).toBeNull()
    for (const bad of [undefined, null, 7, {}, []]) expect(parseJournal(REAL, bad as never)).toBeNull()
  })

  test('J2 a run file of another run id is not taken', () => {
    const file = JSON.stringify({ runId: 'wf_other', workflowName: 'other-run', phases: [{ title: 'A' }] })
    expect(parseRunFile(file, 'wf_1')).toBeNull()
    expect(parseRunFile(file, 'wf_other')).toEqual({ name: 'other-run', total: 1 })
  })

  test('J3 a started line without an agent id, a label or a phase is skipped for what it lacks; the others still count', () => {
    const feed = parseJournal(
      jl(
        { type: 'started', key: KEY, label: 'no id', phase: 'One' },
        { type: 'started', key: KEY, agentId: 'a2', phase: 'One' },
        { type: 'started', key: KEY, agentId: 'a3', label: 'no phase' },
        { type: 'started', key: KEY, agentId: 7, label: 'num id', phase: 'One' },
        { type: 'started', key: KEY, agentId: 'a5', label: 7, phase: 'One' },
        { type: 'started', key: KEY, agentId: 'a6', label: '   ', phase: '  ' },
        started('a7', 'good', 'One'),
        { type: 7, agentId: 'a8', label: 'odd type', phase: 'One' },
        { agentId: 'a9', label: 'no type', phase: 'One' },
      ),
      'wf_1',
    )
    expect(feed?.labels).toEqual({ a3: 'no phase', a7: 'good' })
    expect(feed?.agentPhases).toEqual({ a2: 1, a5: 1, a7: 1 })
  })

  test('J3 an agent id such as __proto__ or constructor is refused: no prototype is changed, no key reads as an own value', () => {
    const feed = parseJournal(
      `{"type":"started","key":"k","agentId":"__proto__","label":"evil","phase":"One"}\n{"type":"started","key":"k","agentId":"constructor","label":"evil2","phase":"One"}\n${JSON.stringify(started('a1', 'ok', 'One'))}\n`,
      'wf_1',
    )
    expect(feed?.labels).toEqual({ a1: 'ok' })
    expect(Object.getPrototypeOf(feed?.labels)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).label).toBeUndefined()
    expect(Object.hasOwn(feed?.labels ?? {}, 'constructor')).toBe(false)
  })

  test('J4 a text over the size cap is not parsed, one at the cap is', () => {
    const line = JSON.stringify(started('a1', 'one', 'One'))
    const fill = (size: number): string => `${line}\n${' '.repeat(size - line.length - 1)}`
    expect(fill(JOURNAL_MAX_BYTES).length).toBe(JOURNAL_MAX_BYTES)
    expect(parseJournal(fill(JOURNAL_MAX_BYTES), 'wf_1')?.labels).toEqual({ a1: 'one' })
    expect(parseJournal(fill(JOURNAL_MAX_BYTES + 1), 'wf_1')).toBeNull()
    expect(parseRunFile(`{"runId":"wf_1","workflowName":"n"}${' '.repeat(JOURNAL_MAX_BYTES)}`, 'wf_1')).toBeNull()
  })

  test('J4 a journal of thousands of started lines keeps a bounded feed', () => {
    const many = jl(...Array.from({ length: 5000 }, (_, i) => started(`a${i}`, `label ${i}`, `Phase ${i}`)))
    const feed = parseJournal(many, 'wf_1')
    expect(Object.keys(feed?.labels ?? {}).length).toBeLessThanOrEqual(500)
    expect(Object.keys(feed?.agentPhases ?? {}).length).toBeLessThanOrEqual(500)
  })

  test('J5 a prompt or result preview, a result, a key and the tools used never reach the feed', () => {
    const feed = parseJournal(
      jl(
        started('a1', 'one', 'One', { promptPreview: 'PROMPT-LEAK', prompt: 'PROMPT-LEAK', resultPreview: 'RESULT-LEAK', model: 'MODEL-LEAK' }),
        result('a1', { result: { summary: 'RESULT-LEAK', findings: [{ claim: 'RESULT-LEAK' }] }, toolsUsed: ['TOOL-LEAK'], resultPreview: 'RESULT-LEAK' }),
      ),
      'wf_1',
    )
    const text = JSON.stringify(feed)
    expect(text).toContain('one')
    for (const leak of ['PROMPT-LEAK', 'RESULT-LEAK', 'TOOL-LEAK', 'MODEL-LEAK', KEY]) expect(text).not.toContain(leak)
    // A started line with no label of its own never borrows the prompt, the model or the key as one.
    const bare = parseJournal(jl({ type: 'started', key: KEY, agentId: 'a2', phase: 'One', promptPreview: 'PROMPT-LEAK', prompt: 'PROMPT-LEAK', model: 'MODEL-LEAK', result: 'RESULT-LEAK' }), 'wf_1')
    expect(bare?.labels).toEqual({})
    expect(JSON.stringify(bare)).not.toMatch(/PROMPT-LEAK|MODEL-LEAK|RESULT-LEAK/)
    expect(Object.keys(feed ?? {}).sort()).toEqual(['agentPhases', 'labels', 'name', 'phase', 'runId'])
  })

  test('J5 the run file gives its name and total only: workflowProgress previews, phase details, the script and the result stay out', () => {
    const file = JSON.stringify({
      runId: 'wf_1',
      workflowName: 'pane-assess',
      status: 'completed',
      script: 'SCRIPT-LEAK',
      result: 'RESULT-LEAK',
      summary: 'RESULT-LEAK',
      phases: [{ title: 'One', detail: 'DETAIL-LEAK' }, { title: 'Two', detail: 'DETAIL-LEAK' }],
      workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', promptPreview: 'PROMPT-LEAK', resultPreview: 'RESULT-LEAK' }],
    })
    const meta = parseRunFile(file, 'wf_1')
    expect(meta).toEqual({ name: 'pane-assess', total: 2 })
    const text = JSON.stringify(workflowFeed('wf_1', REAL, file))
    for (const leak of ['PROMPT-LEAK', 'RESULT-LEAK', 'DETAIL-LEAK', 'SCRIPT-LEAK']) expect(text).not.toContain(leak)
  })

  test('J6 no journal and no run file make no feed; a journal alone, or a run file alone, make one', () => {
    expect(workflowFeed('wf_1', null, null)).toBeNull()
    expect(workflowFeed('wf_1', '', '')).toBeNull()
    expect(workflowFeed('wf_1', 'garbage', 'garbage')).toBeNull()
    expect(workflowFeed('wf_1', REAL, null)?.phase?.index).toBe(2)
    expect(workflowFeed('wf_1', null, JSON.stringify({ runId: 'wf_1', workflowName: 'solo', phases: [{ title: 'A' }] }))).toEqual({
      runId: 'wf_1',
      name: 'solo',
      phase: null,
      labels: {},
      agentPhases: {},
    })
  })

  test('J6 the project folder is the path with every character that is not a letter or digit turned into a hyphen', () => {
    expect(projectSlug('C:\\Users\\dkhay\\continuous-claude')).toBe('C--Users-dkhay-continuous-claude')
    expect(projectSlug('C:\\Users\\dkhay\\continuous-claude\\.claude\\worktrees\\cp-mod')).toBe('C--Users-dkhay-continuous-claude--claude-worktrees-cp-mod')
    expect(projectSlug('/home/me/.claude/wt')).toBe('-home-me--claude-wt')
    expect(projectSlug('C:/r')).toBe('C--r')
  })

  test('J6 the two paths sit under the session folder; a session or run id that could leave it gives no path', () => {
    expect(journalPath('C:/home', 'C--r', 's1-2', 'wf_1')).toBe('C:/home/.claude/projects/C--r/s1-2/subagents/workflows/wf_1/journal.jsonl')
    expect(runFilePath('C:/home', 'C--r', 's1-2', 'wf_1')).toBe('C:/home/.claude/projects/C--r/s1-2/workflows/wf_1.json')
    for (const [slug, session, run] of [['C--r', '..', 'wf_1'], ['C--r', 's1', '../x'], ['C--r', 's1', 'wf_1/../../x'], ['..', 's1', 'wf_1'], ['C--r', 's1/x', 'wf_1'], ['C--r', '', 'wf_1'], ['', 's1', 'wf_1']]) {
      expect(journalPath('C:/home', slug!, session!, run!), `${slug} ${session} ${run}`).toBeNull()
      expect(runFilePath('C:/home', slug!, session!, run!), `${slug} ${session} ${run}`).toBeNull()
    }
  })

  test('J9 the run file adds the name and the phase total to the journal feed; the index and title stay the journal\'s', () => {
    const file = JSON.stringify({ runId: 'wf_1', workflowName: 'swarm-journal-probe', phases: [{ title: 'One' }, { title: 'Two' }] })
    expect(workflowFeed('wf_1', REAL, file)).toMatchObject({ name: 'swarm-journal-probe', phase: { index: 2, total: 2, title: 'Two' } })
  })

  test('J9 a run file with no name, an empty name, a name that is not text, no phases or a bad shape gives no name and no total', () => {
    for (const body of [{ runId: 'wf_1' }, { runId: 'wf_1', workflowName: '', phases: [] }, { runId: 'wf_1', workflowName: 7, phases: 'x' }, { runId: 'wf_1', workflowName: '  ', phases: {} }]) {
      expect(parseRunFile(JSON.stringify(body), 'wf_1'), JSON.stringify(body)).toEqual({ name: null, total: null })
    }
    for (const text of ['', 'not json', '[]', 'null', '7', '{"runId":']) expect(parseRunFile(text, 'wf_1'), text).toBeNull()
  })

  test('J9 a secret in the run name is redacted and the name is clipped; a run with more phases than the cap gives no total', () => {
    const file = JSON.stringify({ runId: 'wf_1', workflowName: `n ${SECRET}`, phases: Array.from({ length: 5000 }, (_, i) => ({ title: `p${i}` })) })
    const meta = parseRunFile(file, 'wf_1')
    expect(JSON.stringify(meta)).not.toContain(SECRET)
    expect(meta?.total).toBeNull()
    expect(parseRunFile(JSON.stringify({ runId: 'wf_1', workflowName: 'N'.repeat(5000) }), 'wf_1')?.name?.length).toBeLessThanOrEqual(LABEL_MAX)
  })

  test('J9 the total never sits below the phase index the journal has already shown', () => {
    const file = JSON.stringify({ runId: 'wf_1', workflowName: 'w', phases: [{ title: 'One' }] })
    expect(workflowFeed('wf_1', REAL, file)?.phase).toEqual({ index: 2, total: null, title: 'Two' })
  })
})
