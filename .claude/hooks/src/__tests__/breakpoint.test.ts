/**
 * Card compact-session-breakpoint: the code-built state file that a compact leaves and the resume reads.
 *
 * Fixture source (seat requirement: say which): the JSONL line shapes below were READ from this harness's own session
 * transcript (4c4b5eb5, 2026-11-14), not invented: an AskUserQuestion call is an `assistant` line whose content has a
 * `tool_use` block named AskUserQuestion with `input.questions[{header,question,multiSelect,options}]`; its answer is a
 * `user` line with a `tool_result` block (string content "Your questions have been answered: ...") AND a top-level
 * `toolUseResult: { questions, answers: { <question text>: <answer> }, annotations }`; a line Dave typed has
 * `origin: { kind: 'human' }`, `promptSource: 'typed'`, `message.content` as a string. Plugin, system and task-notification
 * lines have another origin; hook and system text has `isMeta: true` or starts with `<`.
 * Not observed in that transcript: a non-empty `annotations` object (0 of 315 results). The `annotations[question].notes`
 * shape in the note test is an ASSUMPTION; the parser reads it defensively and ignores any other shape.
 * The PreCompact and SessionStart (compact) stdin fields come from the Claude Code hooks documentation
 * (https://code.claude.com/docs/en/hooks: PreCompact input `trigger`, `custom_instructions`, common `session_id`,
 * `transcript_path`, `cwd`; SessionStart `source` includes `compact`), not from a captured payload.
 *
 * Ways this can fail (one test group each):
 *  1. A decision is missed, invented or misordered (call without result, free-text answer, answers only in the content string).
 *  2. Injected or system text counts as something Dave typed (plugin, task notification, meta, array content, `<command-...>`).
 *  3. A secret reaches the file (every text goes through the secret mask).
 *  4. The file or the injected text grows past its cap and blows the 10,000 character hook context cap.
 *  5. A compact with nothing to save replaces a good file (never replace with less).
 *  6. The hook deletes something that is not its own old file.
 *  7. The resume text appears after startup, resume or clear, or the outcome question stays after a compact.
 *  8. A bad session id writes outside the state folder.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseTranscriptTail,
  buildBreakpoint,
  shouldReplace,
  breakpointPath,
  pruneOld,
  injectionText,
  applyBreakpoint,
  laneFactsFrom,
  carriedDecisionLines,
  readBreakpoint,
  FRESH_MS,
  MAX_FILE_CHARS,
  MAX_INJECT_CHARS,
  TYPED_HEADER,
} from '../shared/breakpoint.js';

// ---------------------------------------------------------------- fixture builders (shapes read from a real transcript)
const ask = (id: string, questions: Array<{ header: string; question: string; options?: string[] }>, at: string) =>
  JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: questions.map((q) => ({ header: q.header, question: q.question, multiSelect: false, options: (q.options ?? ['a', 'b']).map((label) => ({ label, description: '' })) })) } }] },
  });
const answered = (id: string, answers: Record<string, string>, at: string, annotations: unknown = {}) =>
  JSON.stringify({
    type: 'user', timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: ${Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ')}. You can now continue with these answers in mind.` }] },
    toolUseResult: { questions: [], answers, annotations },
  });
const answeredTextOnly = (id: string, q: string, a: string, at: string) =>
  JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${q}"="${a}". You can now continue with these answers in mind.` }] } });
const human = (text: string, at: string, promptSource = 'typed') =>
  JSON.stringify({ type: 'user', timestamp: at, origin: { kind: 'human' }, promptSource, message: { role: 'user', content: text } });

const T = (n: number) => `2026-11-14T12:${String(n).padStart(2, '0')}:00.000Z`;

// ---------------------------------------------------------------- 1. decisions
describe('parseTranscriptTail: decisions', () => {
  it('pairs an AskUserQuestion call with its answer, oldest first', () => {
    const text = [
      ask('t1', [{ header: 'Land', question: 'Land PR 571?' }], T(1)),
      answered('t1', { 'Land PR 571?': 'Land now (Recommended)' }, T(2)),
      ask('t2', [{ header: 'Review', question: 'Which review?' }], T(3)),
      answered('t2', { 'Which review?': 'No review, land on CI ($0) (Recommended)' }, T(4)),
    ].join('\n');
    const { decisions } = parseTranscriptTail(text);
    expect(decisions.map((d) => [d.header, d.question, d.answer])).toEqual([
      ['Land', 'Land PR 571?', 'Land now (Recommended)'],
      ['Review', 'Which review?', 'No review, land on CI ($0) (Recommended)'],
    ]);
    expect(decisions[0].at).toBe(T(2));
  });

  it('keeps a free-text "Other" answer as the user typed it', () => {
    const text = [
      ask('t1', [{ header: 'Card', question: 'Which card?' }], T(1)),
      answered('t1', { 'Which card?': 'the compact one, but do the design note first' }, T(2)),
    ].join('\n');
    expect(parseTranscriptTail(text).decisions[0].answer).toBe('the compact one, but do the design note first');
  });

  it('does not list a question that has no answer yet', () => {
    const text = [ask('t1', [{ header: 'Land', question: 'Land PR 571?' }], T(1))].join('\n');
    expect(parseTranscriptTail(text).decisions).toEqual([]);
  });

  it('reads two questions of one call as two decisions', () => {
    const text = [
      ask('t1', [{ header: 'A', question: 'First?' }, { header: 'B', question: 'Second?' }], T(1)),
      answered('t1', { 'First?': 'x', 'Second?': 'y' }, T(2)),
    ].join('\n');
    expect(parseTranscriptTail(text).decisions.map((d) => [d.header, d.answer])).toEqual([['A', 'x'], ['B', 'y']]);
  });

  it('lists only the questions that have an answer when a result answers one of two', () => {
    const text = [
      ask('t1', [{ header: 'A', question: 'First?' }, { header: 'B', question: 'Second?' }], T(1)),
      answered('t1', { 'First?': 'x' }, T(2)),
    ].join('\n');
    expect(parseTranscriptTail(text).decisions.map((d) => d.question)).toEqual(['First?']);
  });

  it('falls back to the result text when the structured answers are missing', () => {
    const text = [
      ask('t1', [{ header: 'Land', question: 'Land PR 571?' }], T(1)),
      answeredTextOnly('t1', 'Land PR 571?', 'Keep open', T(2)),
    ].join('\n');
    expect(parseTranscriptTail(text).decisions[0]).toMatchObject({ question: 'Land PR 571?', answer: 'Keep open' });
  });

  it('adds a note of the user when the answer has one (assumed annotation shape)', () => {
    const text = [
      ask('t1', [{ header: 'Land', question: 'Land PR 571?' }], T(1)),
      answered('t1', { 'Land PR 571?': 'Land now' }, T(2), { 'Land PR 571?': { notes: 'after CI is green' } }),
    ].join('\n');
    expect(parseTranscriptTail(text).decisions[0].note).toBe('after CI is green');
  });

  it('skips a line that is not JSON and the cut first line of a tail read', () => {
    const text = ['{"type":"assistant","timest', 'not json at all', ask('t1', [{ header: 'H', question: 'Q?' }], T(1)), answered('t1', { 'Q?': 'a' }, T(2))].join('\n');
    expect(parseTranscriptTail(text).decisions).toHaveLength(1);
  });

  it('never throws on an empty or odd input', () => {
    expect(parseTranscriptTail('')).toEqual({ decisions: [], typed: [] });
    expect(() => parseTranscriptTail('\n\n{}\n[]\nnull\n"x"')).not.toThrow();
  });
});

// ---------------------------------------------------------------- 2. what Dave typed
describe('parseTranscriptTail: typed lines', () => {
  it('keeps only text a human typed, accepted or queued, and skips injected text', () => {
    const text = [
      human('land 561', T(1)),
      human('fold it into A2, go', T(2), 'suggestion_accepted'),
      human('Land 407 Yes your recommendation', T(3), 'queued'),
      JSON.stringify({ type: 'user', timestamp: T(4), origin: { kind: 'plugin', name: 'ccv3-mods' }, promptSource: 'system', message: { role: 'user', content: 'The ccv3-mods plugin sent a message: PR watcher' } }),
      JSON.stringify({ type: 'user', timestamp: T(5), origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', message: { role: 'user', content: '<task-notification>done</task-notification>' } }),
      JSON.stringify({ type: 'user', timestamp: T(6), isMeta: true, message: { role: 'user', content: '<system-reminder> summary </system-reminder>' } }),
      JSON.stringify({ type: 'user', timestamp: T(7), origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: [{ type: 'text', text: 'array form' }] } }),
      human('<command-name>/compact</command-name>', T(8)),
      JSON.stringify({ type: 'user', timestamp: T(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }),
    ].join('\n');
    expect(parseTranscriptTail(text).typed.map((t) => t.text)).toEqual(['land 561', 'fold it into A2, go', 'Land 407 Yes your recommendation']);
  });

  it('keeps the last 5 typed lines, each cut at 300 characters', () => {
    const lines = Array.from({ length: 8 }, (_, i) => human(`line ${i} ` + 'x'.repeat(400), T(i)));
    const typed = parseTranscriptTail(lines.join('\n')).typed;
    expect(typed).toHaveLength(5);
    expect(typed[0].text.startsWith('line 3 ')).toBe(true);
    expect(typed[4].text.startsWith('line 7 ')).toBe(true);
    expect(typed.every((t) => t.text.length <= 300)).toBe(true);
  });
});

// ---------------------------------------------------------------- the lane facts
describe('laneFactsFrom: the board JSON of the lane shim', () => {
  const board = {
    lanes: [
      { id: 'mine-1', title: 'Compact break point', owner_session_id: 'S1', state: 'active', note: 'GOAL: let Dave compact in place. | 2026-11-14 design note sent | NEXT: write red tests | MS: C:/repo/.claudedocs/coordination/milestones/mine-1.md' },
      { id: 'other-1', title: 'x', owner_session_id: 'S2', state: 'active', note: 'GOAL: not mine' },
      { id: 'done-1', title: 'y', owner_session_id: 'S1', state: 'done', note: 'GOAL: finished' },
    ],
  };
  it('returns the GOAL, NEXT and milestone path of each lane the session holds', () => {
    expect(laneFactsFrom(board, 'S1')).toEqual([
      { id: 'mine-1', title: 'Compact break point', goal: 'let Dave compact in place.', next: 'write red tests', milestone: 'C:/repo/.claudedocs/coordination/milestones/mine-1.md' },
    ]);
  });
  it('returns nothing for a session with no lane, or for a board that is not an object', () => {
    expect(laneFactsFrom(board, 'S9')).toEqual([]);
    expect(laneFactsFrom(null, 'S1')).toEqual([]);
    expect(laneFactsFrom({ lanes: 'x' }, 'S1')).toEqual([]);
  });
  it('drops a lane id that is not a safe id and keeps the rest', () => {
    const odd = { lanes: [{ id: '../x', title: 't', owner_session_id: 'S1', state: 'active', note: '' }, { id: 'ok-1', title: 't', owner_session_id: 'S1', state: 'active', note: '' }] };
    expect(laneFactsFrom(odd, 'S1').map((l) => l.id)).toEqual(['ok-1']);
  });
});

// ---------------------------------------------------------------- the file
const baseInput = () => ({
  sessionId: '4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac',
  trigger: 'manual' as const,
  now: new Date('2026-11-14T18:00:00Z'),
  lanes: [{ id: 'compact-session-breakpoint', title: 'Compact', goal: 'let Dave compact in place', next: 'write red tests', milestone: 'C:/repo/.claudedocs/coordination/milestones/compact-session-breakpoint.md' }],
  branch: 'feat/compact-session-breakpoint',
  decisions: [{ at: T(2), header: 'Land', question: 'Land PR 571?', answer: 'Land now (Recommended)' }],
  typed: [{ at: T(3), text: 'yes take the card' }],
});

// ---------------------------------------------------------------- seat fix 2 (CodeRabbit CLI minor, 11-14): decisions get the budget FIRST
describe('buildBreakpoint: decisions get the budget before long lane fields and typed lines', () => {
  const long = (c: string, n: number) => c.repeat(n);
  const lane = (i: number) => ({ id: `lane-number-${i}`, title: long('T', 100), goal: long('g', 300), next: long('n', 300), milestone: 'C:/' + long('m', 300) });
  const typed5 = Array.from({ length: 5 }, (_, i) => ({ at: T(10 + i), text: long('t', 400) + i }));
  const decisions = (n: number) => Array.from({ length: n }, (_, i) => ({ at: T(i), header: 'H', question: `Decision question number ${i}?`, answer: `answer ${i} ` + long('a', 120) }));
  const input = (n: number) => ({ ...baseInput(), lanes: [lane(1), lane(2), lane(3)], typed: typed5, decisions: decisions(n) });

  it('3 long lanes + 5 long typed lines + 10 decisions: every decision stays, the file stays under the cap, the resume sentence stays', () => {
    const t = buildBreakpoint(input(10));
    for (let i = 0; i < 10; i++) expect(t, `decision ${i}`).toContain(`Decision question number ${i}?`);
    expect(t.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(t).toContain('Resume: continue with the NEXT step');
  });
  it('too many decisions for the file: the newest stay, the oldest go, the cap and the resume sentence hold', () => {
    const t = buildBreakpoint(input(40));
    expect(t).toContain('Decision question number 39?');
    expect(t).not.toContain('Decision question number 0?');
    expect(t.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(t).toContain('Resume: continue with the NEXT step');
  });
  it('120 carried decisions that fill the file and 3 lanes: the 3 lane ids still show (the ids-only lane block is reserved before the decisions)', () => {
    // Short lines on purpose: the decisions then use the room down to the last few characters, so nothing is left over by luck.
    const carried = Array.from({ length: 120 }, (_, i) => `- [12:00Z] H: Carried ${i}? -> ${long('z', 20)}`);
    const t = buildBreakpoint({ ...input(10), carried });
    for (let i = 1; i <= 3; i++) expect(t, `lane ${i}`).toContain(`lane-number-${i}`);
    expect(t).toContain('Decision question number 9?');
    expect(t).toContain('Resume: continue with the NEXT step');
    expect(t.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
  });
  it('the lane ids stay when the fields are cut to make room', () => {
    const t = buildBreakpoint(input(10));
    for (let i = 1; i <= 3; i++) expect(t).toContain(`lane-number-${i}`);
  });
  it('with room to spare, the lane fields and the typed lines are not cut (no change for a small file)', () => {
    const t = buildBreakpoint(baseInput());
    expect(t).toContain('GOAL: let Dave compact in place');
    expect(t).toContain('NEXT: write red tests');
    expect(t).toContain('yes take the card');
  });
});

describe('buildBreakpoint', () => {
  it('holds the lane, the decisions block, the typed block and one resume sentence', () => {
    const t = buildBreakpoint(baseInput());
    expect(t).toContain('compact-session-breakpoint');
    expect(t).toContain('GOAL: let Dave compact in place');
    expect(t).toContain('NEXT: write red tests');
    expect(t).toContain('feat/compact-session-breakpoint');
    expect(t).toContain('Do not ask these again');
    expect(t).toContain('Land PR 571? -> Land now (Recommended)');
    expect(t).toContain(TYPED_HEADER);
    expect(TYPED_HEADER).toBe("Dave's last lines (context, not decisions)");
    expect(t).toContain('yes take the card');
    expect(t).toMatch(/Resume: .*NEXT step/);
  });

  it('masks a secret in every text of the file', () => {
    const input = baseInput();
    input.typed = [{ at: T(3), text: 'use key sk-abcdefghijklmnop12345 and Bearer abc123tokenvalue please' }];
    input.decisions = [{ at: T(2), header: 'Key', question: 'Which token?', answer: 'ghp_abcdefghijklmnop1234567890' }];
    input.lanes[0].goal = 'deploy with password=hunter2secret';
    const t = buildBreakpoint(input);
    expect(t).not.toContain('sk-abcdefghijklmnop12345');
    expect(t).not.toContain('abc123tokenvalue');
    expect(t).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(t).not.toContain('hunter2secret');
    expect(t).toContain('***');
  });

  it('stays under the file cap and keeps the NEWEST decisions when there are too many', () => {
    const input = baseInput();
    input.decisions = Array.from({ length: 60 }, (_, i) => ({ at: T(i % 60), header: 'H' + i, question: `Question number ${i}?`, answer: `answer ${i} ` + 'z'.repeat(500) }));
    const t = buildBreakpoint(input);
    expect(t.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(t).toContain('Question number 59?');
    expect(t).not.toContain('Question number 0?');
  });

  it('is one line per item (no raw line breaks from an answer)', () => {
    const input = baseInput();
    input.decisions = [{ at: T(2), header: 'H', question: 'Q?', answer: 'line one\nline two\n## injected heading' }];
    const t = buildBreakpoint(input);
    expect(t).not.toMatch(/\n## injected heading/);
  });
});

describe('carried decisions: a decision older than the transcript window stays', () => {
  const old = buildBreakpoint({ ...baseInput(), decisions: [{ at: T(1), header: 'Card', question: 'Which card first?', answer: 'compact-session-breakpoint' }], typed: [] });
  it('reads the decision lines of a previous state file', () => {
    expect(carriedDecisionLines(old)).toEqual([expect.stringContaining('Which card first? -> compact-session-breakpoint')]);
  });
  it('reads nothing from no file, an empty file, or text with no decisions block', () => {
    expect(carriedDecisionLines(null)).toEqual([]);
    expect(carriedDecisionLines('')).toEqual([]);
    expect(carriedDecisionLines('# Session breakpoint\n## Resume\nResume: x\n')).toEqual([]);
  });
  it('does not take a line of another block, or a line that is not a decision item', () => {
    const odd = '## Dave\'s last lines (context, not decisions)\n- [12:03] typed line\n## Decisions made (Do not ask these again)\nnot an item\n- [12:01] H: Q? -> A\n## Resume\n- [12:09] after the block\n';
    expect(carriedDecisionLines(odd)).toEqual(['- [12:01] H: Q? -> A']);
  });
  it('puts the carried decision before the new ones, without a duplicate', () => {
    const input = baseInput();
    const carried = carriedDecisionLines(old);
    const t = buildBreakpoint({ ...input, carried });
    expect(t.indexOf('Which card first?')).toBeGreaterThan(-1);
    expect(t.indexOf('Which card first?')).toBeLessThan(t.indexOf('Land PR 571?'));
    const again = buildBreakpoint({ ...input, decisions: [{ at: T(1), header: 'Card', question: 'Which card first?', answer: 'compact-session-breakpoint' }], carried });
    expect(again.split('Which card first?').length - 1).toBe(1);
  });
  it('still keeps the newest items under the cap when old and new together are too many', () => {
    const many = Array.from({ length: 40 }, (_, i) => `- [12:00] H${i}: Carried question ${i}? -> answer ${'z'.repeat(150)}`);
    const t = buildBreakpoint({ ...baseInput(), carried: many });
    expect(t.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(t).toContain('Land PR 571?');
    expect(t).toContain('Carried question 39?');
    expect(t).not.toContain('Carried question 0?');
  });
});

describe('shouldReplace: never replace with less', () => {
  const rich = buildBreakpoint(baseInput());
  const empty = buildBreakpoint({ ...baseInput(), lanes: [], decisions: [], typed: [], branch: null });
  it('writes when no file exists, or the old one cannot be read', () => {
    expect(shouldReplace(null, empty)).toBe(true);
    expect(shouldReplace(null, rich)).toBe(true);
  });
  it('keeps a file that has content when the new one has none', () => {
    expect(shouldReplace(rich, empty)).toBe(false);
  });
  it('replaces a file that has content by another that has content, and an empty one by anything', () => {
    expect(shouldReplace(rich, rich)).toBe(true);
    expect(shouldReplace(empty, rich)).toBe(true);
    expect(shouldReplace(empty, empty)).toBe(true);
  });
});

describe('breakpointPath', () => {
  it('is one file per session under the home state folder', () => {
    const p = breakpointPath('/home/u', '4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac')!;
    expect(p.replace(/\\/g, '/')).toBe('/home/u/.claude/state/breakpoint/4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac.md');
  });
  it('refuses a session id that could leave the folder', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '', '..', 'x'.repeat(200)]) expect(breakpointPath('/home/u', bad)).toBeNull();
  });
});

describe('pruneOld: only its own old files in its own folder', () => {
  it('deletes a session file older than 30 days and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-prune-'));
    const day = 24 * 3600 * 1000;
    const now = Date.now();
    const mk = (name: string, ageDays: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      const t = new Date(now - ageDays * day);
      fs.utimesSync(p, t, t);
      return p;
    };
    const oldOwn = mk('4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac.md', 31);
    const newOwn = mk('7e7549ed-cef5-4a85-99be-ef273fb80930.md', 2);
    const oldOther = mk('notes.txt', 90);
    const oldOddName = mk('README.md', 90);
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(pruneOld(dir, now)).toBe(1);
    expect(fs.existsSync(oldOwn)).toBe(false);
    for (const p of [newOwn, oldOther, oldOddName, path.join(dir, 'sub')]) expect(fs.existsSync(p)).toBe(true);
  });
  it('does nothing for a folder that does not exist', () => {
    expect(pruneOld(path.join(os.tmpdir(), 'bp-nope-' + Date.now()), Date.now())).toBe(0);
  });
});

// ---------------------------------------------------------------- seat review 12:27: a stale file must not be injected
describe('readBreakpoint: only a fresh file (seat fix 1)', () => {
  const SID = '4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac';
  const put = (ageMs: number) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-fresh-'));
    const file = breakpointPath(home, SID)!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Session breakpoint\n- [12:01Z] Q? -> A\n');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    return home;
  };
  it('uses a file written a minute ago', () => {
    expect(readBreakpoint(put(60_000), SID)).toContain('Q? -> A');
  });
  it('ignores a file older than the freshness window (an earlier compact, a hook that timed out or is not registered)', () => {
    expect(FRESH_MS).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(readBreakpoint(put(FRESH_MS + 60_000), SID)).toBeNull();
    expect(readBreakpoint(put(3 * 24 * 3600 * 1000), SID)).toBeNull();
  });
  it('an ignored file gives today\'s context after a compact (fail open)', () => {
    const ledger = '## Continuity ledger\n';
    expect(applyBreakpoint('compact', ledger, readBreakpoint(put(2 * 3600 * 1000), SID))).toBe(ledger);
  });
});

describe('UTC mark on the times (seat minor 2)', () => {
  it('writes Z after the hh:mm of a decision and of a typed line', () => {
    const text = buildBreakpoint(baseInput());
    expect(text).toMatch(/- \[\d\d:\d\dZ\] .*->/);
    expect(text).toMatch(/- \[\d\d:\d\dZ\] /);
    expect(text).not.toMatch(/- \[\d\d:\d\d\] /);
  });
});

// ---------------------------------------------------------------- the resume
describe('injectionText', () => {
  it('says it is state data, and to read the lane note and live pages again before use', () => {
    const t = injectionText(buildBreakpoint(baseInput()));
    expect(t).toMatch(/state data/i);
    expect(t).toMatch(/lane note/i);
    expect(t).toMatch(/live page/i);
  });
  it('stays under 4,000 characters even for a file at its cap', () => {
    const big = 'y'.repeat(MAX_FILE_CHARS);
    expect(injectionText(big).length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(MAX_INJECT_CHARS).toBeLessThanOrEqual(4000);
  });
});

describe('applyBreakpoint: the SessionStart context', () => {
  const ledger = '## Continuity ledger\n...\n\n## Unmarked Session Outcomes\nMark them: artifact_mark.py\n';
  const bp = buildBreakpoint(baseInput());
  it('after a compact it replaces the ledger dump and drops the outcome question', () => {
    const out = applyBreakpoint('compact', ledger, bp);
    expect(out).toContain('Land PR 571?');
    expect(out).not.toContain('Unmarked Session Outcomes');
    expect(out).not.toContain('Continuity ledger');
  });
  it('after a compact with no breakpoint it keeps today\'s context (fail open)', () => {
    expect(applyBreakpoint('compact', ledger, null)).toBe(ledger);
    expect(applyBreakpoint('compact', ledger, '')).toBe(ledger);
  });
  it.each(['startup', 'resume', 'clear', 'fork', 'cli', undefined])('does not change the context after %s', (src) => {
    expect(applyBreakpoint(src as string | undefined, ledger, bp)).toBe(ledger);
  });
});
