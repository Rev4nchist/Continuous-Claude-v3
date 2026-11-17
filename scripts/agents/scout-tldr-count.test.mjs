// Tests of scout-tldr-count.mjs (card coord-search-defaults). Fixtures are made up: no real transcript, no real id.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countTranscript, guardOutput, projectDirs, readScoutRuns, summarize, tldrCalls } from './scout-tldr-count.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'scout-tldr-count.mjs');
const MARK = 'SECRETMARK9731';

let tmp;
let dir; // the projects folder of the fixture
let rootNoList; // a repo root with no listed-id list
const tool = (id, name, input = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
function writeRun(session, agent, type, lines, mtime) {
  const sub = path.join(dir, session, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `${agent}.meta.json`), JSON.stringify({ agentType: type, description: `${MARK} prompt text` }));
  const f = path.join(sub, `${agent}.jsonl`);
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(f, mtime, mtime);
}
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('scout-tldr-count', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-'));
    dir = path.join(tmp, 'projects');
    rootNoList = path.join(tmp, 'root-no-list');
    fs.mkdirSync(rootNoList);
    // Run A (scout): 2 Grep, 1 Glob, 1 Read, 2 Bash, 1 other tool. One Grep line is repeated (a streamed copy of the same tool id).
    writeRun(`sess-${MARK}`, 'agent-a', 'scout', [
      tool('t1', 'Grep', { pattern: MARK }),
      tool('t1', 'Grep', { pattern: MARK }),
      tool('t2', 'Grep'), tool('t3', 'Glob'), tool('t4', 'Read'),
      tool('t5', 'Bash', { command: `tldr impact foo src/ --lang typescript # ${MARK}` }),
      tool('t6', 'Bash', { command: 'cd src && tldr structure . --lang javascript; tldr tree . --ext .mjs' }),
      tool('t7', 'WebFetch'),
    ], new Date('2026-11-16T12:00:00Z'));
    // Run B (scout): 3 Grep calls, no tldr, written long ago.
    writeRun('sess-b', 'agent-b', 'scout', [tool('u1', 'Grep'), tool('u2', 'Grep'), tool('u3', 'Grep')], new Date('2026-01-01T00:00:00Z'));
    // Run C (critic): must not count, whatever it runs.
    writeRun('sess-c', 'agent-c', 'critic', [tool('v1', 'Bash', { command: 'tldr structure . --lang python' })], new Date('2026-11-16T12:00:00Z'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('tldrCalls: one entry per tldr segment, with its sub-command and whether it passes --lang; other words become "other"', () => {
    assert.deepEqual(tldrCalls('tldr structure . --lang typescript'), [{ sub: 'structure', lang: true }]);
    assert.deepEqual(tldrCalls('cd a && tldr tree . --ext .mjs; tldr.exe calls src --lang=go'), [{ sub: 'tree', lang: false }, { sub: 'calls', lang: true }]);
    assert.deepEqual(tldrCalls('tldr frobnicate x'), [{ sub: 'other', lang: false }]);
  });

  it('tldrCalls: the word tldr as an argument is not a call; a quoted pipe is not a split', () => {
    assert.deepEqual(tldrCalls('rg tldr src; echo tldr; grep -n tldr structure x'), []);
    assert.deepEqual(tldrCalls('rg "a|tldr search" .'), [], 'tldr inside a quoted pattern');
    assert.deepEqual(tldrCalls('tldr search "a|b" . --lang ts'), [{ sub: 'search', lang: true }], 'a quoted pipe must not drop --lang');
  });

  it('tldrCalls: the usual shell prefixes before tldr are still a call', () => {
    const one = (cmd, sub) => assert.deepEqual(tldrCalls(cmd), [{ sub, lang: false }], cmd);
    one('C:/Users/x/.local/bin/tldr.exe impact f .', 'impact');
    one('TLDR_QUIET=1 timeout 60 tldr search q src', 'search');
    one('timeout 60s tldr arch src', 'arch');
    one('x=$(tldr arch src)', 'arch');
    one('(tldr tree src)', 'tree');
    one('if true; then tldr calls src; fi', 'calls');
    one('uv run tldr extract f.mjs', 'extract');
    one('rg x src | tldr search y .', 'search');
  });

  it('countTranscript counts each tool id once (a streamed copy must not double the count)', () => {
    const text = [tool('a', 'Grep'), tool('a', 'Grep'), tool('b', 'Bash', { command: 'tldr search x .' })].join('\n');
    const r = countTranscript(text);
    assert.equal(r.tools, 2);
    assert.equal(r.byTool.Grep, 1);
    assert.equal(r.tldr.length, 1);
  });

  it('counts the two scout runs exactly and leaves the critic run out', () => {
    const s = summarize(readScoutRuns([dir]), null);
    assert.equal(s.runs, 2);
    assert.equal(s.runsWithTldr, 1);
    assert.equal(s.runsWithTldrPercent, 50);
    assert.equal(s.toolCalls, 10);
    assert.deepEqual(s.byTool, { Grep: 5, Glob: 1, Read: 1, Bash: 2, other: 1 });
    assert.equal(s.tldrCalls, 3);
    assert.deepEqual(s.tldrBySubcommand, { impact: 1, structure: 1, tree: 1 });
    assert.equal(s.tldrLangRequired, 2, 'impact and structure take --lang; tree does not');
    assert.equal(s.tldrLangGiven, 2);
    assert.equal(s.medianToolCallsPerRun, 5, 'runs of 7 and 3 calls: the median of an even count is the mean of the two middle values');
  });

  it('--since keeps only runs written at or after the date; the date is printed normalised', () => {
    const r = cli(['--dir', dir, '--root', rootNoList, '--since', '2026-06-01']);
    assert.equal(r.code, 0, r.err);
    const s = JSON.parse(r.out);
    assert.equal(s.runs, 1);
    assert.equal(s.toolCalls, 7);
    assert.equal(s.since, '2026-06-01T00:00:00.000Z');
  });

  it('the output holds no command text, no prompt text, no session folder name and no path', () => {
    const r = cli(['--dir', dir, '--root', rootNoList]);
    assert.equal(r.code, 0, r.err);
    const forms = (p) => [p, p.replace(/\\/g, '/'), JSON.stringify(p).slice(1, -1)];
    for (const forbidden of [MARK, 'tldr impact', 'foo', 'src/', 'sess-', path.basename(tmp), ...forms(tmp)]) {
      assert.ok(!r.out.includes(forbidden), `the output holds "${forbidden}"`);
    }
    assert.match(r.err, /no listed-id list in this root/);
  });

  it('a transcript that cannot be read is skipped and counted, and does not stop the run', () => {
    const d2 = path.join(tmp, 'projects-bad');
    const sub = path.join(d2, 'sess', 'subagents');
    fs.mkdirSync(path.join(sub, 'agent-d.jsonl'), { recursive: true }); // a folder where the transcript should be: reading it fails
    fs.writeFileSync(path.join(sub, 'agent-d.meta.json'), JSON.stringify({ agentType: 'scout' }));
    fs.writeFileSync(path.join(sub, 'agent-e.meta.json'), JSON.stringify({ agentType: 'scout' }));
    fs.writeFileSync(path.join(sub, 'agent-e.jsonl'), `${tool('w1', 'Grep')}\n`);
    const s = summarize(readScoutRuns([d2]), null);
    assert.equal(s.runs, 1);
    assert.equal(s.unreadableTranscripts, 1);
  });

  it('projectDirs: the project folder and its worktree folders, nothing else', () => {
    const projects = path.join(tmp, 'all-projects');
    const primary = path.join(tmp, 'repo');
    const slug = primary.replace(/[^A-Za-z0-9]/g, '-');
    for (const n of [slug, `${slug}--claude-worktrees-one`, `${slug}--claude-worktrees-two`, `${slug}-other`, 'unrelated']) fs.mkdirSync(path.join(projects, n), { recursive: true });
    const names = projectDirs(projects, primary).map((p) => path.basename(p)).sort();
    assert.deepEqual(names, [slug, `${slug}--claude-worktrees-one`, `${slug}--claude-worktrees-two`].sort());
    assert.deepEqual(projectDirs(path.join(tmp, 'no-such-folder'), primary), []);
  });

  it('exit 2 when no scout run is in the window', () => {
    const r = cli(['--dir', dir, '--root', rootNoList, '--since', '2027-01-01']);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
  });

  it('exit 1 for an unknown argument and for a bad date', () => {
    assert.equal(cli(['--nope']).code, 1);
    assert.equal(cli(['--since', 'not-a-date']).code, 1);
    assert.equal(cli(['--dir']).code, 1);
  });

  it('the last pass: guardOutput refuses a text that holds a listed id by the hook rule, and lets counts through', () => {
    // Made-up list. By the hook rule a bare number is not an id (too many collisions); a number with a context word is.
    assert.equal(guardOutput('{"note":"PR 100"}', ['100']), false);
    assert.equal(guardOutput('{"toolCalls":100}', ['100']), true);
    assert.equal(guardOutput('{"toolCalls":100}', null), true);
  });

  it('a list with an unreadable shape stops the run with exit 3 and no output', () => {
    const root = path.join(tmp, 'root-bad-list');
    fs.mkdirSync(path.join(root, '.claudedocs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claudedocs', '2026-11-01-pr-review-dataset.json'), '{ not json');
    const r = cli(['--dir', dir, '--root', root]);
    assert.equal(r.code, 3, r.err);
    assert.equal(r.out, '');
    assert.match(r.err, /listed-id list could not be read/);
  });
});
