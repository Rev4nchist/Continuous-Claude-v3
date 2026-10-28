import { describe, expect, test } from 'claude-code/testing'

import { gitInfo } from '../hooks/agentic-os/gitinfo'

// Ways the repo, branch and worktree reader can fail, one test each. The reader is a Map, so no disk is touched.
// Q1 a primary checkout reports a worktree, or the wrong repo name, or does not walk up from a sub folder
// Q2 a linked worktree names itself as the repo, or loses its own worktree name
// Q3 a detached HEAD gives a branch, or the full sha
// Q4 no .git anywhere gives a value, throws, or reads without end
// Q5 a relative gitdir (and commondir) is read from the wrong folder
// Q6 a branch with slashes is cut at a slash
// Q7 CRLF line endings stay in the name
// Q8 a huge or binary HEAD becomes a branch name, or hides the repo; a huge or binary .git file is believed
// Q9 a reader that throws reaches the engine
// Q10 Windows backslash paths are not understood
// Q11 a submodule is called a worktree
// Q12 a linked worktree without commondir loses its repo
// Q13 an unreadable HEAD of a linked worktree loses the worktree

const files = (entries: Record<string, string>) => {
  const reads: string[] = []
  const read = async (path: string): Promise<string | null> => {
    reads.push(path)
    return entries[path] ?? null
  }
  return { read, reads }
}

const NONE = { repo: null, branch: null, worktree: null }

