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
// K2  Accept does not run --confirm <rec> --by dave (a tap is always dave; v2) then --apply, or the work waits on a timer (decision: press work runs INLINE)
// K3  another option does not run --by dave
// K4  headless runs --confirm, --apply or gh, opens a pane, or returns no text plan
// K5  /pathway <pr> none costs a model turn (prompt.submit) or does not record; K5b accept (a paid one raises the one question; his tap on the paid row records by dave); K5c usage text
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
  /** The label names `gh pr view` answers with. Unset: none. */
  labels?: string[]
  throwStore?: string
  /** A `store.delete` whose key starts with this text throws (a store that fails after a good apply). */
  throwDelete?: string
  /** The first `store.set` whose key starts with this text throws; later ones work. */
  throwSetOnce?: string
  /** A `store.set` for which this returns true throws (a write that fails for one value only, or every time). */
  throwSetWhen?: (key: string, value: unknown) => boolean
  /** A file write whose path contains this text throws (a full disk, a locked file). */
  throwWrite?: string
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
  /** Replies for the first `gh pr view` calls, in order; later calls answer by `view` or the default. */
  viewSeq?: Reply[]
  /** What slot-queue.mjs prints. Unset: a good `add`. */
  slot?: Reply
  /** Replies for the first `--apply` calls, in order; later calls answer by `apply`. */
  applySeq?: Reply[]
  /** What the mod's own call that returns a ready PR to draft answers. Unset: success. */
  undo?: Reply
  /** What the engine's `--drop-taps` answers (the tap drop of a PR returned to draft). Unset: success. */
  drop?: Reply
  /** Replies for the first `--drop-taps` calls, in order; later calls answer by `drop`. */
  dropSeq?: Reply[]
  /** Replies for the first engine `--json` calls that carry --no-ledger (the prepare call), in order; later calls answer by `json`. */
  jsonSeq?: Reply[]
  /** Replies for the first engine `--json` calls WITHOUT --no-ledger (the ledger step), in order; later calls answer by `json`. */
  ledgerSeq?: Reply[]
  /** How Dave answers the dialog the mod raises ($.ui.ask). Unset: he closes it (Esc). 'manual': the test answers it through `seen.dialogs[n].answer(...)`. */
  answer?: Answer
  /** One answer per dialog, in order; later dialogs use `answer`. */
  answers?: Answer[]
}

/** A label (RegExp: the first label that matches; string: that text), Esc, an empty answer, text typed under Other, or a function of the labels. */
type Answer = string | RegExp | { other: string } | 'dismiss' | 'empty' | 'manual' | ((labels: string[], question: string) => Answer)
type Dialog = { question: string; header: string | undefined; labels: string[]; answer: (a: Answer) => void }

/** Set by `openPane` (the old pane tests): a dialog waits for the test to press. Reset by every `world`. */
let manualDefault = false
/** The `seen` of the newest world, for the helpers that take no world. */
let lastSeen: { dialogs: Dialog[] } | null = null

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
  lastSeen = null
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
    dialogs: [] as Dialog[],
    descriptions: [] as string[],
    opens: [] as Rec[],
    closes: 0,
    registered: [] as string[],
    tools: [] as string[],
    ran: [] as { tool: string; text: string }[],
    writes: [] as string[],
    /** `next.origin` of each AskUserQuestion that reached the bottom (T0). */
    origins: [] as { plugin: unknown; tier: unknown }[],
  }
  manualDefault = false
  lastSeen = seen
  const root = opts.root ?? ROOT
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false } }), ...(opts.files ?? {}) }
  const statuses = opts.statuses ?? {}
  // Armed by a test after `start`, so only the call under test throws.
  const fail = { exists: false, root: false, set: false, env: false, setOnceDone: false }

  on('store.get', (_$, e) => {
    if (opts.throwStore && e.key.startsWith(opts.throwStore)) throw new Error('store failed')
    return { value: store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    if (fail.set && e.key.startsWith('checkpoint:pr:')) throw new Error('store.set failed')
    if (opts.throwSetWhen?.(e.key, e.value)) throw new Error('store.set failed (throwSetWhen)')
    if (opts.throwSetOnce && !fail.setOnceDone && e.key.startsWith(opts.throwSetOnce)) {
      fail.setOnceDone = true
      throw new Error('store.set failed once')
    }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    if (opts.throwDelete && e.key.startsWith(opts.throwDelete)) throw new Error('store.delete failed')
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
  // The /pathway log is read back by the mod (read, add a line, write the whole file), so its writes are kept and read again.
  const written: Record<string, string> = {}
  on('fs.read', (_$, e) => {
    const text = files[slash(e.path)] ?? (slash(e.path).endsWith('.jsonl') ? written[slash(e.path)] : undefined)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    if (opts.throwWrite && slash(e.path).includes(opts.throwWrite)) throw new Error('write failed')
    seen.writes.push(e.path)
    written[slash(e.path)] = e.text
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    if (e.name === 'pathway') seen.descriptions.push(String((e as unknown as { description?: string }).description))
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    seen.tools.push(e.name)
    if (e.name === 'pr_checkpoint') seen.descriptions.push(String((e as unknown as { description?: string }).description))
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
      // The state read of the watcher's asks (`--json state,...`) asks about a PR that is READY (a draft gets no ask): its default is not a draft.
      const stateRead = (argv[argv.indexOf('--json') + 1] ?? '').startsWith('state')
      const reply: Reply = opts.viewSeq?.shift() ?? opts.view ?? {
        stdout: JSON.stringify({ isDraft: opts.isDraft ?? !stateRead, state: 'OPEN', headRefOid: opts.viewHead ?? HEAD, headRefName: opts.branch ?? 'feat/x', author: { login: opts.author ?? 'Rev4nchist' }, labels: (opts.labels ?? []).map(name => ({ name })), number: Number(argv[3]) }),
      }
      return done(reply)
    }
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'comment') {
      if (opts.gate) return opts.gate.then(() => done(OK)) as never
      return done(opts.comments?.shift() ?? OK)
    }
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'ready') return done(opts.undo ?? OK)
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
      if (argv.includes('--drop-taps')) return done(opts.dropSeq?.shift() ?? opts.drop ?? { stdout: '{"ok":true,"dropped":0}\n' })
      if (argv.includes('--json')) {
        // The real engine adds the ledger block only without --no-ledger (pr-checkpoint.mjs runRecommend).
        const noLedger = argv.includes('--no-ledger')
        const reply = (noLedger ? opts.jsonSeq?.shift() : opts.ledgerSeq?.shift()) ?? opts.json ?? { stdout: JSON.stringify(engineJson()) }
        if (!noLedger || reply === 'throw' || reply.stdout === undefined) return done(reply)
        try {
          const { ledger: _ledger, ...plain } = JSON.parse(reply.stdout) as Rec
          return done({ ...reply, stdout: JSON.stringify(plain) })
        } catch {
          return done(reply)
        }
      }
      if (argv.includes('--confirm')) {
        const pathway = argv[argv.indexOf('--confirm') + 1]
        const by = argv[argv.indexOf('--by') + 1]
        const label = pathway === 'none' ? 'review:none' : pathway === 'both' ? 'review:deep' : 'review:coderabbit'
        const record = { head: HEAD, body_sha256: 'c'.repeat(64), pathway, label, class: 'infra', recommended: 'coderabbit', decided_by: by, at: '2026-10-28T20:00:00.000Z', budget: pathway === 'none' ? [0, 0] : [1, 2] }
        const reply = done(opts.confirm ?? { stdout: JSON.stringify(record) })
        return opts.gate ? (opts.gate.then(() => reply) as never) : reply
      }
      if (argv.includes('--apply')) return done(opts.applySeq?.shift() ?? opts.apply ?? OK)
      return done({ stdout: `PR checkpoint for ${HEAD.slice(0, 7)}: class infra, 7 file(s), 212 line(s)\nRecommended: coderabbit  budget 1+2\n` })
    }
    if (line.includes('slot-queue.mjs')) {
      return done(opts.slot ?? { stdout: JSON.stringify({ ok: true, item: { state: argv.includes('--round') ? 'awaiting-fix' : 'opening' }, position: null, total: 0, nextSlotInMin: 0 }) })
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
  // The engine draws $.ui.ask as a tool.call of AskUserQuestion; this is its bottom. A call by the model (the test) lands here too.
  const sequence = [...(opts.answers ?? [])]
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e, next) => {
    const origin = (next as unknown as { origin?: { plugin: unknown; tier: unknown } }).origin
    seen.origins.push({ plugin: origin?.plugin, tier: origin?.tier })
    const input = e as unknown as { questions: { question: string; header?: string; options: ({ label: string } | string)[] }[] }
    const q = input.questions[0]!
    const labels = q.options.map(one => (typeof one === 'string' ? one : one.label))
    seen.asks.push(String(q.question))
    const record: Dialog = { question: q.question, header: q.header, labels, answer: () => undefined }
    seen.dialogs.push(record)
    const shape = (spec: Answer): never => {
      const picked = typeof spec === 'function' ? spec(labels, q.question) : spec
      if (picked === 'dismiss') return { deny: 'dismissed' } as never
      if (picked === 'empty') return { result: { questions: [], answers: {} } } as never
      const text = typeof picked === 'object' && 'other' in picked ? picked.other : picked instanceof RegExp ? labels.find(l => picked.test(l)) : picked
      if (text === undefined) throw new Error(`no label matches in ${JSON.stringify(labels)}`)
      // The engine echoes the questions into the result (census 2026-11-09: 521 of 521); the agentic-os tap writer reads them.
      return { result: { questions: input.questions, answers: { [q.question]: text } } } as never
    }
    const spec = sequence.shift() ?? opts.answer ?? (manualDefault ? 'manual' : 'dismiss')
    const resolved = typeof spec === 'function' ? spec(labels, q.question) : spec
    if (resolved !== 'manual') return shape(resolved)
    return new Promise(resolve => {
      record.answer = a => resolve(shape(a) as never)
    }) as never
  })
  return { clock, seen, store, session, fail, written }
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

// The tool call waits for Dave's answer, so the old pane tests press a key in a dialog the test holds open: `openPane` starts the call with the
// dialog in manual mode, `pane.press({ key })` answers it with the label that key stood for and waits for the call to end.
const PRESS: Record<string, Answer> = {
  'opt-coderabbit': /^CodeRabbit review/,
  'opt-none': /^No review, land on CI/,
  'opt-both': /^CodeRabbit \+ Greptile/,
  'opt-wait': /^Keep as draft/,
  dismiss: 'dismiss',
}
/** PR C: a paid row carries its price and its tap is the paid yes, so a press raises no second question. */
/** An Esc is asked again twice (v2, Dave 2026-11-06): the default test answer, a closed dialog, raises the question this many times. */
const ESC_ASKS = 3
/** The engine result when none is the recommendation: a tap on it records at once. */
const NONE_REC_JSON = { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0] })) }
/** PR C: one question. The Recommended row of the default fixture is the paid row, and the tap on it records. */
const PICK_YES: Answer[] = [/\(Recommended\)$/]
const PICK_YES_TWICE: Answer[] = [...PICK_YES, ...PICK_YES]
const argvOf = (seen: { run: Run[] }, part: string) => seen.run.filter(r => r.argv.some(a => a.includes(part))).map(r => r.argv)
const engineCalls = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs'))).map(r => r.argv.slice(2).join(' '))
/** A press returns before its handler ends, so a test waits for the work a press started. */
const settle = async () => {
  for (let turn = 0; turn < 500; turn += 1) await Promise.resolve()
}
/** Waits (real time, a few milliseconds a turn) until `pred` holds: the tool call runs real async work before it raises its dialog. */
const waitFor = async (pred: () => boolean) => {
  for (let turn = 0; turn < 400 && !pred(); turn += 1) await new Promise(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(() => resolve(undefined), 5))
}
const counts = (seen: { run: Run[] }) => ({
  confirm: seen.run.filter(r => r.argv.includes('--confirm')).length,
  apply: seen.run.filter(r => r.argv.includes('--apply')).length,
  comments: seen.run.filter(r => r.argv[0] === 'gh' && r.argv[2] === 'comment').map(r => r.argv),
})

/** Calls the tool the way the model does and leaves the dialog open for the test to answer. `told` settles when the call ends. */
const openPane = async ($: Engine) => {
  manualDefault = true
  await start($)
  const told = callTool($, { pr: 7, body: 'pr-body.md' })
  await waitFor(() => lastSeen!.dialogs.length > 0)
  const dialog = lastSeen!.dialogs[0]
  return {
    told,
    dialog,
    pane: {
      press: async ({ key }: { key: string }) => {
        dialog!.answer(PRESS[key]!)
        // A closed dialog is asked again twice. The press closes those as the same Dave would.
        let ended = false
        void told.then(() => (ended = true))
        for (let next = 1; !ended; ) {
          await new Promise(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(() => resolve(undefined), 2))
          const later = lastSeen!.dialogs[next]
          if (later) {
            later.answer('dismiss')
            next += 1
          }
        }
        await told
        await settle()
      },
    },
  }
}

const CONFIG_ENFORCE = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: true } }) }
const LOCK_DENIED = (r: { deny?: string }) => typeof r.deny === 'string' && r.deny.length > 0

