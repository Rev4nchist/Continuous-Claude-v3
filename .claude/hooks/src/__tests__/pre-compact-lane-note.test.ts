import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pickHeldLanes,
  buildCompactText,
  firstInProgressTodo,
  firstInProgressTask,
  currentWorkText,
  branchOf,
  inCooldown,
  runPreCompactLaneNote,
  type LaneRunner,
} from '../pre-compact-lane-note.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

const board = (lanes: Array<Record<string, unknown>>) => ({ board: 'b', lanes, me: SID });

// Same shape as a real Claude Code transcript line: tool_use nested in message.content.
// Real transcripts also repeat each tool_use in an api-request-blob line.
function assistantTodoLine(todos: Array<{ content: string; status: string }>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] },
  });
}

describe('pickHeldLanes', () => {
  it('keeps lanes owned by this session that are not done', () => {
    const j = board([
      { id: 'mine-a', owner_session_id: SID, state: 'active' },
      { id: 'mine-b', owner_session_id: SID, state: 'review' },
    ]);
    expect(pickHeldLanes(j, SID)).toEqual(['mine-a', 'mine-b']);
  });

  it('skips a lane held by another session', () => {
    expect(pickHeldLanes(board([{ id: 'x', owner_session_id: OTHER, state: 'active' }]), SID)).toEqual([]);
  });

  it('skips a done lane and an unowned lane', () => {
    const j = board([
      { id: 'd', owner_session_id: SID, state: 'done' },
      { id: 'u', owner_session_id: null, state: 'ready' },
    ]);
    expect(pickHeldLanes(j, SID)).toEqual([]);
  });

  it('returns nothing for malformed board JSON', () => {
    expect(pickHeldLanes(null, SID)).toEqual([]);
    expect(pickHeldLanes({ lanes: 'nope' }, SID)).toEqual([]);
    expect(pickHeldLanes({ lanes: [null, 5, {}] }, SID)).toEqual([]);
  });

  it('drops a lane id that could parse as a CLI flag', () => {
    expect(pickHeldLanes(board([{ id: '--json', owner_session_id: SID, state: 'active' }]), SID)).toEqual([]);
  });
});

describe('buildCompactText', () => {
  const now = new Date(2026, 10, 5, 9, 7); // local time 09:07

  it('builds the decided one-line text', () => {
    const t = buildCompactText({ trigger: 'manual', now, todo: 'Fix the parser' });
    expect(t).toBe('Compacting (manual) at 09:07 local. Open task: Fix the parser.');
  });

  it('adds the branch when there is one', () => {
    expect(buildCompactText({ trigger: 'auto', now, todo: null, branch: 'feat/x' })).toBe(
      'Compacting (auto) at 09:07 local on branch feat/x.',
    );
  });

  it('leaves the task clause out when there is no task ("none" would mislead)', () => {
    const text = buildCompactText({ trigger: 'auto', now, todo: null });
    expect(text).not.toContain('Open task');
    expect(text).not.toContain('none recorded');
    expect(text).toBe('Compacting (auto) at 09:07 local.');
  });

  it('clips a long todo and stays within 300 chars', () => {
    const t = buildCompactText({ trigger: 'auto', now, todo: 'x'.repeat(5000) });
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t).toContain('x'.repeat(120));
    expect(buildCompactText({ trigger: 'auto', now, todo: null, branch: 'b'.repeat(500) }).length).toBeLessThanOrEqual(300);
    expect(t).not.toContain('x'.repeat(121));
  });

  it('removes newlines, control chars and non-ASCII from a todo', () => {
    const t = buildCompactText({ trigger: 'manual', now, todo: 'line1\nline2\r\n\ttab\u0007bell — dash \u{1F600}' });
    expect(t).not.toMatch(/[\r\n\t\u0007]/);
    expect(t).toMatch(/^[\x20-\x7e]+$/);
    expect(t).toContain('line1 line2 tab');
  });

  it('treats a whitespace-only todo as no todo', () => {
    expect(buildCompactText({ trigger: 'manual', now, todo: ' \n\t ' })).not.toContain('Open task');
  });

  it('never lets an unknown trigger into the text', () => {
    const t = buildCompactText({ trigger: 'x; rm -rf' as never, now, todo: null });
    expect(t).toContain('Compacting (unknown)');
  });
});

