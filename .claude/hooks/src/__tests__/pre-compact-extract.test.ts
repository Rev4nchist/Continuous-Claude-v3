/**
 * B9: pre-compact-extract keeps extraction state per session.
 *
 * `last_extracted_line` is a line index into ONE transcript. Before B9 one flat
 * state file served every session in the project, so a second session started
 * at the first session's line and skipped its own early thinking blocks. The
 * cooldown was project wide, and `last_launched` was stamped before the launch
 * even when the launch failed.
 *
 * These tests call the real runPreCompactExtract with a fake launcher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPreCompactExtract, type LaunchArgs } from '../pre-compact-extract.js';
import { MAX_SESSIONS, parseState, withLaunchStamp } from '../shared/extraction-state.js';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const COOLDOWN_MS = 5 * 60 * 1000;
const T0 = 1_800_000_000_000;

let projectDir: string;
let transcript: string;
let stateFile: string;
let launches: LaunchArgs[];

const ok = (a: LaunchArgs) => { launches.push(a); return true; };
const fail = (a: LaunchArgs) => { launches.push(a); return false; };

function run(sid: string, opts: { launcher?: (a: LaunchArgs) => boolean; now?: number } = {}) {
  return runPreCompactExtract(
    { trigger: 'auto', session_id: sid, transcript_path: transcript },
    projectDir,
    { launcher: opts.launcher ?? ok, now: () => opts.now ?? T0 },
  );
}

function readState(): any {
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

function seed(state: unknown): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-extract-'));
  transcript = path.join(projectDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  stateFile = path.join(projectDir, '.claude', 'extraction-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  launches = [];
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('start line is per session', () => {
  it('a second session starts at line 0 and does not inherit the first session line', () => {
    seed({ version: 2, sessions: { [A]: { last_extracted_line: 120 } } });
    run(B, { now: T0 });
    expect(launches).toHaveLength(1);
    expect(launches[0].startLine).toBe(0);
  });

  it('the same session resumes from its own saved line', () => {
    seed({ version: 2, sessions: { [A]: { last_extracted_line: 120 }, [B]: { last_extracted_line: 7 } } });
    run(A, { now: T0 });
    expect(launches[0].startLine).toBe(120);
  });

  it('old flat shape: the session named in the file keeps its line, any other starts at 0', () => {
    seed({ session_id: A, last_extracted_line: 40, recent_hashes: ['h1'], last_extraction_time: 'x' });
    run(B, { now: T0 });
    expect(launches[0].startLine).toBe(0);

    launches = [];
    seed({ session_id: A, last_extracted_line: 40, recent_hashes: ['h1'], last_extraction_time: 'x' });
    run(A, { now: T0 });
    expect(launches[0].startLine).toBe(40);
  });

  it('old flat shape without a session id starts every session at 0 and does not throw', () => {
    seed({ last_extracted_line: 99, recent_hashes: [], last_launched: T0 - 10 * COOLDOWN_MS });
    expect(() => run(A, { now: T0 })).not.toThrow();
    expect(launches[0].startLine).toBe(0);
  });

  it('an empty or corrupt state file starts at line 0 and does not throw', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '');
    expect(() => run(A, { now: T0 })).not.toThrow();
    expect(launches[0].startLine).toBe(0);
  });
});

describe('cooldown is per session', () => {
  it('session A is in cooldown after its launch, session B is not', () => {
    run(A, { now: T0 });
    expect(launches).toHaveLength(1);

    const again = run(A, { now: T0 + 1000 });
    expect(again.systemMessage).toContain('Cooldown');
    expect(launches).toHaveLength(1);

    const other = run(B, { now: T0 + 1000 });
    expect(other.systemMessage).not.toContain('Cooldown');
    expect(launches).toHaveLength(2);
    expect(launches[1].sessionId).toBe(B);
  });

  it('session A launches again once its own cooldown has passed', () => {
    run(A, { now: T0 });
    run(A, { now: T0 + COOLDOWN_MS + 1 });
    expect(launches).toHaveLength(2);
  });
});

describe('stamp only after a successful launch', () => {
  it('a failed launch writes no last_launched and starts no cooldown', () => {
    const out = run(A, { launcher: fail, now: T0 });
    expect(out.systemMessage).toContain('unavailable');
    // Shape independent: no last_launched anywhere in the file.
    const raw = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf-8') : '';
    expect(raw).not.toContain('last_launched');

    const retry = run(A, { now: T0 + 1000 });
    expect(retry.systemMessage).not.toContain('Cooldown');
    expect(launches).toHaveLength(2);
  });

  it('a successful launch stamps last_launched for that session only', () => {
    seed({ version: 2, sessions: { [B]: { last_extracted_line: 7, last_launched: T0 - 1 } } });
    run(A, { now: T0 });
    const st = readState();
    expect(st.sessions[A].last_launched).toBe(T0);
    expect(st.sessions[B]).toEqual({ last_extracted_line: 7, last_launched: T0 - 1 });
  });

  it('the stamp keeps the session saved line and the shared hashes', () => {
    seed({ version: 2, recent_hashes: ['h1', 'h2'], sessions: { [A]: { last_extracted_line: 120 } } });
    run(A, { now: T0 });
    const st = readState();
    expect(st.sessions[A].last_extracted_line).toBe(120);
    expect(st.recent_hashes).toEqual(['h1', 'h2']);
  });

  it('the stamp migrates an old flat file without losing the old session line or hashes', () => {
    seed({ session_id: A, last_extracted_line: 40, recent_hashes: ['h1'], last_extraction_time: 'x' });
    run(B, { now: T0 });
    const st = readState();
    expect(st.sessions[A].last_extracted_line).toBe(40);
    expect(st.sessions[B].last_launched).toBe(T0);
    expect(st.recent_hashes).toEqual(['h1']);
  });
});

describe('session map limits', () => {
  it('prunes to MAX_SESSIONS, drops the oldest and keeps the session being stamped', () => {
    const sessions: Record<string, { last_launched: number }> = {};
    for (let i = 0; i < MAX_SESSIONS + 10; i++) sessions[`s${i}`] = { last_launched: 1000 + i };
    const next = withLaunchStamp(parseState(JSON.stringify({ version: 2, sessions })), 's0', T0);
    expect(Object.keys(next.sessions)).toHaveLength(MAX_SESSIONS);
    expect(next.sessions['s0'].last_launched).toBe(T0);
    expect(next.sessions['s1']).toBeUndefined();
  });

  it('treats a session id of __proto__ as a plain key', () => {
    const next = withLaunchStamp(parseState(null), '__proto__', T0);
    expect(Object.keys(next.sessions)).toEqual(['__proto__']);
    expect(({} as any).last_launched).toBeUndefined();
  });
});

describe('no transcript', () => {
  it('does not launch and does not touch state', () => {
    const out = runPreCompactExtract(
      { trigger: 'auto', session_id: A, transcript_path: path.join(projectDir, 'missing.jsonl') },
      projectDir,
      { launcher: ok, now: () => T0 },
    );
    expect(out.systemMessage).toContain('No transcript');
    expect(launches).toHaveLength(0);
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});