describe('pr-checkpoint: registration and the checkpoint question', () => {
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

  test('K1 the recommendation row is marked (a paid one is row 1, never row 0), not the engine order; the question holds the overview; no pane opens', async ($, on) => {
    const { seen } = world(on)
    const { dialog, pane } = await openPane($)
    // The prepare call posts the rate-limit probe for this PR. The text plan and the record calls never do.
    expect(engineCalls(seen)[0]).toBe('--json --pr 7 --probe --no-ledger')
    expect(seen.opens).toEqual([])
    // PR C: a paid recommendation is row 1; row 0 is Keep as draft, which records nothing.
    expect(dialog!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['Keep as draft', 'CodeRabbit review', 'No review, land on CI'])
    expect(dialog!.labels[1]).toMatch(/\(Recommended\)$/)
    expect(dialog!.labels.filter(label => label.includes('(Recommended)')).length).toBe(1)
    expect(dialog!.header).toBe('PR #7')
    expect(dialog!.question).toContain('#7')
    expect(dialog!.question).toMatch(/7 files/)
    // Three lines: the PR with band and files, the recommendation with its reason, the CodeRabbit slot (no slot fact in this fixture: unknown).
    expect(dialog!.question.split('\n')).toEqual(['PR #7, band unknown, 7 files.', 'Recommended: CodeRabbit review, because infra class.', 'CodeRabbit slot: unknown (no notice seen).', 'Also: critical file touched.', 'Held: CodeRabbit + Greptile (Greptile held: credits unknown).'])
    await pane.press({ key: 'dismiss' })
  })

  test('K1b a Dependabot author is passed to the engine as --dependabot', async ($, on) => {
    const { seen } = world(on, { author: 'dependabot[bot]' })
    const { pane } = await openPane($)
    expect(engineCalls(seen)[0]).toBe('--json --pr 7 --probe --no-ledger --dependabot')
    await pane.press({ key: 'dismiss' })
  })

  test('K12 a held pathway is text in the question with its reason, and has no label', async ($, on) => {
    world(on)
    const { dialog, pane } = await openPane($)
    expect(dialog!.labels.some(label => label.startsWith('CodeRabbit + Greptile'))).toBe(false)
    expect(dialog!.question).toContain('Greptile held: credits unknown')
    await pane.press({ key: 'dismiss' })
  })

  // Config drift row: the engine's own text (config_drift_why) shows in the question. An engine without it (old) keeps the generic warning; no drift shows none.
  test('K1d config drift: the question shows the engine reason (main config unread), not the generic warning', async ($, on) => {
    const why = "Main's review-router.config.json is missing or not JSON, so it counts as drift"
    world(on, { json: { stdout: JSON.stringify(engineJson({ config_drift: true, config_drift_why: why })) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.question).toContain(why)
    expect(dialog!.question).not.toContain('branch config differs from main')
    await pane.press({ key: 'dismiss' })
  })

  // CodeRabbit round 2: the question showed only why[0]. A HIGH or CRITICAL PR with the RF floor has the RB reason first and the floor (aegis + critic) second.
  test('K1g the question shows every reason of the engine, so the internal-pass floor is visible before Dave picks none', async ($, on) => {
    const rb = 'Band HIGH (score 5): no CodeRabbit PR bot under the interim rule.'
    const rf = 'Security-tier file x-guard.ts: run the internal pass (aegis + critic) before READY.'
    world(on, { json: { stdout: JSON.stringify(engineJson({ why: [rb, rf] })) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.question).toContain('no CodeRabbit PR bot under the interim rule')
    expect(dialog!.question).toContain('run the internal pass (aegis + critic) before READY')
    expect(dialog!.question).not.toContain('READY..')
    await pane.press({ key: 'dismiss' })
  })

  test('K1e config drift with no reason keeps the generic warning', async ($, on) => {
    world(on, { json: { stdout: JSON.stringify(engineJson({ config_drift: true })) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.question).toContain('Warning: branch config differs from main')
    await pane.press({ key: 'dismiss' })
  })

  test('K1f no config drift shows no config warning even when a reason string is present', async ($, on) => {
    world(on, { json: { stdout: JSON.stringify(engineJson({ config_drift: false, config_drift_why: 'stale reason' })) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.question).not.toContain('stale reason')
    expect(dialog!.question).not.toMatch(/branch config differs/i)
    await pane.press({ key: 'dismiss' })
  })

  test('K10 an R0 result (no stamp) raises no dialog and the tool text holds the reason', async ($, on) => {
    const w = world(on, { json: { stdout: JSON.stringify(engineJson({ recommended: null, options: [], why: ['Run pre-pr.mjs: no stamp for this head.'], budget: [0, 0] })) } })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(w.seen.dialogs).toEqual([])
    expect(told.text).toContain('Run pre-pr.mjs')
  })

  test('K2 the recommended label (its tap is the paid yes) runs --confirm <recommended> --by dave then --apply, inline (no timer), and records the store', async ($, on) => {
    const { seen, store } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    // No clock.advance here on purpose. Decision (plan review 7): the answer's work runs inside the call.
    const calls = engineCalls(seen).filter(call => !call.startsWith('--json'))
    expect(calls.length).toBe(2)
    expect(calls[0]).toMatch(/^--confirm coderabbit --by dave --body \S*pr-body\.md --pr 7$/)
    expect(calls[1]).toBe('--apply 7')
    expect(seen.run.find(r => r.argv.includes('--confirm'))?.cwd).toBe(ROOT)
    const record = store.get('checkpoint:pr:7') as Rec
    expect(record.state).toBe('applied')
    expect(record.pathway).toBe('coderabbit')
    expect(record.label).toBe('review:coderabbit')
    expect(record.head).toBe(HEAD)
    expect(record.budget).toEqual([1, 2])
    expect(record.decided_by).toBe('dave')
    expect(record.pr).toBe(7)
    expect(record.files).toBe(7)
    expect(record.session).toBe(SESSION)
    expect((record.capacity as Rec).count).toBe(38)
    expect(record.appliedAt).toBe(NOW)
    expect(store.get(PENDING)).toBeUndefined()
    expect(seen.writes.filter(path => path.includes('review-ledger'))).toEqual([])
    expect(seen.asks.length).toBe(1)
    expect(seen.toasts.some(text => /#7/.test(text))).toBe(true)
  })

  test('K3 another label runs --by dave', async ($, on) => {
    const { seen, store } = world(on)
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-none' })
    const calls = engineCalls(seen).filter(call => !call.startsWith('--json'))
    expect(calls[0]).toMatch(/^--confirm none --by dave --body \S*pr-body\.md --pr 7$/)
    expect(calls[1]).toBe('--apply 7')
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    expect((store.get('checkpoint:pr:7') as Rec).budget).toEqual([0, 0])
  })

  test('K2b a second call while the first still records runs the engine once: one --confirm and one --apply', async ($, on) => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const { seen } = world(on, { gate, answers: PICK_YES })
    await start($)
    const first = callTool($, { pr: 7, body: 'pr-body.md' })
    await waitFor(() => seen.dialogs.length > 0)
    const second = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(second.text).toMatch(/question is open/i)
    release()
    await first
    await settle()
    expect(counts(seen).confirm).toBe(1)
    expect(counts(seen).apply).toBe(1)
  })

  test('K7 Keep as draft when it is the recommendation: it comes first, records nothing and says the PR stays a draft', async ($, on) => {
    const wait = engineJson({
      recommended: 'wait',
      capacity: { count: 55, band: 'high', warning: 'CodeRabbit 7-day count is 55', source: 'manual', date: '2026-10-25' },
      options: [option('wait'), option('coderabbit'), option('none')],
    })
    const { seen, store } = world(on, { json: { stdout: JSON.stringify(wait) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.labels[0]).toMatch(/^Keep as draft .*\(Recommended\)$/)
    expect(dialog!.question).toContain('CodeRabbit 7-day count is 55')
    await pane.press({ key: 'opt-wait' })
    expect(counts(seen).confirm).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(seen.toasts.some(text => /stays a draft/i.test(text))).toBe(true)
  })

  test('K8 a refused --confirm gives the engine line to the model and never applies', async ($, on) => {
    const { seen, store } = world(on, { confirm: { exitCode: 1, stderr: 'pr-checkpoint: refused: The PR body is not the body pre-pr.mjs checked.\n' }, answers: PICK_YES })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(told.text).toContain('The PR body is not the body pre-pr.mjs checked.')
    expect(told.text).toMatch(/not recorded/)
  })

  test('K9b a throw after --confirm (the store write fails) is told to the model, frees the flag, and a second call works', async ($, on) => {
    const w = world(on, { answers: PICK_YES_TWICE })
    await start($)
    w.fail.set = true
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(w.seen).confirm).toBe(1)
    expect(counts(w.seen).apply).toBe(0)
    expect(told.text).toMatch(/store\.set/) // the kit skips a throwing hook and reports 'no implementation for store.set'
    expect(told.text).toMatch(/was not recorded/)
    w.fail.set = false
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(w.seen).confirm).toBe(2)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
  })

  // m5 (card prflow-paid-run-guard): the engine marks Keep as draft when the recommendation is held; the mod does the same (one rule, two copies).
  test('K1c a recommendation that is held marks Keep as draft Recommended, and every pick is --by dave', async ($, on) => {
    const held = engineJson({ recommended: 'both', options: [option('none'), option('coderabbit'), option('both', { available: false, reason: 'Greptile held: credits unknown' })] })
    const { seen } = world(on, { json: { stdout: JSON.stringify(held) } })
    const { dialog, pane } = await openPane($)
    expect(dialog!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['Keep as draft', 'CodeRabbit review', 'No review, land on CI'])
    expect(dialog!.labels.filter(label => label.includes('(Recommended)'))).toEqual(['Keep as draft ($0) (Recommended)'])
    expect(dialog!.question).toContain('Greptile held: credits unknown')
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
    const { dialog, pane } = await openPane($)
    expect((store.get(PENDING) as Rec).stamp).toBe('2026-10-30T20:00:00.000Z')
    expect((store.get(PENDING) as Rec).root).toBe(WT)
    const json = seen.run.find(r => r.argv.includes('--json') && r.argv.some(a => a.includes('pr-checkpoint.mjs')))!
    expect(json.argv[1]).toBe(ENGINE)
    expect(json.cwd).toBe(WT)
    expect(cwdOf(seen, 'log').filter(cwd => cwd !== undefined)).toEqual([WT])
    expect(seen.run.find(r => r.argv[0] === 'git' && r.argv.includes('diff'))?.cwd).toBe(WT)
    expect(seen.run.find(r => r.argv[0] === 'git' && r.argv.includes('worktree'))?.cwd).toBe(ROOT)
    expect(dialog!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['Keep as draft', 'CodeRabbit review', 'No review, land on CI'])
    await pane.press({ key: 'dismiss' })
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
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-none' })
    const confirm = seen.run.find(r => r.argv.includes('--confirm'))!
    expect(confirm.argv[confirm.argv.indexOf('--body') + 1]).toBe(`${ROOT}/pr-body.md`)
    expect(confirm.cwd).toBe(WT)
  })

  test('W4 a worktree with no engine in it is not used: the session root runs the engine', async ($, on) => {
    const { seen } = world(on, wtOpts({ missing: [`${WT}/scripts/github/pr-checkpoint.mjs`] }))
    const { pane } = await openPane($)
    const json = seen.run.find(r => r.argv.includes('--json') && r.argv.some(a => a.includes('pr-checkpoint.mjs')))!
    expect(json.argv[1]).toBe(ENGINE)
    expect(json.cwd).toBe(ROOT)
    await pane.press({ key: 'dismiss' })
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

  test('W7 a failing git worktree list falls back to the session root and the question still opens', async ($, on) => {
    const { seen } = world(on, { worktrees: { exitCode: 128, stderr: 'fatal: not a git repository' } })
    const { dialog, pane } = await openPane($)
    expect(dialog).toBeDefined()
    await pane.press({ key: 'dismiss' })
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
    expect(calls.some(call => /^--confirm none --by dave --body \S*pr-body\.md --pr 7$/.test(call))).toBe(true)
    expect(calls).toContain('--apply 7')
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(ran.text).toContain('none')
  })

  test('K5b /pathway 7 accept raises the one question; the tap on the paid row records the paid recommendation with --by dave', async ($, on) => {
    const { seen } = world(on, { answer: /^CodeRabbit review/ })
    await start($)
    await slash($, '7 accept --body pr-body.md')
    expect(engineCalls(seen).some(call => /^--confirm coderabbit --by dave /.test(call))).toBe(true)
  })

  test('K5c /pathway with nothing to act on, or a bad word, gives the usage text and runs nothing', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const empty = await slash($, '')
    expect(empty.text ?? '').toContain('No checkpoint waits in this session')
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

  test('K21 the model learns the outcome from the tool result, with no extra row and no turn', async ($, on) => {
    const { seen, session } = world(on, { answers: PICK_YES })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toContain('#7')
    expect(told.text).toContain('review:coderabbit')
    expect(told.text).toMatch(/do not merge/i)
    expect(session.appended().filter(row => JSON.stringify(row.message).includes('PR checkpoint:'))).toEqual([])
    expect(seen.submits).toEqual([])
  })

  test('K21b a bare /pathway that records gives the model one hidden context line, with no turn', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const { seen } = world(on, { store: { [PENDING]: pending }, answers: PICK_YES })
    await start($)
    const ran = (await slash($, '')) as unknown as { text?: string; context?: string[] }
    expect(ran.context?.length).toBe(1)
    expect(ran.context![0]).toMatch(/Dave chose coderabbit for #7/)
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

// F13 (free-slot queue, W3). The queue state file and the queue's write verbs are not the model's to touch: `add --band CRITICAL` jumps the
// queue, `decide` forges Dave's choice, `drop` removes an item, and a direct write forges any of it. Same shape as K13 and K13b: the deny keys on
// raw text and path, always (warn mode too), and spawns nothing. The read verbs and the test and git commands stay open.
describe('pr-checkpoint: the free-slot queue lock (Lock A path, Lock B text)', () => {
  const SLOT_SPELLINGS = [
    'C:/Users/x/.claude/state/coderabbit-slot.json',
    'C:\\Users\\x\\.claude\\state\\coderabbit-slot.json',
    'c:/USERS/x/.CLAUDE/State/CodeRabbit-Slot.JSON',
    'C:/Users/x/.claude/cache/../state/coderabbit-slot.json',
    // m12: the lock file next to the state file. A tool write of a live pid there would freeze every queue write.
    'C:/Users/x/.claude/state/coderabbit-slot.json.lock',
    'C:\\Users\\x\\.claude\\state\\CodeRabbit-Slot.json.LOCK',
  ]
  const shell = async ($: Engine, command: string, tool: 'Bash' | 'PowerShell' = 'Bash') =>
    (await $.tool.call({ tool, command } as never)) as unknown as { deny?: string }
  const HEAD40 = 'c'.repeat(40)

  for (const tool of ['Write', 'Edit', 'MultiEdit'] as const) {
    test(`F13 ${tool} on coderabbit-slot.json is denied in every spelling, and in warn mode`, async ($, on) => {
      const { seen } = world(on)
      await start($)
      for (const file_path of SLOT_SPELLINGS) {
        const r = await $.tool.call({ tool, file_path, content: '{}', old_string: 'a', new_string: 'b', edits: [] } as never)
        expect(LOCK_DENIED(r as never), file_path).toBe(true)
      }
      expect(seen.ran).toEqual([])
    })
  }

  test('F13 a Write to another file in the state folder passes', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const passed = await $.tool.call({ tool: 'Write', file_path: 'C:/Users/x/.claude/state/sync-cursor', content: 'x' } as never)
    expect(LOCK_DENIED(passed as never)).toBe(false)
    expect(seen.ran.length).toBe(1)
  })

  const DENIED: [('Bash' | 'PowerShell'), string][] = [
    ['Bash', 'node scripts/github/slot-queue.mjs decide --pr 1 --kind first'],
    ['Bash', 'node scripts/github/slot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', `node scripts/github/slot-queue.mjs add --pr 1 --band CRITICAL --head ${HEAD40}`],
    ['Bash', `node "C:/Users/x/continuous-claude/scripts/github/slot-queue.mjs" add --pr 1 --band CRITICAL --head ${HEAD40}`],
    ['PowerShell', 'node scripts\\github\\slot-queue.mjs  DECIDE --pr 1 --kind pay'],
    ['PowerShell', "node 'scripts/github/slot-queue.mjs' 'drop' --pr 1 --reason x"],
    ['Bash', 'echo {} > ~/.claude/state/coderabbit-slot.json'],
    ['PowerShell', "Set-Content -Path $HOME\\.claude\\state\\CodeRabbit-Slot.json -Value '{}'"],
    ['Bash', 'rm ~/.claude/state/coderabbit-slot.json'],
    // Lock B globs: a glob of the state file name is the state file. Only a read command may name it.
    ['Bash', 'rm ~/.claude/state/coderabbit-slot.*'],
    ['Bash', 'rm -f ~/.claude/state/coderabbit-sl*'],
    ['Bash', 'mv ~/.claude/state/coderabbit-sl* /tmp'],
    ['Bash', 'mv ~/.claude/state/coderabbit-s?ot.json /tmp/x'],
    ['Bash', 'rm ~/.claude/state/[c]oderabbit-slot.json'],
    ['Bash', 'rm ~/.claude/state/?oderabbit-slot.json'],
    ['Bash', 'rm ~/.claude/state/*slot.json'],
    ['Bash', 'rm ~/.claude/state/coderabbit-*'],
    ['Bash', 'rm ~/.claude/state/coderabbit-slot.{json,lock}'],
    ['Bash', 'rm ~/.claude/state/coderabbit-slot.json.l*'],
    ['Bash', 'rm ~/.claude/state/coderabbit-slot.json.tmp-*'],
    ['Bash', "rm '/home/x/.claude/state/coderabbit-sl'*"],
    ['Bash', 'cp /tmp/forged.json ~/.claude/state/coderabbit-slot.js*'],
    ['Bash', 'cp /tmp/forged.json ~/.claude/state/coderabbit-slot.json'],
    ['Bash', 'cat /tmp/forged.json > ~/.claude/state/coderabbit-slot.json'],
    ['Bash', 'cat /tmp/forged.json > ~/.claude/state/coderabbit-sl*'],
    ['Bash', 'cat /tmp/forged.json >> ~/.claude/state/coderabbit-slot.*'],
    ['Bash', 'cat /tmp/x | tee ~/.claude/state/coderabbit-sl*'],
    ['Bash', 'cat ~/.claude/state/coderabbit-slot.json; rm ~/.claude/state/coderabbit-sl*'],
    ['PowerShell', 'Remove-Item $HOME\\.claude\\state\\coderabbit-slot.*'],
    ['PowerShell', 'Remove-Item -Force $HOME\\.claude\\state\\CodeRabbit-Sl*'],
    // A glob over the state folder, or the folder itself, can delete the file (CodeRabbit CLI Major on f0edd54).
    ['Bash', 'rm -f ~/.claude/state/*.json'],
    ['Bash', 'rm ~/.claude/state/*'],
    ['Bash', 'mv ~/.claude/state/c* /tmp'],
    ['Bash', 'rm -rf ~/.claude/state'],
    ['Bash', 'rm -rf ~/.claude/state/'],
    ['PowerShell', 'Remove-Item $HOME\\.claude\\state\\*.json'],
    ['PowerShell', 'Remove-Item -Recurse $HOME\\.claude\\state'],
    ['PowerShell', 'Move-Item $HOME\\.claude\\state\\* C:\\tmp'],
    ['PowerShell', 'Move-Item $HOME\\.claude\\state\\coderabbit-s?ot.json C:\\tmp'],
    ['PowerShell', 'Move-Item $HOME\\.claude\\state\\[c]oderabbit-slot.json C:\\tmp'],
    ['PowerShell', 'Copy-Item C:\\tmp\\forged.json $HOME\\.claude\\state\\coderabbit-sl*'],
    ['PowerShell', "Set-Content -Path $HOME\\.claude\\state\\coderabbit-slot.* -Value '{}'"],
    ['PowerShell', "'{}' | Out-File $HOME\\.claude\\state\\coderabbit-sl*"],
    ['PowerShell', 'Out-File -FilePath $HOME\\.claude\\state\\coderabbit-slot.json.lock* -InputObject x'],
    ['PowerShell', 'Get-Content C:\\tmp\\forged.json > $HOME\\.claude\\state\\coderabbit-sl*'],
    // git is open for a read of the file, not for the verbs that delete or restore it.
    ['Bash', 'git rm -f ~/.claude/state/coderabbit-slot.json'],
    ['Bash', 'git -C ~/.claude restore state/coderabbit-sl*'],
    ['Bash', 'git mv ~/.claude/state/coderabbit-slot.json /tmp/x'],
    // A quote split of the file name is the file name.
    ['Bash', "rm ~/.claude/state/coderabbit-sl''ot.json"],
    // M4: the verb is not a literal token right after the script path.
    ['PowerShell', "$v='decide'; node scripts/github/slot-queue.mjs $v --pr 1 --kind first"],
    ['Bash', 'v=drop; node scripts/github/slot-queue.mjs $v --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot-queue.mjs "$VERB" --pr 1 --reason x'],
    ['PowerShell', "node scripts/github/slot-queue.mjs @('drop','--pr','1','--reason','x')"],
    ['PowerShell', 'node scripts/github/slot-queue.mjs $(Get-Verb) --pr 1'],
    ['PowerShell', 'node scripts/github/slot-queue.mjs a`dd --pr 1 --band HIGH --head x'],
    ['Bash', "node scripts/github/slot-queue.mjs ad''d --pr 1 --band HIGH --head x"],
    // M4: the script as a variable, so the verb follows a name that is not the script path.
    ['PowerShell', "$s='scripts/github/slot-queue.mjs'; node $s add --pr 1 --band HIGH --head x"],
    ['Bash', 's="scripts/github/slot-queue.mjs"; node "$s" drop --pr 1 --reason x'],
    // M4: node loads the module as code.
    ['Bash', `node -e "import('./scripts/github/slot-queue.mjs').then(m=>m.main(['add','--pr','1']))"`],
    ['Bash', `node --eval "import('./scripts/github/slot-queue.mjs').then(m=>m.main(['drop']))"`],
    ['Bash', `node -pe "require('./scripts/github/slot-queue.mjs')"`],
    ['PowerShell', `node --input-type=module -e "import { main } from './scripts/github/slot-queue.mjs'; main(['drop'])"`],
    ['Bash', "node - <<'EOF'\nimport { main } from './scripts/github/slot-queue.mjs'\nmain(['drop', '--pr', '1', '--reason', 'x'])\nEOF"],
    ['Bash', `node -e "import('file:///C:/r/scripts/github/slot-queue-model.mjs')"`],
    // Round 2 (Opus re-review): the allow list denies every one of these because the module is not followed by tick, list or probe.
    ['Bash', "node scripts/github/slot-queue.mjs ''drop --pr 1 --reason x"],
    ['Bash', 'node scripts/github/slot-queue.mjs \\drop --pr 1 --reason x'],
    ['PowerShell', 'cmd /c node scripts\\github\\slot-queue.mjs dr^op --pr 1 --reason x'],
    ['Bash', 'echo decide --pr 1 --kind pay | xargs node scripts/github/slot-queue.mjs'],
    ['PowerShell', "$env:S='scripts/github/slot-queue.mjs'; node $env:S drop --pr 1 --reason x"],
    ['Bash', 'for f in scripts/github/slot-queue.mjs; do node $f drop --pr 1 --reason x; done'],
    ['PowerShell', "foreach ($f in 'scripts/github/slot-queue.mjs') { node $f drop --pr 1 --reason x }"],
    ['Bash', 'node scripts/github/slot-queue.m* drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot-q* drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/*queue.mjs drop --pr 1 --reason x'],
    ['PowerShell', "iex ('node scripts/github/slot-queue.mjs ' + 'dr'+'op')"],
    ['PowerShell', 'pwsh -EncodedCommand ZAByAG8AcAA= ; node scripts/github/slot-queue.mjs tick --json'],
    ['PowerShell', 'pwsh -enc ZAByAG8AcAA= ; node scripts/github/slot-queue.mjs tick --json'],
    // The tick, list and probe verbs behind a variable-built path, a cmd /c wrapper, a pipe into xargs, iex or a second call with a write verb.
    ['Bash', '$ROOT/scripts/github/slot-queue.mjs tick'],
    ['PowerShell', 'node $env:ROOT\\scripts\\github\\slot-queue.mjs tick --json'],
    ['PowerShell', 'cmd /c node %ROOT%\\scripts\\github\\slot-queue.mjs tick'],
    ['Bash', 'cmd /c node scripts/github/slot-queue.mjs tick'],
    ['Bash', 'echo x | xargs node scripts/github/slot-queue.mjs tick'],
    ['PowerShell', "iex 'node scripts/github/slot-queue.mjs tick'"],
    ['Bash', 'node scripts/github/slot-queue.mjs tick; node scripts/github/slot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot-queue.mjs tick && node scripts/github/slot-queue.mjs decide --pr 1 --kind pay'],
    ['Bash', 'git status\nnode scripts/github/slot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'git status && node scripts/github/slot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot-queue.mjs ti\\ck'],
    ['Bash', 'NODE_OPTIONS= node scripts/github/SLOT-QUEUE.MJS DROP --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot-qu$()eue.mjs drop --pr 1 --reason x'],
    ['Bash', "node scripts/github/slo''t-que''ue.mjs drop --pr 1 --reason x"],
    // A split of the name by a backtick escape, an empty substitution or a variable leaves a piece that still reads as the module.
    ['PowerShell', 'node scripts/github/sl`ot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/sl$()ot-queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'node scripts/github/slot${X}queue.mjs drop --pr 1 --reason x'],
    ['Bash', 'git commit -m "`node scripts/github/slot-queue.mjs drop --pr 1 --reason x`"'],
    // The git, grep and rg commands are open only as themselves: a compound, an alias, a subshell or a --pre command runs other code.
    ['Bash', "git -c alias.x='!node scripts/github/slot-queue.mjs drop --pr 1' x"],
    ['Bash', "rg --pre 'node scripts/github/slot-queue.mjs drop --pr 1' x"],
    ['Bash', 'git commit -m "$(node scripts/github/slot-queue.mjs drop --pr 1 --reason x)"'],
    ['Bash', 'git commit -m "x; node scripts/github/slot-queue.mjs drop --pr 1 --reason x"'],
    ['Bash', "git commit -F - <<'EOF'\nslot-queue.mjs decide --pr 1 --kind pay\nEOF"],
    ['Bash', 'grep -n x scripts/github/slot-queue.mjs && node scripts/github/slot-queue.mjs drop --pr 1'],
    ['Bash', `node --test scripts/github/slot-queue.test.mjs -e "import('./scripts/github/slot-queue.mjs')"`],
  ]

  test('F13 shell text that names the queue file, or a queue write verb right after the script path, is denied in every form, with no spawn', async ($, on) => {
    const { seen } = world(on)
    await start($)
    for (const [tool, command] of DENIED) {
      const r = await shell($, command, tool)
      expect(LOCK_DENIED(r), `${tool}: ${command}`).toBe(true)
      expect(r.deny).toMatch(/Read or Grep/)
    }
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  const ALLOWED: [('Bash' | 'PowerShell'), string][] = [
    ['Bash', 'node scripts/github/slot-queue.mjs tick --json'],
    ['Bash', 'node scripts/github/slot-queue.mjs list --json'],
    ['Bash', 'node scripts/github/slot-queue.mjs probe --pr 246 --json'],
    ['Bash', 'git add scripts/github/slot-queue.mjs scripts/github/slot-queue-model.mjs'],
    ['PowerShell', 'git add scripts\\github\\slot-queue.mjs'],
    ['Bash', 'node --test scripts/github/slot-queue.test.mjs'],
    ['Bash', 'node --test scripts/github/slot-queue.test.mjs scripts/github/slot-queue-model.test.mjs'],
    ['Bash', 'grep -n add scripts/github/slot-queue.mjs'],
    // M4: the stricter checks must not catch these.
    ['Bash', 'grep -e add scripts/github/slot-queue.mjs'],
    ['Bash', 'node scripts/github/slot-queue.mjs list --json | jq .'],
    ['Bash', 'node scripts/github/slot-queue.mjs tick --session $SESSION_ID --json'],
    ['PowerShell', 'node scripts/github/slot-queue.mjs tick --session $env:CLAUDE_SESSION_ID --json'],
    ['Bash', 'CCV3_X=1 node scripts/github/slot-queue.mjs tick --json'],
    ['Bash', 'node --check scripts/github/slot-queue.mjs'],
    ['Bash', 'node -e "console.log(1)"'],
    ['Bash', 'node scripts/github/slot-queue.mjs tick --json && git add scripts/github/slot-queue.mjs scripts/github/slot-queue-model.mjs'],
    ['Bash', 'node --test --test-name-pattern="add" scripts/github/slot-queue.test.mjs scripts/github/slot-queue-model.test.mjs'],
    // Round 2: a commit message that names the module is a git command (Minor 6); -F is the workaround when it holds a separator.
    ['Bash', 'git commit -m "fix(slot-queue): slot-queue.mjs decide --pr 1 now needs the lock"'],
    ['Bash', 'git commit -F C:/tmp/msg.txt'],
    ['Bash', 'git -C C:/r/.claude/worktrees/free-slot add scripts/github/slot-queue.mjs scripts/github/slot-queue-model.mjs'],
    ['Bash', 'git diff -- scripts/github/slot-queue.mjs'],
    ['Bash', 'git log --oneline -3 -- scripts/github/slot-queue-model.mjs'],
    ['Bash', 'git grep -n drop -- scripts/github/slot-queue.mjs'],
    ['Bash', 'grep -rn "decide" scripts/github/slot-queue.mjs'],
    ['Bash', 'rg -n drop scripts/github/slot-queue.mjs'],
    ['PowerShell', 'Select-String -Path scripts\\github\\slot-queue.mjs -Pattern drop'],
    ['PowerShell', 'Get-Content scripts\\github\\slot-queue.mjs'],
    ['Bash', 'cat scripts/github/slot-queue.mjs'],
    // Reading the state file is open, in the literal and in a glob form. Only a write names it as a denied command.
    ['Bash', 'cat ~/.claude/state/coderabbit-slot.json'],
    ['Bash', 'cat ~/.claude/state/coderabbit-slot.*'],
    ['Bash', 'cat ~/.claude/state/coderabbit-sl*'],
    ['Bash', 'grep -n queued ~/.claude/state/coderabbit-slot.json'],
    ['Bash', 'rg -n queued ~/.claude/state/coderabbit-s?ot.json'],
    ['PowerShell', 'Get-Content $HOME\\.claude\\state\\coderabbit-slot.json'],
    ['PowerShell', 'Get-Content $HOME\\.claude\\state\\coderabbit-sl* -Raw'],
    ['PowerShell', 'Select-String -Path $HOME\\.claude\\state\\coderabbit-slot.json -Pattern queued'],
    ['PowerShell', 'Select-String -Path $HOME\\.claude\\state\\[c]oderabbit-slot.json -Pattern queued'],
    ['Bash', 'cat ~/.claude/state/coderabbit-slot.json | jq .'],
    ['Bash', 'cat ~/.claude/state/coderabbit-paid.jsonl'],
    // Listing or reading the state folder stays open.
    ['Bash', 'ls ~/.claude/state/*.json'],
    ['Bash', 'ls -la ~/.claude/state'],
    ['PowerShell', 'Get-ChildItem $HOME\\.claude\\state\\*.json'],
    ['Bash', 'cat ~/.claude/state/*.json'],
    ['Bash', 'cat ~/.claude/state/sync-cursor'],
    ['Bash', 'rm ~/.claude/state/coderabbit-paid.jsonl'],
    ['Bash', 'git commit -m "docs: the queue file is coderabbit-slot.json"'],
    ['Bash', "node 'scripts/github/slot-queue.mjs' 'tick' --json"],
    ['PowerShell', 'node scripts\\github\\slot-queue.mjs  TICK --json'],
    ['Bash', 'node scripts/github/slot-queue.mjs tick --json; node scripts/github/slot-queue.mjs list --json'],
    ['Bash', 'cd C:/r && git add scripts/github/slot-queue.mjs && git status'],
    ['Bash', 'node --check scripts/github/slot-queue.mjs && node --test scripts/github/slot-queue.test.mjs'],
  ]

  test('F13 the read verbs, git add of the files and the test run are not denied, and spawn no CLI', async ($, on) => {
    const { seen } = world(on)
    await start($)
    for (const [tool, command] of ALLOWED) {
      expect(LOCK_DENIED(await shell($, command, tool)), `${tool}: ${command}`).toBe(false)
    }
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  test('F13 the deny text names git commit -F for a commit message that mentions the module', async ($, on) => {
    world(on)
    await start($)
    const r = await shell($, 'node scripts/github/slot-queue.mjs drop --pr 1')
    expect(r.deny).toMatch(/git commit -F/)
  })

  // Minor 5. Breaks if any pattern is quadratic on a long line (an unbounded quantifier beside a repeated prefix).
  // 400k characters in under 500 ms: linear work plus the harness call stays far under it, while a quadratic
  // pattern grows 16x from 100k (the old guard took 199 ms at 100k, so about 3 s here). A 50 ms limit at 100k flaked under load.
  const LONG: [string, string][] = [
    ['no module', 'x '.repeat(200_000)],
    ['module repeated, all tick', 'node scripts/github/slot-queue.mjs tick '.repeat(10_000)],
    ['module repeated, no verb', 'scripts/github/slot-queue.mjs '.repeat(13_600)],
    ['slot- prefix repeated', 'slot-'.repeat(80_000)],
    ['separators and a module at the end', `git commit -m "${'x;'.repeat(200_000)} slot-queue.mjs"`],
    ['quotes and carets', `${"'^`".repeat(120_000)} slot-queue.mjs tick`],
    ['one long token before the module', `${'a'.repeat(400_000)}slot-queue.mjs tick`],
    ['glob chars', `node ${'*?['.repeat(120_000)}slot-queue`],
  ]
  for (const [label, command] of LONG) {
    test(`F13 a 400k-character line (${label}) is judged in under 500 ms`, async ($, on) => {
      world(on)
      await start($)
      await shell($, 'git status')
      const t0 = performance.now()
      await shell($, command)
      expect(performance.now() - t0).toBeLessThan(500)
    })
  }

  test('F13 the kill switch lifts the queue lock with the others', async ($, on) => {
    world(on, { env: { CCV3_MODS_OFF: '1' } })
    await start($)
    expect(LOCK_DENIED(await shell($, `node scripts/github/slot-queue.mjs decide --pr 1 --kind first`))).toBe(false)
    const w = (await $.tool.call({ tool: 'Write', file_path: SLOT_SPELLINGS[0], content: '{}' } as never)) as unknown as { deny?: string }
    expect(LOCK_DENIED(w)).toBe(false)
  })
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
  // G1 to G4: /pathway grant <pr> <round> is Dave's typed Yes, for a round the pane never asked about (or asked about and he declined).
  test('G1 /pathway grant 7 4 after a No: a grant for round 4 on the record head, the decline is cleared, the model is told, nothing posted', async ($, on) => {
    const declined = { kind: 'round', round: 4, head: HEAD }
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ declined }) }, statuses: { 7: REVIEWED(3) } })
    await start($)
    const submitted = w.seen.submits.length
    const ran = await slash($, 'grant 7 4')
    expect(ran.text ?? '').toContain('round 4')
    const grant = w.store.get('checkpoint:grant:7') as Rec
    expect(grant.round).toBe(4)
    expect(grant.head).toBe(HEAD)
    expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeUndefined()
    expect(counts(w.seen).comments).toEqual([])
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Dave allowed round 4 for #7')
    expect(w.seen.submits.length).toBe(submitted)
  })

  test('G2 a /pathway grant raised by a plugin writes nothing', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ declined: { kind: 'round', round: 4, head: HEAD } }) }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await slash($, 'grant 7 4', 'plugin')
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeDefined()
  })

  test('G3 a /pathway grant for a PR with no checkpoint record writes nothing and says why', async ($, on) => {
    const w = world(on, { store: { ...watchDoc() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    const ran = await slash($, 'grant 7 4')
    expect(ran.text ?? '').toMatch(/no checkpoint record/i)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
  })

  for (const [name, declined] of [
    ['an opening decline', { kind: 'opening', round: 1, head: HEAD }],
    ['a decline of a later round (5)', { kind: 'round', round: 5, head: HEAD }],
  ] as [string, Rec][]) {
    test(`G6 /pathway grant 7 4 keeps ${name}, which the grant does not cover`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ declined }) }, statuses: { 7: REVIEWED(3) } })
      await start($)
      await slash($, 'grant 7 4')
      expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
      expect((w.store.get('checkpoint:pr:7') as Rec).declined).toEqual(declined)
    })
  }

  test('G7 a failed cleanup after the grant write reports the stored grant, not "nothing recorded"', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ declined: { kind: 'round', round: 4, head: HEAD } }) }, statuses: { 7: REVIEWED(3) } })
    await start($)
    w.fail.set = true
    const ran = await slash($, 'grant 7 4')
    w.fail.set = false
    expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
    expect(ran.text ?? '').toMatch(/grant is stored/i)
    expect(ran.text ?? '').not.toMatch(/nothing was recorded/i)
    expect(JSON.stringify(w.session.appended().map(row => row.message))).not.toContain('post one @coderabbitai review')
  })

  for (const [name, declined, what] of [
    ['an opening decline', { kind: 'opening', round: 1, head: HEAD }, 'the opening review'],
    ['a decline of round 5', { kind: 'round', round: 5, head: HEAD }, 'round 5'],
  ] as [string, Rec, string][]) {
    test(`G8 /pathway grant 7 4 with ${name} kept: the model is not told to post a review`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ declined }) }, statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, 'grant 7 4')
      const rows = JSON.stringify(w.session.appended().map(row => row.message))
      expect(rows).toContain('Dave allowed round 4 for #7')
      expect(rows).toContain(`decline of ${what} stays`)
      expect(rows).not.toContain('post one @coderabbitai review')
      expect(ran.text ?? '').toContain(`decline of ${what} stays`)
    })
  }

  for (const args of ['grant 7 99999999999999999999', 'grant 99999999999999999999 4']) {
    test(`G9 "/pathway ${args}" is a usage error: an unsafe integer is never stored`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, args)
      expect(ran.text ?? '').toMatch(/usage/i)
      expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    })
  }

  test('G10 a lower grant keeps the higher stored round, whichever head that grant carries (the pane stores the PR head at ask time)', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await slash($, 'grant 7 5')
    await slash($, 'grant 7 4')
    expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(5)
    w.store.set('checkpoint:grant:7', { round: 5, head: 'b'.repeat(40), at: NOW })
    await slash($, 'grant 7 4')
    expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(5)
  })

  test('G11 a new checkpoint record voids the grant stored under the old one, so it cannot cover the new record', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:grant:7': { round: 4, head: HEAD, at: NOW } } })
    await start($)
    await slash($, '7 none --body pr-body.md')
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
  })

  test('G12 a new checkpoint record drops the queued asks of the old record, so an old Yes cannot recreate a grant', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await w.clock.advance(TICK)
    expect(asksOf(w.store).length).toBe(1)
    await slash($, '7 none --body pr-body.md')
    expect(asksOf(w.store)).toEqual([])
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
  })

  test('G5 a /pathway grant drops the queued round ask it covers, so a later No cannot override the grant', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
    await start($)
    await w.clock.advance(TICK)
    expect(asksOf(w.store).length).toBe(1)
    await slash($, 'grant 7 4')
    expect(asksOf(w.store)).toEqual([])
    expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
    expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeUndefined()
  })

  for (const args of ['grant', 'grant 7', 'grant 7 0', 'grant 7 x', 'grant 7 4 5', 'grant 0 4', 'grant 7 4 --body b.md']) {
    test(`G4 "/pathway ${args}" gives the usage text and writes nothing`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, args)
      expect(ran.text ?? '').toMatch(/usage/i)
      expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    })
  }

  const QUIET = () => status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
  const GREP_CLEAN = () => status(7, {
    routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, routedReviewed: false, reviewedHead: false,
    coderabbitRounds: 1, reasons: ['no Greptile check on the head commit yet (review pending)'],
  })
  const OPENING_POST = ['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@coderabbitai review']

  test('A2 the opening ask 30 minutes after ready is a dialog: No ($0) is first (the recommendation), Yes has the cost, and Yes posts exactly one @coderabbitai review', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, answer: /^Yes/ })
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    const [dialog] = w.seen.dialogs
    expect(dialog!.question).toContain('CodeRabbit has not started on #7 30 minutes after ready')
    expect(dialog!.labels[0]).toMatch(/^No, do not post.*\(Recommended\)$/)
    expect(dialog!.labels[1]).toMatch(/^Yes, post the review .*\$/)
    const posts = counts(w.seen).comments
    expect(posts).toEqual([OPENING_POST])
    expect(asksOf(w.store)).toEqual([])
    expect(((w.store.get('checkpoint:pr:7') as Rec).opened as Rec).head).toBe(HEAD)
  })

  test('A2d opening ask, No: nothing is posted, the record is declined, the model is told, and the ask does not come back', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, answer: /^No/ })
    await start($)
    await w.clock.advance(TICK)
    expect(counts(w.seen).comments).toEqual([])
    expect(asksOf(w.store)).toEqual([])
    expect(((w.store.get('checkpoint:pr:7') as Rec).declined as Rec).kind).toBe('opening')
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Do not request a review on #7')
    for (let i = 0; i < 3; i += 1) await w.clock.advance(TICK)
    expect(asksOf(w.store)).toEqual([])
    expect(counts(w.seen).comments).toEqual([])
    expect(w.seen.dialogs.length).toBe(1)
  })

  for (const [name, view] of [
    ['the PR was merged', { state: 'MERGED', headRefOid: HEAD }],
    ['the PR was closed', { state: 'CLOSED', headRefOid: HEAD }],
    ['the head moved', { state: 'OPEN', headRefOid: OTHER_HEAD }],
  ] as const) {
    test(`A2e a late Yes on the opening ask posts nothing when ${name}: the ask is dropped and Dave gets a toast`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, view: { stdout: JSON.stringify(view) }, answer: /^Yes/ })
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(counts(w.seen).comments).toEqual([])
      expect(asksOf(w.store)).toEqual([])
      expect(w.seen.toasts.some(text => /#7/.test(text) && /no longer|merged|closed|moved/i.test(text))).toBe(true)
      expect(argvOf(w.seen, 'view').some(argv => argv.includes('state,headRefOid,isDraft'))).toBe(true)
    })
  }

  for (const [name, view] of [
    ['gh fails to start', 'throw'],
    ['gh exits 1', { exitCode: 1, stderr: 'HTTP 502' }],
    ['gh prints no JSON', { stdout: 'not json' }],
  ] as [string, Reply][]) {
    test(`A2f a Yes posts nothing when the PR state cannot be read (${name}): the ask stays queued and Dave gets a toast`, async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, view, answer: /^Yes/ })
      await start($)
      await w.clock.advance(TICK)
      expect(counts(w.seen).comments).toEqual([])
      expect(asksOf(w.store).length).toBe(1)
      expect(w.seen.toasts.some(text => /#7/.test(text) && /could not read/i.test(text))).toBe(true)
    })
  }

  test('A3 the Greptile ask on a both PR: No is first with the credits in the other label, Yes posts one @greptileai, and a No ends it', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ pathway: 'both', label: 'review:deep' }) }, statuses: { 7: GREP_CLEAN() }, answer: /^No/ })
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    const [dialog] = w.seen.dialogs
    expect(dialog!.question).toContain('Ask Greptile to review the final head aaaaaaa of #7? 3 credits (Plus)')
    expect(dialog!.labels[0]).toMatch(/^No, skip Greptile .*\(Recommended\)$/)
    expect(dialog!.labels[1]).toMatch(/^Yes, ask Greptile \(3 credits\)$/)
    expect(counts(w.seen).comments).toEqual([])
    for (let i = 0; i < 2; i += 1) await w.clock.advance(TICK)
    expect(asksOf(w.store)).toEqual([])
    expect(w.seen.dialogs.length).toBe(1)
  })

  test('A3b Greptile ask, Yes: exactly one @greptileai comment and the ask leaves the queue', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record({ pathway: 'both', label: 'review:deep' }) }, statuses: { 7: GREP_CLEAN() }, answer: /^Yes/ })
    await start($)
    await w.clock.advance(TICK)
    expect(counts(w.seen).comments).toEqual([['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@greptileai']])
    expect(asksOf(w.store)).toEqual([])
  })

  test('A2g (v2) a dialog that returns row 0 on the opening ask posts nothing: No is the first label', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, answer: labels => labels[0]! })
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).comments).toEqual([])
    expect(((w.store.get('checkpoint:pr:7') as Rec).declined as Rec).kind).toBe('opening')
  })

  test('A5 a tick finds the checkpoint question open: it raises nothing and asks at a later tick, after the answer', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) }, answers: ['manual'], answer: 'dismiss' })
    await start($)
    const tool = callTool($, { pr: 7, body: 'pr-body.md' })
    await waitFor(() => w.seen.dialogs.length > 0)
    expect(w.seen.dialogs.length).toBe(1)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect(asksOf(w.store).length).toBe(1)
    w.seen.dialogs[0]!.answer('dismiss')
    await tool
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(4)
    expect(w.seen.dialogs[3]!.question).toContain('Round 4 of 1+2 for #7')
  })

  test('A5b a failed post keeps the ask queued with no quiet time; the next tick asks again and a second Yes posts', async ($, on) => {
    const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: QUIET() }, comments: [{ exitCode: 1, stderr: 'HTTP 502' }, OK], answer: /^Yes/ })
    await start($)
    await w.clock.advance(TICK)
    expect(counts(w.seen).comments.length).toBe(1)
    expect(asksOf(w.store).length).toBe(1)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(2)
    expect(counts(w.seen).comments.length).toBe(2)
    expect(asksOf(w.store)).toEqual([])
  })

  test('T19c a queued ask whose answer another session already stored leaves the queue and raises no dialog', async ($, on) => {
    const w = world(on, {
      store: { ...watchDoc(), 'checkpoint:pr:7': record(), 'checkpoint:grant:7': { round: 4, head: HEAD, at: NOW }, [ASKS]: [{ kind: 'round', pr: 7, head: HEAD, text: 'Round 4 of 1+2 for #7', round: 4 }] },
      statuses: { 7: REVIEWED(3) },
      answer: /^Yes/,
    })
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs).toEqual([])
    expect(asksOf(w.store)).toEqual([])
  })

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

  // T3: the round grants (the dialog Yes, `/pathway grant`) put the PR back in the free-slot queue; the queue posts, so the notice says not to.
  describe('the free-slot queue after a round grant (T3, F12)', () => {
    const slotRuns = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('slot-queue.mjs'))).map(r => r.argv.slice(2))
    const ADD_R4 = ['add', '--pr', '7', '--band', 'HIGH', '--head', HEAD, '--round', '4', '--escalated', '--session', SESSION, '--json']
    const told = (w: { session: { appended: () => readonly { message: unknown }[] } }) => JSON.stringify(w.session.appended().map(row => row.message))
    const QUEUE_NOTICE = 'the free-slot queue posts @coderabbitai review after the fix push. Do not post it.'
    const OLD_NOTICE = 'after the fix push, post one @coderabbitai review.'
    const banded = (over: Rec = {}) => ({ ...watchDoc(), 'checkpoint:pr:7': record({ band: 'HIGH', ...over }) })

    test('T3 the Yes on a round ask runs add --round 4 --escalated on the record head, and the notice says the queue posts', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) }, answer: /^Yes/ })
      await start($)
      await w.clock.advance(TICK)
      expect(slotRuns(w.seen)).toEqual([ADD_R4])
      expect(told(w)).toContain(QUEUE_NOTICE)
      expect(told(w)).not.toContain(OLD_NOTICE)
      expect(counts(w.seen).comments).toEqual([])
    })

    test('T3 /pathway grant 7 4 runs the same add; the reply and the notice say the queue posts', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(slotRuns(w.seen)).toEqual([ADD_R4])
      expect(ran.text ?? '').toContain('the free-slot queue posts')
      expect(ran.text ?? '').not.toContain('post one @coderabbitai review')
      expect(told(w)).toContain(QUEUE_NOTICE)
    })

    // F13: /pathway grant comes after fix pushes, so the record head is stale. The add carries the PR's current head, or no add runs.
    test('T3 /pathway grant 7 4 after a fix push queues the round on the PR current head, not the record head', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) }, viewHead: OTHER_HEAD })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(slotRuns(w.seen)).toEqual([ADD_R4.map(arg => (arg === HEAD ? OTHER_HEAD : arg))])
      expect(ran.text ?? '').toContain('the free-slot queue posts')
    })

    // GD1-GD4: a grant reads the PR first. A PR that is a draft, closed or unreadable gets no grant and no queue entry (a grant on a returned PR would outlive its cleanup).
    const gdState = (over: Rec = {}): Reply => ({ stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD, isDraft: false, ...over }) })
    const nothingGranted = (w: ReturnType<typeof world>, declined: Rec) => {
      expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
      expect(slotRuns(w.seen)).toEqual([])
      expect((w.store.get('checkpoint:pr:7') as Rec).declined).toEqual(declined)
      expect(told(w)).not.toContain('Dave allowed round')
    }
    const DECLINE = { kind: 'round', round: 4, head: HEAD }

    test('GD1 /pathway grant 7 4 on a PR that is a draft stores no grant, queues nothing and says so', async ($, on) => {
      const w = world(on, { store: banded({ declined: DECLINE }), statuses: { 7: REVIEWED(3) }, view: gdState({ isDraft: true }) })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(ran.text ?? '').toMatch(/PR #7.*a draft.*Nothing was recorded\./)
      nothingGranted(w, DECLINE)
    })

    for (const [name, view, why] of [
      ['the PR is closed', gdState({ state: 'CLOSED' }), /closed/],
      ['gh exits 1', { exitCode: 1, stderr: 'gh: network down' }, /network down/],
      ['gh prints a state with no draft field', { stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD }) }, /draft state/],
    ] as [string, Reply, RegExp][]) {
      test(`GD2 /pathway grant 7 4 stores no grant and queues nothing when ${name}`, async ($, on) => {
        const w = world(on, { store: banded({ declined: DECLINE }), statuses: { 7: REVIEWED(3) }, view })
        await start($)
        const ran = await slash($, 'grant 7 4')
        expect(ran.text ?? '').toMatch(why)
        expect(ran.text ?? '').toMatch(/PR #7.*Nothing was recorded\./)
        nothingGranted(w, DECLINE)
      })
    }

    test('GD3 /pathway grant 7 4 with no checkout to read the PR in stores no grant and queues nothing', async ($, on) => {
      const w = world(on, { store: banded({ declined: DECLINE }), statuses: { 7: REVIEWED(3) }, missing: ['scripts/github/pr-checkpoint.mjs'] })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(ran.text ?? '').toMatch(/Nothing was recorded\./)
      nothingGranted(w, DECLINE)
    })

    test('GD4 (control) /pathway grant 7 4 on an open PR that is not a draft reads the state fields once, stores the grant and queues the round', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(argvOf(w.seen, 'view').filter(argv => argv.includes('state,headRefOid,isDraft')).length).toBe(1)
      expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
      expect(slotRuns(w.seen)).toEqual([ADD_R4])
      expect(ran.text ?? '').toContain('the free-slot queue posts')
    })

    test('T3 a grant raised by a plugin runs no add', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) } })
      await start($)
      await slash($, 'grant 7 4', 'plugin')
      expect(slotRuns(w.seen)).toEqual([])
    })

    test('T3 a record with no band (an older record) runs no add and keeps the old notice', async ($, on) => {
      const w = world(on, { store: { ...watchDoc(), 'checkpoint:pr:7': record() }, statuses: { 7: REVIEWED(3) } })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect(slotRuns(w.seen)).toEqual([])
      expect(ran.text ?? '').toContain('post one @coderabbitai review')
      expect(told(w)).toContain(OLD_NOTICE)
    })

    test('T3 a failed add gives one toast, keeps the old notice, and the grant stays stored', async ($, on) => {
      const w = world(on, { store: banded(), statuses: { 7: REVIEWED(3) }, slot: { exitCode: 2, stdout: '{"ok":false,"reason":"slot-queue: bad state file"}' } })
      await start($)
      const ran = await slash($, 'grant 7 4')
      expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
      expect(w.seen.toasts.filter(text => text.includes('slot-queue: bad state file')).length).toBe(1)
      expect(ran.text ?? '').toContain('post one @coderabbitai review')
      expect(told(w)).toContain(OLD_NOTICE)
    })

    test('T3 a grant that keeps an earlier decline runs no add', async ($, on) => {
      const declined = { kind: 'opening', round: 1, head: HEAD }
      const w = world(on, { store: banded({ declined }), statuses: { 7: REVIEWED(3) } })
      await start($)
      await slash($, 'grant 7 4')
      expect(slotRuns(w.seen)).toEqual([])
    })
  })
})

