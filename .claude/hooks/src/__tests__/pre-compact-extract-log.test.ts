/**
 * pre-compact-extract sends the extractor child's stdout and stderr to a log file.
 *
 * Before this change the child ran with stdio 'ignore', so a failed store left no trace.
 * These tests inject a fake spawn helper. No real child starts, and no test writes
 * the real home log: every test passes its own log path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runBackgroundExtraction,
  runPreCompactExtract,
  defaultExtractLogPath,
  type LaunchArgs,
} from '../pre-compact-extract.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

let dir: string;
let opcDir: string;
let args: LaunchArgs;
let spawnCalls: Array<{ cmd: string; argv: readonly string[]; options: any }>;
let unref: ReturnType<typeof vi.fn>;

const fakeSpawn: any = (cmd: string, argv: readonly string[], options: any) => {
  spawnCalls.push({ cmd, argv, options });
  return { unref };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-log-'));
  opcDir = path.join(dir, 'opc');
  fs.mkdirSync(path.join(opcDir, 'scripts', 'core'), { recursive: true });
  fs.writeFileSync(path.join(opcDir, 'scripts', 'core', 'incremental_extract.py'), '');
  args = {
    transcriptPath: path.join(dir, 't.jsonl'),
    sessionId: SID,
    startLine: 3,
    stateFile: path.join(dir, 'state.json'),
    projectDir: dir,
  };
  spawnCalls = [];
  unref = vi.fn();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('child output goes to the log file', () => {
  it('passes a log file descriptor for stdout and stderr, not ignore', () => {
    const logPath = path.join(dir, 'logs', 'pce.log');
    const ok = runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    expect(ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    const stdio = spawnCalls[0].options.stdio;
    expect(Array.isArray(stdio)).toBe(true);
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('creates the log folder and appends, never truncates', () => {
    const logPath = path.join(dir, 'new', 'deep', 'pce.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'OLD LINE\n');
    runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    const text = fs.readFileSync(logPath, 'utf-8');
    expect(text.startsWith('OLD LINE\n')).toBe(true);
    expect(text.split('\n').filter((l) => l.includes(SID))).toHaveLength(2);
  });

  it('creates a missing log folder', () => {
    const logPath = path.join(dir, 'missing', 'sub', 'pce.log');
    runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('writes a log line with an ISO timestamp and the session id', () => {
    const logPath = path.join(dir, 'pce.log');
    runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    const line = fs.readFileSync(logPath, 'utf-8').split('\n').find((l) => l.includes(SID));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\]/);
  });
});

describe('fail open when the log cannot be opened', () => {
  it('falls back to stdio ignore and still launches', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file, not a folder');
    const logPath = path.join(blocker, 'sub', 'pce.log');
    let ok = false;
    expect(() => {
      ok = runBackgroundExtraction(args, { spawnHidden: fakeSpawn, opcDir, logPath });
    }).not.toThrow();
    expect(ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.stdio).toBe('ignore');
  });

  it('the hook still continues and reports the launch', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    fs.writeFileSync(args.transcriptPath, '{}\n');
    const out = runPreCompactExtract(
      { trigger: 'auto', session_id: SID, transcript_path: args.transcriptPath },
      dir,
      { now: () => 1_800_000_000_000, extract: { spawnHidden: fakeSpawn, opcDir, logPath: path.join(blocker, 'x.log') } },
    );
    expect(out.continue).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe('hook output is unchanged', () => {
  it('returns the same JSON shape and message on a launch', () => {
    fs.writeFileSync(args.transcriptPath, '{}\n');
    const out = runPreCompactExtract(
      { trigger: 'auto', session_id: SID, transcript_path: args.transcriptPath },
      dir,
      { now: () => 1_800_000_000_000, extract: { spawnHidden: fakeSpawn, opcDir, logPath: path.join(dir, 'pce.log') } },
    );
    expect(out).toEqual({
      continue: true,
      systemMessage: '[PreCompact:L0] Memory extraction launched (background)',
    });
    expect(spawnCalls[0].argv).toContain('--session-id');
  });
});

describe('default log path', () => {
  it('is under the home folder and honours the env override', () => {
    const saved = process.env.CCV3_PRE_COMPACT_EXTRACT_LOG;
    try {
      delete process.env.CCV3_PRE_COMPACT_EXTRACT_LOG;
      expect(defaultExtractLogPath()).toBe(
        path.join(os.homedir(), '.claude', 'logs', 'pre-compact-extract.log'),
      );
      process.env.CCV3_PRE_COMPACT_EXTRACT_LOG = path.join(dir, 'x.log');
      expect(defaultExtractLogPath()).toBe(path.join(dir, 'x.log'));
    } finally {
      if (saved === undefined) delete process.env.CCV3_PRE_COMPACT_EXTRACT_LOG;
      else process.env.CCV3_PRE_COMPACT_EXTRACT_LOG = saved;
    }
  });
});
