import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { FileTouch } from '../../types'
import type { Span } from '../agentic-os/pane-model'
import { ICON_GLYPH, iconSvg } from '../shared/glyphs'
import { TONE } from '../shared/tones'
import { diffLines, hunksOf } from '../skin/model'
import { STATE_TONE, capFiles, commit, editCounts, fileRows, isGitCommit, relative, touch } from './model'

// Touched Files: the files this session's own tool calls named, as a tree in the /files pane.
// It never lists a folder: nothing outside the session's calls can appear, so it is safe on a shared screen.
// One regex-matched tool.call hook (agentic-os holds the plugin's one unmatched tool.call hook).

const files = atom({ plugin: 'ccv3-mods', key: 'files' } as const, [] as FileTouch[])
const PANE = 'files'

const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_FILES_OFF')) === '1'

type Ran = { result?: unknown; isError?: boolean; deny?: string }
const ranClean = (ran: Ran): boolean => ran.deny === undefined && ran.isError !== true

const head = async ($: EngineInterface, root: string): Promise<string | null> => {
  const run = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5000 }).catch(() => null)
  return run?.exitCode === 0 ? run.stdout.trim() : null
}

const STATE_HEX: Record<FileTouch['state'], string> = { read: '#8A867D', edited: '#D97757', committed: '#4E9A6A' }

export const touchedFiles = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (!(await isOff($))) {
      await $.command.register({ name: 'files', description: 'Touched Files: the files this session read, edited and committed' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Read|Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell)$/ }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const shell = tool === 'Bash' || tool === 'PowerShell'
    const command = typeof input.command === 'string' ? input.command : ''
    const commits = shell && isGitCommit(command)
    // Any other shell command is not this module's business: no host call before it runs.
    if (shell && !commits) return next(e)
    const root = await $.session.root().catch(() => '')
    // A commit is real only if HEAD moved: an `echo "git commit"` makes none.
    const before = commits ? await head($, root) : null
    const ran = await next(e)
    if (commits) {
      // `git commit && npm test` can land the commit and still fail the call: only a deny means no commit.
      if ((ran as Ran).deny !== undefined) return ran
      const after = await head($, root)
      if (after !== null && after !== before) {
        const git = ['git', '-c', 'core.quotePath=false']
        // diff-tree: paths relative to the session root (--relative), merge commits included (-m), the first commit too (--root).
        const listed = await $.process.run([...git, 'diff-tree', '-m', '-r', '--root', '--no-commit-id', '--name-only', '--relative', 'HEAD'], { cwd: root, timeoutMs: 5000 }).catch(() => null)
        const dirty = await $.process.run([...git, 'diff', '--name-only', '--relative', 'HEAD'], { cwd: root, timeoutMs: 5000 }).catch(() => null)
        if (listed?.exitCode === 0) {
          await update($, files, list => commit(list, listed.stdout.split('\n'), dirty?.exitCode === 0 ? dirty.stdout.split('\n') : []))
        }
      }
      return ran
    }
    if (!ranClean(ran as Ran)) return ran
    const result = (ran as Ran).result as { staged?: unknown; structuredPatch?: unknown } | undefined
    // A staged edit was held for review: the file did not change.
    if (result?.staged === true) return ran
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    if (path === null) return ran
    const rel = relative(path, root)
    // Counts from the patch the tool reports when there is one (replace_all, unchanged lines, an overwrite).
    const hunks = hunksOf(result)
    if (tool === 'Read') await update($, files, list => capFiles(touch(list, rel, 'read')))
    else if (hunks !== null) {
      const { added, removed } = diffLines(hunks, 0)
      await update($, files, list => capFiles(touch(list, rel, 'edited', { added, removed })))
    } else if (tool === 'Edit') await update($, files, list => touch(list, rel, 'edited', editCounts(String(input.old_string ?? ''), String(input.new_string ?? ''))))
    else if (Array.isArray(input.edits)) {
      const counts = (input.edits as { old_string?: unknown; new_string?: unknown }[]).reduce(
        (n, one) => {
          const c = editCounts(String(one.old_string ?? ''), String(one.new_string ?? ''))
          return { added: n.added + c.added, removed: n.removed + c.removed }
        },
        { added: 0, removed: 0 },
      )
      await update($, files, list => touch(list, rel, 'edited', counts))
    } else if (tool === 'Write') await update($, files, list => touch(list, rel, 'edited', editCounts('', String(input.content ?? ''))))
    else if (tool === 'NotebookEdit') await update($, files, list => touch(list, rel, 'edited', editCounts('', String(input.new_source ?? ''))))
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'files' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Touched files' })
    return { text: opened.isPlaced ? 'Touched Files opened.' : `Touched Files waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Touched Files failed to open.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const list = await read($, files)
    const rows = fileRows(list, e.props.bodyColumns - 4, e.props.scroll.bodyRows, e.props.scroll.offset)
    const byKey = new Map(list.map(file => [`f:${file.path}`, file]))
    const svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const line = (spans: Span[]) => (
      <Text wrap="truncate-end">
        {spans.map((span, i) => (
          <Text key={`s${i}`} {...TONE[span.tone]}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
    const icon = (key: string) => {
      const file = byKey.get(key)
      const isDir = key.startsWith('d:')
      if (!isDir && file === undefined) return null
      if (svg === null) return <Text {...TONE[isDir ? 'head' : STATE_TONE[file?.state ?? 'read']]}>{isDir ? ICON_GLYPH.folder : ICON_GLYPH.read}</Text>
      const Svg = svg
      const color = isDir ? '#8A867D' : STATE_HEX[file?.state ?? 'read']
      return <Svg source={iconSvg(isDir ? 'folder' : file?.state === 'read' ? 'read' : 'edit', color)} alt={isDir ? 'folder' : (file?.state ?? 'file')} width={14} height={14} />
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map(row => (
          <Box key={`row-${row.key}`} flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={1}>
              {icon(row.key)}
              {line(row.left)}
            </Box>
            {row.right ? line(row.right) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