// ---- review factory step A: auto-confirm and the mobile /pathway gap (Dave 2026-11-01) ------------------------------------------------
// How it can fail, and the test that catches it:
// AU1  an eligible checkpoint (engine `auto.eligible`, recommended none) waits for a press, or records differently from a press (same record, apply, label)
// AU1b the visible line to Dave (toast) does not name the band, or the model is told "Dave chose" instead of "auto-confirmed"
// AU2  a refused record still applies, or raises no question (the fallback is the question)
// AU3  a refused apply leaves no way to retry
// AU4  an engine result with no `auto` block (an old engine), or eligible false, auto-confirms
// AU5  eligible true with a recommendation other than none auto-confirms
// AU6  a head that moved between the first read and the record still records
// AU7  a headless session records
// AU8  a throw while recording (store.set) loses the checkpoint instead of falling back to the question
// AU9  an unreadable PR state at the second read records
// AU10 a stale pending checkpoint of the same PR survives an auto-confirm
// M1   /pathway from a non-composer origin (the bridge, i.e. mobile remote control) shows a plan read in the session root, where no stamp lives
// M1c  a headless /pathway does not say the session is headless (Dave 2026-11-02, C)
// M2   a bare composer /pathway with a pending checkpoint does not draw it again, or runs the engine
// M2b  a bare bridge /pathway raises no dialog on the phone, or runs the engine or gh
// M2c  a bare bridge /pathway with no pending checkpoint raises a dialog or runs the engine
// M3   a bridge /pathway <pending pr> <word> does not record, records outside the PR worktree, or not as dave (Dave 2026-11-02, A)
// M3b  a bridge accept for the pending PR is not --by default
// M4   a bridge /pathway for a PR that is not this session's pending checkpoint records
// M5   a plugin or SDK /pathway records, even for the pending PR
// L1   a /pathway leaves no line, or more than one, in ~/.claude/state/ccv3-mods/pathway-commands.jsonl, or the line lacks a field (D)
// L2   a /pathway that throws leaves no log line
const AUTO = { eligible: true, band: 'MID', reason: 'Band MID is recommended none: no CodeRabbit PR bot, the internal review stack covers it.' }
const autoJson = (over: Rec = {}) =>
  ({ stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0], band: { band: 'MID' }, auto: AUTO, ...over })) })
const confirms = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.includes('--confirm'))
const viewJson = (over: Rec = {}) => ({ stdout: JSON.stringify({ isDraft: true, state: 'OPEN', headRefOid: HEAD, headRefName: 'feat/x', author: { login: 'Rev4nchist' }, ...over }) })

describe('pr-checkpoint: auto-confirm', () => {
  test('AU1 an eligible checkpoint records none with --by auto and applies it, with no pane and no press', async ($, on) => {
    const { seen, store } = world(on, { json: autoJson() })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    const calls = engineCalls(seen).filter(call => !call.startsWith('--json'))
    expect(calls[0]).toMatch(/^--confirm none --by auto --body \S*pr-body\.md --pr 7$/)
    expect(calls[1]).toBe('--apply 7')
    expect(seen.opens).toEqual([])
    const record = store.get('checkpoint:pr:7') as Rec
    expect(record.state).toBe('applied')
    expect(record.pathway).toBe('none')
    expect(record.label).toBe('review:none')
    expect(record.decided_by).toBe('auto')
    expect(record.budget).toEqual([0, 0])
    expect(record.pr).toBe(7)
    expect(record.session).toBe(SESSION)
    expect(store.get(PENDING)).toBeUndefined()
    expect(told.text).toMatch(/auto-confirmed/i)
    expect(told.text).toMatch(/ready/i)
    expect(told.text).not.toMatch(/wait for dave/i)
  })

  test('AU1b the toast names the band and says auto-confirmed; the model is told it was automatic, with no turn', async ($, on) => {
    const { seen, session } = world(on, { json: autoJson() })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(seen.toasts.some(text => /#7/.test(text) && /MID/.test(text) && /auto-confirmed/i.test(text))).toBe(true)
    const rows = session.appended().filter(row => JSON.stringify(row.message).includes('PR checkpoint:'))
    expect(rows.length).toBe(1)
    const text = JSON.stringify(rows[0]!.message)
    expect(text).toMatch(/auto-confirmed/i)
    expect(text).toContain('MID')
    expect(text).toContain('review:none')
    expect(text).not.toMatch(/Dave chose/)
    expect(text).toMatch(/do not merge/i)
    expect(seen.submits).toEqual([])
  })

  test('AU1c in a worktree the auto record runs there, like a press (W2)', async ($, on) => {
    const { seen } = world(on, wtOpts({ json: autoJson() }))
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(confirms(seen)[0]!.cwd).toBe(WT)
    expect(seen.run.find(r => r.argv.includes('--apply'))?.cwd).toBe(WT)
  })

  test('AU2 a refused record raises the question, applies nothing, and the tool says why', async ($, on) => {
    const { seen, store } = world(on, { json: autoJson(), confirm: { exitCode: 1, stderr: 'pr-checkpoint: refused: --by auto is not allowed here: x' } })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(seen).apply).toBe(0)
    expect(seen.dialogs.length).toBe(ESC_ASKS)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(store.get(PENDING)).toBeDefined()
    expect(told.text).toMatch(/auto-confirm/i)
    expect(told.text).toMatch(/waits for Dave/)
    expect(seen.dialogs[0]!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['No review, land on CI', 'Keep as draft', 'CodeRabbit review'])
  })

  test('AU3 a refused apply raises the question with the error in the tool text; the record stays confirmed', async ($, on) => {
    const { seen, store } = world(on, { json: autoJson(), apply: { exitCode: 1, stderr: 'pr-checkpoint: refused: PR #7 is not a draft' } })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(seen).apply).toBe(1)
    expect(seen.dialogs.length).toBe(ESC_ASKS)
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('confirmed')
    expect(told.text).toContain('not a draft')
  })

  const NOT_AUTO: [string, Reply][] = [
    ['no auto block (an old engine)', { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0] })) }],
    ['eligible false', autoJson({ auto: { ...AUTO, eligible: false } })],
    ['eligible not a boolean', autoJson({ auto: { ...AUTO, eligible: 'yes' } })],
    ['a malformed block', autoJson({ auto: 'MID' })],
  ]
  for (const [label, json] of NOT_AUTO) {
    test(`AU4 ${label} waits for the press`, async ($, on) => {
      const { seen } = world(on, { json })
      await start($)
      const told = await callTool($, { pr: 7, body: 'pr-body.md' })
      expect(counts(seen).confirm + counts(seen).apply).toBe(0)
      expect(seen.dialogs.length).toBe(ESC_ASKS)
    })
  }

  test('AU5 eligible true with a recommendation other than none waits for the press', async ($, on) => {
    const { seen } = world(on, { json: autoJson({ recommended: 'coderabbit', options: [option('coderabbit'), option('none')] }) })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(seen).confirm).toBe(0)
    expect(seen.dialogs.length).toBe(ESC_ASKS)
  })

  test('AU6 a head that moved between the first read and the record waits for the press', async ($, on) => {
    const { seen, store } = world(on, { json: autoJson(), viewSeq: [viewJson(), viewJson({ headRefOid: OTHER_HEAD })] })
    await start($)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(seen).confirm).toBe(0)
    expect(seen.dialogs.length).toBe(ESC_ASKS)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(told.text).toMatch(/moved/i)
  })

  const SECOND_READ: [string, Reply][] = [
    ['a gh failure', { exitCode: 1, stderr: 'gh: HTTP 502' }],
    ['text that is not JSON', { stdout: 'not json' }],
    ['a timeout', 'throw'],
    ['a PR that left draft', viewJson({ isDraft: false })],
  ]
  for (const [label, second] of SECOND_READ) {
    test(`AU9 ${label} at the second PR read waits for the press`, async ($, on) => {
      const { seen } = world(on, { json: autoJson(), viewSeq: [viewJson(), second] })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      expect(counts(seen).confirm).toBe(0)
      expect(seen.dialogs.length).toBe(ESC_ASKS)
    })
  }

  test('AU7 a headless session still gets the text plan only', async ($, on) => {
    const { seen, store } = world(on, { json: autoJson() })
    await start($, false)
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect([...store.keys()].filter(key => key.startsWith('checkpoint:'))).toEqual([])
  })

  test('AU8 a throw while recording falls back to the question and leaves no record behind', async ($, on) => {
    const w = world(on, { json: autoJson() })
    await start($)
    w.fail.set = true
    const told = await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.store.get(PENDING)).toBeDefined()
  })

  test('AU10 a stale pending checkpoint of the same PR is cleared by an auto-confirm', async ($, on) => {
    const { store } = world(on, {
      json: autoJson(),
      store: { [PENDING]: { pr: 7, body: 'old.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: OTHER_HEAD, at: NOW } },
    })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(store.get(PENDING)).toBeUndefined()
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('auto')
  })
})

describe('pr-checkpoint: /pathway from a surface that is not the composer (mobile remote control)', () => {
  test('M1 a bridge /pathway <pr> reads the plan in the PR worktree (where the stamp is), says why it only shows the plan, and records nothing', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    await start($)
    const ran = await slash($, '7 none --body pr-body.md', 'bridge')
    const plan = seen.run.find(r => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && !r.argv.includes('--json'))!
    expect(plan.argv[1]).toBe(ENGINE)
    expect(plan.argv).not.toContain('--probe')
    expect(plan.cwd).toBe(WT)
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(ran.text ?? '').toContain('PR checkpoint for')
    expect(ran.text ?? '').toMatch(/bridge/)
    expect(ran.text ?? '').toMatch(/composer/)
  })

  test('M1b a bridge /pathway <pending pr> without a word asks the question again, with no gh call and no engine call', async ($, on) => {
    const { seen } = world(on, wtOpts())
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    const before = seen.run.length
    const dialogsBefore = seen.dialogs.length
    await slash($, '7', 'bridge')
    const after = seen.run.slice(before)
    expect(seen.dialogs.length).toBe(dialogsBefore + ESC_ASKS)
    expect(after.filter(r => r.argv[0] === 'gh')).toEqual([])
    expect(after.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs')))).toEqual([])
  })

  test('M1c a headless /pathway makes no gh call to find the worktree (K4b)', async ($, on) => {
    const { seen } = world(on, wtOpts())
    await start($, false)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toContain('PR checkpoint for')
    expect(ran.text ?? '').toMatch(/this session is headless/i)
    expect(ran.text ?? '').not.toMatch(/came from/)
    expect(seen.run.filter(r => r.argv[0] === 'gh')).toEqual([])
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
  })

  test('M2 a bare composer /pathway with a pending checkpoint asks again and runs no engine call', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    const engineBefore = engineCalls(seen).length
    const dialogsBefore = seen.dialogs.length
    const ran = await slash($, '')
    expect(ran.text ?? '').toMatch(/closed the question/i)
    expect(seen.dialogs.length).toBe(dialogsBefore + ESC_ASKS)
    expect(seen.opens).toEqual([])
    expect(engineCalls(seen).length).toBe(engineBefore)
  })

  test('M2b a bare bridge /pathway asks the pending PR in a dialog (no pane, no engine call, no gh call)', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    const dialogsBefore = seen.dialogs.length
    const before = seen.run.length
    const ran = await slash($, '', 'bridge')
    expect(seen.dialogs.length).toBe(dialogsBefore + ESC_ASKS)
    expect(seen.dialogs.at(-1)!.question).toContain('#7')
    expect(seen.opens).toEqual([])
    expect(ran.text ?? '').toMatch(/closed the question/i)
    const after = seen.run.slice(before)
    expect(after.filter(r => r.argv[0] === 'gh')).toEqual([])
    expect(after.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs')))).toEqual([])
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
  })

  test('M2c a bare bridge /pathway with no pending checkpoint asks for the PR and opens nothing', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const ran = await slash($, '', 'bridge')
    expect(ran.text ?? '').toContain('No checkpoint waits in this session')
    expect(seen.opens).toEqual([])
    expect(engineCalls(seen)).toEqual([])
  })

  test('M3 a bridge /pathway 7 none for the pending PR records in the PR worktree with --by dave', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    const ran = await slash($, '7 none', 'bridge')
    const confirm = confirms(seen)
    expect(confirm.length).toBe(1)
    expect(confirm[0]!.argv.slice(2).join(' ')).toMatch(/^--confirm none --by dave --body \S*pr-body\.md --pr 7$/)
    expect(confirm[0]!.cwd).toBe(WT)
    expect(seen.run.find(r => r.argv.includes('--apply'))?.cwd).toBe(WT)
    const record = store.get('checkpoint:pr:7') as Rec
    expect(record.state).toBe('applied')
    expect(record.decided_by).toBe('dave')
    expect(store.get(PENDING)).toBeUndefined()
    expect(ran.text ?? '').toMatch(/recorded/)
  })

  test('M3b a bridge /pathway 7 accept for the pending PR raises the one question; the tap on the paid row records with --by dave', async ($, on) => {
    const { seen } = world(on, wtOpts({ answers: ['dismiss', 'dismiss', 'dismiss', /^CodeRabbit review/] }))
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await slash($, '7 accept', 'bridge')
    expect(engineCalls(seen).some(call => /^--confirm coderabbit --by dave /.test(call))).toBe(true)
  })

  test('M4 a bridge /pathway for a PR that is not the pending checkpoint shows the plan only and says why', async ($, on) => {
    const { seen, store } = world(on, wtOpts())
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    const ran = await slash($, '8 none --body pr-body.md', 'bridge')
    expect(counts(seen).confirm + counts(seen).apply).toBe(0)
    expect(store.get('checkpoint:pr:8')).toBeUndefined()
    expect(store.get(PENDING)).toBeDefined()
    expect(ran.text ?? '').toContain('PR checkpoint for')
    expect(ran.text ?? '').toMatch(/came from bridge/)
    expect(ran.text ?? '').toMatch(/#7/)
  })

  for (const kind of ['plugin', 'sdk']) {
    test(`M5 a ${kind} /pathway 7 none never records, even for the pending PR`, async ($, on) => {
      const { seen, store } = world(on, wtOpts())
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      const ran = await slash($, '7 none', kind)
      expect(counts(seen).confirm + counts(seen).apply).toBe(0)
      expect(store.get('checkpoint:pr:7')).toBeUndefined()
      expect(ran.text ?? '').toMatch(new RegExp(`came from ${kind}`))
    })
  }
})

const LOG = 'C:/home/.claude/state/ccv3-mods/pathway-commands.jsonl'
const logLines = (written: Record<string, string>) => (written[LOG] ?? '').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Rec)

