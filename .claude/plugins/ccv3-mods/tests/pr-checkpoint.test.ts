import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The PR Checkpoint mod (PR C, RED). Every check drives the plugin through the engine, as the model, Dave and the
// headless run do: a tool call, a /pathway command, a pane press, a Bash or Write call, a watcher tick.
// Nothing imports the module under test, so each test fails on what it names and never on a missing import.
//
// How it can fail, and the test that catches it:
// Tests marked (guard) pass today by design: they pin a pass-through or an off switch that the new code must not break.
// K0  the tool or the command is not registered (interactive or headless)
// K1  the first option is not the recommendation, its hotkey/autoFocus/primary look is wrong, or the pane opens without focus
// K1b a Dependabot author is not passed to the engine as --dependabot
// K2  Accept does not run --confirm <rec> --by default then --apply, or the work waits on a timer (decision: press work runs INLINE)
// K3  another option does not run --by dave
// K4  headless runs --confirm, --apply or gh, opens a pane, or returns no text plan
// K5  /pathway <pr> none costs a model turn (prompt.submit) or does not record; K5b accept; K5c usage text
// K6  dismiss records something   K7 wait records something   K8 a refused --confirm still applies   K9 a refused --apply loses the retry
// K10 an R0 result shows option Buttons   K11 a non-draft PR, a moved head or an unreadable PR opens the pane
// K12 a held option is pressable   K12b --json exit 3, bad JSON or a timeout opens the pane   K12c a missing body file runs the engine
// K12d the pane is not placed (isPlaced false) and nobody is told to type /pathway
// K13 lock A: a tool write to pathway.json is allowed (any spelling, NotebookEdit's notebook_path, . and .. segments)
// K13b lock B: a shell text that names pre-pr/pathway.json is allowed in warn mode, in any write form (>, cp, tee, mv, node -e, Set-Content,
//      Out-File, Copy-Item, [IO.File]::WriteAllText) or read form, or the deny spawns the CLI   K13c (Dave Q1) a bare mention (a commit message) passes
// K15 lock B: a shell ready, label or self-confirm shape is allowed in enforce mode, or a plain gh read spawns the CLI
// K15b the CLI gets the whole command (SKIP_PRE_PR_GATE prefix, PowerShell backtick continuation) and the right --shell
// K16 lock B: a label add with no store record for HEAD, another label, another head or ANOTHER PR NUMBER is allowed
// K17 lock B in warn mode denies, or toasts more than once per pattern; a non-boolean enforce enforces
// K18 a failing shapes CLI after a prefilter hit allows the command   K19 a throw inside a lock hook lets the command run
// K19b outside a CCv3 root the lock denies or spawns (pass-through)
// K19c a foreign -R, GH_REPO or a CLI that says ccv3:false lifts the lock in a CCv3 root (the checkout decides, as in the PR B gate)
// K19d a compound command, a non-literal -R, or a CLI that says ccv3:true is let through in a CCv3 root (the lock reads no -R and no repo itself)
// K19e a failing fs.exists or session.root after a prefilter hit allows the command (the root lookup swallowed its error and passed)
// K9b  a throw after --confirm (store.set) leaves the pane on "Running" with no option Buttons   K1c a held recommendation still marks a Button Recommended
// A2e  a late Yes posts a review request on a merged PR or on a head that moved
// The command name: the module registers COMMAND, a word Claude Code does not ship (validate refuses "/checkpoint"); K0, K0b, K22, A4 and slash() read it.
// K21 the model is not told the outcome (session.append row), or the tell costs a turn
// K22 the kill switches (CCV3_MODS_OFF, CCV3_PR_CHECKPOINT_OFF) leave a tool, command or lock behind
// A1  the round ask: text, order (No first), count from the stored capacity, grant on Yes, decline on No, no post
// A2  the opening ask: 30 minutes, Yes first, exactly one @coderabbitai review on Yes   A2d No on the opening ask posts nothing and is not asked twice
// A2b no opening ask at 29 minutes, the ask at 30   A2f no opening ask while the CodeRabbit status is pending
// A3  the Greptile ask: once, No first   A1-A3 first button: hotkey 1, autoFocus, primary look, "(Recommended)"
// A5  a second press of Yes while the first still posts spends a second review (one gh pr comment per press, for the opening and the Greptile ask)
// K2b a second press of an option while the first still records runs the engine twice
// A4  an ask with isPlaced false gives a toast and "type /pathway", and /pathway draws it
// Choices that these tests pin and Dave may change are listed in prC-red.md, section "Choices for Dave".

const SESSION = 'test-session'
const ROOT = 'C:/r'
const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)
const TOOL = 'mcp__ccv3-mods__pr_checkpoint'
// The command Dave types. `claude plugin validate` 2.1.312 refuses "/checkpoint" (a name Claude Code ships), so the module registers this word.
const COMMAND = 'pathway'
const MIN = 60_000
const TICK = 300_000
const NOW = 1_000_000
const REPO = 'Rev4nchist/Continuous-Claude-v3'
const ENGINE = `${ROOT}/scripts/github/pr-checkpoint.mjs`
const SHAPES_CLI = `${ROOT}/.claude/hooks/dist/checkpoint-shapes-cli.mjs`
const CONFIG = `${ROOT}/review-router.config.json`
const PENDING = `checkpoint:pending:${SESSION}`
const ASKS = `checkpoint:asks:${SESSION}`
const WATCH = `pr-watch:${SESSION}`

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | 'throw'
type Option = { pathway: string; label: string | null; available: boolean; cost: [number, number]; reason: string }
type Rec = Record<string, unknown>

const option = (pathway: string, over: Partial<Option> = {}): Option => ({
  pathway,
  label: pathway === 'none' ? 'review:none' : pathway === 'both' ? 'review:deep' : pathway === 'wait' ? null : `review:${pathway}`,
  available: true,
  cost: pathway === 'none' || pathway === 'wait' ? [0, 0] : [1, 2],
  reason: `${pathway} reason`,
  ...over,
})

/** The engine's `--json` output (the T21 key set). Options in the engine's order: none first, the recommendation second. */
const engineJson = (over: Rec = {}) => ({
  head: HEAD,
  class: 'infra',
  matched: 3,
  size: { files: 7, lines: 212 },
  checks: [{ step: 'tests', status: 'PASS', detail: '12 passed' }],
  cli: { bySeverity: { Major: 1 } },
  credits: { used: null, monthly: null },
  capacity: { count: 38, band: 'ok', warning: null, source: 'manual', date: '2026-10-25' },
  recommended: 'coderabbit',
  options: [option('none'), option('coderabbit'), option('both', { available: false, reason: 'Greptile held: credits unknown' })],
  why: ['infra class', 'critical file touched'],
  budget: [1, 2],
  config_drift: false,
  ...over,
})

type Status = Rec & { pr: number }
const status = (pr: number, over: Rec = {}): Status => ({
  pr,
  head: HEAD,
  headShort: 'aaaaaaa',
  branch: 'feat/x',
  ready: false,
  reasons: [],
  mergeable_state: 'blocked',
  reviewedHead: false,
  unresolved: 0,
  rateLimited: false,
  prState: 'open',
  merged: false,
  isDraft: false,
  labels: ['review:coderabbit', 'risk:infra'],
  routing: { required: ['coderabbit'], held: null, source: 'labels' },
  routedReviewed: false,
  coderabbitReviewedHead: false,
  coderabbitRounds: 0,
  coderabbitRequests: 0,
  ...over,
})

type Opts = {
  /** Paths (substrings) that fs.exists answers false for. */
  missing?: string[]
  files?: Record<string, string>
  root?: string
  env?: Record<string, string>
  store?: Rec
  view?: Reply
  json?: Reply
  confirm?: Reply
  apply?: Reply
  shapes?: Reply | ((command: string) => Reply)
  head?: string
  open?: { isPlaced: boolean; reason?: string }
  statuses?: Record<number, Status>
  author?: string
  isDraft?: boolean
  viewHead?: string
  throwStore?: string
  /** A pending promise: the fake `gh pr comment` and the engine `--confirm` answer only after it settles (a slow call, so two presses overlap). */
  gate?: Promise<void>
  /** Replies for the first `gh pr comment` calls, in order; later calls succeed. */
  comments?: Reply[]
  /** The PR's head branch that gh pr view prints (headRefName). */
  branch?: string
  /** What `git worktree list --porcelain` prints in the session root. Unset: an empty list, so the session root is the checkout. */
  worktrees?: Reply
  /** `git rev-parse HEAD` per cwd; a cwd not listed answers `head`. */
  headAt?: Record<string, string>
}

type Run = { argv: string[]; stdin?: string; cwd?: string }

const OK = { exitCode: 0, stdout: '', stderr: '' }
const done = (r: Reply) => {
  if (r === 'throw') throw new Error('process timed out after 120000 ms')
  return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
}

/** What the shapes CLI would print for the commands the lock tests use. A fake of the CLI; its real output is pinned in checkpoint-shapes-cli.test.ts. */
const shapesFor = (command: string) => {
  const labels = [...new Set([...command.matchAll(/review:[a-z]+/gi)].map(m => m[0].toLowerCase()))]
  const out = {
    create: false,
    nonDraft: false,
    ready: /gh pr ready/.test(command) && !/--undo(?!=)/.test(command),
    label: /--add-label|addLabelsToLabelable|\/labels\b/.test(command) ? { labels, blind: /addLabelsToLabelable/.test(command) } : null,
    self: /pr-checkpoint/.test(command) && /--(confirm|apply)/.test(command),
    nonLiteral: false,
    // The real CLI prints `ccv3: true` when the text holds a visible CCv3 signal. These commands hold none, so the checkout decides.
    ccv3: false,
  }
  return { exitCode: 0, stdout: JSON.stringify(out), stderr: '' }
}

