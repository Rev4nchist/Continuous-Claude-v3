import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { isGitCommit, relative } from '../hooks/touched-files/model'

// Ways Touched Files can fail, one test each.
// T1 a path outside a tool call shows up (a folder listing), or a failed call marks a file
// T2 +/- counts are wrong for Edit and Write, or a later Read lowers an edited file
// T3 a commit flips files it doesn't list, or an "echo git commit" (HEAD unchanged) flips anything
// T4 the terminal gets Svg icons, or the desktop none
// T5 CCV3_MOD_FILES_OFF still records; Windows paths are not made relative

const PANE_PROPS = {
  title: 'Touched files',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type Git = { head: string; next: string; show: string; dirty: string }

const world = (on: On, env: Record<string, string> = {}) => {
  const git: Git = { head: 'aaa', next: 'aaa', show: '', dirty: '' }
  const calls = { list: 0 }
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => {
    calls.list++
    return { value: [] }
  })
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('rev-parse')) return out(`${git.head}\n`)
    if (e.argv.includes('diff-tree')) return out(git.show)
    if (e.argv.includes('diff')) return out(git.dirty)
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: {} } }))
  // The engine's Edit result carries the real patch: one line kept, one added.
  on('tool.call', { tool: 'Edit' }, (_$, e) =>
    e.file_path.includes('locked')
      ? { result: 'denied', isError: true }
      : { result: { filePath: e.file_path, structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' one', ' two', '+three'] }] } } as never,
  )
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' } }))
  on('tool.call', { tool: 'Bash' }, () => {
    git.head = git.next
    return { result: { stdout: '', stderr: '' } }
  })
  return { git, calls }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

const pane = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'Pane', requestId: 'files', props: PANE_PROPS, viewport: { columns: 80, rows: 40 } })
  const text = (await ui.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
  const svgs = (await ui.findAll({ type: 'Svg' })).length
  await ui.unmount()
  return { text, svgs }
}

describe('touched files', () => {
  test('T1 only tool-call paths appear; a failed edit marks nothing', async ($, on) => {
    const { calls } = world(on)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/a.ts' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/locked.ts', old_string: 'a', new_string: 'b' } as never)
    const { text } = await pane($)
    expect(text).toContain('a.ts')
    expect(text).toContain('read 1')
    expect(text).not.toContain('locked.ts')
    expect(calls.list).toBe(0)
  })

  test('T2 counts add up; a later read keeps the file edited', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/x.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/y.ts', content: 'a\nb\nc\nd' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/x.ts' } as never)
    const { text } = await pane($)
    expect(text).toContain('edited 2')
    // From the patch (+1 −0), not the input strings (which would say +3 −2).
    expect(text).toContain('+1 −0')
    expect(text).toContain('+4 −0')
  })

  test('T3 a commit flips only the files it lists; an echo flips nothing', async ($, on) => {
    const { git } = world(on)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' } as never)
    git.show = 'a.ts\nother.ts\n'
    await $.tool.call({ tool: 'Bash', command: 'echo "git commit"' } as never)
    expect((await pane($)).text).toContain('committed 0')
    git.next = 'bbb'
    await $.tool.call({ tool: 'Bash', command: 'git add a.ts && git commit -m "x"' } as never)
    const { text } = await pane($)
    expect(text).toContain('committed 1')
    expect(text).toContain('edited 1')
    expect(text).not.toContain('other.ts')
  })

  test('T3 a file still dirty after the commit stays edited', async ($, on) => {
    const { git } = world(on)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
    git.show = 'a.ts\n'
    git.dirty = 'a.ts\n'
    git.next = 'ccc'
    await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' } as never)
    expect((await pane($)).text).toContain('committed 0')
  })

  test('T4 Svg icons on desktop, glyphs on the terminal', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/a.ts' } as never)
    expect((await pane($, 'terminal')).svgs).toBe(0)
    expect((await pane($, 'desktop')).svgs).toBe(2)
  })

  test('T5 the off switch records nothing', async ($, on) => {
    world(on, { CCV3_MOD_FILES_OFF: '1' })
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/a.ts' } as never)
    expect((await pane($)).text).toContain('No files touched yet')
  })

  test('T5 paths are made relative on Windows and POSIX; commit detection', () => {
    expect(relative('C:\\Users\\dave\\repo\\hooks\\a.ts', 'c:/users/dave/repo')).toBe('hooks/a.ts')
    expect(relative('/repo/a.ts', '/repo')).toBe('a.ts')
    expect(relative('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
    expect(relative('/repo2/a.ts', '/repo')).toBe('/repo2/a.ts')
    expect(isGitCommit('git commit -m x')).toBe(true)
    expect(isGitCommit('git -C ../r commit -am y')).toBe(true)
    expect(isGitCommit('git commit --dry-run')).toBe(false)
    expect(isGitCommit('git log --grep commit')).toBe(false)
    expect(isGitCommit('git -c user.name=x --no-pager commit -m y')).toBe(true)
    expect(isGitCommit('(cd sub && git commit -m z)')).toBe(true)
    expect(isGitCommit('git commit -m a && npm test --dry-run')).toBe(true)
  })
})