describe('pr-checkpoint: every /pathway leaves one log line', () => {
  test('L1 each command writes one line with ts, session, origin, args, mode, root, checkout and outcome; no body text', async ($, on) => {
    const BODY_TEXT = 'BODY-TEXT-NEVER-LOGGED'
    const { written } = world(on, wtOpts({ files: { [`${WT}/pr-body.md`]: BODY_TEXT, [`${ROOT}/pr-body.md`]: BODY_TEXT } }))
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(logLines(written)).toEqual([])
    await slash($, '', 'bridge')
    await slash($, '8 none --body pr-body.md', 'bridge')
    await slash($, '7 none', 'bridge')
    await slash($, 'banana')
    const lines = logLines(written)
    expect(lines.length).toBe(4)
    expect(lines.map(line => line.origin)).toEqual(['bridge', 'bridge', 'bridge', 'composer'])
    expect(lines.map(line => line.args)).toEqual(['', '8 none --body pr-body.md', '7 none', 'banana'])
    for (const line of lines) {
      expect(typeof line.ts).toBe('string')
      expect(line.session).toBe(SESSION)
      expect(line.mode).toBe('interactive')
      expect(typeof line.outcome).toBe('string')
      expect('root' in line && 'checkout' in line).toBe(true)
    }
    expect(lines[0]!.checkout).toBe(WT)
    expect(lines[2]!.checkout).toBe(WT)
    for (const line of lines.slice(0, 3)) expect(line.root).toBe(ROOT)
    expect(lines[2]!.outcome).toBe('recorded')
    expect(lines[1]!.outcome).toBe('text-plan')
    expect(new Set(lines.map(line => line.outcome)).size).toBe(4)
    expect(written[LOG]).not.toContain(BODY_TEXT)
  })

  test('L1b a headless command logs mode headless', async ($, on) => {
    const { written } = world(on)
    await start($, false)
    await slash($, '7 none --body pr-body.md')
    const lines = logLines(written)
    expect(lines.length).toBe(1)
    expect(lines[0]!.mode).toBe('headless')
    expect(lines[0]!.outcome).toBe('text-plan')
  })

  test('L2 a command that throws still logs one line, outcome error', async ($, on) => {
    const { written } = world(on, { throwStore: 'checkpoint:pending:' })
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toMatch(/failed/)
    const lines = logLines(written)
    expect(lines.length).toBe(1)
    expect(lines[0]!.outcome).toBe('error')
  })
})

// ---- every dialog leaves one log line (lane checkpoint-ask-self-answer) ---------------------------------------------------------------
// Dave saw `pr_checkpoint` record "none by default" with no question shown (PRs 289 to 291) and the cause did not reproduce in a fresh session.
// The mod cannot tell a person's pick from any other source, so each dialog leaves one line with its timing. The next real occurrence then
// shows whether the answer came back in milliseconds or after minutes. How it can fail, and the test that catches it:
// D1 an answered dialog leaves no line, or a line without ts, session, header, label count, question length, outcome, matched label or elapsed ms
// D2 the line holds the question text or the words Dave typed under Other (label texts are logged since 11-05: lane checkpoint-ask-self-answer)
// D3 Esc or typed words are logged as a pick of a label (matched is not null)
// D6 the line lacks the option texts in the order shown, or the text of the label picked, or logs typed words as the picked label
// D4 a failing log write changes what the call records or says
// D5 the log grows without bound
const ASK_LOG = 'C:/home/.claude/state/ccv3-mods/ask-dialogs.jsonl'
const askLines = (written: Record<string, string>) =>
  (written[ASK_LOG] ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Rec)

describe('pr-checkpoint: every dialog leaves one log line', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })

  test('D1 an answered dialog writes one line with its timing, header, sizes, outcome and matched label', async ($, on) => {
    const w = world(on, { json: { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0] })) }, answer: 'manual' })
    await start($)
    const running = call($)
    await waitFor(() => w.seen.dialogs.length > 0)
    await w.clock.advance(7000)
    const dialog = w.seen.dialogs[0]!
    dialog.answer(/Recommended/)
    await running
    const lines = askLines(w.written)
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatchObject({
      session: SESSION,
      header: 'PR #7',
      labels: dialog.labels.length,
      questionChars: dialog.question.length,
      outcome: 'text',
      matched: 0,
      elapsedMs: 7000,
    })
    expect(Number.isNaN(Date.parse(String(lines[0]!.ts)))).toBe(false)
  })

  test('D2 the line holds no question text and no words typed under Other', async ($, on) => {
    const typed = 'please wait for the weekend'
    const w = world(on, { answer: { other: typed } })
    await start($)
    await call($)
    expect(askLines(w.written).length).toBe(ESC_ASKS)
    const text = w.written[ASK_LOG]!
    expect(text).not.toContain(typed)
    expect(text).not.toContain(w.seen.dialogs[0]!.question)
  })

  test('D6 the line lists the option texts in the order shown and the text of the label picked; typed words pick none', async ($, on) => {
    const w = world(on, { answers: [/Recommended/, { other: 'typed words' }] })
    await start($)
    await call($)
    await call($)
    const [picked, typed] = askLines(w.written)
    const shown = w.seen.dialogs[0]!.labels
    expect(picked!.options).toEqual(shown)
    expect(picked!.chosen).toBe(shown.find(label => /Recommended/.test(label)))
    expect(typed!.options).toEqual(w.seen.dialogs[1]!.labels)
    expect(typed!.chosen).toBeNull()
  })

  test('D3 Esc is logged closed and typed words are logged as no label; neither matches a label', async ($, on) => {
    const w = world(on, { answers: ['dismiss', { other: 'something else' }, 'dismiss'] })
    await start($)
    await call($)
    const lines = askLines(w.written)
    expect(lines.map(line => line.outcome)).toEqual(['closed', 'text', 'closed'])
    expect(lines.map(line => line.matched)).toEqual([null, null, null])
  })

  test('D4 a log write that throws changes nothing the call records or says', async ($, on) => {
    const w = world(on, { answers: PICK_YES, throwWrite: 'ask-dialogs' })
    await start($)
    const told = await call($)
    expect(told.thrown).toBeNull()
    expect(told.text).toMatch(/Dave chose coderabbit for #7/)
    expect(counts(w.seen).confirm).toBe(1)
    expect(w.written[ASK_LOG]).toBeUndefined()
  })

  test('D5 only the newest 500 lines are kept', async ($, on) => {
    const seeded = Array.from({ length: 600 }, (_, n) => JSON.stringify({ n })).join('\n')
    const w = world(on, { answer: /Recommended/, files: { [ASK_LOG]: seeded } })
    await start($)
    await call($)
    const lines = askLines(w.written)
    expect(lines.length).toBe(500)
    expect(lines[0]!.n).toBe(101)
    expect(lines[499]!.session).toBe(SESSION)
  })
})

describe('pr-checkpoint: the apply puts the PR in the free-slot queue (T1)', () => {
  const slotRuns = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('slot-queue.mjs'))).map(r => r.argv.slice(2))
  const withBand = (band: string | null) => ({ json: { stdout: JSON.stringify(engineJson({ auto: { eligible: false, band, reason: 'a person decides' } })) } })
  const ADD_HIGH = ['add', '--pr', '7', '--band', 'HIGH', '--head', HEAD, '--session', SESSION, '--json']

  test('T1 a HIGH coderabbit apply runs add --band HIGH on the record head, stores the band, and toasts the queue line', async ($, on) => {
    const { seen, store } = world(on, withBand('HIGH'))
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect(slotRuns(seen)).toEqual([ADD_HIGH])
    expect((store.get('checkpoint:pr:7') as Rec).band).toBe('HIGH')
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(seen.toasts.some(text => text.includes('#7') && text.includes('free CodeRabbit slot') && text.includes('label review'))).toBe(true)
  })

  test('T1 a CRITICAL apply runs add --band CRITICAL', async ($, on) => {
    const { seen } = world(on, withBand('CRITICAL'))
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect(slotRuns(seen)).toEqual([[...ADD_HIGH.slice(0, 4), 'CRITICAL', ...ADD_HIGH.slice(5)]])
  })

  for (const [name, band] of [['MID', 'MID'], ['no band', null]] as const) {
    test(`T1 a coderabbit apply in band ${name} runs no add`, async ($, on) => {
      const { seen, store } = world(on, withBand(band))
      const { pane } = await openPane($)
      await pane.press({ key: 'opt-coderabbit' })
      expect(slotRuns(seen)).toEqual([])
      expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    })
  }

  test('T1 a none apply in a HIGH band runs no add', async ($, on) => {
    const { seen } = world(on, withBand('HIGH'))
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-none' })
    expect(slotRuns(seen)).toEqual([])
  })

  test('T1 an engine apply that refuses runs no add', async ($, on) => {
    const { seen } = world(on, { ...withBand('HIGH'), apply: { exitCode: 1, stderr: 'the head moved' }, answers: [/Recommended/, /^Leave as draft/] })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(slotRuns(seen)).toEqual([])
  })

  test('T1 a failed add never fails the apply: the record is applied and Dave gets one toast with the reason', async ($, on) => {
    const { seen, store } = world(on, { ...withBand('HIGH'), slot: { exitCode: 2, stdout: '{"ok":false,"reason":"slot-queue: bad state file"}' } })
    const { pane } = await openPane($)
    await pane.press({ key: 'opt-coderabbit' })
    expect((store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(seen.toasts.filter(text => text.includes('slot-queue: bad state file')).length).toBe(1)
  })
})

// ---- the checkpoint asks Dave in the session (design 2026-11-03, spike S2: $.ui.ask only) ----------------------------------------------
// The mod raises the dialog itself ($.ui.ask) and waits for the answer inside the tool call. Only an exact match of one of its own
// labels records. How it can fail, and the test that catches it:
// T1  the recommended label does not record, or records --by dave          T2  another label records --by default
// T3  Esc records                  T4  words typed under Other record      T5  an empty answer records
// T6  a model AskUserQuestion with the same labels and its own answers records
// T7  a head that moved during the wait records                            T8  a headless run or a subagent raises a dialog
// T9  two calls raise two dialogs  T10 the pane survives (an open, or a model-facing word "pane")
// T14 a refused --apply has no Retry dialog                                T15 a bare bridge /pathway does not ask
// T18 a plan with no recommendation raises an invalid dialog               P1  a ccv3-mods hook answers AskUserQuestion
// T11 to T13 and T19 (the tick asks) sit in 'asks from the watcher' below.
describe('pr-checkpoint: the checkpoint asks Dave in the session', () => {
  const REC = /\(Recommended\)$/
  const call = ($: Engine, extra: Rec = {}) => callTool($, { pr: 7, body: 'pr-body.md', ...extra })

  test('T1 the recommended label records --by dave with one tap, with its cost in the label; the tool text names the pathway', async ($, on) => {
    const w = world(on, { answers: PICK_YES })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    const [dialog] = w.seen.dialogs
    expect(dialog!.labels[0]).toMatch(/^Keep as draft/)
    expect(dialog!.labels[1]).toMatch(/^CodeRabbit review \(may cost up to \$1\.75\)/)
    expect(dialog!.labels[1]).toMatch(REC)
    expect(dialog!.labels.filter(label => REC.test(label)).length).toBe(1)
    expect(dialog!.labels.length).toBeGreaterThanOrEqual(2)
    expect(dialog!.labels.length).toBeLessThanOrEqual(4)
    expect(dialog!.header!.length).toBeLessThanOrEqual(12)
    expect(dialog!.question).toContain('#7')
    expect(dialog!.question).toMatch(/7 files/)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
    expect(counts(w.seen).apply).toBe(1)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(told.text).toMatch(/Dave chose coderabbit for #7/)
    expect(told.text).toMatch(/Do not merge/)
    expect(w.store.get(PENDING)).toBeUndefined()
  })

  test('T2 another label records --by dave', async ($, on) => {
    const w = world(on, { answer: /^No review, land on CI/ })
    await start($)
    const told = await call($)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    expect((w.store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    expect(told.text).toMatch(/Dave chose none for #7/)
  })

  test('T2b Keep as draft records nothing, keeps the pending checkpoint and tells the model not to ask again', async ($, on) => {
    const w = world(on, { answer: /^Keep as draft/ })
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(w.store.get(PENDING)).toBeDefined()
    expect(told.text).toMatch(/kept #7 as a draft/i)
    expect(told.text).toMatch(/Do not ask him again/i)
    expect(told.text).not.toContain('/pathway')
  })

  test('T2c after Keep as draft a bare /pathway raises the same question again', async ($, on) => {
    const w = world(on, { answers: [/^Keep as draft/] })
    await start($)
    await call($)
    const ran = await slash($, '')
    expect(w.seen.dialogs.length).toBe(1 + ESC_ASKS)
    expect(w.seen.dialogs[1]!.labels).toEqual(w.seen.dialogs[0]!.labels)
    expect(ran.text ?? '').toMatch(/closed the question/i)
  })

  // The slot fact the engine prints beside the old capacity fields: the label and line 3 follow it.
  const slotJson = (slot: Rec) => ({ stdout: JSON.stringify(engineJson({ capacity: { count: 38, band: 'ok', warning: null, source: 'manual', date: '2026-10-25', ...slot } })) })

  test('S1 a free slot: the CodeRabbit label says free slot $0, line 3 says free now, and the pick records by dave with one tap', async ($, on) => {
    const w = world(on, { json: slotJson({ state: 'free', checkedAt: new Date(NOW).toISOString() }), answers: PICK_YES })
    await start($)
    await call($)
    const [dialog] = w.seen.dialogs
    expect(dialog!.labels[0]).toBe('Keep as draft ($0)')
    expect(dialog!.labels[1]).toBe('CodeRabbit now (free slot, $0) (Recommended)')
    expect(dialog!.question.split('\n')[2]).toBe('CodeRabbit slot: free now.')
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
  })

  test('S2 no free slot: the label says paid with the price, line 3 gives the time and the minutes, counted from the clock', async ($, on) => {
    const next = new Date(NOW + 38 * 60_000).toISOString()
    const w = world(on, { json: slotJson({ state: 'wait', nextSlotAt: next, minutesToSlot: 99 }), answers: PICK_YES })
    await start($)
    await call($)
    const [dialog] = w.seen.dialogs
    expect(dialog!.labels[0]).toMatch(/^Keep as draft/)
    expect(dialog!.labels[1]).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(dialog!.question.split('\n')[2]).toMatch(/^CodeRabbit slot: next about \d\d:\d\d C[SD]T \(in 38 min\)\.$/)
    expect(dialog!.labels.some(label => /wait for/i.test(label))).toBe(false)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
  })

  test('T3 Esc records nothing, keeps the pending checkpoint and leaves the PR a draft', async ($, on) => {
    const w = world(on, { answer: 'dismiss' })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.store.get(PENDING)).toBeDefined()
    expect(told.text).toMatch(/closed the question/i)
    expect(told.text).toMatch(/Nothing (was )?recorded/i)
  })

  test('T4 words typed under Other record nothing and reach the model', async ($, on) => {
    const w = world(on, { answer: { other: 'please wait for the weekend' } })
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toContain('please wait for the weekend')
    expect(told.text).toMatch(/Nothing (was )?recorded/i)
    expect(w.store.get(PENDING)).toBeDefined()
  })

  test('T4b Other text that equals a label exactly is Dave\'s own choice and records, as a typed /pathway does', async ($, on) => {
    const w = world(on, { answer: labels => ({ other: labels.find(l => /^No review, land on CI/.test(l))! }) })
    await start($)
    await call($)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('T4c a comma-joined answer records nothing', async ($, on) => {
    const w = world(on, { answer: { other: 'CodeRabbit review (may cost up to $1.75) (Recommended), No review, land on CI ($0)' } })
    await start($)
    await call($)
    expect(counts(w.seen).confirm).toBe(0)
  })

  // Dave 2026-11-06: a dialog answer records only when it is an exact label. A label without case or price, a row number, a pathway word with
  // the PR, or a label with a trailing space is a miss: it records nothing and the question comes back twice at most.
  for (const text of ['coderabbit review (may cost up to $1.75) (Recommended)', 'CodeRabbit review (may cost up to $1.75)', 'CodeRabbit review (may cost up to $1.75) (Recommended) ','1', '2', 'none', '7:coderabbit', 'coderabbit 7', 'accept']) {
    test(`T4d a loose typed answer records nothing and asks again: ${JSON.stringify(text)}`, async ($, on) => {
      const w = world(on, { answer: { other: text } })
      await start($)
      const told = await call($)
      expect(w.seen.dialogs.length).toBe(3)
      expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
      expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
      expect(told.text).toMatch(/Stop/)
      expect(told.text).toMatch(/stays a draft/)
    })
  }

  test('T4d a loose typed answer, then the exact label: the second answer records', async ($, on) => {
    const w = world(on, { answers: [{ other: 'none' }, /^No review, land on CI/] })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(2)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('T4e a typed none for another PR records nothing', async ($, on) => {
    const w = world(on, { answer: { other: '8:none' } })
    await start($)
    await call($)
    expect(counts(w.seen).confirm).toBe(0)
  })

  test('T5 an empty answer records nothing', async ($, on) => {
    const w = world(on, { answer: 'empty' })
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/No valid answer|closed the question/i)
    expect(w.store.get(PENDING)).toBeDefined()
  })

  test('T6 a model AskUserQuestion with the checkpoint labels and its own answers records nothing', async ($, on) => {
    const w = world(on, { answer: 'dismiss' })
    await start($)
    const question = 'PR #7: which review?'
    const options = ['CodeRabbit review (may cost up to $1.75) (Recommended)', 'No review, land on CI ($0)'].map(label => ({ label, description: label }))
    await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question, header: 'PR #7', options, multiSelect: false }], answers: { [question]: options[0]!.label } } as never).catch(() => undefined)
    await settle()
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.seen.run.filter(r => r.argv[0] === 'gh' && r.argv[2] === 'ready').length).toBe(0)
  })

  test('T7 a head that moved while Dave answered records nothing', async ($, on) => {
    const opts: Opts = { answer: REC, json: NONE_REC_JSON }
    const w = world(on, opts)
    opts.answer = () => {
      opts.viewHead = OTHER_HEAD
      return REC
    }
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/changed while Dave answered/i)
    expect(told.text).toMatch(/head moved/i)
  })

  test('T7c a risk:high label added while Dave answered records nothing (the recommendation he saw is stale)', async ($, on) => {
    const opts: Opts = { json: NONE_REC_JSON }
    const w = world(on, opts)
    opts.answer = () => {
      opts.labels = ['risk:high']
      return REC
    }
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/changed while Dave answered/i)
    expect(told.text).toMatch(/risk:high/i)
  })

  test('T7d a risk:high label removed while Dave answered records nothing', async ($, on) => {
    const opts: Opts = { labels: ['risk:high'], json: NONE_REC_JSON }
    const w = world(on, opts)
    opts.answer = () => {
      opts.labels = []
      return REC
    }
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/risk:high/i)
  })

  test('T7e an unrelated label change while Dave answered still records', async ($, on) => {
    const opts: Opts = { json: NONE_REC_JSON }
    const w = world(on, opts)
    opts.answer = () => {
      opts.labels = ['size:l']
      return REC
    }
    await start($)
    await call($)
    expect(counts(w.seen).confirm).toBe(1)
  })

  test('T7b a PR that left draft while Dave answered records nothing', async ($, on) => {
    const opts: Opts = { json: NONE_REC_JSON }
    const w = world(on, opts)
    opts.answer = () => {
      opts.isDraft = false
      return REC
    }
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/no longer a draft/i)
  })

  test('T8 a headless session raises no dialog and gets the text plan', async ($, on) => {
    const w = world(on, { answer: REC })
    await start($, false)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/Nothing was recorded/)
  })

  test('T8b a subagent call raises no dialog, records nothing and gets the text plan', async ($, on) => {
    const w = world(on, { answer: REC })
    await start($)
    const told = await call($, { agentId: 'sub-1' })
    expect(w.seen.dialogs).toEqual([])
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(told.text).toMatch(/subagent/i)
    expect(w.store.get(PENDING)).toBeUndefined()
  })

  test('T9 two calls at once raise one dialog; the second says a question is open', async ($, on) => {
    const w = world(on, { json: NONE_REC_JSON, answer: 'manual' })
    await start($)
    const first = call($)
    await waitFor(() => w.seen.dialogs.length > 0)
    const second = await call($)
    expect(second.text).toMatch(/question is open/i)
    expect(w.seen.dialogs.length).toBe(1)
    w.seen.dialogs[0]!.answer(/Recommended/)
    await first
    await settle()
    expect(counts(w.seen).confirm).toBe(1)
    expect(w.seen.dialogs.length).toBe(1)
  })

  test('T10 no pane opens, and no word the model reads says pane', async ($, on) => {
    const opts: Opts = { answers: [REC, 'dismiss', 'empty', { other: 'x' }, /^Keep as draft/] }
    const w = world(on, opts)
    await start($)
    const outcomes: string[] = [...w.seen.descriptions]
    for (let i = 0; i < 5; i += 1) outcomes.push((await call($)).text)
    opts.json = { stdout: JSON.stringify(engineJson({ recommended: null, options: [], why: ['Run pre-pr.mjs: no stamp for this head.'] })) }
    outcomes.push((await call($)).text)
    const target = ['C:/r/.claude/cache/pre-pr', 'pathway.json'].join('/')
    outcomes.push(JSON.stringify(await $.tool.call({ tool: 'Write', file_path: target, content: '{}' } as never)))
    expect(w.seen.opens).toEqual([])
    for (const text of outcomes) expect(text).not.toMatch(/\bpane\b/i)
    expect(outcomes.length).toBeGreaterThan(8)
    expect(w.seen.descriptions.length).toBeGreaterThanOrEqual(2)
  })

  test('T14 a refused --apply raises a Retry dialog; Retry runs --apply again', async ($, on) => {
    const w = world(on, { answers: [...PICK_YES, /^Retry/], applySeq: [{ exitCode: 1, stderr: 'pr-checkpoint: refused: The head of PR #7 moved.\n' }] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(2)
    expect(w.seen.dialogs[1]!.question).toMatch(/Retry/)
    expect(w.seen.dialogs[1]!.question).toContain('The head of PR #7 moved.')
    expect(counts(w.seen).confirm).toBe(1)
    expect(counts(w.seen).apply).toBe(2)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(told.text).toMatch(/Dave chose/)
  })

  test('T14b Leave as draft after a refused --apply keeps the record confirmed and runs --apply once', async ($, on) => {
    const w = world(on, { answers: [...PICK_YES, /^Leave as draft/], apply: { exitCode: 1, stderr: 'pr-checkpoint: refused: nope.\n' } })
    await start($)
    const told = await call($)
    expect(counts(w.seen).apply).toBe(1)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('confirmed')
    expect(told.text).toMatch(/confirmed, but --apply was refused/)
  })

  test('T15 a bare bridge /pathway with a pending checkpoint raises the dialog, and Dave\'s answer on the phone records', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answers: PICK_YES })
    await start($)
    const ran = await slash($, '', 'bridge')
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.opens).toEqual([])
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
    expect(ran.text ?? '').toMatch(/coderabbit/)
  })

  test('T15b a bare /pathway whose dialog is closed records nothing and keeps the pending checkpoint', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answer: 'dismiss' })
    await start($)
    await slash($, '')
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    expect(counts(w.seen).confirm).toBe(0)
    expect(w.store.get(PENDING)).toBeDefined()
  })

  for (const [name, json] of [
    ['no recommendation', engineJson({ recommended: null, options: [], why: ['Run pre-pr.mjs: no stamp for this head.'], budget: [0, 0] })],
    ['a recommendation and no open option', engineJson({ options: [option('coderabbit', { available: false, reason: 'held' })] })],
  ] as const) {
    test(`T18 ${name}: no dialog, the tool text holds the engine reason, the PR stays a draft`, async ($, on) => {
      const w = world(on, { json: { stdout: JSON.stringify(json) }, answer: REC })
      await start($)
      const told = await call($)
      expect(w.seen.dialogs).toEqual([])
      expect(counts(w.seen).confirm).toBe(0)
      expect(told.text).toMatch(name === 'no recommendation' ? /Run pre-pr\.mjs/ : /held|no option|Nothing recorded/i)
      expect(told.text).toMatch(/stays a draft/i)
    })
  }

  test('T20 an engine option list of four open pathways plus wait still gives at most four labels, one Keep as draft', async ($, on) => {
    const four = engineJson({ recommended: 'both', options: [option('wait'), option('none'), option('coderabbit'), option('both')] })
    const w = world(on, { json: { stdout: JSON.stringify(four) }, answer: 'dismiss' })
    await start($)
    await call($)
    const labels = w.seen.dialogs[0]!.labels
    expect(labels.length).toBeLessThanOrEqual(4)
    expect(labels.filter(l => /^Keep as draft/.test(l)).length).toBe(1)
    expect(labels[0]).toMatch(/^Keep as draft/)
    expect(labels.find(label => label.includes('(Recommended)'))).toMatch(/^CodeRabbit \+ Greptile \(may cost up to \$1\.75 \+ 3 credits\)/)
  })

  test('P1 no ccv3-mods hook answers a model AskUserQuestion: the call reaches the engine bottom unchanged', async ($, on) => {
    const w = world(on, { answer: 'dismiss' })
    await start($)
    const question = 'Spike?'
    const raw = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question, header: 'x', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] } as never).catch(() => 'rejected')
    expect(w.seen.asks).toEqual([question])
    expect(JSON.stringify(raw)).toMatch(/dismissed|rejected/)
  })
})