const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  // What mock.env does (a variable not listed is unset), plus a throw a test arms after `start`: this module's own kill-switch read, the first step of each of its lock hooks. No other module reads this name.
  const variables: Record<string, string> = { USERPROFILE: 'C:/home', ...(opts.env ?? {}) }
  on('env.get', (_$, e) => {
    if (fail.env && e.name === 'CCV3_PR_CHECKPOINT_OFF') throw new Error('env.get failed')
    return { value: variables[e.name] }
  })
  const session = mock.session(on)
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const seen = {
    run: [] as Run[],
    toasts: [] as string[],
    submits: [] as string[],
    asks: [] as string[],
    opens: [] as Rec[],
    closes: 0,
    registered: [] as string[],
    tools: [] as string[],
    ran: [] as { tool: string; text: string }[],
    writes: [] as string[],
  }
  const root = opts.root ?? ROOT
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false } }), ...(opts.files ?? {}) }
  const statuses = opts.statuses ?? {}
  // Armed by a test after `start`, so only the call under test throws.
  const fail = { exists: false, root: false, set: false, env: false }

  on('store.get', (_$, e) => {
    if (opts.throwStore && e.key.startsWith(opts.throwStore)) throw new Error('store failed')
    return { value: store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    if (fail.set && e.key.startsWith('checkpoint:pr:')) throw new Error('store.set failed')
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => {
    if (fail.root) throw new Error('session.root failed')
    return { value: root }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: ['Bash', 'PowerShell'].map(name => ({ name })) as never }))
  // The engine hands a fake the native path form (C:\r\x on Windows). The fixtures use forward slashes, so compare in that form.
  const slash = (path: string) => path.replace(/\\/g, '/')
  on('fs.exists', (_$, e) => {
    if (fail.exists && slash(e.path).includes('pr-checkpoint.mjs')) throw new Error('fs.exists failed')
    return { value: !(opts.missing ?? []).some(part => slash(e.path).includes(part)) }
  })
  on('fs.read', (_$, e) => {
    const text = files[slash(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push(e.path)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    seen.tools.push(e.name)
    return { value: { tool: `mcp__ccv3-mods__${e.name}` } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opens.push({ ...e })
    return { value: opts.open ?? { isPlaced: true } } as never
  })
  on('ui.close', () => {
    seen.closes += 1
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const line = argv.join(' ')
    seen.run.push({ argv, stdin: (e.init as { stdin?: string } | undefined)?.stdin, cwd: (e.init as { cwd?: string } | undefined)?.cwd })
    if (line.includes('review-status.mjs')) {
      const pr = Number(argv.find(part => /^\d+$/.test(part)))
      const one = statuses[pr] ?? status(pr)
      return { value: { exitCode: one.ready === true ? 0 : 1, stdout: JSON.stringify(one), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view') {
      const reply: Reply = opts.view ?? {
        stdout: JSON.stringify({ isDraft: opts.isDraft ?? true, state: 'OPEN', headRefOid: opts.viewHead ?? HEAD, headRefName: opts.branch ?? 'feat/x', author: { login: opts.author ?? 'Rev4nchist' }, number: Number(argv[3]) }),
      }
      return done(reply)
    }
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'comment') {
      if (opts.gate) return opts.gate.then(() => done(OK)) as never
      return done(opts.comments?.shift() ?? OK)
    }
    if (argv[0] === 'git' && argv.includes('worktree')) return done(opts.worktrees ?? OK)
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      const cwd = (e.init as { cwd?: string } | undefined)?.cwd ?? ''
      return done({ stdout: `${opts.headAt?.[cwd] ?? opts.head ?? HEAD}\n` })
    }
    if (argv[0] === 'git' && argv.includes('log')) return done({ stdout: 'feat: one\nfix: two\n' })
    if (argv[0] === 'git' && argv.includes('diff')) return done({ stdout: '10\t2\tscripts/github/review-status.mjs\n' })
    if (line.includes('checkpoint-shapes-cli.mjs')) {
      const shape = typeof opts.shapes === 'function' ? opts.shapes(e.init?.stdin ?? '') : (opts.shapes ?? shapesFor(e.init?.stdin ?? ''))
      return done(shape)
    }
    if (line.includes('pr-checkpoint.mjs')) {
      if (argv.includes('--json')) return done(opts.json ?? { stdout: JSON.stringify(engineJson()) })
      if (argv.includes('--confirm')) {
        const pathway = argv[argv.indexOf('--confirm') + 1]
        const by = argv[argv.indexOf('--by') + 1]
        const label = pathway === 'none' ? 'review:none' : pathway === 'both' ? 'review:deep' : 'review:coderabbit'
        const record = { head: HEAD, body_sha256: 'c'.repeat(64), pathway, label, class: 'infra', recommended: 'coderabbit', decided_by: by, at: '2026-10-28T20:00:00.000Z', budget: pathway === 'none' ? [0, 0] : [1, 2] }
        const reply = done(opts.confirm ?? { stdout: JSON.stringify(record) })
        return opts.gate ? (opts.gate.then(() => reply) as never) : reply
      }
      if (argv.includes('--apply')) return done(opts.apply ?? OK)
      return done({ stdout: `PR checkpoint for ${HEAD.slice(0, 7)}: class infra, 7 file(s), 212 line(s)\nRecommended: coderabbit  budget 1+2\n` })
    }
    return done(OK)
  })
  // The engine's own bottom: a call that no mod denied runs, and the test sees that it ran.
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.ran.push({ tool: 'Bash', text: String((e as { command?: string }).command) })
    return { result: { stdout: 'ran', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    seen.ran.push({ tool: 'PowerShell', text: String((e as { command?: string }).command) })
    return { result: { stdout: 'ran', stderr: '', interrupted: false } }
  })
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const) {
    on('tool.call', { tool: name } as never, (_$: unknown, e: Rec) => {
      seen.ran.push({ tool: name, text: String(e.file_path ?? e.notebook_path) })
      return { result: { type: 'update', filePath: String(e.file_path ?? e.notebook_path), content: '', structuredPatch: [], originalFile: null } } as never
    })
  }
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    seen.asks.push(String((e as unknown as { questions: { question: string }[] }).questions[0]?.question))
    return { deny: 'no chat prompt in the checkpoint flows' }
  })
  return { clock, seen, store, session, fail }
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: ROOT, surface: isInteractive ? 'terminal' : null, isInteractive })

const callTool = async ($: Engine, input: Rec) => {
  try {
    const r = (await $.tool.call({ tool: TOOL, ...input } as never)) as unknown as Rec
    return { text: JSON.stringify(r), raw: r, thrown: null as string | null }
  } catch (err) {
    return { text: String(err), raw: null, thrown: String(err) }
  }
}

const slash = ($: Engine, args: string, kind = 'composer') =>
  $.command.run({ command: COMMAND, args, origin: (kind === 'plugin' ? { kind, name: 'other-mod' } : { kind }) as never, presentation: { isFullscreen: false, columns: 100 } })

const PANE_PROPS = { title: 'PR checkpoint', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'Pane', requestId: 'pr-checkpoint', props: PANE_PROPS, viewport: { columns: 100, rows: 40 } })
type Pane = Awaited<ReturnType<typeof mountPane>>

const buttons = async (pane: Pane) => await pane.findAll({ type: 'Button' })
const keys = async (pane: Pane) => (await buttons(pane)).map(found => found.key ?? '')
const paneText = async (pane: Pane) =>
  [...(await pane.findAll({ type: 'Text' })), ...(await buttons(pane))].map(found => found.text).join('\n')
const argvOf = (seen: { run: Run[] }, part: string) => seen.run.filter(r => r.argv.some(a => a.includes(part))).map(r => r.argv)
const engineCalls = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs'))).map(r => r.argv.slice(2).join(' '))
/** A press returns before its handler ends, so a test waits for the work a press started. */
const settle = async () => {
  for (let turn = 0; turn < 500; turn += 1) await Promise.resolve()
}
const counts = (seen: { run: Run[] }) => ({
  confirm: seen.run.filter(r => r.argv.includes('--confirm')).length,
  apply: seen.run.filter(r => r.argv.includes('--apply')).length,
  comments: seen.run.filter(r => r.argv[0] === 'gh' && r.argv[2] === 'comment').map(r => r.argv),
})

/** Opens the pane the way the model does (the tool call) and mounts it. */
const openPane = async ($: Engine) => {
  await start($)
  const told = await callTool($, { pr: 7, body: 'pr-body.md' })
  return { told, pane: await mountPane($) }
}

const CONFIG_ENFORCE = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: true } }) }
const LOCK_DENIED = (r: { deny?: string }) => typeof r.deny === 'string' && r.deny.length > 0