describe('gitinfo', () => {
  test('Q1 a primary checkout: repo is the folder name, no worktree, and a sub folder walks up', async () => {
    const { read } = files({ 'C:/work/app/.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await gitInfo('C:/work/app', read)).toEqual({ repo: 'app', branch: 'main', worktree: null })
    expect(await gitInfo('C:/work/app/src/deep/er', read)).toEqual({ repo: 'app', branch: 'main', worktree: null })
    // A reader that answers a folder with an empty string instead of failing must not hide the checkout.
    const folder = files({ 'C:/work/app/.git': '', 'C:/work/app/.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await gitInfo('C:/work/app', folder.read)).toEqual({ repo: 'app', branch: 'main', worktree: null })
  })

  test('Q2 Q6 a linked worktree: the repo is the main checkout folder, the worktree its own name, slashes stay in the branch', async () => {
    // The exact files of this worktree on 2026-10-28.
    const { read } = files({
      'C:/Users/dkhay/continuous-claude/.claude/worktrees/sdlc-os-p1a2/.git': 'gitdir: C:/Users/dkhay/continuous-claude/.git/worktrees/sdlc-os-p1a2\n',
      'C:/Users/dkhay/continuous-claude/.git/worktrees/sdlc-os-p1a2/HEAD': 'ref: refs/heads/feat/sdlc-os-p1a2\n',
      'C:/Users/dkhay/continuous-claude/.git/worktrees/sdlc-os-p1a2/commondir': '../..\n',
    })
    const got = await gitInfo('C:/Users/dkhay/continuous-claude/.claude/worktrees/sdlc-os-p1a2/.claude/plugins/ccv3-mods', read)
    expect(got).toEqual({ repo: 'continuous-claude', branch: 'feat/sdlc-os-p1a2', worktree: 'sdlc-os-p1a2' })
  })

  test('Q6 a branch with several slashes is kept whole', async () => {
    const { read } = files({ '/r/x/.git/HEAD': 'ref: refs/heads/user/feat/a-b/c\n' })
    expect((await gitInfo('/r/x', read)).branch).toBe('user/feat/a-b/c')
  })

  test('Q3 a detached HEAD gives the short sha, not a branch and not the full sha', async () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    const { read } = files({ '/r/x/.git/HEAD': `${sha}\n` })
    expect(await gitInfo('/r/x', read)).toEqual({ repo: 'x', branch: 'a1b2c3d', worktree: null })
  })

  test('Q4 no .git anywhere: all null, and the walk up stops', async () => {
    const { read, reads } = files({})
    expect(await gitInfo('/r/x/y/z', read)).toEqual(NONE)
    expect(reads.length).toBeLessThanOrEqual(16)
    const deep = files({})
    expect(await gitInfo(`/${Array.from({ length: 200 }, (_, i) => `d${i}`).join('/')}`, deep.read)).toEqual(NONE)
    expect(deep.reads.length).toBeLessThanOrEqual(80)
  })

  test('Q4 an empty or odd cwd gives all null', async () => {
    const { read } = files({ '/.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await gitInfo('', read)).toEqual(NONE)
    expect(await gitInfo(undefined as unknown as string, read)).toEqual(NONE)
  })

  test('Q5 a relative gitdir is read from the folder that holds the .git file', async () => {
    const { read } = files({
      '/r/main/.git/worktrees/w1/HEAD': 'ref: refs/heads/topic\n',
      '/r/main/.git/worktrees/w1/commondir': '../..',
      '/r/wt/w1/.git': 'gitdir: ../../main/.git/worktrees/w1\n',
    })
    expect(await gitInfo('/r/wt/w1/sub', read)).toEqual({ repo: 'main', branch: 'topic', worktree: 'w1' })
  })

  test('Q7 CRLF in HEAD, the .git file and commondir does not leak into a name', async () => {
    const { read } = files({
      '/r/main/.git/worktrees/w1/HEAD': 'ref: refs/heads/topic\r\n',
      '/r/main/.git/worktrees/w1/commondir': '../..\r\n',
      '/r/wt/w1/.git': 'gitdir: /r/main/.git/worktrees/w1\r\n',
    })
    const got = await gitInfo('/r/wt/w1', read)
    expect(got).toEqual({ repo: 'main', branch: 'topic', worktree: 'w1' })
    const plain = files({ '/r/x/.git/HEAD': 'ref: refs/heads/main\r\n' })
    expect((await gitInfo('/r/x', plain.read)).branch).toBe('main')
  })

  test('Q8 a huge HEAD gives no branch but keeps the repo', async () => {
    const { read } = files({ '/r/x/.git/HEAD': `ref: refs/heads/${'a'.repeat(1_000_000)}` })
    expect(await gitInfo('/r/x', read)).toEqual({ repo: 'x', branch: null, worktree: null })
  })

  test('Q8 a binary HEAD gives no branch but keeps the repo', async () => {
    const { read } = files({ '/r/x/.git/HEAD': 'ref: refs/heads/ma\u0000in\u0001\u0002' })
    expect(await gitInfo('/r/x', read)).toEqual({ repo: 'x', branch: null, worktree: null })
  })

  test('Q8 a .git file that is huge, binary or not a gitdir line is not believed', async () => {
    for (const body of ['gitdir: /x/' + 'a'.repeat(100_000), 'gitdir: /x\u0000y', 'PK\u0003\u0004 not a git file']) {
      const { read } = files({ '/r/wt/.git': body })
      expect(await gitInfo('/r/wt', read)).toEqual(NONE)
    }
  })

  test('Q8 a branch name that is only spaces or empty gives no branch', async () => {
    const { read } = files({ '/r/x/.git/HEAD': 'ref: refs/heads/   \n' })
    expect((await gitInfo('/r/x', read)).branch).toBeNull()
    const blank = files({ '/r/x/.git/HEAD': '' })
    expect(await gitInfo('/r/x', blank.read)).toEqual({ repo: 'x', branch: null, worktree: null })
  })

  test('Q9 a reader that throws or returns a non-string never reaches the caller', async () => {
    const boom = async (): Promise<string | null> => {
      throw new Error('EACCES')
    }
    expect(await gitInfo('/r/x', boom)).toEqual(NONE)
    const odd = (async () => 42) as unknown as (path: string) => Promise<string | null>
    expect(await gitInfo('/r/x', odd)).toEqual(NONE)
  })

  test('Q10 Windows backslash paths in the cwd and the gitdir line', async () => {
    const { read } = files({
      'C:/Users/me/proj/.git/worktrees/w2/HEAD': 'ref: refs/heads/fix/z\n',
      'C:/Users/me/proj/.git/worktrees/w2/commondir': '../..\n',
      'C:/Users/me/wt/w2/.git': 'gitdir: C:\\Users\\me\\proj\\.git\\worktrees\\w2\n',
    })
    expect(await gitInfo('C:\\Users\\me\\wt\\w2\\src', read)).toEqual({ repo: 'proj', branch: 'fix/z', worktree: 'w2' })
  })

  test('Q11 a submodule is not a worktree and keeps its own folder as the repo', async () => {
    const { read } = files({
      '/r/super/.git/modules/sub/HEAD': 'ref: refs/heads/dev\n',
      '/r/super/sub/.git': 'gitdir: ../.git/modules/sub\n',
    })
    expect(await gitInfo('/r/super/sub', read)).toEqual({ repo: 'sub', branch: 'dev', worktree: null })
  })

  test('Q12 a linked worktree with no commondir takes the repo from the gitdir path', async () => {
    const { read } = files({
      '/r/main/.git/worktrees/w3/HEAD': 'ref: refs/heads/t3\n',
      '/r/wt/w3/.git': 'gitdir: /r/main/.git/worktrees/w3\n',
    })
    expect(await gitInfo('/r/wt/w3', read)).toEqual({ repo: 'main', branch: 't3', worktree: 'w3' })
  })

  test('Q13 a linked worktree whose HEAD is gone still names its repo and worktree', async () => {
    const { read } = files({
      '/r/main/.git/worktrees/w4/commondir': '../..',
      '/r/wt/w4/.git': 'gitdir: /r/main/.git/worktrees/w4\n',
    })
    expect(await gitInfo('/r/wt/w4', read)).toEqual({ repo: 'main', branch: null, worktree: 'w4' })
  })

  test('Q14 a name that holds a secret is redacted', async () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    const { read } = files({ '/r/x/.git/HEAD': `ref: refs/heads/fix-${secret}\n` })
    const got = await gitInfo('/r/x', read)
    expect(got.branch ?? '').not.toContain(secret)
    expect(got.branch).not.toBeNull()
  })
})
