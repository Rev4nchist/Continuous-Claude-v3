// Tests of scout-tldr-count.mjs (card coord-search-defaults). Fixtures are made up: no real transcript, no real id.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countTranscript, guardOutput, readScoutRuns, summarize, tldrCalls } from './scout-tldr-count.mjs';

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
    // Run A (scout): 2 Grep, 1 Glob, 1 Read, 2 Bash. One Grep line is repeated (a streamed copy of the same tool id).
    writeRun(`sess-${MARK}`, 'agent-a', 'scout', [
      tool('t1', 'Grep', { pattern: MARK }),
      tool('t1', 'Grep', { pattern: MARK }),
      tool('t2', 'Grep'), tool('t3', 'Glob'), tool('t4', 'Read'),
      tool('t5', 'Bash', { command: `tldr impact foo src/ --lang typescript # ${MARK}` }),
      tool('t6', 'Bash', { command: 'cd src && tldr structure . --lang javascript; tldr tree . --ext .mjs' }),
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
    assert.deepEqual(tldrCalls('rg tldr src; echo tldr; grep -n tldr structure x'), [], 'the word tldr as an argument is not a tldr call');
    assert.deepEqual(tldrCalls('C:/Users/x/.local/bin/tldr.exe impact f . --lang go'), [{ sub: 'impact', lang: true }], 'a path before tldr is allowed');
    assert.deepEqual(tldrCalls('TLDR_QUIET=1 timeout 60 tldr search q src'), [{ sub: 'search', lang: false }], 'env assignments and timeout before tldr are allowed');
  });

  it('countTranscript counts each tool id once (a streamed copy must not double the count)', () => {
    const text = [tool('a', 'Grep'), tool('a', 'Grep'), tool('b', 'Bash', { command: 'tldr search x .' })].join('\n');
    const r = countTranscript(text);
    assert.equal(r.tools, 2);
    assert.equal(r.byTool.Grep, 1);
    assert.equal(r.tldr.length, 1);
  });

  it('counts the two scout runs exactly and leaves the critic run out', () => {
    const s = summarize(readScoutRuns(dir), null);
    assert.equal(s.runs, 2);
    assert.equal(s.runsWithTldr, 1);
    assert.equal(s.toolCalls, 9);
    assert.deepEqual(s.byTool, { Grep: 5, Glob: 1, Read: 1, Bash: 2, other: 0 });
    assert.equal(s.tldrCalls, 3);
    assert.equal(s.tldrWithLang, 2);
    assert.deepEqual(s.tldrBySubcommand, { impact: 1, structure: 1, tree: 1 });
    assert.equal(s.medianToolCallsPerRun, 6);
    assert.equal(s.runsWithTldrPercent, 50);
  });

  it('--since keeps only runs written at or after the date', () => {
    const r = cli(['--dir', dir, '--root', rootNoList, '--since', '2026-06-01']);
    assert.equal(r.code, 0, r.err);
    const s = JSON.parse(r.out);
    assert.equal(s.runs, 1);
    assert.equal(s.toolCalls, 6);
  });

  it('the output holds no command text, no prompt text, no session folder name and no path', () => {
    const r = cli(['--dir', dir, '--root', rootNoList]);
    assert.equal(r.code, 0, r.err);
    for (const forbidden of [MARK, 'tldr impact', 'foo', 'src/', tmp.replace(/\\/g, '/'), tmp, 'sess-']) {
      assert.ok(!r.out.includes(forbidden), `the output holds "${forbidden}"`);
    }
    assert.match(r.err, /no listed-id list in this root/);
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

  it('the printed date is normalised: free text in --since cannot reach the output', () => {
    const r = cli(['--dir', dir, '--root', rootNoList, '--since', '2026-06-01']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).since, '2026-06-01T00:00:00.000Z');
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