describe('pr-checkpoint: registration and the checkpoint pane', () => {
  test('K0 the tool and the command are registered in an interactive and in a headless session', async ($, on) => {
    const a = world(on)
    await start($)
    expect(a.seen.tools).toContain('pr_checkpoint')
    expect(a.seen.registered).toContain(COMMAND)
  })

  test('K0b a headless session registers the tool and the command too (text only there)', async ($, on) => {
    const a = world(on)
    await start($, false)
    expect(a.seen.tools).toContain('pr_checkpoint')
    expect(a.seen.registered).toContain(COMMAND)
  })

  test('K1 the first option is the recommendation, not the engine order; hotkeys, autoFocus, primary look; pane opened with focus', async ($, on) => {
    const { seen } = world(on)
    const { told, pane } = await openPane($)
    expect(told.text).toMatch(/side pane/i)
    expect(told.text).toMatch(/do not run gh pr ready/i)
    expect(engineCalls(seen)[0]).toBe('--json')
    expect(seen.opens.length).toBe(1)
    expect(seen.opens[0]!.id).toBe('pr-checkpoint')
    expect(seen.opens[0]!.focus).toBe(true)
    expect(seen.opens[0]!.closeOnEscape).toBe(true)
    expect(seen.opens[0]!.holdToasts).not.toBe(true)
    expect(await keys(pane)).toEqual(['opt-coderabbit', 'opt-none', 'dismiss'])
    const [first, second, dismiss] = await buttons(pane)
    expect(first!.props.hotkey).toBe('1')
    expect(first!.props.autoFocus).toBe(true)
    expect(first!.props.variant).toBe('primary')
    expect(first!.text).toContain('(Recommended)')
    expect(second!.props.hotkey).toBe('2')
    expect(second!.text).not.toContain('(Recommended)')
    expect(dismiss!.props.hotkey).toBe('0')
    expect(dismiss!.props.role).toBe('dismiss')
    const text = await paneText(pane)
    expect(text).toContain('#7')
    expect(text).toMatch(/infra/)
    expect(text).toMatch(/7 files/)
    expect(text).toMatch(/Major/)
    expect(text).toMatch(/38/)
  })

  test('K1b a Dependabot author is passed to the engine as --dependabot', async ($, on) => {
    const { seen } = world(on, { author: 'dependabot[bot]' })
    await openPane($)
    expect(engineCalls(seen)[0]).toBe('--json --dependabot')
  })

  test('K12 a held option is dim text with its reason, not a Button', async ($, on) => {
    world(on)
    const { pane } = await openPane($)
    expect((await keys(pane)).includes('opt-both')).toBe(false)
    const text = await paneText(pane)
    expect(text).toContain('Greptile held: credits unknown')
    expect(text).toMatch(/both/)
  })

  test('K10 an R0 result (no stamp) shows no option Buttons and the reason', async ($, on) => {
    world(on, { json: { stdout: JSON.stringify(engineJson({ recommended: null, options: [], why: ['Run pre-pr.mjs: no stamp for this head.'], budget: [0, 0] })) } })
    const { pane } = await openPane($)
    expect((await keys(pane)).filter(key => key.startsWith('opt-'))).toEqual([])
    expect(await paneText(pane)).toContain('Run pre-pr.mjs')
  })

  test('K2 Accept runs --confirm <recommended> --by default then --apply, inline (no timer), and records the store', async ($, on) => {
    const { seen, store } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    // No clock.advance here on purpose. Decision (plan review 7): press work runs inside the press handler.
    const calls = engineCalls(seen).filter(call => !call.startsWith('--json'))
    expect(calls.length).toBe(2)
    expect(calls[0]).toMatch(/^--confirm coderabbit --by default --body \S*pr-body\.md$/)
    expect(calls[1]).toBe('--apply 7')
    expect(seen.run.find(r => r.argv.includes('--confirm'))?.cwd).toBe(ROOT)
    const record = store.get('checkpoint:pr:7') as Rec
    expect(record.state).toBe('applied')
    expect(record.pathway).toBe('coderabbit')
    expect(record.label).toBe('review:coderabbit')
    expect(record.head).toBe(HEAD)
    expect(record.budget).toEqual([1, 2])
    expect(record.decided_by).toBe('default')
    expect(record.pr).toBe(7)
    expect(record.session).toBe(SESSION)
    expect((record.capacity as Rec).count).toBe(38)
    expect(record.appliedAt).toBe(NOW)
    expect(store.get(PENDING)).toBeUndefined()
    expect(seen.closes).toBe(1)
    expect(seen.writes.filter(path => path.includes('review-ledger'))).toEqual([])
    expect(seen.asks).toEqual([])
    expect(seen.toasts.some(text => /#7/.test(text))).toBe(true)
  })

  test('K3 another option runs --by dave', async ($, on) => {
    const { seen, store } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-none' })
    const calls = engineCalls(seen).filter(call => !call.startsWith('--json'))
    expect(calls[0]).toMatch(/^--confirm none --by dave --body \S*pr-body\.md$/)
    expect(calls[1]).toBe('--apply 7')
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    expect((store.get('checkpoint:pr:7') as Rec).budget).toEqual([0, 0])
  })

  test('K2b two overlapping presses of an option run the engine once: one --confirm and one --apply', async ($, on) => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const { seen } = world(on, { gate })
    const { pane } = await openPane($)
    const first = pane.press({ key: 'opt-coderabbit' })
    const second = pane.press({ key: 'opt-coderabbit' })
    await settle()
    release()
    await Promise.all([first, second])
    await settle()
    expect(counts(seen).confirm).toBe(1)
    expect(counts(seen).apply).toBe(1)
  })

  test('K6 dismiss records nothing and closes the pane', async ($, on) => {
    const { seen, store } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'dismiss' })
    expect(counts(seen).confirm).toBe(0)
    expect(counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(seen.closes).toBe(1)
  })

  test('K7 wait records nothing, closes the pane and says the PR stays a draft', async ($, on) => {
    const wait = engineJson({
      recommended: 'wait',
      capacity: { count: 55, band: 'high', warning: 'CodeRabbit 7-day count is 55', source: 'manual', date: '2026-10-25' },
      options: [option('wait'), option('coderabbit'), option('none')],
    })
    const { seen, store } = world(on, { json: { stdout: JSON.stringify(wait) } })
    const { pane } = await openPane($)
    expect((await keys(pane))[0]).toBe('opt-wait')
    await pane.press({ key: 'opt-wait' })
    expect(counts(seen).confirm).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(seen.toasts.some(text => /stays a draft/i.test(text))).toBe(true)
  })

  test('K8 a refused --confirm shows its stderr line in the pane and never applies', async ($, on) => {
    const { seen, store } = world(on, { confirm: { exitCode: 1, stderr: 'pr-checkpoint: refused: The PR body is not the body pre-pr.mjs checked.\n' } })
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect(counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(await paneText(pane)).toContain('The PR body is not the body pre-pr.mjs checked.')
  })

  test('K9 a refused --apply keeps the record confirmed, shows the engine text, and retry-apply runs --apply only', async ($, on) => {
    const moved = 'pr-checkpoint: refused: The head of PR #7 moved since the pathway was confirmed (PR bbbbbbb, record aaaaaaa). Run /pathway again.\n'
    const w = world(on, { apply: { exitCode: 1, stderr: moved } })
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('confirmed')
    expect(await paneText(pane)).toContain('Run /pathway again.')
    expect(await paneText(pane)).not.toContain('/checkpoint')
    expect(await keys(pane)).toContain('retry-apply')
    await pane.press({ key: 'retry-apply' })
    expect(counts(w.seen).confirm).toBe(1)
    expect(counts(w.seen).apply).toBe(2)
  })

  test('K9b a throw after --confirm (the store write fails) frees the pane: the error shows, the option Buttons return, and a second press works', async ($, on) => {
    const w = world(on)
    const { pane } = await openPane($)
    w.fail.set = true
    await pane.press({ key: 'opt-coderabbit' })
    expect(counts(w.seen).confirm).toBe(1)
    expect(counts(w.seen).apply).toBe(0)
    const text = await paneText(pane)
    expect(text).toMatch(/store\.set/) // the kit skips a throwing hook and reports 'no implementation for store.set'
    expect(text).not.toMatch(/Running/)
    expect(await keys(pane)).toEqual(['opt-coderabbit', 'opt-none', 'dismiss'])
    w.fail.set = false
    await pane.press({ key: 'opt-coderabbit' })
    expect(counts(w.seen).confirm).toBe(2)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
  })

  test('K1c a recommendation that is held marks no Button Recommended, gives none the focus or the primary look, and every press is --by dave', async ($, on) => {
    const held = engineJson({ recommended: 'both', options: [option('none'), option('coderabbit'), option('both', { available: false, reason: 'Greptile held: credits unknown' })] })
    const { seen } = world(on, { json: { stdout: JSON.stringify(held) } })
    const { pane } = await openPane($)
    expect(await keys(pane)).toEqual(['opt-none', 'opt-coderabbit', 'dismiss'])
    const [first, second] = await buttons(pane)
    for (const one of [first!, second!]) {
      expect(one.text).not.toContain('(Recommended)')
      expect(one.props.autoFocus).not.toBe(true)
      expect(one.props.variant).not.toBe('primary')
    }
    expect(await paneText(pane)).toContain('Greptile held: credits unknown')
    await pane.press({ key: 'opt-none' })
    const confirm = engineCalls(seen).find(call => call.startsWith('--confirm'))
    expect(confirm).toMatch(/^--confirm none --by dave /)
  })
})

// The PR's checkout (lane pathway-session-root). A session in the main checkout opens the checkpoint for a PR whose branch is checked
// out in another worktree. How it can fail, and the test that catches it:
// W1 the engine's facts (its cwd), the stamp or the git facts come from the session root, not from the worktree that holds the PR branch;
//    or the engine CODE comes from that worktree (a session in main must run its own copy, never another worktree's)
// W2 a press (--confirm, --apply) runs in the session root, or the body resolves in the session root while the worktree has it
// W3 a body that only the session root holds is not found (the fallback is lost)
// W4 a worktree with no engine in it is used (not a CCv3 checkout)
// W5 /pathway <pr> <word> --body from the main checkout records in the session root
// W6 no worktree holds the branch: the refusal does not name the branch, so Dave cannot tell what to check out
// W7 a failing `git worktree list` stops the checkpoint instead of falling back to the session root
// W8 Lock B reads HEAD in the session root for a record made in a worktree, so a matching label re-add is denied
// W9 a missing body names only one of the two paths searched
// The porcelain has CRLF line ends, a detached worktree block, and a decoy branch (feat/x-old) before feat/x: a startsWith match fails W1.
const WT = 'C:/r/.claude/worktrees/feat-x'
const PORCELAIN = [
  'worktree C:/r', 'HEAD ' + OTHER_HEAD, 'branch refs/heads/main', '',
  'worktree C:/r/.claude/worktrees/detached', 'HEAD ' + OTHER_HEAD, 'detached', '',
  'worktree C:/r/.claude/worktrees/feat-x-old', 'HEAD ' + OTHER_HEAD, 'branch refs/heads/feat/x-old', '',
  `worktree ${WT}`, 'HEAD ' + HEAD, 'branch refs/heads/feat/x', '',
].join('\r\n')
const wtOpts = (over: Opts = {}): Opts => ({ worktrees: { stdout: PORCELAIN }, ...over })
const cwdOf = (seen: { run: Run[] }, part: string) => seen.run.filter(r => r.argv.some(a => a.includes(part))).map(r => r.cwd)

describe('pr-checkpoint: the PR branch checked out in another worktree', () => {
  test('W1 the engine, the stamp and the git facts run in the worktree that holds the PR branch', async ($, on) => {
    const { seen, store } = world(on, wtOpts({ files: { [`${WT}/.claude/cache/pre-pr/stamp.json`]: JSON.stringify({ at: '2026-10-30T20:00:00.000Z' }) } }))
    const { told, pane } = await openPane($)
    expect(told.text).toMatch(/side pane/i)
    expect((store.get(PENDING) as Rec).stamp).toBe('2026-10-30T20:00:00.000Z')
    expect((store.get(PENDING) as Rec).root).toBe(WT)
    const json = seen.run.find(r => r.argv.includes('--json') && r.argv.some(a => a.includes('pr-checkpoint.mjs')))!
    expect(json.argv[1]).toBe(ENGINE)
    expect(json.cwd).toBe(WT)
    expect(cwdOf(seen, 'log').filter(cwd => cwd !== undefined)).toEqual([WT])
    expect(seen.run.find(r => r.argv[0] === 'git' && r.argv.includes('diff'))?.cwd).toBe(WT)
    expect(seen.run.find(r => r.argv[0] === 'git' && r.argv.includes('worktree'))?.cwd).toBe(ROOT)
    expect(await keys(pane)).toEqual(['opt-coderabbit', 'opt-none', 'dismiss'])
  })

  test('W2 a press runs --confirm and --apply in the worktree, with the body file resolved there', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    const confirm = seen.run.find(r => r.argv.includes('--confirm'))!
    expect(confirm.cwd).toBe(WT)
    expect(confirm.argv[1]).toBe(ENGINE)
    expect(confirm.argv[confirm.argv.indexOf('--body') + 1]).toBe(`${WT}/pr-body.md`)
    const apply = seen.run.find(r => r.argv.includes('--apply'))!
    expect(apply.cwd).toBe(WT)
    expect(apply.argv[1]).toBe(ENGINE)
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect((store.get('checkpoint:pr:7') as Rec).root).toBe(WT)
  })

  test('W3 a body file that only the session root holds is still found there', async ($, on) => {
    const { seen } = world(on, wtOpts({ missing: [`${WT}/pr-body.md`] }))
    const { told, pane } = await openPane($)
    expect(told.text).toMatch(/side pane/i)
    await pane.press({ key: 'opt-none' })
    const confirm = seen.run.find(r => r.argv.includes('--confirm'))!
    expect(confirm.argv[confirm.argv.indexOf('--body') + 1]).toBe(`${ROOT}/pr-body.md`)
    expect(confirm.cwd).toBe(WT)
  })

  test('W4 a worktree with no engine in it is not used: the session root runs the engine', async ($, on) => {
    const { seen } = world(on, wtOpts({ missing: [`${WT}/scripts/github/pr-checkpoint.mjs`] }))
    await openPane($)
    const json = seen.run.find(r => r.argv.includes('--json') && r.argv.some(a => a.includes('pr-checkpoint.mjs')))!
    expect(json.argv[1]).toBe(ENGINE)
    expect(json.cwd).toBe(ROOT)
  })

  test('W5 /pathway <pr> none --body from the main checkout records in the worktree', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toMatch(/none recorded/)
    expect(seen.run.find(r => r.argv.includes('--confirm'))?.cwd).toBe(WT)
    expect(seen.run.find(r => r.argv.includes('--apply'))?.cwd).toBe(WT)
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
  })

  test('W6 no worktree holds the PR branch and the session root is elsewhere: the refusal names the branch', async ($, on) => {
    const { seen } = world(on, wtOpts({ branch: 'feat/y', viewHead: OTHER_HEAD }))
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toMatch(/check out the PR branch at its head/i)
    expect(told.text).toContain('feat/y')
    expect(seen.opens).toEqual([])
  })

  test('W7 a failing git worktree list falls back to the session root and the pane still opens', async ($, on) => {
    const { seen } = world(on, { worktrees: { exitCode: 128, stderr: 'fatal: not a git repository' } })
    const { told } = await openPane($)
    expect(told.text).toMatch(/side pane/i)
    expect(seen.run.find(r => r.argv.includes('--json') && r.argv.some(a => a.includes('pr-checkpoint.mjs')))?.cwd).toBe(ROOT)
  })

  test('W8 enforce: after a press made in the worktree, a matching label re-add is allowed (HEAD read in the worktree, not in main)', async ($, on) => {
    const w = world(on, wtOpts({ files: CONFIG_ENFORCE, head: OTHER_HEAD, headAt: { [WT]: HEAD } }))
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    const before = w.seen.ran.length
    const r = (await $.tool.call({ tool: 'Bash', command: 'gh pr edit 7 --add-label review:coderabbit' } as never)) as unknown as { deny?: string }
    expect(LOCK_DENIED(r)).toBe(false)
    expect(w.seen.ran.length).toBe(before + 1)
    expect(w.seen.run.filter(r => r.argv[0] === 'git' && r.argv.includes('rev-parse')).at(-1)?.cwd).toBe(WT)
  })

  test('W9 a missing body names both paths searched: the worktree and the session root', async ($, on) => {
    world(on, wtOpts({ missing: ['pr-body.md'] }))
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toContain(`${WT}/pr-body.md`)
    expect(told.text).toContain(`${ROOT}/pr-body.md`)
  })
})