describe('firstInProgressTodo', () => {
  it('reads the in_progress todo from a real-format transcript', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      assistantTodoLine([
        { content: 'Done thing', status: 'completed' },
        { content: 'Write the hook', status: 'in_progress' },
        { content: 'Later thing', status: 'pending' },
      ]),
      'not json at all',
    ].join('\n');
    expect(firstInProgressTodo(text)).toBe('Write the hook');
  });

  it('uses the LAST TodoWrite, not an older one', () => {
    const text = [
      assistantTodoLine([{ content: 'Old', status: 'in_progress' }]),
      assistantTodoLine([{ content: 'New', status: 'in_progress' }]),
    ].join('\n');
    expect(firstInProgressTodo(text)).toBe('New');
  });

  it('returns null when the last TodoWrite has nothing in progress', () => {
    const text = [
      assistantTodoLine([{ content: 'Old', status: 'in_progress' }]),
      assistantTodoLine([{ content: 'Old', status: 'completed' }]),
    ].join('\n');
    expect(firstInProgressTodo(text)).toBeNull();
  });

  it('ignores a duplicate in an api-request-blob line', () => {
    const blob = JSON.stringify({
      type: 'api-request-blob',
      message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Ghost', status: 'in_progress' }] } }] },
    });
    expect(firstInProgressTodo(blob)).toBeNull();
  });

  it('returns null for empty or garbage text', () => {
    expect(firstInProgressTodo('')).toBeNull();
    expect(firstInProgressTodo('{"type":"assistant","message":')).toBeNull();
  });
});

// Real transcript shape (Claude Code 2.1.312): TaskCreate's tool_use carries the subject; the id comes back in the
// following user line as toolUseResult.task.id. TaskUpdate carries { taskId, status }.
const taskCreateLine = (toolUseId: string, subject: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'TaskCreate', input: { subject, description: 'd' }, caller: { type: 'direct' } }] },
  });
const taskResultLine = (toolUseId: string, id: string, subject: string) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: `Task #${id} created successfully: ${subject}` }] },
    toolUseResult: { task: { id, subject } },
  });
const taskUpdateLine = (taskId: string, status: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `u${taskId}${status}`, name: 'TaskUpdate', input: { taskId, status } }] },
  });

describe('firstInProgressTask', () => {
  const created = [
    taskCreateLine('t1', 'Write the failing test'),
    taskResultLine('t1', '1', 'Write the failing test'),
    taskCreateLine('t2', 'Fix the hook'),
    taskResultLine('t2', '2', 'Fix the hook'),
  ];

  it('returns the subject of the task a TaskUpdate set to in_progress', () => {
    expect(firstInProgressTask([...created, taskUpdateLine('2', 'in_progress')].join('\n'))?.text).toBe('Fix the hook');
  });

  it('returns null when the in_progress task was then completed', () => {
    const text = [...created, taskUpdateLine('1', 'in_progress'), taskUpdateLine('1', 'completed')].join('\n');
    expect(firstInProgressTask(text)).toBeNull();
  });

  it('returns null when nothing is in progress, or the transcript has no tasks', () => {
    expect(firstInProgressTask(created.join('\n'))).toBeNull();
    expect(firstInProgressTask('')).toBeNull();
  });

  it('skips an update for a task created before the transcript tail (unknown id)', () => {
    expect(firstInProgressTask(taskUpdateLine('9', 'in_progress'))).toBeNull();
  });

  it('ignores an api-request-blob copy of a TaskCreate', () => {
    const blob = JSON.stringify({
      type: 'api-request-blob',
      message: { content: [{ type: 'tool_use', id: 'g', name: 'TaskCreate', input: { subject: 'Ghost' } }] },
    });
    const ghostResult = taskResultLine('g', '5', 'Ghost');
    expect(firstInProgressTask([blob, ghostResult, taskUpdateLine('5', 'in_progress')].join('\n'))).toBeNull();
  });
});

describe('currentWorkText', () => {
  it('prefers the newer of a TodoWrite and a task update', () => {
    const todoThenTask = [
      assistantTodoLine([{ content: 'Old todo', status: 'in_progress' }]),
      taskCreateLine('t1', 'New task'),
      taskResultLine('t1', '1', 'New task'),
      taskUpdateLine('1', 'in_progress'),
    ].join('\n');
    expect(currentWorkText(todoThenTask)).toBe('New task');
    const taskThenTodo = [
      taskCreateLine('t1', 'Old task'),
      taskResultLine('t1', '1', 'Old task'),
      taskUpdateLine('1', 'in_progress'),
      assistantTodoLine([{ content: 'New todo', status: 'in_progress' }]),
    ].join('\n');
    expect(currentWorkText(taskThenTodo)).toBe('New todo');
  });

  it('returns null for an empty transcript', () => {
    expect(currentWorkText('')).toBeNull();
  });
});