// ---- a paid pick that is not the recommendation asks ONE question (Dave 2026-11-05; PRs 315 and 316 recorded coderabbit 7 s and 20 s after the dialog opened) ----
// PR C: the price is in the label of the paid row, so the tap on it is the paid yes, and a paid row is never row 0. A mis-tap is still visible.
// With none recommended the labels are [none (Recommended), Keep as draft, paid].
// How it can fail, and the test that catches it:
// C1 the paid pick records with a second question, or none                      C2 a second Yes/No question is asked
// C3 Esc on the question records                                               C4 words typed on the question record, or reach the log
// C5 the Recommended row asks again   C6 none asks again when a paid pathway is recommended   C7 Keep as draft asks again
describe('pr-checkpoint: a paid pick that is not the recommendation asks one question', () => {
  const noneRecommended = { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0] })) }
  const PAID = /^CodeRabbit review/
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const confirms = (seen: { run: Run[] }) => engineCalls(seen).filter(c => c.startsWith('--confirm'))
  const nothingRecorded = (w: ReturnType<typeof world>) => {
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.seen.run.some(r => r.argv[0] === 'gh' && (r.argv[2] === 'edit' || r.argv[2] === 'ready'))).toBe(false)
    expect(w.store.get(PENDING)).toBeDefined()
  }

  test('C1 none recommended, the paid row picked: one dialog, the paid pathway is recorded', async ($, on) => {
    const w = world(on, { json: noneRecommended, answers: [PAID] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.dialogs[0]!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['No review, land on CI', 'Keep as draft', 'CodeRabbit review'])
    expect(w.seen.dialogs[0]!.labels[2]).toBe('CodeRabbit review (may cost up to $1.75)')
    expect(confirms(w.seen)).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(told.text).toMatch(/Dave chose coderabbit for #7/)
  })

  test('C2 no second question: no Yes or No confirm label is ever shown', async ($, on) => {
    const w = world(on, { json: noneRecommended, answers: [PAID] })
    await start($)
    await call($)
    expect(w.seen.dialogs.flatMap(dialog => dialog.labels).some(label => /^(Yes|No), /.test(label))).toBe(false)
  })

  test('C3 Esc on the question records nothing', async ($, on) => {
    const w = world(on, { json: noneRecommended, answers: ['dismiss'] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    nothingRecorded(w)
    expect(told.text).toMatch(/stays a draft/i)
  })

  test('C4 words typed on the question record nothing and the log keeps no typed word', async ($, on) => {
    const typed = 'yes go ahead and spend it'
    const w = world(on, { json: noneRecommended, answers: [{ other: typed }] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    nothingRecorded(w)
    expect(told.text).toMatch(/Nothing (was )?recorded/i)
    const lines = askLines(w.written)
    expect(lines.map(line => line.matched)).toEqual([null, null, null])
    expect(w.written[ASK_LOG]).not.toContain(typed)
  })

  test('C5 picking the Recommended row asks once', async ($, on) => {
    const w = world(on, { json: noneRecommended, answers: [/\(Recommended\)$/] })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(confirms(w.seen)).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('C6 picking none when a paid pathway is recommended asks once', async ($, on) => {
    const w = world(on, { answers: [/^No review, land on CI/] })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(confirms(w.seen)).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('C7 picking Keep as draft asks once', async ($, on) => {
    const w = world(on, { json: noneRecommended, answers: [/^Keep as draft/] })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).confirm).toBe(0)
  })
})

// T11 a tick ask is answered after the queue changed: the answer lands on the wrong ask
// T12 a closed tick ask nags: none at the next tick, one after 30 minutes, none after the second close
// T13 a round Yes does not store the grant, or a No does not store the decline
// T19 two watching sessions both ask, or none does (one lease per PR)
describe('pr-checkpoint: the watcher raises its asks as dialogs', () => {
  const watchDoc = (extra: Rec = {}) => ({ [WATCH]: { prs: [{ pr: 7, state: null, whenReady: false, ...extra }], backoffUntil: 0, touched: NOW } })
  const record = (over: Rec = {}) => ({
    pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default',
    capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 26 * MIN, ...over,
  })
  const REVIEWED = (rounds: number) => status(7, {
    reasons: ['1 review thread(s) unresolved'], unresolved: 1, coderabbitReviewedHead: true, routedReviewed: true, coderabbitRounds: rounds, coderabbitRequests: Math.max(0, rounds - 1),
  })
  const asksOf = (store: Map<string, unknown>) => (store.get(ASKS) ?? []) as Rec[]
  const LEASE = 'checkpoint:asking:7'
  const setup = (opts: Opts = {}) => ({ statuses: { 7: REVIEWED(3) }, ...opts, store: { ...watchDoc(), 'checkpoint:pr:7': record(), ...(opts.store ?? {}) } })

  test('A1 the round ask is one dialog: No is first and marked Recommended, the cost is in each label, the text names the round and the 7d count', async ($, on) => {
    const w = world(on, setup({ answer: 'dismiss' }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    const [dialog] = w.seen.dialogs
    expect(dialog!.question).toContain('Round 4 of 1+2 for #7')
    expect(dialog!.question).toMatch(/7d.*38/)
    expect(dialog!.labels.length).toBe(2)
    expect(dialog!.labels[0]).toMatch(/^No, stay in budget .*\(Recommended\)$/)
    expect(dialog!.labels[1]).toMatch(/^Yes, one more review .*\$/)
    expect(dialog!.labels.every(label => /\$/.test(label))).toBe(true)
    expect(w.seen.opens).toEqual([])
    expect(counts(w.seen).comments).toEqual([])
  })

  test('T13 round Yes stores the grant for round 4 on this head, tells the model, and posts nothing', async ($, on) => {
    const w = world(on, setup({ answer: /^Yes/ }))
    await start($)
    await w.clock.advance(TICK)
    const grant = w.store.get('checkpoint:grant:7') as Rec
    expect(grant.round).toBe(4)
    expect(grant.head).toBe(HEAD)
    expect(asksOf(w.store)).toEqual([])
    expect(counts(w.seen).comments).toEqual([])
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Dave allowed round 4 for #7')
  })

  test('T13 round No stores the decline on the record, no grant, and the model is told', async ($, on) => {
    const w = world(on, setup({ answer: /^No/ }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    const declined = (w.store.get('checkpoint:pr:7') as Rec).declined as Rec
    expect(declined.kind).toBe('round')
    expect(declined.round).toBe(4)
    expect(asksOf(w.store)).toEqual([])
    expect(JSON.stringify(w.session.appended().map(row => row.message))).toContain('Dave declined round 4 for #7')
  })

  test('T13 an answer that is not one of the two labels stores nothing and keeps the ask queued', async ($, on) => {
    const w = world(on, setup({ answer: { other: 'yes please' } }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeUndefined()
    expect(asksOf(w.store).length).toBe(1)
  })

  test('T11 the ask left the queue while the dialog was open: the answer is dropped, nothing is stored, Dave gets a toast', async ($, on) => {
    const opts = setup()
    const w = world(on, opts)
    opts.answer = () => {
      w.store.delete(ASKS)
      return /^Yes/
    }
    await start($)
    await w.clock.advance(TICK)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeUndefined()
    expect(w.seen.toasts.some(text => /#7 changed; nothing posted/.test(text))).toBe(true)
  })

  test('T11b an opening Yes whose ask moved to another head while the dialog was open posts nothing', async ($, on) => {
    const opts = setup({ store: { 'checkpoint:pr:7': record({ appliedAt: NOW - 40 * MIN }) }, statuses: { 7: status(7, { coderabbitRounds: 0, coderabbitRequests: 0 }) } })
    const w = world(on, opts)
    opts.answer = () => {
      w.store.set(ASKS, [{ ...asksOf(w.store)[0]!, head: OTHER_HEAD }])
      return /^Yes/
    }
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).comments).toEqual([])
  })

  test('T12 a closed ask is quiet at the next tick, comes back once after 30 minutes, and not after the second close', async ($, on) => {
    const w = world(on, setup({ answer: 'dismiss' }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    for (let i = 0; i < 5; i += 1) await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(2)
    for (let i = 0; i < 12; i += 1) await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(2)
    const left = asksOf(w.store)
    expect(left.length).toBe(1)
    expect(left[0]!.dismissed).toBe(2)
  })

  test('T12b a bare /pathway raises a closed ask again, deferred or not', async ($, on) => {
    // The PR is READY (it has an applied record and a queued ask): the bare /pathway reads the draft state first (PR 2 item 1a), and a draft would be cleaned, not asked.
    const w = world(on, setup({ answers: ['dismiss', /^Yes/], isDraft: false }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    const ran = await slash($, '')
    expect(w.seen.dialogs.length).toBe(2)
    expect((w.store.get('checkpoint:grant:7') as Rec).round).toBe(4)
    expect(ran.text ?? '').toMatch(/round 4/i)
  })

  test('T19 a live lease of another session keeps this one quiet; when it lapses this session asks and holds the lease', async ($, on) => {
    const w = world(on, setup({ answer: 'dismiss', store: { [LEASE]: { session: 'other-session', until: NOW + 12 * MIN } } }))
    await start($)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(0)
    expect(asksOf(w.store).length).toBe(1)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect((w.store.get(LEASE) as Rec).session).toBe(SESSION)
  })

  test('T19b the holder keeps the lease while its ask is queued and drops it when the answer is stored', async ($, on) => {
    const w = world(on, setup({ answer: /^Yes/ }))
    await start($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.store.get(LEASE)).toBeUndefined()
  })
})

// ---- "No review, land on CI" at every band (Dave 2026-11-04) -----------------------------------------------------------------------------
// N-M1  the option is missing, first or marked Recommended for HIGH or CRITICAL
// N-M2  picking it does not record none --by dave, or adds a bot label or a queue entry
// N-M3  a typed /pathway 7 none is refused for HIGH            N-M4  a near miss of the label records
// N-M5  a HIGH checkpoint that the engine calls auto-eligible records anything but Dave's pick
describe('pr-checkpoint: No review, land on CI at HIGH and CRITICAL', () => {
  const NO_REVIEW = 'No review, land on CI ($0)'
  const highJson = (band: 'HIGH' | 'CRITICAL', over: Rec = {}) => ({
    stdout: JSON.stringify(
      engineJson({
        recommended: 'coderabbit',
        options: [option('coderabbit'), option('both'), option('none')],
        band: { band },
        auto: { eligible: false, band, reason: `Band ${band}: Dave presses.` },
        ...over,
      }),
    ),
  })
  const queueRuns = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('slot-queue.mjs'))).map(r => r.argv.slice(2))

  for (const band of ['HIGH', 'CRITICAL'] as const) {
    test(`N-M1 ${band}: the last label is the no-review one; the recommendation is marked and is not row 0; none is never first or Recommended`, async ($, on) => {
      world(on, { json: highJson(band) })
      const { dialog, pane } = await openPane($)
      expect(dialog!.labels.at(-1)).toBe(NO_REVIEW)
      expect(dialog!.labels[1]).toMatch(/^CodeRabbit review .*\(Recommended\)$/)
      expect(dialog!.labels.filter(label => label.includes('(Recommended)')).length).toBe(1)
      expect(dialog!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['Keep as draft', 'CodeRabbit review', 'CodeRabbit + Greptile', 'No review, land on CI'])
      await pane.press({ key: 'dismiss' })
    })

    test(`N-M2 ${band}: picking it records none --by dave, applies once, adds no bot label and no queue entry`, async ($, on) => {
      const { seen, store } = world(on, { json: highJson(band), answer: /^No review, land on CI/ })
      await start($)
      const told = await callTool($, { pr: 7, body: 'pr-body.md' })
      const confirms = engineCalls(seen).filter(call => call.startsWith('--confirm'))
      expect(confirms).toEqual([expect.stringMatching(/^--confirm none --by dave --body \S*pr-body\.md --pr 7$/)])
      expect(counts(seen).apply).toBe(1)
      const record = store.get('checkpoint:pr:7') as Rec
      expect(record.pathway).toBe('none')
      expect(record.decided_by).toBe('dave')
      expect(record.state).toBe('applied')
      expect(record.label).toBe('review:none')
      expect(queueRuns(seen)).toEqual([])
      expect(seen.run.filter(r => r.argv[0] === 'gh' && r.argv.some(a => /review:(coderabbit|deep)/.test(a))).length).toBe(0)
      expect(told.text).toMatch(/Dave chose none for #7/)
      expect(store.get(PENDING)).toBeUndefined()
    })
  }

  test('N-M3 a typed /pathway 7 none records --by dave for a HIGH PR', async ($, on) => {
    const { seen, store } = world(on, { json: highJson('HIGH') })
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(engineCalls(seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    expect(ran.text ?? '').toMatch(/none recorded/)
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
  })

  test('N-M4 a comma-joined pair that holds the none label records nothing', async ($, on) => {
    const w = world(on, { json: highJson('HIGH'), answer: { other: `CodeRabbit review (may cost up to $1.75) (Recommended), ${NO_REVIEW}` } })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(counts(w.seen).confirm).toBe(0)
  })

  // A loose typed none at HIGH records nothing: only the exact label does (Dave 2026-11-06).
  for (const text of ['No review, land on CI', 'no review, land on CI ($0)', 'none', '7:none']) {
    test(`N-M4b a loose typed none at HIGH records nothing: ${JSON.stringify(text)}`, async ($, on) => {
      const w = world(on, { json: highJson('HIGH'), answer: { other: text } })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      expect(counts(w.seen).confirm).toBe(0)
    })
  }

  test('N-M5 an engine that calls a HIGH checkpoint auto-eligible while it recommends coderabbit still waits for Dave: no --by auto', async ($, on) => {
    const lying = highJson('HIGH', { auto: { eligible: true, band: 'HIGH', reason: 'x' } })
    const w = world(on, { json: lying, answer: 'dismiss' })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(engineCalls(w.seen).some(call => call.includes('--by auto'))).toBe(false)
    expect(counts(w.seen).confirm).toBe(0)
  })

  // N-M6  a typed none from the bridge at HIGH or CRITICAL records with no dialog      N-M7  the dialog gate also holds a LOW PR back (it must not)
  // N-M8  a held recommendation at HIGH marks a label Recommended, or puts none first
  for (const band of ['HIGH', 'CRITICAL'] as const) {
    test(`N-M6 ${band}: a bridge /pathway 7 none raises the dialog and records nothing until the exact label`, async ($, on) => {
      const w = world(on, { json: highJson(band), answers: ['dismiss', 'dismiss'] })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      const ran = await slash($, '7 none', 'bridge')
      expect(w.seen.dialogs.length).toBe(ESC_ASKS * 2)
      expect(w.seen.dialogs[1]!.labels.at(-1)).toBe(NO_REVIEW)
      expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
      expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
      expect(w.store.get(PENDING)).toBeDefined()
      expect(ran.text ?? '').not.toMatch(/none recorded/)
    })

    test(`N-M6b ${band}: the exact label in that bridge dialog records none --by dave`, async ($, on) => {
      const w = world(on, { json: highJson(band), answers: ['dismiss', 'dismiss', 'dismiss', /^No review, land on CI/] })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      await slash($, '7 none', 'bridge')
      expect(w.seen.dialogs.length).toBe(ESC_ASKS + 1)
      expect(engineCalls(w.seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
      expect((w.store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    })
  }

  test('N-M6c a composer /pathway 7 none at CRITICAL records --by dave with no second dialog', async ($, on) => {
    const w = world(on, { json: highJson('CRITICAL'), answer: 'dismiss' })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await slash($, '7 none')
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    expect(engineCalls(w.seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('N-M7 a bridge /pathway 7 none at LOW still records --by dave with no dialog', async ($, on) => {
    const low = { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], band: { band: 'LOW' }, auto: { eligible: false, band: 'LOW', reason: 'a person decides' } })) }
    const w = world(on, { json: low, answer: 'dismiss' })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await slash($, '7 none', 'bridge')
    expect(w.seen.dialogs.length).toBe(ESC_ASKS)
    expect(engineCalls(w.seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
  })

  test('N-M8 a held recommendation at HIGH: Keep as draft, coderabbit, then no review; only Keep as draft is Recommended (m5); the none pick is --by dave', async ($, on) => {
    const held = highJson('HIGH', {
      recommended: 'both',
      options: [option('coderabbit'), option('both', { available: false, reason: 'Greptile held: credits unknown' }), option('none')],
    })
    const { seen } = world(on, { json: held })
    const { dialog, pane } = await openPane($)
    expect(dialog!.labels.map(label => label.replace(/ \(.*$/, ''))).toEqual(['Keep as draft', 'CodeRabbit review', 'No review, land on CI'])
    expect(dialog!.labels.filter(label => label.includes('(Recommended)'))).toEqual(['Keep as draft ($0) (Recommended)'])
    await pane.press({ key: 'opt-none' })
    expect(engineCalls(seen).find(call => call.startsWith('--confirm'))).toMatch(/^--confirm none --by dave /)
  })

  // N-M9  the interim CodeRabbit rule makes none the recommendation at HIGH and CRITICAL. The first label is then Recommended, but the engine
  //       refuses --by default for none there and land-none-check.mjs reads decided_by dave, so its pick and `accept` must record --by dave.
  for (const band of ['HIGH', 'CRITICAL'] as const) {
    const noneRecommended = () => highJson(band, { recommended: 'none', options: [option('none'), option('coderabbit')] })

    test(`N-M9 ${band}: none is the recommendation: it is first and Recommended, and its pick records --by dave, never --by default`, async ($, on) => {
      const { seen, store } = world(on, { json: noneRecommended(), answer: /^No review, land on CI/ })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      expect(seen.dialogs[0]!.labels[0]).toBe(`${NO_REVIEW} (Recommended)`)
      expect(engineCalls(seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
      expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    })

    test(`N-M9b ${band}: a typed /pathway 7 accept of a recommended none records --by dave`, async ($, on) => {
      const { seen } = world(on, { json: noneRecommended(), answer: 'dismiss' })
      await start($)
      await callTool($, { pr: 7, body: 'pr-body.md' })
      await slash($, '7 accept')
      expect(engineCalls(seen).filter(call => call.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    })
  }
})

// ---- self-approve: the record says how Dave chose, and the store file is locked (lane agent-self-approve-hole, Dave 2026-11-03: DETECT) ----------
// land-pr.ps1 (land-none-check.mjs) reads `via` from checkpoint:pr:<n> and refuses a HIGH or CRITICAL review:none pick that did not come from Dave's dialog or composer.
// V1  a dialog pick stores no `via`, or the wrong one       V2  a composer word stores no `via`, or the wrong one
// V3  a bridge-typed word stores `dialog` or nothing; a bridge none at HIGH that Dave answers in the dialog stores anything but `dialog`
// V4  auto-confirm stores no `via`, or one that is not `auto`
// V5  Lock A lets a tool write reach the plugin store file          V6  Lock B lets shell text that WRITES the plugin store file run (warn mode included)
// V7  Lock B denies a pure read, a search, a commit message, another plugin's store, or a test run with --store (false positives)
describe('pr-checkpoint: via, and the plugin store lock', () => {
  const bandJson = (band: 'LOW' | 'HIGH' | 'CRITICAL') => ({
    stdout: JSON.stringify(
      engineJson({
        recommended: band === 'LOW' ? 'none' : 'coderabbit',
        options: band === 'LOW' ? [option('none'), option('coderabbit')] : [option('coderabbit'), option('both'), option('none')],
        band: { band },
        auto: { eligible: false, band, reason: `Band ${band}: Dave presses.` },
      }),
    ),
  })
  const viaOf = (store: Map<string, unknown>) => (store.get('checkpoint:pr:7') as Rec).via

  test('V1: a dialog pick of none at HIGH stores via dialog', async ($, on) => {
    const { store } = world(on, { json: bandJson('HIGH'), answer: /^No review, land on CI/ })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(viaOf(store)).toBe('dialog')
    expect((store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
  })

  test('V2: /pathway <pr> none from the composer stores via composer', async ($, on) => {
    const { store } = world(on, { json: bandJson('HIGH') })
    await start($)
    await slash($, '7 none --body pr-body.md')
    expect(viaOf(store)).toBe('composer')
  })

  test('V3: a bridge /pathway <pr> none at LOW stores via bridge', async ($, on) => {
    const low = world(on, { json: bandJson('LOW'), answer: 'dismiss' })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await slash($, '7 none', 'bridge')
    expect(viaOf(low.store)).toBe('bridge')
  })

  test('V3b: a bridge none at HIGH raises the dialog, and the exact label stores via dialog', async ($, on) => {
    const w = world(on, { json: bandJson('HIGH'), answers: ['dismiss', /^No review, land on CI/] })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await slash($, '7 none', 'bridge')
    expect(w.seen.dialogs.length).toBe(2)
    expect(viaOf(w.store)).toBe('dialog')
  })

  test('V4: auto-confirm stores via auto', async ($, on) => {
    const { store } = world(on, { json: autoJson() })
    await start($)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    expect(viaOf(store)).toBe('auto')
  })

  const STORE_FILES = [
    'C:/home/.claude/plugins/store/ccv3-mods_ccv3-c4cd07c751a8.json',
    'C:\\home\\.claude\\plugins\\store\\ccv3-mods_ccv3-c4cd07c751a8.json',
    'c:/HOME/.CLAUDE/Plugins/Store/CCV3-Mods_x.JSON',
    'C:/home/.claude/plugins/store/./../store/ccv3-mods_x.json',
    'C:/home/.claude/plugins/store/ccv3-mods_x.json.tmp-123',
  ]

  for (const tool of ['Write', 'Edit', 'MultiEdit'] as const) {
    test(`V5: a ${tool} of the plugin store file is denied in every spelling; a neighbour file passes`, async ($, on) => {
      const { seen } = world(on)
      await start($)
      for (const file_path of STORE_FILES) {
        const r = (await $.tool.call({ tool, file_path, content: '{}', old_string: 'a', new_string: 'b', edits: [] } as never)) as unknown as { deny?: string }
        expect(LOCK_DENIED(r), file_path).toBe(true)
        expect(r.deny).toMatch(/plugin store/i)
      }
      expect(seen.ran).toEqual([])
      const passed = await $.tool.call({ tool, file_path: 'C:/home/.claude/plugins/ccv3-mods/README.md', content: 'x', old_string: 'a', new_string: 'b', edits: [] } as never)
      expect(LOCK_DENIED(passed as never)).toBe(false)
    })
  }

  const shell = async ($: Engine, tool: 'Bash' | 'PowerShell', command: string) => (await $.tool.call({ tool, command } as never)) as unknown as { deny?: string }

  test('V6: shell text that WRITES, moves, deletes or builds the real plugin store file is denied in every form, in warn mode, and spawns no CLI', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const WRITES: [('Bash' | 'PowerShell'), string][] = [
      ['Bash', `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/plugins/store/ccv3-mods_x.json','{}')"`],
      ['Bash', 'cp /tmp/x.json ~/.claude/plugins/store/ccv3-mods_x.json'],
      ['Bash', 'mv /tmp/x.json ~/.claude/plugins/store/ccv3-mods_x.json'],
      ['Bash', 'rm ~/.claude/plugins/store/ccv3-mods_ccv3-c4cd07c751a8.json'],
      ['Bash', 'cd ~/.claude/plugins/store && echo {} > ccv3-mods_x.json'],
      ['Bash', 'cat /tmp/x.json > ~/.claude/plugins/store/ccv3-mods_x.json'],
      ['Bash', 'echo {} | tee ~/.claude/plugins/store/ccv3-mods_x.json'],
      ['Bash', 'git rm ~/.claude/plugins/store/ccv3-mods_x.json'],
      ['PowerShell', "Set-Content -Path $HOME\\.claude\\plugins\\store\\ccv3-mods_x.json -Value '{}'"],
      ['PowerShell', "'{}' | Out-File $HOME/.claude/plugins/store/ccv3-mods_x.json"],
      ['PowerShell', 'Remove-Item $HOME/.claude/plugins/store/ccv3-mods_x.json'],
      ['PowerShell', 'Get-Content a.json | Set-Content $HOME/.claude/plugins/store/ccv3-mods_x.json'],
      // A PowerShell backtick escape splits the name across two pieces, so no single piece names the file (CodeRabbit, #286).
      ['PowerShell', "cd $HOME\\.claude\\plugins\\store; Set-Content ccv3-mods`_x.json '{}'"],
      // A permitted read in one piece must not hide a split-name write in another (CodeRabbit round 2, #286).
      ['PowerShell', `Get-Content "$HOME/.claude/plugins/store/ccv3-mods_x.json"; Set-Content "$HOME/.claude/plugins/store/ccv3-mods\`_x.json" '{}'`],
      ['PowerShell', "cd $HOME\\.claude\\plugins\\store; Get-Content ccv3-mods_x.json; Set-Content ccv3-mods`_x.json '{}'"],
    ]
    for (const [tool, command] of WRITES) {
      const r = await shell($, tool, command)
      expect(LOCK_DENIED(r), `${tool}: ${command}`).toBe(true)
      expect(r.deny).toMatch(/plugin store/i)
    }
    expect(seen.ran).toEqual([])
    expect(argvOf(seen, 'checkpoint-shapes-cli')).toEqual([])
  })

  test('V7: a pure read of the store, a search that names the folder, a commit message, another plugin store and a --store test run all pass', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const PASSES: [('Bash' | 'PowerShell'), string][] = [
      ['Bash', 'cat ~/.claude/plugins/store/ccv3-mods_ccv3-c4cd07c751a8.json'],
      ['Bash', 'ls ~/.claude/plugins/store'],
      ['Bash', 'rg -n "plugins/store" scripts/'],
      ['Bash', 'git commit -m "docs: the land gate reads ~/.claude/plugins/store/ccv3-mods_x.json"'],
      ['Bash', 'cat ~/.claude/plugins/store/cc-plugin-diff_builtin-3903e77c01b1.json'],
      ['Bash', 'cp /tmp/x.json ~/.claude/plugins/store/checkpoint-spike_inline-1cd1e6356cdf.json'],
      ['Bash', 'node scripts/github/land-none-check.mjs 900 --repo o/r --head abc --store C:/tmp/ccv3-mods_ok.json'],
      ['Bash', 'ls ~/.claude/plugins/ccv3-mods'],
      ['PowerShell', 'Get-Content $HOME/.claude/plugins/store/ccv3-mods_x.json'],
      ['PowerShell', 'git commit -m "docs: the land gate reads ~/.claude/plugins/store/ccv3-mods_x.json"'],
    ]
    for (const [tool, command] of PASSES) {
      expect(LOCK_DENIED(await shell($, tool, command)), `${tool}: ${command}`).toBe(false)
    }
    expect(seen.ran.length).toBe(PASSES.length)
  })
})

// ---- pathway flow v2 (Dave 2026-11-06): every decision is a tap ----------------------------------------------------------------------
// How it can fail, and the test that catches it:
// W1  (T11) one dialog return marks a paid PR ready: row 0 on a recommended paid pick records something (PR C: row 0 is Keep as draft)
// W2  the tap on the paid row cannot record, or records by default (PR C: one question)
// W3  a free-text, Esc or empty answer is not asked again, or is asked more than 2 more times, or the stop does not say the PR stays a draft
// W4  (M6) the lines after the first one change the pick, or are not named
// W5  a typed paid word records with no question that shows the price
// R1  (M2) a ready PR with a record cannot be changed, or the undo runs without Dave's answer, or the PR stays ready after a re-pick
// R2  the mod's own undo is seen by Lock B or a shell hook
// L1  (M1) the flag on: the tool opens a dialog itself, records on call 1, or does not return the question for the model
// L2  the flag on: the tap is recorded without --by dave --pr, or twice, or a stop/kept-draft records
// L3  the flag on: a typed /pathway raises a dialog whose tap the engine would refuse
describe('pr-checkpoint v2: a paid pick asks one question, one dialog return never records a paid pick', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const row0 = (labels: string[]) => labels[0]!
  const waitSlot = { stdout: JSON.stringify(engineJson({ capacity: { count: 38, band: 'ok', warning: null, source: 'manual', date: '2026-10-25', state: 'wait', nextSlotAt: new Date(NOW + 38 * MIN).toISOString(), minutesToSlot: 38, checkedAt: new Date(NOW).toISOString() } })) }

  for (const [name, json] of [['an unknown slot', undefined], ['no free slot', waitSlot]] as const) {
    test(`W1 row 0 on a recommended paid pick records nothing and spends nothing (${name})`, async ($, on) => {
      const w = world(on, { ...(json ? { json } : {}), answer: row0 })
      await start($)
      const told = await call($)
      expect(w.seen.dialogs.length).toBe(1)
      expect(w.seen.dialogs[0]!.labels[0]).toMatch(/^Keep as draft/)
      expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
      expect(w.seen.run.some(r => r.argv[0] === 'gh' && (r.argv[2] === 'edit' || r.argv[2] === 'ready' || r.argv[2] === 'comment'))).toBe(false)
      expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
      expect(told.text).toMatch(/Nothing recorded/)
      expect(told.text).toMatch(/kept #7 as a draft/)
    })
  }

  test('W2 the tap on the paid row records by dave, once, then applies', async ($, on) => {
    const w = world(on, { answers: [/\(Recommended\)$/] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
    expect(counts(w.seen).apply).toBe(1)
    expect((w.store.get('checkpoint:pr:7') as Rec).decided_by).toBe('dave')
    expect(told.text).toMatch(/by dave/)
  })

  test('W2 a free-slot CodeRabbit pick is a $0 row: it is row 1, after Keep as draft, and its tap records at once', async ($, on) => {
    const free = { stdout: JSON.stringify(engineJson({ capacity: { count: 38, band: 'ok', warning: null, source: 'manual', date: '2026-10-25', state: 'free', checkedAt: new Date(NOW).toISOString() } })) }
    const w = world(on, { json: free, answers: [/^CodeRabbit now \(free slot/] })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.dialogs[0]!.labels[0]).toBe('Keep as draft ($0)')
    expect(w.seen.dialogs[0]!.labels[1]).toBe('CodeRabbit now (free slot, $0) (Recommended)')
    expect(counts(w.seen).confirm).toBe(1)
  })

  test('W2 none recommended and picked records at once by dave: no second question', async ($, on) => {
    const none = { stdout: JSON.stringify(engineJson({ recommended: 'none', options: [option('none'), option('coderabbit')], budget: [0, 0] })) }
    const w = world(on, { json: none, answer: row0 })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
  })

  test('W3 a free-text answer is asked again, and the next tap records', async ($, on) => {
    const w = world(on, { answers: [{ other: 'hmm, not sure yet' }, /^No review, land on CI/] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(2)
    expect(w.seen.dialogs[1]!.question).toContain('Asking again (1 of 2)')
    expect(w.seen.dialogs[1]!.question).toContain('PR #7')
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    expect(told.text).toMatch(/Dave chose none/)
  })

  test('W3 three misses (text, Esc, empty) stop: 3 dialogs, nothing recorded, the PR stays a draft, the pending stays', async ($, on) => {
    const w = world(on, { answers: [{ other: 'hmm, not sure yet' }, 'dismiss', 'empty'] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(3)
    expect(w.seen.dialogs[2]!.question).toContain('Asking again (2 of 2)')
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.store.get(PENDING)).toBeDefined()
    expect(told.text).toMatch(/Stop/)
    expect(told.text).toMatch(/stays a draft/)
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(told.text).not.toMatch(/\/pathway </)
  })

  test('W3 Keep as draft is an answer, not a miss: one dialog', async ($, on) => {
    const w = world(on, { answer: /^Keep as draft/ })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).confirm).toBe(0)
  })

  test('W3 a typed yes on the one question is a miss, and three misses record nothing', async ($, on) => {
    const w = world(on, { answers: [{ other: 'yes' }, 'dismiss', 'empty'] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(3)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/stays a draft/)
  })

  test('W4 a typed answer with more lines is a miss in the dialog: nothing records', async ($, on) => {
    const w = world(on, { answer: { other: 'none\n\nThis is exactly what I wanted, thanks.' } })
    await start($)
    const told = await call($)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/stays a draft/)
  })

  // Item 1: with none as the first row, "1" and "none" both name a row, and the dialog still records nothing for them.
  for (const typed of ['1', 'none']) {
    test(`W4 the answer ${JSON.stringify(typed)} records nothing in the dialog and the question comes back`, async ($, on) => {
      const w = world(on, { json: NONE_REC_JSON, answer: { other: typed } })
      await start($)
      const told = await call($)
      expect(w.seen.dialogs.length).toBe(3)
      expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
      expect(told.text).toMatch(/Stop/)
      expect(told.text).toMatch(/stays a draft/)
    })
  }

  test('W5 a typed paid word from the composer asks the one question (price in the label), not a Yes or No confirm', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answer: /^Keep as draft/ })
    await start($)
    await slash($, '7 coderabbit')
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.dialogs[0]!.labels[0]).toMatch(/^Keep as draft/)
    expect(w.seen.dialogs[0]!.labels.some(label => /^(Yes|No), /.test(label))).toBe(false)
    expect(counts(w.seen).confirm).toBe(0)
  })

  test('W5 the tap on the paid row of that question records by dave', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answer: /^CodeRabbit review/ })
    await start($)
    await slash($, '7 coderabbit')
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
  })
})

describe('pr-checkpoint v2: a ready PR with a record can change its pick (M2)', () => {
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const ready = viewJson({ isDraft: false })
  const KEEP = 'Keep review:coderabbit (Recommended)'
  const BACK = 'Return to draft and pick again'
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const undos = (seen: { run: Run[] }) => seen.run.filter(r => r.argv[0] === 'gh' && r.argv[2] === 'ready').map(r => r.argv)

  test('R1 Return to draft: the mod undoes ready itself, then asks the pick, and the pick records', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^No review, land on CI/] })
    await start($)
    const told = await call($)
    const [first] = w.seen.dialogs
    expect(first!.header).toBe('PR #7')
    expect(first!.labels).toEqual([KEEP, BACK])
    expect(first!.question).toContain('Change the review pick?')
    expect(first!.question).toContain('review:coderabbit')
    expect(undos(w.seen)).toEqual([['gh', 'pr', 'ready', '7', '--undo', '-R', REPO]])
    expect(w.seen.dialogs.length).toBe(2)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave /)])
    // The undo came before the new record.
    const order = w.seen.run.map(r => (r.argv[2] === 'ready' ? 'undo' : r.argv.includes('--confirm') ? 'confirm' : ''))
    expect(order.indexOf('undo')).toBeLessThan(order.indexOf('confirm'))
    expect(told.text).toMatch(/Dave chose none/)
  })

  test('R1 Return to draft, then Keep as draft: the PR is left a draft and the text says so', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^Keep as draft/] })
    await start($)
    const told = await call($)
    expect(undos(w.seen).length).toBe(1)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/kept #7 as a draft/i)
  })

  test('R1 Keep: nothing is undone and nothing is recorded', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: KEEP })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(undos(w.seen)).toEqual([])
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/review:coderabbit/)
    expect(told.text).toMatch(/Nothing was changed/)
  })

  test('R1 three misses on the change question change nothing and undo nothing', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: 'dismiss' })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(3)
    expect(undos(w.seen)).toEqual([])
    expect(told.text).toMatch(/Nothing was changed/)
  })

  test('R1 a failed undo says so, asks no pick and records nothing', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], undo: { exitCode: 1, stderr: 'GraphQL: not allowed' }, answer: BACK })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).confirm).toBe(0)
    expect(told.text).toMatch(/Could not return #7 to draft/)
  })

  test('R1 a ready PR with no record is refused as before, with no question', async ($, on) => {
    const w = world(on, { viewSeq: [ready] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(undos(w.seen)).toEqual([])
    expect(told.text).toMatch(/is not a draft/)
  })

  test('R1 a record for another head is refused as before', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': { ...RECORD, head: OTHER_HEAD } }, viewSeq: [ready] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(told.text).toMatch(/is not a draft/)
  })

  test('R2 the undo is the mod\'s own process call: no shell tool call, no shapes CLI', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^Keep as draft/] })
    await start($)
    await call($)
    expect(undos(w.seen).length).toBe(1)
    expect(w.seen.ran).toEqual([])
    expect(argvOf(w.seen, 'checkpoint-shapes-cli')).toEqual([])
  })
})