describe('pr-checkpoint: the tool refuses before it opens anything', () => {
  test('K4 headless returns the text plan only: no --json, no --confirm, no --apply, no gh, no pane', async ($, on) => {
    const { seen, store } = world(on)
    await start($, false)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toContain('PR checkpoint for')
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(told.text).toMatch(/draft/)
    expect(engineCalls(seen)).toEqual([''])
    expect(seen.run.some(r => r.argv[0] === 'gh')).toBe(false)
    expect(seen.opens).toEqual([])
    expect([...store.keys()].filter(key => key.startsWith('checkpoint:'))).toEqual([])
  })

  test('K11 a PR that is not a draft opens no pane and says so', async ($, on) => {
    const { seen } = world(on, { isDraft: false })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toMatch(/not a draft/i)
    expect(seen.opens).toEqual([])
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
  })

  test('K11b a local HEAD that is not the PR head opens no pane and says to check out the PR branch', async ($, on) => {
    const { seen } = world(on, { viewHead: OTHER_HEAD })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toMatch(/check out the PR branch at its head/i)
    expect(seen.opens).toEqual([])
  })

  test('K11c an unreadable PR (gh exits 1) returns the error and runs no engine', async ($, on) => {
    const { seen } = world(on, { view: { exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7.' } })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toContain('Could not resolve to a PullRequest')
    expect(engineCalls(seen)).toEqual([])
    expect(seen.opens).toEqual([])
  })

  for (const [name, reply, pattern] of [
    ['exit 3', { exitCode: 3, stderr: 'pr-checkpoint: could not determine (git fetch failed)\n' }, /could not determine \(git fetch failed\)/],
    ['bad JSON', { stdout: 'PR checkpoint for aaaaaaa: class infra, 7 file(s)' }, /JSON/i],
    ['a timeout', 'throw', /timed out/i],
  ] as [string, Reply, RegExp][]) {
    test(`K12b --json ${name}: the error text, no pane, no pathway, the PR stays a draft`, async ($, on) => {
      const { seen, store } = world(on, { json: reply })
      await start($)
      const told = await callTool($, { pr: 7, body: 'pr-body.md' })
      expect(told.text).toMatch(pattern)
      expect(seen.opens).toEqual([])
      expect(counts(seen).confirm + counts(seen).apply).toBe(0)
      expect([...store.keys()].filter(key => key.startsWith('checkpoint:'))).toEqual([])
    })
  }

  test('K12c a missing body file stops the tool and /pathway before the engine runs', async ($, on) => {
    const { seen } = world(on, { missing: ['pr-body.md'] })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toMatch(/body file/i)
    expect(told.text).toContain('pr-body.md')
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toMatch(/body file/i)
    expect(engineCalls(seen)).toEqual([])
    expect(seen.opens).toEqual([])
  })

  test('K12d the pane is not placed (isPlaced false): a toast with the engine reason, and "type /<command>"', async ($, on) => {
    const { seen, store } = world(on, { open: { isPlaced: false, reason: 'the terminal is 100 columns wide; a pane waits below 144' } })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toContain(`/${COMMAND}`)
    expect(told.text).not.toContain('/checkpoint')
    expect(told.text).toContain('the terminal is 100 columns wide')
    expect(seen.toasts.some(text => text.includes(`type /${COMMAND}`))).toBe(true)
    expect(seen.toasts.some(text => text.includes('100 columns'))).toBe(true)
    expect(seen.toasts.some(text => text.includes('/checkpoint'))).toBe(false)
    expect(store.get(PENDING)).toBeDefined()
    const before = seen.opens.length
    const ran = await slash($, '')
    expect(seen.opens.length).toBe(before + 1)
    expect(ran.text ?? '').toMatch(/pane/i)
  })
})

describe('pr-checkpoint: /pathway', () => {
  test('K5 /pathway 7 none costs no model turn and records with --by dave', async ($, on) => {
    const { seen, store } = world(on)
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(typeof ran.text).toBe('string')
    expect(seen.submits).toEqual([])
    expect(seen.asks).toEqual([])
    const calls = engineCalls(seen)
    expect(calls.some(call => /^--confirm none --by dave --body \S*pr-body\.md$/.test(call))).toBe(true)
    expect(calls).toContain('--apply 7')
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(ran.text).toContain('none')
  })

  test('K5b /pathway 7 accept records the recommendation with --by default', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await slash($, '7 accept --body pr-body.md')
    expect(engineCalls(seen).some(call => /^--confirm coderabbit --by default /.test(call))).toBe(true)
  })

  test('K5c /pathway with nothing to act on, or a bad word, gives the usage text and runs nothing', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const empty = await slash($, '')
    expect(empty.text ?? '').toContain('Call pr_checkpoint first, or pass <pr> --body <file>.')
    const bad = await slash($, 'banana')
    expect(bad.text ?? '').toMatch(/usage/i)
    expect(engineCalls(seen)).toEqual([])
    expect(seen.opens).toEqual([])
  })

  test('K14 a /pathway raised by a plugin records nothing and gives the text plan only', async ($, on) => {
    const { seen, store } = world(on)
    await start($)
    const ran = await slash($, '7 none --body pr-body.md', 'plugin')
    expect(typeof ran.text).toBe('string')
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
  })

  test('K4b headless /pathway 7 none records nothing', async ($, on) => {
    const { seen, store } = world(on)
    await start($, false)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toContain('PR checkpoint for')
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
  })

  test('K21 the model learns the outcome from one meta row, with no turn', async ($, on) => {
    const { seen, session } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    const rows = session.appended().filter(row => JSON.stringify(row.message).includes('PR checkpoint:'))
    expect(rows.length).toBe(1)
    const text = JSON.stringify(rows[0]!.message)
    expect(text).toContain('#7')
    expect(text).toContain('review:coderabbit')
    expect(text).toMatch(/do not merge/i)
    expect(seen.submits).toEqual([])
  })
})

describe('pr-checkpoint: lock A, tool writes to pathway.json', () => {
  const SPELLINGS = [
    'C:/r/.claude/cache/pre-pr/pathway.json',
    'C:\\r\\.claude\\cache\\pre-pr\\pathway.json',
    'c:/R/.CLAUDE/Cache/PRE-PR/Pathway.JSON',
    'C:/r/.claude/cache/pre-pr/../pre-pr/pathway.json',
    'C:/r/.claude/cache/pre-pr/./pathway.json',
    'C:/r/.claude/cache/x/../pre-pr/pathway.json',
  ]

  for (const tool of ['Write', 'Edit', 'MultiEdit'] as const) {
    test(`K13 ${tool} on pathway.json is denied in every spelling, and in warn mode`, async ($, on) => {
      const { seen } = world(on)
      await start($)
      for (const file_path of SPELLINGS) {
        const r = await $.tool.call({ tool, file_path, content: '{}', old_string: 'a', new_string: 'b', edits: [] } as never)
        expect(LOCK_DENIED(r as never)).toBe(true)
      }
      expect(seen.ran).toEqual([])
    })
  }

  test('K13 NotebookEdit reads notebook_path, so a pathway.json there is denied too; another file passes', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const denied = await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:/r/.claude/cache/pre-pr/pathway.json', new_source: 'x' } as never)
    expect(LOCK_DENIED(denied as never)).toBe(true)
    const passed = await $.tool.call({ tool: 'Write', file_path: 'C:/r/.claude/cache/pre-pr/stamp.json', content: '{}' } as never)
    expect(LOCK_DENIED(passed as never)).toBe(false)
    expect(seen.ran.map(r => r.text)).toEqual(['C:/r/.claude/cache/pre-pr/stamp.json'])
  })
})