describe('branchOf', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcln-br-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the branch from a plain checkout, from a subfolder', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/abc\n');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    expect(branchOf(path.join(dir, 'a', 'b'))).toBe('feat/abc');
  });

  it('follows the gitdir pointer of a linked worktree', () => {
    const real = path.join(dir, 'main', '.git', 'worktrees', 'w1');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'HEAD'), 'ref: refs/heads/feat/wt\n');
    fs.mkdirSync(path.join(dir, 'wt'));
    fs.writeFileSync(path.join(dir, 'wt', '.git'), `gitdir: ${real}\n`);
    expect(branchOf(path.join(dir, 'wt'))).toBe('feat/wt');
  });

  it('returns null for a detached HEAD or no repo', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(branchOf(dir)).toBeNull();
    expect(branchOf(path.join(os.tmpdir(), 'pcln-no-such-dir-xyz'))).toBeNull();
  });
});

describe('inCooldown', () => {
  const t0 = 1_000_000_000_000;
  it('is true inside five minutes and false after', () => {
    expect(inCooldown({ [SID]: t0 }, SID, t0 + 4 * 60_000)).toBe(true);
    expect(inCooldown({ [SID]: t0 }, SID, t0 + 5 * 60_000 + 1)).toBe(false);
  });
  it('is false for an unknown session or bad state', () => {
    expect(inCooldown({ [OTHER]: t0 }, SID, t0)).toBe(false);
    expect(inCooldown(null, SID, t0)).toBe(false);
    expect(inCooldown({ [SID]: 'x' }, SID, t0)).toBe(false);
  });
});