describe('pr-checkpoint v2: checkpoint.ledger on, the model asks the question (M1)', () => {
  const LEDGER_ON = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const SPEC = {
    header: 'PR #7',
    question: 'PR #7, band MID, 7 files.\nRecommended: CodeRabbit review.\nCodeRabbit slot: unknown (no notice seen).',
    options: [
      { label: 'Keep as draft ($0)', description: 'b' },
      { label: 'CodeRabbit review (may cost up to $1.75) (Recommended)', description: 'a' },
      { label: 'No review, land on CI ($0)', description: 'c' },
    ],
  }
  const withLedger = (ledger: Rec) => ({ stdout: JSON.stringify({ ...engineJson(), ledger }) })
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })

  test('L1 call 1 returns the question for the model: no dialog, nothing recorded, the pending stays', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'ask', ask: SPEC, reasked: 0, text: 'Call AskUserQuestion with ask, word for word. Then call pr_checkpoint {pr} again.' }) })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(told.text).toContain('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(told.text).toContain('Keep as draft ($0)')
    expect(told.text).toMatch(/Keep the options in the order given/)
    expect(told.text).not.toContain('slot changed')
    expect(told.text).toMatch(/AskUserQuestion/)
    expect(told.text).toMatch(/pr_checkpoint/)
    expect(told.text).toMatch(/same pr and body/)
    expect(w.store.get(PENDING)).toBeDefined()
  })

  // Row 0 must be a $0 row. A question whose row 0 can spend money is refused: nothing is stored, nothing is asked, the model tells Dave.
  test('L1b a question whose row 0 is not a $0 row is refused: no question text, no pending, nothing recorded', async ($, on) => {
    const paidFirst = { ...SPEC, options: [SPEC.options[1]!, SPEC.options[0]!, SPEC.options[2]!] }
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'ask', ask: paidFirst, reasked: 0, text: 'ask' }) })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(told.text).not.toContain('AskUserQuestion')
    expect(told.text).toMatch(/row 0|first option/i)
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(told.text).toMatch(/tell Dave/i)
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get(PENDING)).toBeUndefined()
  })

  test('L1d a re-ask after a slot change tells the model why, so Dave hears it; the first ask has no such line', async ($, on) => {
    const note = 'The CodeRabbit slot changed. Your tap was not recorded.'
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'ask', ask: SPEC, reasked: 0, text: `${note} Call AskUserQuestion.`, note }) })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(told.text).toContain(note)
    expect(told.text).toMatch(/AskUserQuestion/)
  })

  test('L1c a row 0 that is a $0 row with the Recommended mark is asked (L1 covers the unmarked one)', async ($, on) => {
    const marked = { ...SPEC, options: [{ label: 'No review, land on CI ($0) (Recommended)', description: 'a' }, SPEC.options[0]!, SPEC.options[1]!] }
    world(on, { files: LEDGER_ON, json: withLedger({ state: 'ask', ask: marked, reasked: 0, text: 'ask' }) })
    await start($)
    expect((await call($)).text).toMatch(/Ask Dave now with AskUserQuestion/)
  })

  test('L2 call 2 with the tap records by dave with --pr, once, and applies; no dialog', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'record', pathway: 'coderabbit', by: 'dave', text: 'Dave picked coderabbit. Record it.' }) })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave --body \S*pr-body\.md --pr 7$/)])
    expect(counts(w.seen).apply).toBe(1)
    const record = w.store.get('checkpoint:pr:7') as Rec
    expect(record.decided_by).toBe('dave')
    expect(record.via).toBe('dialog')
    expect(told.text).toMatch(/Dave chose coderabbit for #7/)
  })

  for (const [state, text] of [
    ['stop', 'Stop. PR #7 stays a draft. Nothing was recorded. Tell Dave.'],
    ['kept-draft', 'Nothing was recorded. PR #7 stays a draft. Call pr_checkpoint {pr} when Dave wants to pick again.'],
  ] as const) {
    test(`L2 ${state} records nothing and relays the engine text`, async ($, on) => {
      const w = world(on, { files: LEDGER_ON, json: withLedger({ state, text }) })
      await start($)
      const told = await call($)
      expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
      expect(w.seen.dialogs).toEqual([])
      expect(told.text).toContain('stays a draft')
    })
  }

  test('L2 the two calls, as Dave runs them: call 1 asks, call 2 finds the tap and records once; no dialog at all', async ($, on) => {
    const w = world(on, {
      files: LEDGER_ON,
      ledgerSeq: [withLedger({ state: 'ask', ask: SPEC, reasked: 0, text: 'Call AskUserQuestion with ask, word for word.' }), withLedger({ state: 'record', pathway: 'coderabbit', by: 'dave', text: 'Dave picked coderabbit. Record it.' })],
    })
    await start($)
    const first = await call($)
    expect(first.text).toContain('Keep as draft ($0)')
    expect(counts(w.seen).confirm).toBe(0)
    expect(w.store.get(PENDING)).toBeDefined()
    const second = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave --body \S*pr-body\.md --pr 7$/)])
    expect(counts(w.seen).apply).toBe(1)
    expect(second.text).toMatch(/Dave chose coderabbit for #7/)
    expect(w.store.get(PENDING)).toBeUndefined()
  })

  test('L2 the engine refuses the record (no tap in the store): nothing is stored and the refusal reaches the model', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'record', pathway: 'coderabbit', by: 'dave', text: '' }), confirm: { exitCode: 1, stderr: "pr-checkpoint: refused: No tap of Dave's for coderabbit on PR #7" } })
    await start($)
    const told = await call($)
    expect(counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(told.text).toContain('No tap')
  })

  test('L3 a typed /pathway from the composer raises no dialog and records nothing: the model is told to call the tool', async ($, on) => {
    const w = world(on, { files: LEDGER_ON })
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(w.seen.dialogs).toEqual([])
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(JSON.stringify(ran)).toMatch(/pr_checkpoint/)
    expect(JSON.stringify(ran)).not.toMatch(/\/pathway </)
  })

  // The two flags disagree: the PR branch lives in a worktree (WT) whose config differs from the session root's. The engine runs in WT, so WT decides.
  const WT_CONFIG = `${WT}/review-router.config.json`
  const ON = JSON.stringify({ checkpoint: { enforce: false, ledger: true } })
  const OFF = JSON.stringify({ checkpoint: { enforce: false } })

  test('L4 the flag is on in the checkout the engine runs in and off in the session root: the model asks (ledger call), no dialog', async ($, on) => {
    const w = world(on, wtOpts({ files: { [CONFIG]: OFF, [WT_CONFIG]: ON }, ledgerSeq: [withLedger({ state: 'ask', ask: SPEC, reasked: 0, text: 'Call AskUserQuestion with ask, word for word.' })] }))
    await start($)
    const told = await call($)
    expect(w.seen.dialogs).toEqual([])
    expect(told.text).toContain('Keep as draft ($0)')
    expect(w.seen.run.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json') && !r.argv.includes('--no-ledger')).map(r => r.cwd)).toEqual([WT])
  })

  test('L4 the flag is off in the checkout the engine runs in and on in the session root: Dave gets the dialog, no ledger call, and --confirm still carries --pr', async ($, on) => {
    const w = world(on, wtOpts({ files: { [CONFIG]: ON, [WT_CONFIG]: OFF }, answer: /^No review/ }))
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.run.filter(r => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json') && !r.argv.includes('--no-ledger'))).toEqual([])
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm none --by dave --body \S*pr-body\.md --pr 7$/)])
  })

  test('L3 the flag off keeps the dialog for a typed /pathway', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answer: /^Keep as draft/ })
    await start($)
    await slash($, '')
    expect(w.seen.dialogs.length).toBe(1)
  })
})

describe('pr-checkpoint v2: prepare asks the engine for facts only; the ledger step is a second call (item 3, item 2)', () => {
  const LEDGER_ON = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const SPEC = {
    header: 'PR #7',
    question: 'PR #7, band MID, 7 files.\nRecommended: CodeRabbit review.\nCodeRabbit slot: unknown (no notice seen).',
    options: [
      { label: 'Keep as draft ($0)', description: 'b' },
      { label: 'CodeRabbit review (may cost up to $1.75) (Recommended)', description: 'a' },
      { label: 'No review, land on CI ($0)', description: 'c' },
    ],
  }
  const withLedger = (ledger: Rec, base: Rec = engineJson()) => ({ stdout: JSON.stringify({ ...base, ledger }) })
  const ASK = withLedger({ state: 'ask', ask: SPEC, reasked: 0, text: 'ask' })
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const jsonCalls = (seen: { run: Run[] }) => engineCalls(seen).filter(c => c.includes('--json'))
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }

  test('E1 the prepare call carries --no-ledger and --probe; the ledger step carries neither probe nor --no-ledger', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    const calls = jsonCalls(w.seen)
    expect(calls.length).toBe(2)
    expect(calls[0]).toMatch(/--no-ledger/)
    expect(calls[0]).toMatch(/--probe/)
    expect(calls[1]).toBe('--json --pr 7')
    expect(told.text).toContain('Keep as draft ($0)')
  })

  test('E1 a Dependabot PR passes --dependabot to the ledger step too: the offer is built from the facts Dave was shown', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, author: 'dependabot[bot]', ledgerSeq: [ASK] })
    await start($)
    await call($)
    const calls = jsonCalls(w.seen)
    expect(calls[0]).toMatch(/--dependabot/)
    expect(calls[1]).toBe('--json --pr 7 --dependabot')
  })

  test('E1 a head that moved stops at the head check: one engine call, with --no-ledger, so no offer is written and no miss is counted', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, viewHead: OTHER_HEAD, ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    const calls = jsonCalls(w.seen)
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatch(/--no-ledger/)
    expect(told.text).toMatch(/Nothing was recorded/)
    expect(told.text).not.toContain('Keep as draft ($0)')
  })

  test('E1 the flag off: one engine call, no ledger step, the dialog asks', async ($, on) => {
    const w = world(on, { answer: /^Keep as draft/ })
    await start($)
    await call($)
    expect(jsonCalls(w.seen).length).toBe(1)
    expect(w.seen.dialogs.length).toBe(1)
  })

  test('E1 the question text comes from the second call: a stop block on the first call is not read', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: withLedger({ state: 'stop', text: 'Stop. PR #7 stays a draft.' }), ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    expect(told.text).toContain('Keep as draft ($0)')
    expect(told.text).not.toContain('Stop. PR #7')
    expect(w.seen.dialogs).toEqual([])
  })

  test('E1 a ready PR returned to draft: the undo runs before the ledger step, and nothing asks the engine before the undo', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, store: { 'checkpoint:pr:7': RECORD }, viewSeq: [viewJson({ isDraft: false })], answer: 'Return to draft and pick again', ledgerSeq: [ASK] })
    await start($)
    await call($)
    const engine = (r: Run) => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json')
    const order = w.seen.run.map(r => (r.argv[2] === 'ready' ? 'undo' : engine(r) ? (r.argv.includes('--no-ledger') ? 'facts' : 'ledger') : ''))
    expect(order.filter(Boolean)).toEqual(['undo', 'facts', 'ledger'])
  })

  test('E2 an auto-eligible PR whose auto-confirm failed asks the engine again with --ask-anyway, and the question comes back, not "no question"', async ($, on) => {
    const eligible = autoJson()
    const w = world(on, { files: LEDGER_ON, json: eligible, confirm: { exitCode: 1, stderr: 'pr-checkpoint: refused: the body changed' }, ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    const calls = jsonCalls(w.seen)
    expect(calls.length).toBe(2)
    expect(calls[1]).toBe('--json --pr 7 --ask-anyway')
    expect(told.text).toMatch(/Auto-confirm was not possible/)
    expect(told.text).toContain('Keep as draft ($0)')
    expect(told.text).toMatch(/AskUserQuestion/)
    expect(told.text).not.toMatch(/stays a draft/)
    expect(counts(w.seen).apply).toBe(0)
  })

  test('E2 an eligible PR that auto-confirm records asks nothing and makes no ledger call', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: autoJson() })
    await start($)
    const told = await call($)
    expect(jsonCalls(w.seen).length).toBe(1)
    expect(told.text).toMatch(/auto-confirmed/)
  })

  test('E2 a PR that is not auto-eligible gets no --ask-anyway', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(jsonCalls(w.seen).some(c => c.includes('--ask-anyway'))).toBe(false)
  })

  test('E2 an eligible PR whose recommendation is not none is never auto-confirmed, so it is asked with --ask-anyway too', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, json: { stdout: JSON.stringify(engineJson({ auto: AUTO })) }, ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    expect(jsonCalls(w.seen)[1]).toBe('--json --pr 7 --ask-anyway')
    expect(told.text).toContain('Keep as draft ($0)')
  })

  test('E1 an unreadable ledger answer (an engine with the flag off for this checkout) falls back to the dialog', async ($, on) => {
    const w = world(on, { files: LEDGER_ON, answer: /^Keep as draft/ })
    await start($)
    await call($)
    expect(w.seen.dialogs.length).toBe(1)
  })
})

describe('pr-checkpoint v2: Return to draft drops the grant and the free-slot queue entry (item 4)', () => {
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const GRANT = { round: 2, head: HEAD, at: NOW }
  const BACK = 'Return to draft and pick again'
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const drops = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.some(a => a.includes('slot-queue.mjs')) && r.argv.includes('drop')).map(r => r.argv)
  const ready = viewJson({ isDraft: false })

  test('Q1 after a good undo the grant row goes and the queue entry of the PR is dropped, before the next question', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD, 'checkpoint:grant:7': GRANT }, viewSeq: [ready], answers: [BACK, /^Keep as draft/] })
    await start($)
    await call($)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    const [drop] = drops(w.seen)
    expect(drop).toBeDefined()
    expect(drop!.slice(drop!.indexOf('drop'), drop!.indexOf('drop') + 3)).toEqual(['drop', '--pr', '7'])
    // PR 1 taps: the tap drop ('taps', the engine's --drop-taps) runs after the queue drop and before the next question.
    const order = w.seen.run.map(r => (r.argv[2] === 'ready' ? 'undo' : r.argv.includes('--drop-taps') ? 'taps' : r.argv.includes('drop') ? 'drop' : r.argv.some(a => a.includes('pr-checkpoint.mjs')) ? 'engine' : ''))
    expect(order.filter(Boolean)).toEqual(['undo', 'drop', 'taps', 'engine'])
    expect(w.seen.ran).toEqual([])
  })

  test('Q1 a failed undo leaves the grant and the queue entry alone', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD, 'checkpoint:grant:7': GRANT }, viewSeq: [ready], undo: { exitCode: 1, stderr: 'GraphQL: not allowed' }, answer: BACK })
    await start($)
    await call($)
    expect(w.store.get('checkpoint:grant:7')).toEqual(GRANT)
    expect(drops(w.seen)).toEqual([])
  })

  test('Q1 Keep drops nothing', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD, 'checkpoint:grant:7': GRANT }, viewSeq: [ready], answer: 'Keep review:coderabbit (Recommended)' })
    await start($)
    await call($)
    expect(w.store.get('checkpoint:grant:7')).toEqual(GRANT)
    expect(drops(w.seen)).toEqual([])
  })

  test('Q1 (PR 2 item 7) a queue drop that fails stops the new question: the queue could still post a review for the draft PR', async ($, on) => {
    const w = world(on, { store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], slot: { exitCode: 2, stderr: 'slot-queue: lock busy' }, answers: [BACK, /^Keep as draft/] })
    await start($)
    const told = await call($)
    expect(drops(w.seen).length).toBe(1)
    expect(w.seen.dialogs.length).toBe(1) // only the change-the-pick question Dave answered
    expect(told.text).toMatch(/cleanup of PR #7 is not finished.*queue entry/i)
  })
})

describe('pr-checkpoint: who raised an AskUserQuestion (GPAA P3, T0)', () => {
  // The agentic-os tap writer skips the mod's own dialogs by reading `next.origin.plugin`. This pins the two values it relies on.
  test('T0 a call by the model reads origin engine; the mod own $.ui.ask reads origin ccv3-mods', async ($, on) => {
    const { seen } = world(on, { answers: ['Alpha', ...PICK_YES] })
    await start($)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which one?', header: 'Test', options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }], multiSelect: false }] } as never)
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await settle()
    expect(seen.origins.length).toBeGreaterThanOrEqual(2)
    expect(seen.origins[0]).toEqual({ plugin: 'engine', tier: 'core' })
    // Every dialog of the mod (the pick) reads the same.
    for (const origin of seen.origins.slice(1)) expect(origin).toEqual({ plugin: 'ccv3-mods', tier: 'user' })
  })

  // TAP11: the agentic-os tap writer skips a dialog whose origin is not the engine. Without the skip, the pick of
  // the mod would be stored as taps by Dave. The model call at the end proves the writer is live in this world (a control).
  test('TAP11 the own dialogs of the mod are not stored as taps; a model call in the same session is', async ($, on) => {
    const { seen, written } = world(on, { answers: [...PICK_YES, 'Alpha'] })
    await start($)
    const everything = () => Object.values(written).join('\n')
    await callTool($, { pr: 7, body: 'pr-body.md' })
    await settle()
    expect(seen.origins.length).toBeGreaterThanOrEqual(1)
    expect(everything()).not.toContain('Dave (tap)')
    await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which one?', header: 'Test', options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }], multiSelect: false }] } as never)
    expect(everything()).toContain('Test: Alpha')
  })
})