describe('pr-checkpoint: lock A fails closed by its own return', () => {
  // K13f: Lock A answers { deny } itself when it throws, as Lock B does, and does not leave the deny to .catch. A .catch deny of a hook that
  // threw can be lost under an outer unmatched tool.call hook (the Agentic OS observer; PR C kit finding). The seam is env.get: Lock A's
  // first step (the kill-switch read) throws, so the deny must come from the hook's own return. The kit reproduces the loss: the plugin's
  // other modules already hold unmatched tool.call hooks (touched-files, the Agentic OS observer), so even the plain case fails on the old
  // code. The two extra cases add a bare pass-through hook first and last.
  const writes = ($: Engine) => $.tool.call({ tool: 'Write', file_path: 'C:/r/.claude/cache/pre-pr/stamp.json', content: '{}' } as never) as unknown as Promise<{ deny?: string }>

  for (const where of ['none', 'outer-first', 'outer-last'] as const) {
    test(`K13f a throw inside lock A (${where === 'none' ? 'no outer hook' : `an unmatched outer tool.call hook, registered ${where === 'outer-first' ? 'before' : 'after'} the mod`}) denies with the lock-failed text, and the write never ran`, async ($, on) => {
      const outer = (_$: unknown, e: unknown, next: (e: unknown) => unknown) => next(e)
      if (where === 'outer-first') on('tool.call', outer as never)
      const w = world(on)
      const { seen } = w
      if (where === 'outer-last') on('tool.call', outer as never)
      await start($)
      w.fail.env = true
      const r = await writes($)
      expect(LOCK_DENIED(r)).toBe(true)
      expect(r.deny).toMatch(/lock failed/i)
      expect(seen.ran).toEqual([])
    })
  }
})

describe('pr-checkpoint: lock B fails closed by its own return, off switch included', () => {
  // K13f for Bash and PowerShell: the kill-switch read is the first step of the handler. A throw there must be answered by shellLock's own
  // return, because an outer unmatched tool.call hook can drop the deny of a handler that threw (the same loss as lock A, fd8dbae7).
  // It fails if the handler awaits isOff before shellLock, as the old code did: the deny is then only the .catch one.
  for (const tool of ['Bash', 'PowerShell'] as const) {
    for (const where of ['none', 'outer-first', 'outer-last'] as const) {
      test(`K13f ${tool}: a throw from the env.get read (${where === 'none' ? 'no outer hook' : `an unmatched outer tool.call hook, registered ${where === 'outer-first' ? 'before' : 'after'} the mod`}) denies with the lock-failed text, and the command never ran`, async ($, on) => {
        const outer = (_$: unknown, e: unknown, next: (e: unknown) => unknown) => next(e)
        if (where === 'outer-first') on('tool.call', outer as never)
        const w = world(on)
        const { seen } = w
        if (where === 'outer-last') on('tool.call', outer as never)
        await start($)
        w.fail.env = true
        const r = (await $.tool.call({ tool, command: 'git status' } as never)) as unknown as { deny?: string }
        expect(LOCK_DENIED(r as never)).toBe(true)
        expect(r.deny).toMatch(/lock failed/i)
        expect(seen.ran).toEqual([])
      })
    }
  }
})