describe('runPreCompactLaneNote', () => {
  let dir: string;
  let stateFile: string;
  let transcript: string;
  let calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  let clock: number;

  const boardOut = (lanes: Array<Record<string, unknown>>) => JSON.stringify(board(lanes));

  function deps(runner: LaneRunner) {
    return { runner, now: () => new Date(clock), stateFile, laneCli: '/x/lane.mjs' };
  }
  function recorder(handler: (args: string[]) => { code: number; stdout?: string }): LaneRunner {
    return async (args, opts) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      const r = handler(args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: '' };
    };
  }
  const input = () => ({ trigger: 'manual' as const, session_id: SID, transcript_path: transcript, cwd: dir });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcln-'));
    stateFile = path.join(dir, 'state', 'pre-compact-lane-note-state.json');
    transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, assistantTodoLine([{ content: 'Ship the hook', status: 'in_progress' }]) + '\n');
    calls = [];
    clock = new Date(2026, 10, 5, 12, 0).getTime();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const twoLanes = [
    { id: 'l1', owner_session_id: SID, state: 'active' },
    { id: 'l2', owner_session_id: SID, state: 'review' },
    { id: 'theirs', owner_session_id: OTHER, state: 'active' },
    { id: 'fin', owner_session_id: SID, state: 'done' },
  ];

  it('logs one compact event per held lane, with session env and cwd, and skips the others', async () => {
    const r = await runPreCompactLaneNote(
      input(),
      deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 0 }))),
    );
    expect(r).toEqual({ continue: true, systemMessage: '[PreCompact] compact event logged on 2 lane(s)' });
    const events = calls.filter((c) => c.args[0] === 'compact');
    expect(events.map((c) => c.args[1])).toEqual(['l1', 'l2']);
    expect(events[0].args).toHaveLength(3); // compact <id> <one text argv>
    expect(events[0].args[2]).toContain('Open task: Ship the hook.');
    expect(calls[0].env.CLAUDE_CODE_SESSION_ID).toBe(SID);
    expect(calls[0].cwd).toBe(dir);
    expect(calls[0].args).toEqual(['board', '--json']);
  });

  it("keeps each lane's own note: no call can overwrite it, and a lane with no note stays empty", async () => {
    const notes: Record<string, string | null> = { l1: "Dave's progress: parser done, tests next", l2: null };
    const events: Array<{ lane: string; text: string }> = [];
    const runner = recorder((a) => {
      if (a[0] === 'board') return { code: 0, stdout: boardOut(twoLanes) };
      // The lane CLI semantics: `note` replaces the note. Only `compact` is event-only.
      if (a[0] === 'note') notes[a[1]] = a.slice(2).join(' ');
      else if (a[0] === 'compact') events.push({ lane: a[1], text: a[2] });
      else return { code: 2 };
      return { code: 0 };
    });
    await runPreCompactLaneNote(input(), deps(runner));
    expect(notes).toEqual({ l1: "Dave's progress: parser done, tests next", l2: null });
    expect(calls.filter((c) => c.args[0] === 'note')).toHaveLength(0);
    expect(events.map((e) => e.lane)).toEqual(['l1', 'l2']);
    expect(events[0].text).toMatch(/^Compacting \(manual\) at 12:00 local/);
  });

  it('never falls back to `note` when the lane CLI does not know `compact` (older CLI, exit 2)', async () => {
    const r = await runPreCompactLaneNote(
      input(),
      deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 2 }))),
    );
    expect(calls.filter((c) => c.args[0] === 'note')).toHaveLength(0);
    expect(r.systemMessage).toMatch(/skipped: every compact event write failed/);
  });

  it('writes nothing when no lane is held', async () => {
    const r = await runPreCompactLaneNote(
      input(),
      deps(recorder(() => ({ code: 0, stdout: boardOut([{ id: 'theirs', owner_session_id: OTHER, state: 'active' }]) }))),
    );
    expect(r.continue).toBe(true);
    expect(r.systemMessage).toMatch(/^\[PreCompact\] lane note skipped: /);
    expect(calls.filter((c) => c.args[0] === 'compact')).toHaveLength(0);
  });

  it('writes nothing and still continues when the CLI exits non-zero', async () => {
    const r = await runPreCompactLaneNote(input(), deps(recorder(() => ({ code: 1, stdout: 'no lane board for x' }))));
    expect(r.continue).toBe(true);
    expect(r.systemMessage).toMatch(/lane note skipped: .*exit 1/);
    expect(calls).toHaveLength(1);
  });

  it('writes nothing and still continues when the CLI prints bad JSON', async () => {
    const r = await runPreCompactLaneNote(input(), deps(recorder(() => ({ code: 0, stdout: '<<not json' }))));
    expect(r.continue).toBe(true);
    expect(r.systemMessage).toMatch(/lane note skipped: .*JSON/);
    expect(calls).toHaveLength(1);
  });

  it('still continues when the runner throws', async () => {
    const boom: LaneRunner = async () => {
      throw new Error('spawn exploded');
    };
    const r = await runPreCompactLaneNote(input(), deps(boom));
    expect(r.continue).toBe(true);
    expect(r.systemMessage).toMatch(/lane note skipped/);
  });

  it('a failing event write for one lane does not stop the next lane', async () => {
    const r = await runPreCompactLaneNote(
      input(),
      deps(
        recorder((a) => {
          if (a[0] === 'board') return { code: 0, stdout: boardOut(twoLanes) };
          return a[1] === 'l1' ? { code: 1 } : { code: 0 };
        }),
      ),
    );
    expect(calls.filter((c) => c.args[0] === 'compact').map((c) => c.args[1])).toEqual(['l1', 'l2']);
    expect(r.systemMessage).toBe('[PreCompact] compact event logged on 1 lane(s)');
  });

  it('suppresses a second call inside 5 minutes and allows one after', async () => {
    const run = () => runPreCompactLaneNote(input(), deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 0 }))));
    await run();
    const firstNotes = calls.filter((c) => c.args[0] === 'compact').length;
    expect(firstNotes).toBe(2);

    clock += 2 * 60_000;
    const second = await run();
    expect(second.systemMessage).toMatch(/skipped: .*cooldown/);
    expect(calls.filter((c) => c.args[0] === 'compact').length).toBe(firstNotes);

    clock += 4 * 60_000; // 6 minutes after the first
    await run();
    expect(calls.filter((c) => c.args[0] === 'compact').length).toBe(firstNotes * 2);
  });

  it('does not start the cooldown when every event write failed', async () => {
    const run = () => runPreCompactLaneNote(input(), deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 1 }))));
    await run();
    const second = await run();
    expect(second.systemMessage).not.toMatch(/cooldown/);
  });

  it('a state file error never blocks the event', async () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.mkdirSync(stateFile); // a directory where the file should be: read and write both fail
    const r = await runPreCompactLaneNote(input(), deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 0 }))));
    expect(r.systemMessage).toBe('[PreCompact] compact event logged on 2 lane(s)');
  });

  it('writes the event without a task clause when the transcript is missing', async () => {
    const i = { ...input(), transcript_path: path.join(dir, 'gone.jsonl') };
    await runPreCompactLaneNote(i, deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 0 }))));
    expect(calls.find((c) => c.args[0] === 'compact')!.args[2]).not.toContain('Open task');
  });

  it('the event text carries no transcript content other than the task', async () => {
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET-LAST-MESSAGE' }] } }) + '\n');
    await runPreCompactLaneNote(input(), deps(recorder((a) => (a[0] === 'board' ? { code: 0, stdout: boardOut(twoLanes) } : { code: 0 }))));
    expect(calls.find((c) => c.args[0] === 'compact')!.args[2]).not.toContain('SECRET');
  });
});
