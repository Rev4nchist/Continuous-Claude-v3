/**
 * Card coord-seat-role-on-holder: a compacted seat gets its short role card back in the break point file.
 * Design: .claudedocs/orchestrator-design/design-v3.md rows 5 and 6; seat read 2026-11-15 (conditions A, B, item 6).
 *
 * Holder = the session that owns lane `re-program` in the board JSON the hook already reads (one read, 4,000 ms limit).
 * The short block lives in ~/.claude/rules-ondemand/seat-role.md between the markers
 * `<!-- short-card:start -->` and `<!-- short-card:end -->`. The file stays at MAX_FILE_CHARS and the inject text at 3,900.
 *
 * Ways this can fail (one test each):
 *  P2 a compacted holder does not get the late line of the short block
 *  P3 a maximal file (many decisions) goes over the cap, or loses the card or the lane id
 *  T1 the short card pushes decision lines out with no word about it (condition A: one count line plus the path)
 *  T2 the board read fails or times out: the compact waits, throws or writes a card for a non-holder
 *  T3 the card file is missing or has no markers: the hook throws, or writes nothing
 *  T4 a session that does not hold re-program gets the card (another owner, or another lane)
 *  T5 a secret in the card text reaches the file
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPreCompactBreakpoint, type BreakpointDeps } from '../pre-compact-breakpoint.js';
import { injectionText, MAX_FILE_CHARS, MAX_INJECT_CHARS } from '../shared/breakpoint.js';

const SID = '7e7549ed-0b86-4552-af79-7c1a0a9f59ac';
const OTHER = '11111111-0b86-4552-af79-7c1a0a9f59ac';
const LATE = 'Run `CronList`, re-create the tick.';
const SHORT = `SEAT CARD (short). Each tick: 1. lane.mjs mine, inbox --peek. 2. Dave queue: a moved head SHA is stale. ${LATE} Full card: ~/.claude/rules-ondemand/seat-role.md.`;
const CARD = `# Seat role card\n\nbody\n\n<!-- short-card:start -->\n${SHORT}\n<!-- short-card:end -->\n\n## Where facts live\nlate full line\n`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seat-bp-'));
const ask = (id: string, q: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-15T12:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ header: 'Q', question: q, multiSelect: false, options: [{ label: 'a', description: '' }] }] } }] } });
const ans = (id: string, q: string, a: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-15T12:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${q}"="${a}".` }] }, toolUseResult: { questions: [], answers: { [q]: a }, annotations: {} } });
const holderBoard = (owner = SID, id = 're-program') => ({ lanes: [{ id, title: 'RE program seat', owner_session_id: owner, state: 'active', note: 'GOAL: keep builders moving | NEXT: tick' }] });

function setup(opts: { card?: string | null; board?: unknown; runner?: BreakpointDeps['runner']; decisions?: number } = {}) {
  const home = tmp();
  if (opts.card !== null) {
    fs.mkdirSync(path.join(home, '.claude', 'rules-ondemand'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'rules-ondemand', 'seat-role.md'), opts.card ?? CARD);
  }
  const transcript = path.join(tmp(), 't.jsonl');
  const n = opts.decisions ?? 2;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(ask(`t${i}`, `Decision number ${i}: which of the long option names applies to this case here?`), ans(`t${i}`, `Decision number ${i}: which of the long option names applies to this case here?`, `Option ${i} with a fairly long answer text to fill the room`));
  fs.writeFileSync(transcript, lines.join('\n'));
  const deps: BreakpointDeps = {
    home,
    now: () => new Date(),
    runner: opts.runner ?? (async () => ({ code: 0, stdout: JSON.stringify(opts.board ?? holderBoard()), stderr: '' })),
    branchOf: () => 'coord/seat-role-on-holder',
  };
  const file = path.join(home, '.claude', 'state', 'breakpoint', `${SID}.md`);
  return { home, transcript, deps, file };
}
const run = async (s: ReturnType<typeof setup>) => {
  const out = await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: s.transcript, cwd: 'C:/r' }, s.deps);
  return { out, text: fs.existsSync(s.file) ? fs.readFileSync(s.file, 'utf8') : '' };
};

describe('P2: a compacted holder gets the short block', () => {
  it('the file holds the late line of the short block and a pointer to the full card', async () => {
    const { text } = await run(setup());
    expect(text).toContain(LATE);
    expect(text).toContain('seat-role.md');
    expect(text).toContain('re-program');
  });
});

describe('P3: a maximal file stays under the caps and keeps the card and the lane id', () => {
  it('60 decisions: file <= MAX_FILE_CHARS, inject <= 3,900 (and < 4,000), card whole, lane id kept', async () => {
    const { text } = await run(setup({ decisions: 60 }));
    expect(text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(injectionText(text).length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(MAX_INJECT_CHARS).toBeLessThan(4000);
    expect(text).toContain(SHORT);
    expect(text).toContain('- re-program');
  });
});

describe('T1: no silent drop (seat condition A)', () => {
  it('one line names how many decision lines are not shown and the path that holds them all', async () => {
    const s = setup({ decisions: 60 });
    const { text } = await run(s);
    const shown = (text.match(/^- \[\d\d:\d\dZ\] .*->/gm) ?? []).length;
    const m = /(\d+) decision lines not shown: full list (\S+)/.exec(text);
    expect(m, 'count line present').not.toBeNull();
    expect(Number(m![1]) + shown).toBe(60);
    expect(m![2].replace(/\\/g, '/')).toBe(s.transcript.replace(/\\/g, '/'));
  });
  it('no line when every decision fits', async () => {
    const { text } = await run(setup({ decisions: 2 }));
    expect(text).not.toMatch(/decision lines not shown/);
  });
});

describe('T2: the board read fails or times out (seat item 6)', () => {
  it.each([
    ['times out', async () => ({ code: 124, stdout: '', stderr: 'timeout' })],
    ['throws', async () => { throw new Error('boom'); }],
  ])('the board read %s: the compact goes on, no card, the pointer line stays', async (_n, runner) => {
    const { out, text } = await run(setup({ runner: runner as BreakpointDeps['runner'] }));
    expect(out.continue).toBe(true);
    expect(text).not.toContain(LATE);
    expect(text).toContain('seat-role.md');
  });
  it('the hook makes exactly one board read', async () => {
    let calls = 0;
    await run(setup({ runner: async () => { calls++; return { code: 0, stdout: JSON.stringify(holderBoard()), stderr: '' }; } }));
    expect(calls).toBe(1);
  });
});

describe('T3: the card file is missing or has no markers', () => {
  it.each([['missing', null], ['no markers', '# Seat role card\n\nno block here\n']])('%s: pointer line only, no throw', async (_n, card) => {
    const { out, text } = await run(setup({ card }));
    expect(out.continue).toBe(true);
    expect(text).not.toContain(LATE);
    expect(text).toContain('seat-role.md');
  });
});

describe('T4: a session that does not hold re-program gets no card', () => {
  it.each([
    ['another owner', holderBoard(OTHER)],
    ['another lane', holderBoard(SID, 're-other-lane')],
    ['no lanes', { lanes: [] }],
  ])('%s', async (_n, board) => {
    const { text } = await run(setup({ board }));
    expect(text).not.toContain(LATE);
    expect(text).not.toContain('seat-role.md');
  });
});

describe('T5: a secret in the card text is masked before the write', () => {
  it('a token-shaped string in the block does not reach the file', async () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const card = CARD.replace(SHORT, `${SHORT} ${secret}`);
    const { text } = await run(setup({ card }));
    expect(text).toContain(LATE);
    expect(text).not.toContain(secret);
  });
});