describe('pr-checkpoint: lock B, shell text', () => {
  const shell = async ($: Engine, command: string, tool: 'Bash' | 'PowerShell' = 'Bash') =>
    (await $.tool.call({ tool, command } as never)) as unknown as { deny?: string }

  // Plan 3.4 step 2: shell text that names pre-pr/pathway.json is denied, always, with no spawn. Any list of write tokens is a second
  // hand lexer (tee, mv, node -e, Copy-Item and [IO.File] all get past it), so the deny keys on the path alone and fails closed.
  const NAMES_PATHWAY: [('Bash' | 'PowerShell'), string][] = [
    ['Bash', 'echo {} > .claude/cache/pre-pr/pathway.json'],
    ['Bash', 'cp /tmp/x.json .claude/cache/pre-pr/pathway.json'],
    ['Bash', 'echo {} | tee .claude/cache/pre-pr/pathway.json'],
    ['Bash', 'mv /tmp/x.json .claude/cache/pre-pr/pathway.json'],
    ['Bash', `node -e "require('fs').writeFileSync('.claude/cache/pre-pr/pathway.json','{}')"`],
    ['Bash', 'cat .claude/cache/pre-pr/pathway.json'],
    ['Bash', 'cat .CLAUDE/Cache/PRE-PR/Pathway.JSON'],
    ['PowerShell', "Set-Content -Path .claude\\cache\\pre-pr\\pathway.json -Value '{}'"],
    ['PowerShell', "'{}' | Out-File .claude/cache/pre-pr/pathway.json"],
    ['PowerShell', 'Copy-Item x.json .claude\\cache\\pre-pr\\pathway.json'],
    ['PowerShell', "[IO.File]::WriteAllText('.claude/cache/pre-pr/pathway.json', '{}')"],
    ['PowerShell', 'Get-Content .claude\\cache\\pre-pr\\pathway.json'],
  ]

  test('K13b shell text that names pre-pr/pathway.json is denied in every form, in warn mode, and spawns no CLI', async ($, on) => {
    const { seen } = world(on)
    await start($)
    for (const [tool, command] of NAMES_PATHWAY) {
      expect(LOCK_DENIED(await shell($, command, tool)), `${tool}: ${command}`).toBe(true)
    }
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  test('K13c (Dave Q1, plan default) a bare mention of the path in a commit message is denied too: fail closed, no spawn', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(LOCK_DENIED(await shell($, 'git commit -m "docs: the gate reads .claude/cache/pre-pr/pathway.json"'))).toBe(true)
    expect(LOCK_DENIED(await shell($, 'git commit -m "docs: the gate reads .claude\\cache\\pre-pr\\pathway.json"', 'PowerShell'))).toBe(true)
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  // PR D: the router counts a ready event as a checkpoint only when a pathway-confirmed marker comment names the head. The apply step posts it
  // (node, not a shell call). A shell gh command whose text holds the marker word is denied, always and on the raw text; no lexer, no spawn.
  test('K13d a gh command that names pathway-confirmed is denied in every form, in warn mode, and spawns no CLI', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const marker = '<!-- pathway-confirmed head=' + 'a'.repeat(40) + ' pathway=none -->'
    for (const [tool, command] of [
      ['Bash', `gh pr comment 201 --body '${marker}'`],
      ['Bash', `gh api repos/o/r/issues/201/comments -f body='${marker}'`],
      ['Bash', 'gh pr comment 201 --body "<!-- PATHWAY-CONFIRMED head=x -->"'],
      ['PowerShell', `gh.exe pr comment 201 --body '${marker}'`],
    ] as const) {
      expect(LOCK_DENIED(await shell($, command, tool)), `${tool}: ${command}`).toBe(true)
    }
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  test('K13e a plain gh comment, and a non-gh command that mentions the word, are not denied by the marker rule', async ($, on) => {
    world(on)
    await start($)
    expect(LOCK_DENIED(await shell($, 'gh pr comment 201 --body "thanks"'))).toBe(false)
    expect(LOCK_DENIED(await shell($, 'git commit -m "docs: the router reads the pathway-confirmed marker"'))).toBe(false)
  })

  // PR D review C12: the marker lock covers write shapes only. A read of the comments that names the word is not a post.
  test('K13f a gh read that names pathway-confirmed is not denied: view, list, api GET, a pipe to a filter', async ($, on) => {
    world(on)
    await start($)
    for (const [tool, command] of [
      ['Bash', `gh pr view 221 --json comments --jq '.comments[]|select(.body|test("pathway-confirmed"))'`],
      ['Bash', `gh api repos/o/r/issues/221/comments --jq '.[]|select(.body|test("pathway-confirmed"))'`],
      ['PowerShell', 'gh api repos/o/r/issues/221/comments | Select-String pathway-confirmed'],
      ['Bash', 'gh issue list --search "pathway-confirmed"'],
      ['Bash', `gh api graphql -f query='query { repository(owner:"o",name:"r") { issue(number:5) { comments(first:50) { nodes { body } } } } }' --jq '.. | select(.body? | test("pathway-confirmed"))'`],
    ] as const) {
      expect(LOCK_DENIED(await shell($, command, tool)), `${tool}: ${command}`).toBe(false)
    }
  })

  test('K13g every gh write shape that names pathway-confirmed is denied: issue comment, pr edit or create body, api POST or PATCH, api -f or -F body=', async ($, on) => {
    world(on)
    await start($)
    const word = 'pathway-confirmed head=' + 'a'.repeat(40) + ' pathway=none'
    for (const command of [
      `gh issue comment 5 --body '<!-- ${word} -->'`,
      `gh pr edit 201 --body '<!-- ${word} -->'`,
      `gh pr create --title t --body '<!-- ${word} -->'`,
      `gh api repos/o/r/issues/comments/9 -X PATCH -f body='<!-- ${word} -->'`,
      `gh api repos/o/r/issues/201/comments --method POST --input body.json -f note='<!-- ${word} -->'`,
      `gh api repos/o/r/issues/201/comments -F body='<!-- ${word} -->'`,
    ]) {
      expect(LOCK_DENIED(await shell($, command)), command).toBe(true)
    }
  })

  // PR D verifier follow-up (C12): two write shapes the first narrowing missed. The old regex denied both.
  test('K13h a gh api graphql mutation, and a gh api --input body from stdin, that carry pathway-confirmed are denied', async ($, on) => {
    world(on)
    await start($)
    const marker = '<!-- pathway-confirmed head=' + 'a'.repeat(40) + ' pathway=none -->'
    for (const [tool, command] of [
      ['Bash', `gh api graphql -f query='mutation { addComment(input:{subjectId:"X", body:"${marker}"}) { clientMutationId } }'`],
      ['PowerShell', `gh api graphql -f query='mutation { addComment(input:{subjectId:"X", body:"${marker}"}) { clientMutationId } }'`],
      ['Bash', `echo '{"body":"${marker}"}' | gh api repos/o/r/issues/201/comments --input -`],
      ['PowerShell', `'{"body":"${marker}"}' | gh api repos/o/r/issues/201/comments --input -`],
    ] as const) {
      expect(LOCK_DENIED(await shell($, command, tool)), `${tool}: ${command}`).toBe(true)
    }
  })

  test('K15 enforce: ready, a label add and a self-confirm are denied; --undo and plain reads pass; reads spawn nothing', async ($, on) => {
    const { seen } = world(on, { files: CONFIG_ENFORCE })
    await start($)
    for (const command of [
      'gh pr ready 201',
      'gh pr edit 201 --add-label review:none',
      'node scripts/github/pr-checkpoint.mjs --confirm none --by dave --body b.md',
      'node scripts/github/pr-checkpoint.mjs --apply 201',
    ]) {
      expect(LOCK_DENIED(await shell($, command))).toBe(true)
      expect(LOCK_DENIED(await shell($, command, 'PowerShell'))).toBe(true)
    }
    expect(seen.ran).toEqual([])
    seen.run.length = 0
    // No gated word in these: no prefilter hit, so the lock spawns nothing.
    for (const command of ['gh pr view 201', 'git status', 'node scripts/github/pr-checkpoint.mjs --json']) {
      expect(LOCK_DENIED(await shell($, command))).toBe(false)
    }
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
    // These hit the prefilter and go to the CLI, which reports no gated shape: they pass.
    for (const command of ['gh pr ready 201 --undo', 'gh pr view 201 --json labels']) {
      expect(LOCK_DENIED(await shell($, command))).toBe(false)
    }
    expect(seen.ran.length).toBe(5)
  })

  test('K15b the CLI gets the whole command on stdin and the shell of the tool; the SKIP_PRE_PR_GATE prefix does not lift the lock', async ($, on) => {
    // This fake CLI joins nothing: it says "ready" when the word is in the text it was given. The real joining is tested in checkpoint-shapes-cli.test.ts.
    const sawReady = (command: string): Reply => ({ stdout: JSON.stringify({ create: false, nonDraft: false, ready: command.includes('ready'), label: null, self: false, nonLiteral: false, ccv3: false }) })
    const { seen } = world(on, { files: CONFIG_ENFORCE, shapes: sawReady })
    await start($)
    const prefixed = 'SKIP_PRE_PR_GATE=1 gh pr ready 201'
    expect(LOCK_DENIED(await shell($, prefixed))).toBe(true)
    const backtick = 'gh pr `\r\nready 201'
    expect(LOCK_DENIED(await shell($, backtick, 'PowerShell'))).toBe(true)
    const calls = seen.run.filter(r => r.argv.some(a => a.includes('checkpoint-shapes-cli')))
    expect(calls.length).toBe(2)
    expect(calls[0]!.stdin).toBe(prefixed)
    expect(calls[0]!.argv).toEqual(['node', SHAPES_CLI, '--shell', 'bash'])
    expect(calls[1]!.stdin).toBe(backtick)
    expect(calls[1]!.argv).toEqual(['node', SHAPES_CLI, '--shell', 'pwsh'])
  })

  test('K16 enforce: a label add is allowed only with a store record for this PR number, this HEAD and this label', async ($, on) => {
    const record = { pr: 201, state: 'confirmed', head: HEAD, label: 'review:coderabbit', pathway: 'coderabbit' }
    const w = world(on, { files: CONFIG_ENFORCE, store: { 'checkpoint:pr:201': record } })
    await start($)
    expect(LOCK_DENIED(await shell($, 'gh pr edit 201 --add-label review:coderabbit'))).toBe(false)
    expect(w.seen.ran.length).toBe(1)
    for (const command of [
      'gh pr edit 201 --add-label review:none',
      'gh pr edit 201 --add-label review:coderabbit,review:deep',
      'gh pr edit 202 --add-label review:coderabbit',
    ]) {
      expect(LOCK_DENIED(await shell($, command))).toBe(true)
    }
    expect(w.seen.ran.length).toBe(1)
  })

  test('K16c (guard) enforce: a store record in state applied allows the label too (plan 3.4: confirmed or applied)', async ($, on) => {
    const record = { pr: 201, state: 'applied', head: HEAD, label: 'review:coderabbit', pathway: 'coderabbit' }
    const w = world(on, { files: CONFIG_ENFORCE, store: { 'checkpoint:pr:201': record } })
    await start($)
    expect(LOCK_DENIED(await shell($, 'gh pr edit 201 --add-label review:coderabbit'))).toBe(false)
    expect(w.seen.ran.length).toBe(1)
  })

  for (const [name, record] of [
    ['another head', { pr: 201, state: 'confirmed', head: OTHER_HEAD, label: 'review:coderabbit' }],
    ['a record that is only pending', { pr: 201, state: 'pending', head: HEAD, label: 'review:coderabbit' }],
  ] as [string, Rec][]) {
    test(`K16b enforce: a store record with ${name} does not allow the label`, async ($, on) => {
      const w = world(on, { files: CONFIG_ENFORCE, store: { 'checkpoint:pr:201': record } })
      await start($)
      expect(LOCK_DENIED(await shell($, 'gh pr edit 201 --add-label review:coderabbit'))).toBe(true)
      expect(w.seen.ran).toEqual([])
    })
  }

  test('K17 warn mode (enforce false): the shapes pass, one toast per pattern per session', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(LOCK_DENIED(await shell($, 'gh pr ready 201'))).toBe(false)
    expect(LOCK_DENIED(await shell($, 'gh pr ready 202'))).toBe(false)
    expect(LOCK_DENIED(await shell($, 'gh pr edit 201 --add-label review:none'))).toBe(false)
    expect(seen.ran.length).toBe(3)
    // Two patterns (ready, review-label), two lock toasts: the second ready adds none. Toasts of other modules do not count.
    // The lock's toast names its pattern id (contract: prC-red.md).
    const lockToasts = seen.toasts.filter(text => /\bready\b|review-label/i.test(text))
    expect(lockToasts.length).toBe(2)
    expect(lockToasts.filter(text => /review-label/i.test(text)).length).toBe(1)
    expect(lockToasts.filter(text => /\bready\b/i.test(text) && !/review-label/i.test(text)).length).toBe(1)
  })

  for (const config of ['{"checkpoint":{"enforce":"true"}}', '{"checkpoint":{"enforce":1}}', 'not json']) {
    test(`K17b (guard) config ${config} is warn mode: only a boolean true enforces`, async ($, on) => {
      const { seen } = world(on, { files: { [CONFIG]: config } })
      await start($)
      expect(LOCK_DENIED(await shell($, 'gh pr ready 201'))).toBe(false)
      expect(seen.ran.length).toBe(1)
    })
  }

  for (const [name, shapes] of [
    ['exits 2', { exitCode: 2, stderr: 'no input' }],
    ['prints bad JSON', { stdout: 'not json' }],
    ['times out', 'throw'],
  ] as [string, Reply][]) {
    for (const [mode, files] of [['warn', undefined], ['enforce', CONFIG_ENFORCE]] as const) {
      test(`K18 the shapes CLI ${name} after a prefilter hit: denied in ${mode} mode`, async ($, on) => {
        const { seen } = world(on, { shapes, files })
        await start($)
        expect(LOCK_DENIED(await shell($, 'gh pr ready 201'))).toBe(true)
        expect(seen.ran).toEqual([])
      })
    }
  }

  test('K19 a throw inside the lock denies with the lock-failed text, and the command never ran', async ($, on) => {
    // The store holds a valid record for this PR, head and label, so only the .catch path can deny this command.
    const valid = { pr: 201, state: 'confirmed', head: HEAD, label: 'review:coderabbit', pathway: 'coderabbit' }
    const { seen } = world(on, { files: CONFIG_ENFORCE, store: { 'checkpoint:pr:201': valid }, throwStore: 'checkpoint:pr:' })
    await start($)
    const r = await shell($, 'gh pr edit 201 --add-label review:coderabbit')
    expect(LOCK_DENIED(r)).toBe(true)
    expect(r.deny).toMatch(/lock failed/i)
    expect(r.deny).not.toMatch(/review-label/i)
    expect(seen.ran).toEqual([])
  })

  test('K19a (guard) the same valid record without the throw allows the command, so K19 denies for the throw alone', async ($, on) => {
    const valid = { pr: 201, state: 'confirmed', head: HEAD, label: 'review:coderabbit', pathway: 'coderabbit' }
    const { seen } = world(on, { files: CONFIG_ENFORCE, store: { 'checkpoint:pr:201': valid } })
    await start($)
    expect(LOCK_DENIED(await shell($, 'gh pr edit 201 --add-label review:coderabbit'))).toBe(false)
    expect(seen.ran.length).toBe(1)
  })

  for (const [name, arm] of [
    ['fs.exists', (fail: { exists: boolean; root: boolean }) => { fail.exists = true }],
    ['session.root', (fail: { exists: boolean; root: boolean }) => { fail.root = true }],
  ] as const) {
    for (const [mode, files] of [['warn', undefined], ['enforce', CONFIG_ENFORCE]] as const) {
      test(`K19e a failing ${name} after a prefilter hit is denied with the lock-failed text in ${mode} mode, and the command never ran`, async ($, on) => {
        const w = world(on, { files })
        await start($)
        arm(w.fail)
        const r = await shell($, 'gh pr ready 201')
        expect(LOCK_DENIED(r)).toBe(true)
        expect(r.deny).toMatch(/lock failed/i)
        expect(w.seen.ran).toEqual([])
      })
    }
  }

  test('K19b (guard) outside a CCv3 root, a ready or label shape passes with no spawn and no deny', async ($, on) => {
    const other = world(on, { root: 'C:/other', missing: ['C:/other/scripts/github/pr-checkpoint.mjs', 'C:/other/.claude/hooks/dist'], files: { 'C:/other/review-router.config.json': '{"checkpoint":{"enforce":true}}' } })
    await start($)
    for (const command of ['gh pr ready 201', 'gh pr view 201 --json labels', 'gh api graphql -f query=addLabelsToLabelable', 'gh pr edit 201 --add-label review:none']) {
      expect(LOCK_DENIED(await shell($, command))).toBe(false)
    }
    expect(other.seen.ran.length).toBe(4)
    expect(argvOf(other.seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  // The CLI's `ccv3` is the gate's own reader of a visible CCv3 signal. Dave's PR B rule: the hook never names a foreign repo; a gated command from a
  // CCv3 checkout is always gated, whatever -R it holds. This root has scripts/github/pr-checkpoint.mjs, so it is a CCv3 checkout.
  const ccv3Reply = (ccv3: boolean) => (command: string): Reply => ({
    stdout: JSON.stringify({
      create: false, nonDraft: false, ready: /ready/.test(command), label: /add-label/.test(command) ? { labels: ['review:none'], blind: false } : null,
      self: false, nonLiteral: false, ccv3,
    }),
  })

  test('K19c in a CCv3 root a gated shape is denied even when the CLI says ccv3 false (a foreign -R does not lift it), and the CLI was asked', async ($, on) => {
    const { seen } = world(on, { files: CONFIG_ENFORCE, shapes: ccv3Reply(false) })
    await start($)
    const commands = ['gh pr ready 201 -R someone/else', 'gh pr edit 201 --repo someone/else --add-label review:none', 'GH_REPO=someone/else gh pr ready 201']
    for (const command of commands) expect(LOCK_DENIED(await shell($, command)), command).toBe(true)
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli').length).toBe(3)
  })

  for (const [name, command, ccv3] of [
    ['a compound command whose second ready names no repo', 'gh pr ready 1 -R a/b; gh pr ready 2', false],
    ['raw -R text that names a foreign repo while the CLI reads the CCv3 fork', 'gh pr ready 201 -R someone/else', true],
    ['a non-literal -R value', 'gh pr ready 201 -R "$TARGET"', false],
    ['a ready that names the CCv3 repo', 'gh pr ready 201 -R Rev4nchist/Continuous-Claude-v3', true],
    ['one foreign and one unnamed label add', 'gh pr edit 1 --repo a/b --add-label review:none && gh pr ready 2', false],
  ] as [string, string, boolean][]) {
    test(`K19d enforce: ${name} is denied in a CCv3 root, whatever ccv3 says`, async ($, on) => {
      const { seen } = world(on, { files: CONFIG_ENFORCE, shapes: ccv3Reply(ccv3) })
      await start($)
      expect(LOCK_DENIED(await shell($, command))).toBe(true)
      expect(seen.ran).toEqual([])
    })
  }
})

describe('pr-checkpoint: kill switches', () => {
  for (const env of [{ CCV3_MODS_OFF: '1' }, { CCV3_PR_CHECKPOINT_OFF: '1' }] as Record<string, string>[]) {
    test(`K22 (guard) ${Object.keys(env)[0]}=1 leaves no tool, no command and no lock`, async ($, on) => {
      const { seen } = world(on, { env, files: CONFIG_ENFORCE })
      await start($)
      expect(seen.tools).not.toContain('pr_checkpoint')
      expect(seen.registered).not.toContain(COMMAND)
      const r = (await $.tool.call({ tool: 'Bash', command: 'gh pr ready 201' } as never)) as unknown as { deny?: string }
      expect(LOCK_DENIED(r)).toBe(false)
      const w = (await $.tool.call({ tool: 'Write', file_path: 'C:/r/.claude/cache/pre-pr/pathway.json', content: '{}' } as never)) as unknown as { deny?: string }
      expect(LOCK_DENIED(w)).toBe(false)
    })
  }
})

describe('pr-checkpoint: asks from the watcher', () => {
  const watchDoc = (extra: Rec = {}) => ({ [WATCH]: { prs: [{ pr: 7, state: null, whenReady: false, ...extra }], backoffUntil: 0, touched: NOW } })
  const record = (over: Rec = {}) => ({
    pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default',
    capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 26 * MIN, ...over,
  })
  const REVIEWED = (rounds: number) => status(7, {
    reasons: ['1 review thread(s) unresolved'], unresolved: 1, coderabbitReviewedHead: true, routedReviewed: true, coderabbitRounds: rounds, coderabbitRequests: Math.max(0, rounds - 1),
  })
  const asksOf = (store: Map<string, unknown>) => (store.get(ASKS) ?? []) as Rec[]
  // Clock anchor (critic finding 14): the 30 minutes of the opening ask run from `appliedAt`, the moment the mod's --apply succeeded.
  // That is when the engine marked the PR ready, so it is "since the PR left draft" (plan 4.2). A2 and A2b move `appliedAt`, not a PR field.
  /** The first button of an ask pane is the recommendation: same look as the first option in K1. */
  const expectRecommendedFirst = async (pane: Pane, order: [string, string]) => {
    expect(await keys(pane)).toEqual(order)
    const [first, second] = await buttons(pane)
    expect(first!.props.hotkey).toBe('1')
    expect(first!.props.autoFocus).toBe(true)
    expect(first!.props.variant).toBe('primary')
    expect(first!.text).toContain('(Recommended)')
    expect(second!.props.hotkey).toBe('2')
    expect(second!.props.autoFocus).not.toBe(true)
    expect(second!.text).not.toContain('(Recommended)')
  }

  test('A1 a round ask at budget + 1: No is first, the text names the round and the 7d count, and nothing is posted', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await w.clock.advance(TICK)
    const asks = asksOf(w.store)
    expect(asks.length).toBe(1)
    expect(asks[0]!.kind).toBe('round')
    expect(asks[0]!.pr).toBe(7)
    expect(asks[0]!.head).toBe(HEAD)
    expect(String(asks[0]!.text)).toContain('Round 4 of 1+2 for #7')
    expect(String(asks[0]!.text)).toMatch(/7d.*38/)
    expect(w.seen.opens.length).toBe(1)
    expect(w.seen.opens[0]!.focus).toBe(true)
    const pane = await mountPane($)
    await expectRecommendedFirst(pane, ['ask-no', 'ask-yes'])
    expect(await paneText(pane)).toContain('Round 4 of 1+2 for #7')
    expect(counts(w.seen).comments).toEqual([])
    expect(w.seen.asks).toEqual([])
  })

  test('A1b round ask, Yes: a grant for round 4 on this head, the model is told, and the mod posts nothing', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await w.clock.advance(TICK)
    const pane = await mountPane($)
    const submitted = w.seen.submits.length
    await pane.press({ key: 'ask-yes' })
    const grant = w.store.get('checkpoint:grant:7') as Rec
    expect(grant.round).toBe(4)
    expect(grant.head).toBe(HEAD)
    expect(asksOf(w.store)).toEqual([])
    expect(counts(w.seen).comments).toEqual([])
    const rows = JSON.stringify(w.session.appended().map(row => row.message))
    expect(rows).toContain('Dave allowed round 4 for #7')
    expect(w.seen.submits.length).toBe(submitted)
  })

  test('A1c round ask, No: the ask is declined on the record, the model is told, no grant, nothing posted', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await w.clock.advance(TICK)
    const pane = await mountPane($)
    await pane.press({ key: 'ask-no' })
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    const declined = (w.store.get('checkpoint:pr:7') as Rec).declined as Rec
    expect(declined.kind).toBe('round')
    expect(declined.round).toBe(4)
    expect(declined.head).toBe(HEAD)
    expect(counts(w.seen).comments).toEqual([])
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Dave declined round 4 for #7')
  })

  test('A2 an opening ask 30 minutes after ready: Yes is first (the recommendation) and posts exactly one @coderabbitai review', async ($, on) => {
    const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet } })
    await start($)
    await w.clock.advance(TICK)
    const asks = asksOf(w.store)
    expect(asks.length).toBe(1)
    expect(asks[0]!.kind).toBe('opening')
    expect(String(asks[0]!.text)).toContain('CodeRabbit has not started on #7 30 minutes after ready')
    const pane = await mountPane($)
    await expectRecommendedFirst(pane, ['ask-yes', 'ask-no'])
    await pane.press({ key: 'ask-yes' })
    const posts = counts(w.seen).comments
    expect(posts.length).toBe(1)
    expect(posts[0]).toEqual(['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@coderabbitai review'])
    expect(asksOf(w.store)).toEqual([])
    expect(w.seen.asks).toEqual([])
  })

  test('A2d opening ask, No: nothing is posted, the record is declined, the model is told, and the ask does not come back', async ($, on) => {
    const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet } })
    await start($)
    await w.clock.advance(TICK)
    const pane = await mountPane($)
    await pane.press({ key: 'ask-no' })
    expect(counts(w.seen).comments).toEqual([])
    expect(asksOf(w.store)).toEqual([])
    expect(((w.store.get('checkpoint:pr:7') as Rec).declined as Rec).kind).toBe('opening')
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Do not request a review on #7')
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(asksOf(w.store)).toEqual([])
    expect(counts(w.seen).comments).toEqual([])
    expect(w.seen.opens.length).toBe(1)
  })

  for (const [name, view] of [
    ['the PR was merged', { state: 'MERGED', headRefOid: HEAD }],
    ['the PR was closed', { state: 'CLOSED', headRefOid: HEAD }],
    ['the head moved', { state: 'OPEN', headRefOid: OTHER_HEAD }],
  ] as const) {
    test(`A2e a late Yes on the opening ask posts nothing when ${name}: the ask is dropped and Dave gets a toast`, async ($, on) => {
      const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet }, view: { stdout: JSON.stringify(view) } })
      await start($)
      await w.clock.advance(TICK)
      expect(asksOf(w.store).length).toBe(1)
      const pane = await mountPane($)
      await pane.press({ key: 'ask-yes' })
      expect(counts(w.seen).comments).toEqual([])
      expect(asksOf(w.store)).toEqual([])
      expect(w.seen.toasts.some(text => /#7/.test(text) && /no longer|merged|closed|moved/i.test(text))).toBe(true)
      expect(argvOf(w.seen, 'view').some(argv => argv.includes('state,headRefOid'))).toBe(true)
    })
  }

  for (const [name, view] of [
    ['gh fails to start', 'throw'],
    ['gh exits 1', { exitCode: 1, stderr: 'HTTP 502' }],
    ['gh prints no JSON', { stdout: 'not json' }],
  ] as [string, Reply][]) {
    test(`A2f a Yes posts nothing when the PR state cannot be read (${name}): the ask stays queued and Dave gets a toast`, async ($, on) => {
      const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet }, view })
      await start($)
      await w.clock.advance(TICK)
      const pane = await mountPane($)
      await pane.press({ key: 'ask-yes' })
      expect(counts(w.seen).comments).toEqual([])
      expect(asksOf(w.store).length).toBe(1)
      expect(w.seen.toasts.some(text => /#7/.test(text) && /could not read/i.test(text))).toBe(true)
    })
  }

  test('A2b the opening ask waits for 30 minutes after ready: none at 29 minutes, the ask at 30', async ($, on) => {
    const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    // The first check runs one TICK (5 minutes) after the start. appliedAt 24 minutes back makes that check 29 minutes after ready.
    const early = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ appliedAt: NOW - 24 * MIN }) }, statuses: { 7: quiet } })
    await start($)
    await early.clock.advance(TICK)
    expect(asksOf(early.store)).toEqual([])
    expect(early.seen.opens).toEqual([])
    await early.clock.advance(TICK)
    expect(asksOf(early.store).map(ask => ask.kind)).toEqual(['opening'])
  })

  test('A2b2 the opening ask comes at exactly 30 minutes after ready', async ($, on) => {
    const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const exact = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ appliedAt: NOW - 25 * MIN }) }, statuses: { 7: quiet } })
    await start($)
    await exact.clock.advance(TICK)
    expect(asksOf(exact.store).map(ask => ask.kind)).toEqual(['opening'])
  })

  test('A2f (guard) no opening ask while the CodeRabbit status is pending: the review may be starting; the ask comes when it is not', async ($, on) => {
    const pending = status(7, { coderabbit: 'pending', reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const wait = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: pending } })
    await start($)
    await wait.clock.advance(TICK)
    await wait.clock.advance(TICK)
    expect(asksOf(wait.store)).toEqual([])
    expect(wait.seen.opens).toEqual([])
  })

  for (const coderabbit of ['absent', 'success']) {
    test(`A2g the same PR with the CodeRabbit status ${coderabbit} (not pending) gets the opening ask`, async ($, on) => {
      const quiet = status(7, { coderabbit, reasons: ['no CodeRabbit PR-bot review of the head commit'] })
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet } })
      await start($)
      await w.clock.advance(TICK)
      expect(asksOf(w.store).map(ask => ask.kind)).toEqual(['opening'])
    })
  }

  test('A2c (guard) the opening ask is not asked while CodeRabbit is rate limited', async ($, on) => {
    const limited = status(7, { coderabbitLimited: true, coderabbitRateLimited: true, reasons: ['CodeRabbit rate limited: head not reviewed'] })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: limited } })
    await start($)
    await w.clock.advance(TICK)
    expect(asksOf(w.store)).toEqual([])
    expect(w.seen.opens).toEqual([])
  })

  test('A3 the Greptile ask on a both PR: once, No first, Yes posts one @greptileai, and a No ends it', async ($, on) => {
    const both = record({ pathway: 'both', label: 'review:deep' })
    const clean = status(7, {
      routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, routedReviewed: false, reviewedHead: false,
      coderabbitRounds: 1, reasons: ['no Greptile check on the head commit yet (review pending)'],
    })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': both }, statuses: { 7: clean } })
    await start($)
    await w.clock.advance(TICK)
    const asks = asksOf(w.store)
    expect(asks.length).toBe(1)
    expect(asks[0]!.kind).toBe('greptile')
    expect(String(asks[0]!.text)).toContain('Ask Greptile to review the final head aaaaaaa of #7? 3 credits (Plus)')
    const pane = await mountPane($)
    await expectRecommendedFirst(pane, ['ask-no', 'ask-yes'])
    await pane.press({ key: 'ask-no' })
    expect(counts(w.seen).comments).toEqual([])
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(asksOf(w.store)).toEqual([])
    expect(w.seen.opens.length).toBe(1)
  })

  test('A3b Greptile ask, Yes: exactly one @greptileai comment and the ask leaves the queue', async ($, on) => {
    const clean = status(7, {
      routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, reviewedHead: false, coderabbitRounds: 1,
      reasons: ['no Greptile check on the head commit yet (review pending)'],
    })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ pathway: 'both', label: 'review:deep' }) }, statuses: { 7: clean } })
    await start($)
    await w.clock.advance(TICK)
    const pane = await mountPane($)
    await pane.press({ key: 'ask-yes' })
    const posts = counts(w.seen).comments
    expect(posts.length).toBe(1)
    expect(posts[0]).toEqual(['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@greptileai'])
    expect(asksOf(w.store)).toEqual([])
  })

  for (const [name, pathway, body] of [
    ['opening', 'coderabbit', '@coderabbitai review'],
    ['greptile', 'both', '@greptileai'],
  ] as const) {
    test(`A5 two overlapping Yes presses on the ${name} ask post exactly one comment`, async ($, on) => {
      const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
      const clean = status(7, {
        routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, reviewedHead: false, coderabbitRounds: 1,
        reasons: ['no Greptile check on the head commit yet (review pending)'],
      })
      let release: () => void = () => undefined
      const gate = new Promise<void>(resolve => (release = resolve))
      const w = world(on, {
        store: { ...watchDoc(), 'checkpoint:pr:7': record(pathway === 'both' ? { pathway: 'both', label: 'review:deep' } : {}) },
        statuses: { 7: pathway === 'both' ? clean : quiet },
        gate,
      })
      await start($)
      await w.clock.advance(TICK)
      const pane = await mountPane($)
      const first = pane.press({ key: 'ask-yes' })
      const second = pane.press({ key: 'ask-yes' })
      await settle()
      release()
      await Promise.all([first, second])
      await settle()
      const posts = counts(w.seen).comments
      expect(posts.length).toBe(1)
      expect(posts[0]).toEqual(['gh', 'pr', 'comment', '7', '-R', REPO, '--body', body])
      expect(asksOf(w.store)).toEqual([])
    })
  }

  test('A5b a failed post frees the press: the ask stays queued and a second Yes posts', async ($, on) => {
    const quiet = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: quiet }, comments: [{ exitCode: 1, stderr: 'HTTP 502' }, OK] })
    await start($)
    await w.clock.advance(TICK)
    const pane = await mountPane($)
    await pane.press({ key: 'ask-yes' })
    expect(counts(w.seen).comments.length).toBe(1)
    expect(asksOf(w.store).length).toBe(1)
    await pane.press({ key: 'ask-yes' })
    expect(counts(w.seen).comments.length).toBe(2)
    expect(asksOf(w.store)).toEqual([])
  })

  test('A3c (guard) a coderabbit-pathway PR is never asked for Greptile', async ($, on) => {
    const clean = status(7, {
      routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, reviewedHead: false, coderabbitRounds: 1,
      reasons: ['no Greptile check on the head commit yet (review pending)'],
    })
    const only = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: clean } })
    await start($)
    await only.clock.advance(TICK)
    expect(asksOf(only.store).filter(ask => ask.kind === 'greptile')).toEqual([])
    expect(only.seen.opens).toEqual([])
  })

  test('A4 an ask with isPlaced false gives a toast with the reason and "type /<command>"; the command then draws the ask', async ($, on) => {
    const w = world(on, {
      store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) },
      open: { isPlaced: false, reason: 'the terminal is 100 columns wide; a pane waits below 144' },
    })
    await start($)
    await w.clock.advance(TICK)
    expect(asksOf(w.store).length).toBe(1)
    expect(w.seen.toasts.some(text => text.includes(`type /${COMMAND}`) && text.includes('#7'))).toBe(true)
    expect(w.seen.toasts.some(text => text.includes('100 columns wide'))).toBe(true)
    const before = w.seen.opens.length
    await slash($, '')
    expect(w.seen.opens.length).toBe(before + 1)
    const pane = await mountPane($)
    expect(await keys(pane)).toEqual(['ask-no', 'ask-yes'])
  })
})