// ---- one question for a paid pick (card prflow-review-pick, PR C) -----------------------------------------------------------------------
// The price is in the label of the paid row, so Dave's tap on it is the paid yes. No second "paid confirm" dialog exists, and row 0 is never a paid row.
// How it can fail, and the test that catches it:
// X1  a paid row is row 0, or a paid label has no price, or the question does not name the recommendation
// X2  a dialog that returns row 0 with no tap records or spends something
// X3  a paid tap asks a second question, or does not record by dave once
// X4  a PR returned to draft (change pick) is auto-confirmed, in the dialog mode or in the ledger mode, on call 1 or on call 2
// X5  a typed paid word records with no question that shows the price
describe('pr-checkpoint PR C: a paid pick asks one question', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const LEDGER = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', budget: [0, 0], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const BACK = 'Return to draft and pick again'
  const ready = viewJson({ isDraft: false })
  const ASK = { stdout: JSON.stringify({ ...engineJson(), ledger: { state: 'ask', ask: { header: 'PR #7', question: 'q', options: [{ label: 'Keep as draft ($0)', description: 'a' }, { label: 'No review, land on CI ($0)', description: 'b' }] }, reasked: 0, text: 'ask' } }) }
  const jsonCalls = (seen: { run: Run[] }) => engineCalls(seen).filter(c => c.includes('--json'))
  const autoConfirms = (seen: { run: Run[] }) => confirms(seen).filter(r => r.argv.includes('auto'))
  /** The marker's `at` is the mock clock (ms); the mod hands it to the engine as an ISO time (--repick-since). */
  const SINCE = new Date(NOW).toISOString()

  test('X1 one dialog: the paid label carries its price, row 0 is Keep as draft, the question names the recommendation', async ($, on) => {
    const w = world(on, { answer: 'dismiss' })
    await start($)
    await call($)
    const first = w.seen.dialogs[0]!
    expect(first.labels[0]).toMatch(/^Keep as draft/)
    expect(first.labels[0]).not.toMatch(/Recommended/)
    expect(first.labels.find(label => /^CodeRabbit review/.test(label))).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(first.question).toContain('Recommended: CodeRabbit review')
  })

  test('X2 row 0 on the question records nothing: one dialog, no confirm, no apply, no label', async ($, on) => {
    const w = world(on, { answer: labels => labels[0]! })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(counts(w.seen).confirm + counts(w.seen).apply).toBe(0)
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(told.text).toMatch(/kept #7 as a draft/)
  })

  test('X3 the tap on the paid row records by dave, once, then applies: one dialog, no Yes or No confirm', async ($, on) => {
    const w = world(on, { answer: /^CodeRabbit review/ })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(1)
    expect(engineCalls(w.seen).filter(c => c.startsWith('--confirm'))).toEqual([expect.stringMatching(/^--confirm coderabbit --by dave /)])
    expect(counts(w.seen).apply).toBe(1)
    expect(w.seen.dialogs.flatMap(d => d.labels).some(label => /^(Yes|No), /.test(label))).toBe(false)
    expect(told.text).toMatch(/Dave chose coderabbit/)
  })

  test('X4 dialog mode: a PR returned to draft asks the pick and is not auto-confirmed', async ($, on) => {
    const w = world(on, { json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^Keep as draft/] })
    await start($)
    const told = await call($)
    expect(w.seen.dialogs.length).toBe(2)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(told.text).toMatch(/kept #7 as a draft/i)
  })

  test('X4 ledger mode, call 1: a PR returned to draft is not auto-confirmed and the engine is asked with --ask-anyway', async ($, on) => {
    const w = world(on, { files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: BACK, ledgerSeq: [ASK] })
    await start($)
    const told = await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(jsonCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
    expect(told.text).toContain('Keep as draft ($0)')
  })

  test('X4 ledger mode, call 2 (the PR is a draft now): still no auto-confirm, still --ask-anyway', async ($, on) => {
    const w = world(on, { files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: BACK, ledgerSeq: [ASK, ASK] })
    await start($)
    await call($)
    const second = await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(jsonCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
    expect(second.text).toContain('Keep as draft ($0)')
  })

  test('X4 ledger mode: the first ledger call fails (no pending is stored), the next call still asks and never records --by auto', async ($, on) => {
    const w = world(on, { files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: BACK, ledgerSeq: [{ exitCode: 1, stderr: 'pr-checkpoint: boom' }, ASK] })
    await start($)
    await call($)
    const second = await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(jsonCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
    expect(second.text).toContain('Keep as draft ($0)')
  })

  test('X4 another checkpoint between the two calls does not open the door: a PR returned to draft is still asked', async ($, on) => {
    const other = { pr: 8, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: BACK, ledgerSeq: [{ exitCode: 1, stderr: 'pr-checkpoint: boom' }, ASK] })
    await start($)
    await call($)
    w.store.set(PENDING, other)
    const second = await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(second.text).toContain('Keep as draft ($0)') // m9: the second call is checked, not only the first
  })

  // One re-pick marker per PR (`checkpoint:repick:<pr>`): set when a PR with an applied record is returned to draft, cleared only when Dave's pick is applied.
  // While it is set the PR is never auto-confirmed, on any head. Without it a failed --apply left the record `confirmed`, the returned-to-draft test read false
  // and the next call auto-confirmed none and marked the PR ready over Dave's pick.
  const MARKER = 'checkpoint:repick:7'
  const asked = (w: { seen: { dialogs: unknown[] } }) => w.seen.dialogs.length

  test('X6 return to draft, Dave taps CodeRabbit, --apply fails: the next call asks again and never records --by auto', async ($, on) => {
    const w = world(on, { json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^CodeRabbit review/, /^Leave as draft/, 'dismiss', 'dismiss', 'dismiss'], apply: { exitCode: 1, stderr: 'pr-checkpoint: refused: nope.\n' } })
    await start($)
    await call($)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('confirmed')
    expect(w.store.get(MARKER)).toBeDefined()
    const before = asked(w)
    await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(asked(w)).toBeGreaterThan(before)
    expect(w.store.get(MARKER)).toBeDefined()
  })

  test('X6 a new push (another head) after a return to draft still asks: the marker holds on any head', async ($, on) => {
    const old = { ...RECORD, head: 'b'.repeat(40) }
    const w = world(on, { json: autoJson(), store: { 'checkpoint:pr:7': old, [MARKER]: { head: 'b'.repeat(40), at: NOW } }, answers: ['dismiss', 'dismiss', 'dismiss'] })
    await start($)
    await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(asked(w)).toBeGreaterThan(0)
  })

  test('X6 ledger mode: the marker also makes the engine call carry --ask-anyway', async ($, on) => {
    const w = world(on, { files: LEDGER, json: autoJson(), store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(autoConfirms(w.seen)).toEqual([])
    expect(jsonCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
  })

  test('X6 the first LOW auto-confirm of a fresh PR (no marker) still works and sets no marker', async ($, on) => {
    const w = world(on, { json: autoJson({ auto: { ...AUTO, band: 'LOW' } }) }) // the fixture reports the band the test names
    await start($)
    const told = await call($)
    expect(autoConfirms(w.seen).length).toBe(1)
    expect(told.text).toMatch(/auto-confirmed/)
    expect(w.store.get(MARKER)).toBeUndefined()
  })

  test('X6 the marker clears after Dave\'s pick is applied, so a later fresh cycle can auto-confirm again', async ($, on) => {
    const w = world(on, { json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answers: [BACK, /^CodeRabbit review/] })
    await start($)
    await call($)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(w.store.get(MARKER)).toBeUndefined()
    w.store.delete('checkpoint:pr:7')
    await call($)
    expect(autoConfirms(w.seen).length).toBe(1)
  })

  // Order (a): the free-slot and the paid CodeRabbit row now sit at the same place (after Keep as draft), so the label alone tells them apart.
  test('g a refused --apply then a second call after the slot changed: the free-slot and the paid CodeRabbit row differ in label, row 0 is Keep as draft', async ($, on) => {
    const slot = (over: Rec) => ({ stdout: JSON.stringify(engineJson({ capacity: { count: 38, band: 'ok', warning: null, source: 'manual', date: '2026-10-25', checkedAt: new Date(NOW).toISOString(), ...over } })) })
    const w = world(on, {
      jsonSeq: [slot({ state: 'free' }), slot({ state: 'wait', nextSlotAt: new Date(NOW + 38 * MIN).toISOString(), minutesToSlot: 38 })],
      answers: [/^CodeRabbit now \(free slot/, /^Leave as draft/, 'dismiss'],
      apply: { exitCode: 1, stderr: 'pr-checkpoint: refused: nope.\n' },
    })
    await start($)
    await call($)
    await call($)
    const [free, retry, paid] = w.seen.dialogs
    expect(retry!.question).toMatch(/Retry/)
    const crRow = (labels: string[]) => labels.find(label => /^CodeRabbit (now|review)/.test(label))!.replace(/ \(Recommended\)$/, '')
    expect([free!.labels[0], paid!.labels[0]]).toEqual(['Keep as draft ($0)', 'Keep as draft ($0)'])
    expect([crRow(free!.labels), crRow(paid!.labels)]).toEqual(['CodeRabbit now (free slot, $0)', 'CodeRabbit review (may cost up to $1.75)'])
  })

  test('X5 a typed paid word asks the one question (price in the label) and records nothing without a tap', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const w = world(on, { store: { [PENDING]: pending }, answer: /^Keep as draft/ })
    await start($)
    await slash($, '7 coderabbit')
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.dialogs[0]!.labels.some(label => /^CodeRabbit review \(may cost up to \$1\.75\)/.test(label))).toBe(true)
    expect(counts(w.seen).confirm).toBe(0)
  })
})

// ---- PR 1 "taps" of card prflow-paid-run-guard ------------------------------------------------------------------------------------------
// A stored tap must not record after a PR went back to draft. The engine owns the store (its tests keep the real taps: pr-checkpoint-ledger.test.mjs
// A1 to A6); the mod owns WHEN the drop runs and what Dave and the model are told. The fake engine here is stateless, so these tests pin the calls.
// How it can fail, and the test that catches it:
// AM1  the drop does not run after the undo (before the question is built), or runs more than once, or before the undo succeeded
// AM2  a PR returned to draft by hand (a record applied at this head, the PR a draft) gets no drop, or one on every call, or a fresh PR gets one
// AM3  a failed drop still asks Dave or still builds a question, or loses the marker, or says nothing
// AM4  the marker time does not reach the engine (--repick-since), an unreadable marker omits the flag, or a fresh PR passes one
// AM5  the confirm of a re-picked PR does not carry --repick-since
// m1   a marker delete that throws after a good apply reports "not recorded" and skips the queue add
// m2   a marker write that throws skips the grant delete, the queue drop and the tap drop
// m4   the typed paid word drops the extra lines of the answer without a note
describe('pr-checkpoint PR 1 taps: the drop of the taps of a PR returned to draft', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const LEDGER = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', budget: [0, 0], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const BACK = 'Return to draft and pick again'
  const MARKER = 'checkpoint:repick:7'
  const SINCE = new Date(NOW).toISOString()
  const ready = viewJson({ isDraft: false })
  const ledgerReply = (ledger: Rec, over: Rec = {}) => ({ stdout: JSON.stringify({ ...engineJson(over), ledger }) })
  const ASK = ledgerReply({ state: 'ask', ask: { header: 'PR #7', question: 'q', options: [{ label: 'Keep as draft ($0)', description: 'a' }, { label: 'No review, land on CI ($0)', description: 'b' }] }, reasked: 0, text: 'ask' })
  const RECORDED = (over: Rec = {}) => ledgerReply({ state: 'record', ask: null, pathway: 'coderabbit', reasked: 0, text: 'Dave picked coderabbit. Record it.' }, over)
  const STOP = (reason: string) => `The taps of PR #7 could not be cleared (${reason}). Nothing was recorded. The PR stays a draft. Tell Dave.`
  const autoConfirms = (seen: { run: Run[] }) => confirms(seen).filter(r => r.argv.includes('auto'))
  const drops = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.includes('--drop-taps'))
  const at = (seen: { run: Run[] }, pred: (r: Run) => boolean) => seen.run.findIndex(pred)
  const isUndo = (r: Run) => r.argv[0] === 'gh' && r.argv.includes('--undo')
  const isLedgerCall = (r: Run) => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json') && !r.argv.includes('--no-ledger')
  const isSlotDrop = (r: Run) => r.argv.some(a => a.includes('slot-queue.mjs')) && r.argv.includes('drop')
  const ledgerCalls = (seen: { run: Run[] }) => seen.run.filter(isLedgerCall).map(r => r.argv.slice(2).join(' '))
  const returned = (over: Parameters<typeof world>[1] = {}) => ({ files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD }, viewSeq: [ready], answer: BACK, ledgerSeq: [ASK, ASK], ...over })

  test('AM1 a return to draft in the mod: undo, then ONE --drop-taps --pr 7, then the question is built', async ($, on) => {
    const w = world(on, returned())
    await start($)
    const told = await call($)
    expect(drops(w.seen).map(r => r.argv.slice(2).join(' '))).toEqual(['--drop-taps --pr 7'])
    const [undo, drop, ask] = [at(w.seen, isUndo), at(w.seen, r => r.argv.includes('--drop-taps')), at(w.seen, isLedgerCall)]
    expect(undo).toBeGreaterThanOrEqual(0)
    expect(drop).toBeGreaterThan(undo)
    expect(ask).toBeGreaterThan(drop)
    expect(told.text).toContain('Keep as draft ($0)')
    expect(w.store.get(MARKER)).toEqual({ at: NOW, dropped: true }) // only a good drop sets the flag
    await call($)
    expect(drops(w.seen).length).toBe(1) // the second call does not drop again
  })

  test('AM1b a failed undo drops nothing: the PR is still ready and no tap is cleared', async ($, on) => {
    const w = world(on, returned({ undo: { exitCode: 1, stderr: 'gh: no\n' } }))
    await start($)
    await call($)
    expect(drops(w.seen)).toEqual([])
    expect(w.store.get(MARKER)).toBeUndefined()
  })

  test('AM2 a PR returned to draft by hand (an applied record of this head, a draft now): one drop when the marker is first set, never again', async ($, on) => {
    const w = world(on, returned({ viewSeq: [], answer: 'dismiss' }))
    await start($)
    await call($)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    expect(drops(w.seen).map(r => r.argv.slice(2).join(' '))).toEqual(['--drop-taps --pr 7'])
    await call($)
    await call($)
    expect(drops(w.seen).length).toBe(1)
  })

  test('AM2b a fresh PR (no record, no marker) runs no drop', async ($, on) => {
    const w = world(on, { files: LEDGER, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(drops(w.seen)).toEqual([])
    expect(w.store.get(MARKER)).toBeUndefined()
  })

  test('AM3 the drop fails after the mod undo: the stop text, the marker stays, no question is built and Dave is asked nothing', async ($, on) => {
    const w = world(on, returned({ drop: { exitCode: 1, stderr: 'pr-checkpoint: refused: the taps of PR #7 could not be cleared (lock). Nothing was recorded.\n' } }))
    await start($)
    const told = await call($)
    expect(told.text).toContain(STOP('pr-checkpoint: refused: the taps of PR #7 could not be cleared (lock). Nothing was recorded.'))
    expect(w.store.get(MARKER)).toBeDefined()
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(autoConfirms(w.seen)).toEqual([])
    expect(w.seen.dialogs.length).toBe(1) // only the Change-the-pick question that Dave answered
    expect(w.store.get(MARKER)).not.toHaveProperty('dropped') // no good drop yet
    // The marker has no `dropped` flag, so the next call runs the drop AGAIN (a stale tap and a paid-round row must not outlive the return to draft).
    const next = await call($)
    expect(drops(w.seen).length).toBe(2)
    expect(next.text).toContain('could not be cleared')
    expect(ledgerCalls(w.seen)).toEqual([])
  })

  test('AM3d a failed drop is retried on the next call; after a good one the marker says dropped, the question is asked, and no third drop runs', async ($, on) => {
    const w = world(on, returned({ dropSeq: [{ exitCode: 1, stderr: 'boom\n' }] }))
    await start($)
    const first = await call($)
    expect(first.text).toContain(STOP('boom'))
    const second = await call($)
    expect(drops(w.seen).length).toBe(2)
    expect(w.store.get(MARKER)).toEqual({ at: NOW, dropped: true })
    expect(ledgerCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
    expect(second.text).toContain('Keep as draft ($0)')
    await call($)
    expect(drops(w.seen).length).toBe(2)
  })

  test('AM6 a marker with no dropped flag (the drop never succeeded) runs the drop once, then marks it', async ($, on) => {
    const w = world(on, { files: LEDGER, store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [ASK, ASK] })
    await start($)
    await call($)
    expect(drops(w.seen).length).toBe(1)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    await call($)
    expect(drops(w.seen).length).toBe(1)
  })

  test('AM7 a marker write that throws when a PR is found returned by hand: the drop still runs and the question is asked', async ($, on) => {
    const w = world(on, returned({ viewSeq: [], throwSetOnce: MARKER, answer: 'dismiss' }))
    await start($)
    const told = await call($)
    expect(drops(w.seen).length).toBe(1)
    expect(told.text).toContain('Keep as draft ($0)')
  })

  test('AM3b a drop that cannot run (a timeout) is a failure too: the stop text names the cause', async ($, on) => {
    const w = world(on, returned({ drop: 'throw' }))
    await start($)
    const told = await call($)
    // The kit skips a throwing process hook and reports "no implementation"; a real timeout reads "timed out". Either way the cause is named.
    expect(told.text).toMatch(/The taps of PR #7 could not be cleared \(.+\)\. Nothing was recorded\. The PR stays a draft\. Tell Dave\./)
    expect(ledgerCalls(w.seen)).toEqual([])
  })

  test('AM3c a PR returned to draft by hand and a failed drop: the stop text, the marker is set, no question', async ($, on) => {
    const w = world(on, returned({ viewSeq: [], drop: { exitCode: 1, stderr: 'boom\n' } }))
    await start($)
    const told = await call($)
    expect(told.text).toContain(STOP('boom'))
    expect(w.store.get(MARKER)).toBeDefined()
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(w.seen.dialogs.length).toBe(0)
  })

  test('AM4 the ledger call carries the marker time as an ISO value', async ($, on) => {
    const marked = world(on, { files: LEDGER, store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(ledgerCalls(marked.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
  })

  // F2 (fix round): a marker with no readable time is repaired before the offer (a fresh marker with a readable time, a drop, the flag).
  // The old rule sent an unparseable value, so the engine read even a tap on the new offer as stale and Dave could never get through.
  for (const bad of [{ head: HEAD }, { head: HEAD, at: 'soon' }, { head: HEAD, at: 1e18 }, { head: HEAD, at: null }]) {
    test(`AM4b a marker with no readable time is repaired, so the ledger call carries a value that parses: ${JSON.stringify(bad)}`, async ($, on) => {
      const w = world(on, { files: LEDGER, store: { [MARKER]: bad }, ledgerSeq: [ASK] })
      await start($)
      await call($)
      expect(ledgerCalls(w.seen).at(-1)).toBe(`--json --pr 7 --ask-anyway --repick-since ${SINCE}`)
      expect(w.store.get(MARKER)).toMatchObject({ at: NOW, dropped: true })
    })
  }

  test('AM4c a fresh PR with no marker passes no --repick-since', async ($, on) => {
    const w = world(on, { files: LEDGER, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(ledgerCalls(w.seen).at(-1)).toBe('--json --pr 7')
  })

  test('AM5 the confirm of a re-picked PR carries --repick-since; the confirm of a fresh PR does not', async ($, on) => {
    const marked = world(on, { files: LEDGER, store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [RECORDED()] })
    await start($)
    await call($)
    expect(engineCalls(marked.seen).find(c => c.startsWith('--confirm'))).toMatch(new RegExp(`^--confirm coderabbit --by dave --body .* --pr 7 --repick-since ${SINCE}$`))
  })

  test('AM5b a fresh PR confirm has no --repick-since', async ($, on) => {
    const w = world(on, { files: LEDGER, ledgerSeq: [RECORDED()] })
    await start($)
    await call($)
    const confirm = engineCalls(w.seen).find(c => c.startsWith('--confirm'))
    expect(confirm).toMatch(/--pr 7$/)
  })

  test('m1 a marker delete that throws after a good apply still reports the record and queues the PR', async ($, on) => {
    const high = { auto: { eligible: false, band: 'HIGH', reason: 'x' } }
    // The band the record carries comes from the prepare call (the facts call), not from the ledger block.
    const w = world(on, { files: LEDGER, json: { stdout: JSON.stringify(engineJson(high)) }, store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [RECORDED(high)], throwDelete: 'checkpoint:repick:' })
    await start($)
    const told = await call($)
    expect(told.text).toContain('Dave chose coderabbit')
    expect(told.text).not.toContain('was not recorded')
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
    expect(w.seen.run.some(r => r.argv.some(a => a.includes('slot-queue.mjs')) && r.argv.includes('add'))).toBe(true)
  })

  test('m2 a marker write that throws still deletes the grant, drops the queue item and clears the taps', async ($, on) => {
    const w = world(on, returned({ store: { 'checkpoint:pr:7': RECORD, 'checkpoint:grant:7': { round: 1, head: HEAD, at: NOW } }, throwSetOnce: MARKER }))
    await start($)
    await call($)
    expect(w.store.get('checkpoint:grant:7')).toBeUndefined()
    expect(w.seen.run.some(isSlotDrop)).toBe(true)
    expect(drops(w.seen).length).toBeGreaterThanOrEqual(1)
    // The drop of releaseReturned runs before the ledger call of the same pass, as in AM1.
    const [undo, drop, ask] = [at(w.seen, isUndo), at(w.seen, r => r.argv.includes('--drop-taps')), at(w.seen, isLedgerCall)]
    expect(drop).toBeGreaterThan(undo)
    expect(ask).toBeGreaterThan(drop)
  })

  test('m4 a typed paid word with more lines asks the one question and says what it ignored', async ($, on) => {
    const pending = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    world(on, { store: { [PENDING]: pending }, answer: /^Keep as draft/ })
    await start($)
    const ran = await slash($, '7 coderabbit\nplease go ahead')
    expect(ran.text ?? '').toContain('Ignored: "please go ahead".')
  })
})

// ---- fix round of PR 1 taps: the CodeRabbit CLI findings F1 to F5 on the re-pick marker ------------------------------------------------------
// One shared cleanup (cleanupReturn) runs after a mod undo and after a return to draft by hand. The marker is a small state machine.
// How it can fail, and the test that catches it (C = control: it passes before the fix and pins what must stay):
// FR1  (C) a fresh PR (no marker, no applied record) gets a cleanup
// FR2  F1  a return by hand clears only the taps: the round grant and the free-slot queue entry of the old record stay
// FR3  (C) a marker that says dropped, with proof as new as the return, drops again (twice), or one with no applied record does
// FR4  F3  a marker with dropped:true from an EARLIER return is trusted when the applied record is newer: the taps of the ready period stay
// FR5  (C) a marker without dropped does not drop again, or drops and never flags it
// FR6  F2  a marker with an unreadable time keeps the engine rejecting every new tap; a failed repair write still offers
// FR8  F5  a good drop whose flag write fails still offers a choice, so the tap on it is dropped by the next call
// FR9  a grant delete that throws skips the queue drop
// FR10 to FR13  F4  a stored pending checkpoint or a typed pick reaches the question or a record while the cleanup is outstanding
describe('pr-checkpoint PR 1 taps fix round: the re-pick marker state machine', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const LEDGER = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', budget: [0, 0], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const BACK = 'Return to draft and pick again'
  const MARKER = 'checkpoint:repick:7'
  const GRANT = 'checkpoint:grant:7'
  const GRANT_ROW = { round: 1, head: HEAD, at: NOW }
  const SINCE = new Date(NOW).toISOString()
  const ASK = { stdout: JSON.stringify({ ...engineJson(), ledger: { state: 'ask', ask: { header: 'PR #7', question: 'q', options: [{ label: 'Keep as draft ($0)', description: 'a' }, { label: 'No review, land on CI ($0)', description: 'b' }] }, reasked: 0, text: 'ask' } }) }
  const drops = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.includes('--drop-taps'))
  const at = (seen: { run: Run[] }, pred: (r: Run) => boolean) => seen.run.findIndex(pred)
  const isSlotDrop = (r: Run) => r.argv.some(a => a.includes('slot-queue.mjs')) && r.argv.includes('drop')
  const isLedgerCall = (r: Run) => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json') && !r.argv.includes('--no-ledger')
  const ledgerCalls = (seen: { run: Run[] }) => seen.run.filter(isLedgerCall).map(r => r.argv.slice(2).join(' '))
  const SECOND = `--json --pr 7 --ask-anyway --repick-since ${SINCE}`
  const STOP = (reason: string) => `The taps of PR #7 could not be cleared (${reason}). Nothing was recorded. The PR stays a draft. Tell Dave.`
  const MARKER_STOP = /re-pick marker of PR #7 could not be saved.*Nothing was asked/
  const FLAG_STOP = /taps of PR #7 were cleared, but the proof of it could not be saved.*Nothing was asked/
  /** A PR returned by hand: a draft now (the default view), with an applied record of this head. */
  const byHand = (over: Parameters<typeof world>[1] = {}) => ({ files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW }, ledgerSeq: [ASK, ASK, ASK], answer: 'dismiss' as const, ...over })
  const withStore = (extra: Rec, over: Parameters<typeof world>[1] = {}) => byHand({ ...over, store: { ...(over.store ?? { 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW }), ...extra } })

  test('FR1 (control) a fresh PR gets no cleanup: no drop, no marker, the grant stays, a plain ledger call', async ($, on) => {
    const w = world(on, { files: LEDGER, store: { [GRANT]: GRANT_ROW }, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(drops(w.seen)).toEqual([])
    expect(w.seen.run.some(isSlotDrop)).toBe(false)
    expect(w.store.get(MARKER)).toBeUndefined()
    expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    expect(ledgerCalls(w.seen)).toEqual(['--json --pr 7'])
  })

  test('FR2 F1: a return to draft by hand deletes the round grant and drops the queue entry too, before the tap drop', async ($, on) => {
    const w = world(on, byHand())
    await start($)
    await call($)
    expect(w.store.get(GRANT)).toBeUndefined()
    const [slot, tap] = [at(w.seen, isSlotDrop), at(w.seen, r => r.argv.includes('--drop-taps'))]
    expect(slot).toBeGreaterThanOrEqual(0)
    expect(tap).toBeGreaterThan(slot)
    expect(drops(w.seen).length).toBe(1)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
  })

  test('FR3 (control) a dropped marker with no applied record is trusted: no cleanup, no drop, the ask carries the marker time', async ($, on) => {
    const w = world(on, { files: LEDGER, store: { [MARKER]: { at: NOW, dropped: true }, [GRANT]: GRANT_ROW }, ledgerSeq: [ASK] })
    await start($)
    await call($)
    expect(drops(w.seen)).toEqual([])
    expect(w.seen.run.some(isSlotDrop)).toBe(false)
    expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    expect(ledgerCalls(w.seen)).toEqual([SECOND])
  })

  test('FR3b (control) a dropped marker that is as new as the applied record (appliedAt before the marker) is trusted: no drop', async ($, on) => {
    const w = world(on, withStore({ 'checkpoint:pr:7': { ...RECORD, appliedAt: NOW - 1000 }, [MARKER]: { at: NOW, dropped: true } }))
    await start($)
    await call($)
    expect(drops(w.seen)).toEqual([])
    expect(w.seen.run.some(isSlotDrop)).toBe(false)
    expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    expect(ledgerCalls(w.seen)).toEqual([SECOND])
  })

  test('FR4 F3: a dropped marker older than the applied record is stale proof: the full cleanup runs again and the marker is new', async ($, on) => {
    const w = world(on, withStore({ 'checkpoint:pr:7': { ...RECORD, appliedAt: NOW - 1000 }, [MARKER]: { at: NOW - 5000, dropped: true } }))
    await start($)
    await call($)
    expect(drops(w.seen).length).toBe(1)
    expect(w.seen.run.some(isSlotDrop)).toBe(true)
    expect(w.store.get(GRANT)).toBeUndefined()
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    expect(ledgerCalls(w.seen)).toEqual([SECOND])
  })

  test('FR5 (control) a marker without dropped runs the drop once and flags it; the next call drops nothing', async ($, on) => {
    const w = world(on, { files: LEDGER, store: { [MARKER]: { head: HEAD, at: NOW } }, ledgerSeq: [ASK, ASK] })
    await start($)
    await call($)
    expect(drops(w.seen).length).toBe(1)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    await call($)
    expect(drops(w.seen).length).toBe(1)
  })

  for (const bad of [{ head: HEAD }, { head: HEAD, at: 'soon' }, { head: HEAD, at: 1e18 }, { head: HEAD, at: null }]) {
    for (const flagged of [false, true]) {
      test(`FR6 F2: a marker with no readable time is repaired first (fresh time, drop, flag), flagged=${flagged}: ${JSON.stringify(bad)}`, async ($, on) => {
        const w = world(on, { files: LEDGER, store: { [MARKER]: { ...bad, ...(flagged ? { dropped: true } : {}) } }, ledgerSeq: [ASK] })
        await start($)
        await call($)
        expect(w.store.get(MARKER)).toMatchObject({ at: NOW, dropped: true })
        expect(drops(w.seen).length).toBe(1)
        expect(ledgerCalls(w.seen)).toEqual([SECOND])
      })
    }
  }

  test('FR6b F2: the repair write fails: a stop text, no offer, no ledger call, no dialog; the marker stays unreadable (old taps stay rejected)', async ($, on) => {
    const w = world(on, { files: LEDGER, store: { [MARKER]: { head: HEAD, dropped: true } }, ledgerSeq: [ASK], throwSetWhen: key => key === MARKER })
    await start($)
    const told = await call($)
    expect(told.text).toMatch(MARKER_STOP)
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(w.seen.dialogs.length).toBe(0)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, dropped: true })
  })

  test('FR7 (control) a failed drop after the cleanup is the stop text, with no offer, in the manual-return path too', async ($, on) => {
    const w = world(on, byHand({ drop: { exitCode: 1, stderr: 'boom\n' } }))
    await start($)
    const told = await call($)
    expect(told.text).toContain(STOP('boom'))
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
  })

  test('FR8 F5: a good drop whose flag write fails is a retryable stop (no offer); the next call drops again, flags, and then asks', async ($, on) => {
    let failed = false
    const failOnce = (key: string, value: unknown) => {
      if (key !== MARKER || (value as Rec).dropped !== true || failed) return false
      failed = true
      return true
    }
    const w = world(on, byHand({ viewSeq: [viewJson({ isDraft: false })], store: { 'checkpoint:pr:7': RECORD }, answer: BACK, throwSetWhen: failOnce }))
    await start($)
    const first = await call($)
    expect(first.text).toMatch(FLAG_STOP)
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(w.seen.dialogs.length).toBe(1) // only the change-the-pick question Dave answered
    expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
    const second = await call($)
    expect(drops(w.seen).length).toBe(2)
    expect(w.store.get(MARKER)).toMatchObject({ dropped: true })
    expect(second.text).toContain('Keep as draft ($0)')
  })

  test('FR9 (PR 2 item 6): a grant delete that throws still drops the queue entry and the taps, but keeps the cleanup open: no dropped flag', async ($, on) => {
    const w = world(on, byHand({ throwDelete: 'checkpoint:grant:' }))
    await start($)
    await call($)
    expect(w.seen.run.some(isSlotDrop)).toBe(true)
    expect(drops(w.seen).length).toBe(1)
    expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
  })

  // ---- F4: the same guard on the paths that open the question or record a typed pick ----------------------------------------------------
  const PENDING_FIX = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }

  test('FR10 F4: ledger off, a saved pending checkpoint, a marker not dropped and the drop fails: a bare /pathway opens no question', async ($, on) => {
    const w = world(on, { store: { [PENDING]: PENDING_FIX, [MARKER]: { head: HEAD, at: NOW } }, drop: { exitCode: 1, stderr: 'boom\n' }, answer: /^Keep as draft/ })
    await start($)
    const ran = await slash($, '')
    expect(ran.text ?? '').toContain(STOP('boom'))
    expect(w.seen.dialogs.length).toBe(0)
    expect(w.seen.opens).toEqual([])
  })

  test('FR11 F4: the same bare /pathway after a good drop: the saved question opens and the marker is flagged', async ($, on) => {
    const w = world(on, { store: { [PENDING]: PENDING_FIX, [MARKER]: { head: HEAD, at: NOW } }, answer: /^Keep as draft/ })
    await start($)
    await slash($, '')
    expect(drops(w.seen).length).toBe(1)
    expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    expect(w.seen.dialogs.length).toBeGreaterThanOrEqual(1)
  })

  test('FR12 F4: a typed pick records nothing while the cleanup is outstanding (the drop fails): no --confirm, no record', async ($, on) => {
    const w = world(on, { store: { [MARKER]: { head: HEAD, at: NOW } }, drop: { exitCode: 1, stderr: 'boom\n' } })
    await start($)
    const ran = await slash($, '7 none --body pr-body.md')
    expect(ran.text ?? '').toContain(STOP('boom'))
    expect(w.seen.run.filter(r => r.argv.includes('--confirm'))).toEqual([])
    expect(w.store.get('checkpoint:pr:7')).toBeUndefined()
    expect(w.seen.dialogs.length).toBe(0)
  })

  test('FR12b F4: the same typed pick runs the drop first and then records, once the drop works', async ($, on) => {
    const w = world(on, { store: { [MARKER]: { head: HEAD, at: NOW } } })
    await start($)
    await slash($, '7 none --body pr-body.md')
    expect(drops(w.seen).length).toBe(1)
    expect((w.store.get('checkpoint:pr:7') as Rec).state).toBe('applied')
  })

  test('FR13 (control) a saved pending checkpoint of a PR that is READY with an applied record: a bare /pathway cleans nothing (no draft proof)', async ($, on) => {
    const w = world(on, { store: { [PENDING]: PENDING_FIX, 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW }, isDraft: false, answer: /^Keep as draft/ })
    await start($)
    await slash($, '')
    expect(drops(w.seen)).toEqual([])
    expect(w.seen.run.some(isSlotDrop)).toBe(false)
    expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    expect(w.store.get(MARKER)).toBeUndefined()
  })
})

// ---- PR 2 group A of card prflow-paid-run-guard: the ten items that PR 1 left (CLI run 2, CodeRabbit review, coordinator list) -----------------
// How it can fail, and the test that catches it (C = control: it passes before the change and pins what must stay):
// AD1-AD7  item 1c: a Yes on a queued ask grants, queues or posts for a PR that is a draft, is at another head, or whose state cannot be read (a round Yes read no PR)
// AD5a-c   (C) a Yes on an open, same-head, not-draft PR still grants (and queues) or posts once
// BQ1-BQ3  item 1a: a bare /pathway raises a queued ask of a PR that was returned to draft by hand (BQ2 C: a ready PR still gets it)
// AC1-AC3  item 1b: the shared cleanup leaves the queued asks (and the lease) of the PR that went back to draft (AC3 C: a fresh PR keeps them)
// RH2-RH4  item 2: a return to draft by a model shell, Dave's land tap or the GitHub page (no mod code ran), followed by a push of a new head, reads as a fresh PR
// FD1-FD3  item 5: the cleanup runs on a PR that is no longer a draft, moved to another head, or cannot be read (FD0 C: a draft at the head is cleaned)
// GF1      item 6: a failed grant delete still sets dropped:true, so the next call skips the grant delete
// QF1-QF2  item 7: a failed or timed-out queue drop is ignored (QF2 C: an entry that is already absent is complete)
// PS1-PS2  item 8: a saved pending checkpoint with no marker trusts "no return" without the live draft state (PS3 C: no applied record, no gh call)
describe('pr-checkpoint PR 2 group A: the ten items', () => {
  const call = ($: Engine) => callTool($, { pr: 7, body: 'pr-body.md' })
  const LEDGER = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false, ledger: true } }) }
  const RECORD = { pr: 7, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', budget: [0, 0], decided_by: 'dave', via: 'dialog', session: SESSION, at: '2026-11-06T20:55:00.000Z' }
  const MARKER = 'checkpoint:repick:7'
  const GRANT = 'checkpoint:grant:7'
  const GRANT_ROW = { round: 1, head: HEAD, at: NOW }
  const LEASE = 'checkpoint:asking:7'
  const BACK = 'Return to draft and pick again'
  const ASK = { stdout: JSON.stringify({ ...engineJson(), ledger: { state: 'ask', ask: { header: 'PR #7', question: 'q', options: [{ label: 'Keep as draft ($0)', description: 'a' }, { label: 'No review, land on CI ($0)', description: 'b' }] }, reasked: 0, text: 'ask' } }) }
  const drops = (seen: { run: Run[] }) => seen.run.filter(r => r.argv.includes('--drop-taps'))
  const isSlot = (verb: string) => (r: Run) => r.argv.some(a => a.includes('slot-queue.mjs')) && r.argv.includes(verb)
  const slotDrops = (seen: { run: Run[] }) => seen.run.filter(isSlot('drop'))
  const slotAdds = (seen: { run: Run[] }) => seen.run.filter(isSlot('add'))
  const isLedgerCall = (r: Run) => r.argv.some(a => a.includes('pr-checkpoint.mjs')) && r.argv.includes('--json') && !r.argv.includes('--no-ledger')
  const ledgerCalls = (seen: { run: Run[] }) => seen.run.filter(isLedgerCall).map(r => r.argv.slice(2).join(' '))
  const autoConfirms = (seen: { run: Run[] }) => confirms(seen).filter(r => r.argv.includes('auto'))
  const STOP = (reason: string) => `The taps of PR #7 could not be cleared (${reason}). Nothing was recorded. The PR stays a draft. Tell Dave.`
  const stateView = (over: Rec = {}) => ({ stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD, isDraft: false, ...over }) })
  const asksOf = (store: Map<string, unknown>) => (store.get(ASKS) ?? []) as Rec[]
  /** A PR returned by hand: a draft now (the default view), with an applied record of the head A. */
  const byHand = (over: Opts = {}): Opts => ({ files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW }, ledgerSeq: [ASK, ASK, ASK], answer: 'dismiss', ...over })
  const nothingCleaned = (w: ReturnType<typeof world>) => {
    expect(drops(w.seen)).toEqual([])
    expect(slotDrops(w.seen)).toEqual([])
    expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    expect(w.store.get(MARKER)).toBeUndefined()
    expect(ledgerCalls(w.seen)).toEqual([])
    expect(autoConfirms(w.seen)).toEqual([])
    expect(w.seen.dialogs.length).toBe(0)
  }

  // ---- item 1c: the Yes on a queued ask reads the PR (open, same head, not a draft) --------------------------------------------------------
  describe('item 1c: the Yes on a queued ask', () => {
    const watchDoc = { [WATCH]: { prs: [{ pr: 7, state: null, whenReady: false }], backoffUntil: 0, touched: NOW } }
    const record = (over: Rec = {}) => ({
      pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default', band: 'HIGH',
      capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 26 * MIN, ...over,
    })
    const REVIEWED = status(7, { reasons: ['1 review thread(s) unresolved'], unresolved: 1, coderabbitReviewedHead: true, routedReviewed: true, coderabbitRounds: 3, coderabbitRequests: 2 })
    const QUIET = status(7, { reasons: ['no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count).'] })
    const GREP_CLEAN = status(7, { routing: { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }, coderabbitReviewedHead: true, routedReviewed: false, reviewedHead: false, coderabbitRounds: 1, reasons: ['no Greptile check on the head commit yet (review pending)'] })
    const round = (view: Reply, over: Opts = {}) => ({ statuses: { 7: REVIEWED }, store: { ...watchDoc, 'checkpoint:pr:7': record() }, view, answer: /^Yes/, ...over })
    const opening = (view: Reply, over: Opts = {}) => ({ statuses: { 7: QUIET }, store: { ...watchDoc, 'checkpoint:pr:7': record() }, view, answer: /^Yes/, ...over })
    const greptile = (view: Reply, over: Opts = {}) => ({ statuses: { 7: GREP_CLEAN }, store: { ...watchDoc, 'checkpoint:pr:7': record({ pathway: 'both', label: 'review:deep' }) }, view, answer: /^Yes/, ...over })
    const dropped = (w: ReturnType<typeof world>) => {
      expect(asksOf(w.store)).toEqual([])
      expect(w.seen.toasts.some(text => /#7/.test(text) && /draft|moved|no longer/i.test(text))).toBe(true)
    }

    test('AD1 a round Yes on a PR that is a draft writes no grant, queues nothing and drops the ask', async ($, on) => {
      const w = world(on, round(stateView({ isDraft: true })))
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(slotAdds(w.seen)).toEqual([])
      expect((w.store.get('checkpoint:pr:7') as Rec).declined).toBeUndefined()
      dropped(w)
    })

    test('AD2 a round Yes after the head moved writes no grant, queues nothing and drops the ask', async ($, on) => {
      const w = world(on, round(stateView({ headRefOid: OTHER_HEAD })))
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(slotAdds(w.seen)).toEqual([])
      dropped(w)
    })

    test('AD3 an opening Yes on a PR that is a draft posts nothing and drops the ask', async ($, on) => {
      const w = world(on, opening(stateView({ isDraft: true })))
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(counts(w.seen).comments).toEqual([])
      dropped(w)
    })

    test('AD4 a Greptile Yes on a PR that is a draft posts nothing and drops the ask', async ($, on) => {
      const w = world(on, greptile(stateView({ isDraft: true })))
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(counts(w.seen).comments).toEqual([])
      dropped(w)
    })

    test('AD5a (control) a round Yes on an open, same-head PR that is not a draft stores the grant and queues the round', async ($, on) => {
      const w = world(on, round(stateView()))
      await start($)
      await w.clock.advance(TICK)
      expect((w.store.get(GRANT) as Rec).round).toBe(4)
      expect(slotAdds(w.seen).length).toBe(1)
      expect(asksOf(w.store)).toEqual([])
    })

    test('AD5b (control) an opening Yes on an open, same-head PR that is not a draft posts one review request', async ($, on) => {
      const w = world(on, opening(stateView()))
      await start($)
      await w.clock.advance(TICK)
      expect(counts(w.seen).comments).toEqual([['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@coderabbitai review']])
      expect(asksOf(w.store)).toEqual([])
    })

    test('AD5c (control) a Greptile Yes on an open, same-head PR that is not a draft posts one @greptileai', async ($, on) => {
      const w = world(on, greptile(stateView()))
      await start($)
      await w.clock.advance(TICK)
      expect(counts(w.seen).comments).toEqual([['gh', 'pr', 'comment', '7', '-R', REPO, '--body', '@greptileai']])
      expect(asksOf(w.store)).toEqual([])
    })

    for (const [name, view] of [['gh exits 1', { exitCode: 1, stderr: 'HTTP 502' }], ['gh prints a state with no draft field', { stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD }) }]] as [string, Reply][]) {
      test(`AD6 a round Yes writes no grant when the PR state cannot be read (${name}): the ask stays queued and Dave gets a toast`, async ($, on) => {
        const w = world(on, round(view))
        await start($)
        await w.clock.advance(TICK)
        expect(w.store.get(GRANT)).toBeUndefined()
        expect(slotAdds(w.seen)).toEqual([])
        expect(asksOf(w.store).length).toBe(1)
        expect(w.seen.toasts.some(text => /#7/.test(text) && /could not read/i.test(text))).toBe(true)
      })
    }

    test('AD7 a round Yes with no checkout to read the PR in writes no grant and keeps the ask queued', async ($, on) => {
      const w = world(on, round(stateView(), { missing: ['scripts/github/pr-checkpoint.mjs'] }))
      await start($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs.length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(asksOf(w.store).length).toBe(1)
    })
  })

  // ---- item 1a: a bare /pathway raises no queued ask of a PR that was returned to draft ------------------------------------------------------
  describe('item 1a: a bare /pathway with a queued ask', () => {
    const QUEUED = { kind: 'round', pr: 7, head: HEAD, round: 4, text: 'Round 4 of 1+2 for #7' }
    const queued = (over: Opts = {}): Opts => ({ store: { 'checkpoint:pr:7': { ...RECORD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2] }, [GRANT]: GRANT_ROW, [ASKS]: [QUEUED] }, answer: 'dismiss', ...over })

    test('BQ1 a PR returned to draft by hand: the bare /pathway opens no question, runs the cleanup and the queue is empty', async ($, on) => {
      const w = world(on, queued())
      await start($)
      await slash($, '')
      expect(w.seen.dialogs.length).toBe(0)
      expect(asksOf(w.store)).toEqual([])
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    })

    test('BQ2 (control) the same queued ask of a PR that is ready: the bare /pathway raises the question and keeps the queue', async ($, on) => {
      const w = world(on, queued({ isDraft: false }))
      await start($)
      await slash($, '')
      expect(w.seen.dialogs.length).toBe(1)
      expect(drops(w.seen)).toEqual([])
      expect(w.store.get(GRANT)).toEqual(GRANT_ROW)
    })

    test('BQ4 a PR returned to draft by hand and pushed again (a draft at ANOTHER head): the bare /pathway runs the cleanup on the fresh head, the grant, the queue entry and the asks are gone', async ($, on) => {
      const w = world(on, queued({ viewHead: OTHER_HEAD }))
      await start($)
      await slash($, '')
      expect(w.seen.dialogs.length).toBe(0)
      expect(asksOf(w.store)).toEqual([])
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(slotDrops(w.seen).length).toBe(1)
      expect(drops(w.seen).length).toBe(1)
      expect(w.store.get(MARKER)).toEqual({ head: OTHER_HEAD, at: NOW, dropped: true })
    })

    test('BQ3 a failed cleanup of the returned PR: the bare /pathway says so and opens no question', async ($, on) => {
      const w = world(on, queued({ drop: { exitCode: 1, stderr: 'boom\n' } }))
      await start($)
      const ran = await slash($, '')
      expect(ran.text ?? '').toContain(STOP('boom'))
      expect(w.seen.dialogs.length).toBe(0)
    })
  })

  // ---- item 1b: the shared cleanup clears the queued asks of the PR ------------------------------------------------------------------------
  describe('item 1b: the cleanup of a PR that went back to draft clears its queued asks', () => {
    const ONE = { kind: 'round', pr: 7, head: HEAD, round: 4, text: 'Round 4 of 1+2 for #7' }
    const TWO = { kind: 'opening', pr: 8, head: OTHER_HEAD, text: 'CodeRabbit has not started on #8' }
    const LEASED = { [ASKS]: [ONE, TWO], [LEASE]: { session: SESSION, until: NOW + 10 * MIN } }

    test('AC1 a return by hand drops the asks and the lease of that PR and keeps the ask of another PR', async ($, on) => {
      const w = world(on, byHand({ store: { 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW, ...LEASED } }))
      await start($)
      await call($)
      expect(asksOf(w.store)).toEqual([TWO])
      expect(w.store.get(LEASE)).toBeUndefined()
    })

    test('AC2 the mod own undo (Return to draft) drops them the same way', async ($, on) => {
      const w = world(on, { files: LEDGER, json: autoJson(), store: { 'checkpoint:pr:7': RECORD, ...LEASED }, viewSeq: [viewJson({ isDraft: false })], answer: BACK, ledgerSeq: [ASK, ASK] })
      await start($)
      await call($)
      expect(asksOf(w.store)).toEqual([TWO])
      expect(w.store.get(LEASE)).toBeUndefined()
    })

    test('AC3 (control) a fresh PR gets no cleanup and keeps its queued asks and its lease', async ($, on) => {
      const w = world(on, { files: LEDGER, store: LEASED, ledgerSeq: [ASK] })
      await start($)
      await call($)
      expect(asksOf(w.store)).toEqual([ONE, TWO])
      expect(w.store.get(LEASE)).toBeDefined()
    })
  })

  // ---- item 2: a return that no mod code saw, then a push of a new head ----------------------------------------------------------------------
  describe('item 2: applied at head A, returned to draft by hand, then a push of head B', () => {
    const atB = (over: Opts = {}): Opts => byHand({ json: autoJson({ head: OTHER_HEAD }), viewHead: OTHER_HEAD, ...over })
    const cleanedAtB = (w: ReturnType<typeof world>) => {
      expect(drops(w.seen).map(r => r.argv.slice(2).join(' '))).toEqual(['--drop-taps --pr 7'])
      expect(slotDrops(w.seen).length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(w.store.get(MARKER)).toEqual({ head: OTHER_HEAD, at: NOW, dropped: true })
      expect(autoConfirms(w.seen)).toEqual([])
      expect(ledgerCalls(w.seen)).toEqual([`--json --pr 7 --ask-anyway --repick-since ${new Date(NOW).toISOString()}`])
    }

    test('RH2 (source: a model shell gh pr ready --undo) the next mod call sees the return at the new head and cleans', async ($, on) => {
      const w = world(on, atB())
      await start($)
      const shell = (await $.tool.call({ tool: 'Bash', command: 'gh pr ready 7 --undo' } as never)) as unknown as { deny?: string }
      expect(shell.deny).toBeUndefined()
      expect(w.seen.ran.map(r => r.text)).toEqual(['gh pr ready 7 --undo'])
      await call($)
      cleanedAtB(w)
    })

    test('RH3 (source: Dave land tap "Return to draft", run by the model as gh pr ready --undo) the next mod call sees the return at the new head and cleans', async ($, on) => {
      const w = world(on, atB())
      await start($)
      const shell = (await $.tool.call({ tool: 'Bash', command: 'gh pr ready 7 -R Rev4nchist/Continuous-Claude-v3 --undo' } as never)) as unknown as { deny?: string }
      expect(shell.deny).toBeUndefined()
      await call($)
      cleanedAtB(w)
    })

    test('RH4 (source: the GitHub page, no command at all) the next mod call sees the return at the new head: an auto-eligible PR is not auto-confirmed, the cleanup runs and Dave is asked', async ($, on) => {
      const w = world(on, atB())
      await start($)
      await call($)
      cleanedAtB(w)
    })
  })

  // ---- item 5: no cleanup without a fresh read that shows a draft at the head ---------------------------------------------------------------
  describe('item 5: the draft state is read after the applied record, before any cleanup', () => {
    test('FD0 (control) a fresh read that shows a draft at the head: the cleanup runs once', async ($, on) => {
      const w = world(on, byHand({ viewSeq: [viewJson(), viewJson()] }))
      await start($)
      await call($)
      expect(drops(w.seen).length).toBe(1)
      expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
    })

    for (const [name, second, text] of [
      ['the PR is ready again (another session applied the same head while the engine ran)', viewJson({ isDraft: false }), /could not be checked before the cleanup \(the PR is no longer a draft\)/i],
      ['the head moved', viewJson({ headRefOid: OTHER_HEAD }), /could not be checked before the cleanup \(the head moved to bbbbbbb\)/i],
      ['gh cannot read the PR', { exitCode: 1, stderr: 'HTTP 502' } as Reply, /could not be checked before the cleanup \(HTTP 502\)/i],
    ] as [string, Reply, RegExp][]) {
      test(`FD1-3 ${name}: no cleanup, no question, no auto-confirm, the queue entry of the ready PR stays`, async ($, on) => {
        const w = world(on, byHand({ viewSeq: [viewJson(), second] }))
        await start($)
        const told = await call($)
        expect(told.text).toMatch(text)
        nothingCleaned(w)
      })
    }
  })

  // ---- item 6 and 7: a failed grant delete or queue drop keeps the cleanup open and the next call retries it ----------------------------------
  describe('item 6 and 7: a cleanup step that fails keeps the cleanup open', () => {
    const OPEN = (what: RegExp) => new RegExp(`cleanup of PR #7 is not finished.*${what.source}.*Nothing was asked`)

    test('GF1 a grant delete that fails: the stop text names the grant, no flag, no question; the next call deletes it, flags and asks', async ($, on) => {
      const opts = byHand({ throwDelete: 'checkpoint:grant:' })
      const w = world(on, opts)
      await start($)
      const first = await call($)
      expect(first.text).toMatch(OPEN(/round grant/))
      expect(slotDrops(w.seen).length).toBe(1) // the other steps still ran
      expect(drops(w.seen).length).toBe(1)
      expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
      expect(ledgerCalls(w.seen)).toEqual([])
      opts.throwDelete = undefined
      const second = await call($)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(w.store.get(MARKER)).toMatchObject({ head: HEAD, at: NOW, dropped: true })
      expect(second.text).toContain('Keep as draft ($0)')
    })

    for (const [name, slot] of [['exits 2', { exitCode: 2, stderr: 'slot-queue: lock busy' }], ['times out', 'throw']] as [string, Reply][]) {
      test(`QF1 a queue drop that ${name}: the stop text names the queue entry, no flag, no question; the next call drops it again, flags and asks`, async ($, on) => {
        const opts = byHand({ slot })
        const w = world(on, opts)
        await start($)
        const first = await call($)
        expect(first.text).toMatch(OPEN(/queue entry/))
        expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
        expect(ledgerCalls(w.seen)).toEqual([])
        opts.slot = undefined
        const second = await call($)
        expect(slotDrops(w.seen).length).toBe(2) // the no-flag path retries the queue drop, not only the taps
        expect(w.store.get(MARKER)).toMatchObject({ dropped: true })
        expect(second.text).toContain('Keep as draft ($0)')
      })
    }

    test('QF3 no queue script to run (not found in any root): the stop text names the queue entry and the marker has no dropped flag', async ($, on) => {
      const w = world(on, byHand({ missing: ['slot-queue.mjs'] }))
      await start($)
      const told = await call($)
      expect(told.text).toMatch(OPEN(/queue entry/))
      expect(slotDrops(w.seen)).toEqual([])
      expect(w.store.get(MARKER)).not.toHaveProperty('dropped')
      expect(ledgerCalls(w.seen)).toEqual([])
    })

    test('QF2 (control) an entry that is already absent from the queue is a complete cleanup: flag set, question asked', async ($, on) => {
      const w = world(on, byHand({ slot: { stdout: '{"ok":true,"dropped":false}\n' } }))
      await start($)
      const told = await call($)
      expect(w.store.get(MARKER)).toMatchObject({ dropped: true })
      expect(told.text).toContain('Keep as draft ($0)')
    })
  })

  // ---- item 8: a saved pending checkpoint with no marker rechecks the live draft state ------------------------------------------------------
  describe('item 8: a bare /pathway on a saved pending checkpoint', () => {
    const PENDING_FIX = { pr: 7, body: 'pr-body.md', root: ROOT, result: engineJson(), covers: [], stamp: null, prHead: HEAD, at: NOW }
    const saved = (over: Opts = {}): Opts => ({ store: { [PENDING]: PENDING_FIX, 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW }, answer: /^Keep as draft/, ...over })

    test('PS1 no marker, an applied record and the PR is a draft now: the live read shows the return and the cleanup runs before the question', async ($, on) => {
      const w = world(on, saved())
      await start($)
      await slash($, '')
      expect(drops(w.seen).length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(w.store.get(MARKER)).toEqual({ head: HEAD, at: NOW, dropped: true })
      expect(w.seen.dialogs.length).toBeGreaterThanOrEqual(1)
    })

    test('PS4 no marker, an applied record at head A and the PR is a draft at head B: the cleanup runs with the fresh head; the grant and the queued asks are gone', async ($, on) => {
      const QUEUED = { kind: 'round', pr: 7, head: HEAD, round: 4, text: 'Round 4 of 1+2 for #7' }
      const w = world(on, saved({ viewHead: OTHER_HEAD, store: { [PENDING]: PENDING_FIX, 'checkpoint:pr:7': RECORD, [GRANT]: GRANT_ROW, [ASKS]: [QUEUED] } }))
      await start($)
      await slash($, '')
      expect(drops(w.seen).length).toBe(1)
      expect(slotDrops(w.seen).length).toBe(1)
      expect(w.store.get(GRANT)).toBeUndefined()
      expect(asksOf(w.store)).toEqual([])
      expect(w.store.get(MARKER)).toEqual({ head: OTHER_HEAD, at: NOW, dropped: true })
    })

    test('PS2 the live read fails: no cleanup is guessed, and no question opens', async ($, on) => {
      const w = world(on, saved({ view: { exitCode: 1, stderr: 'HTTP 502' } }))
      await start($)
      const ran = await slash($, '')
      expect(ran.text ?? '').toMatch(/could not be checked/i)
      nothingCleaned(w)
    })

    test('PS3 (control) no applied record and no marker: no gh call, no cleanup, the question opens', async ($, on) => {
      const w = world(on, saved({ store: { [PENDING]: PENDING_FIX, [GRANT]: GRANT_ROW } }))
      await start($)
      await slash($, '')
      expect(argvOf(w.seen, 'view')).toEqual([])
      expect(drops(w.seen)).toEqual([])
      expect(w.store.get(MARKER)).toBeUndefined()
      expect(w.seen.dialogs.length).toBeGreaterThanOrEqual(1)
    })
  })
})
