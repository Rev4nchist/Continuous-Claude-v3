import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isMsysCrash, redactCommand, responseText, rotateIfNeeded } from '../msys-crash-capture';

// The real signature, with the Windows path elided. The path is irrelevant to
// detection and a literal one only invites the backslash-escaping bug that
// silently corrupted the hook's own census during development.
const REAL_CRASH =
  '      0 [main] bash (28696) bash.exe: *** fatal error - add_item ("/", ...) failed, errno 1';

describe('responseText - the shape is not stable, so never miss stderr', () => {
  it('takes a bare string', () => {
    expect(responseText('boom')).toBe('boom');
  });

  it('reads .output, .stdout and .stderr', () => {
    expect(responseText({ stdout: 'out', stderr: 'err' })).toContain('out');
    expect(responseText({ stdout: 'out', stderr: 'err' })).toContain('err');
    expect(responseText({ output: 'o' })).toBe('o');
  });

  it('falls back to stringify so an unknown shape still yields searchable text', () => {
    // The case that matters: if the harness renames the field, the hook must
    // still see the signature rather than silently recording ok:1.
    expect(responseText({ weird_future_field: REAL_CRASH })).toContain('add_item');
  });

  it('never throws on null or a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => responseText(circular)).not.toThrow();
    expect(responseText(null)).toBe('');
  });
});

describe('isMsysCrash', () => {
  it('detects a real MSYS init failure', () => {
    expect(isMsysCrash(REAL_CRASH, 'grep -rn foo src/')).toBe(true);
  });

  it('detects the other documented signatures', () => {
    expect(isMsysCrash('cygheap base mismatch detected', 'ls')).toBe(true);
    expect(isMsysCrash('unable to remap something', 'ls')).toBe(true);
  });

  it('ignores ordinary failures', () => {
    expect(isMsysCrash('command not found', 'frobnicate')).toBe(false);
    expect(isMsysCrash('', 'ls')).toBe(false);
  });

  it('REFUSES to count a command that is READING crash text as a crash', () => {
    // The tldr investigation shipped four false "proof of injection" hits by
    // COUNTING grep matches instead of classifying them. Same trap, guarded:
    // reading the log must never manufacture a new event in the log.
    expect(isMsysCrash(REAL_CRASH, 'grep add_item ~/.claude/logs/msys-events.jsonl')).toBe(false);
    expect(isMsysCrash(REAL_CRASH, 'cat .claude/rules/windows-platform.md')).toBe(false);
    expect(isMsysCrash(REAL_CRASH, 'tail msys-crash.jsonl')).toBe(false);
  });
});

describe('redactCommand', () => {
  it('redacts secrets rather than logging them', () => {
    expect(redactCommand('curl -H "api_key=abc123"')).toContain('<redacted>');
    expect(redactCommand('curl -H "api_key=abc123"')).not.toContain('abc123');
    expect(redactCommand('export TOKEN=sk-live-xyz')).not.toContain('sk-live-xyz');
  });

  it('collapses whitespace and caps length', () => {
    expect(redactCommand('a'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(redactCommand('a\n\n  b')).toBe('a b');
  });

  it('handles empty input', () => {
    expect(redactCommand('')).toBe('');
  });
});

describe('rotateIfNeeded - the log carries a denominator, so it grows fast', () => {
  const tmp = join(tmpdir(), `msys-rot-${process.pid}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => { mkdirSync(tmp, { recursive: true }); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('leaves a small file alone', () => {
    const f = join(tmp, 'events.jsonl');
    writeFileSync(f, 'x'.repeat(100));
    expect(rotateIfNeeded(f, 1000)).toBe(false);
    expect(existsSync(f + '.1')).toBe(false);
  });

  it('rotates once the file reaches the cap, keeping one generation', () => {
    const f = join(tmp, 'events.jsonl');
    writeFileSync(f, 'x'.repeat(1000));
    expect(rotateIfNeeded(f, 1000)).toBe(true);
    expect(existsSync(f)).toBe(false);      // fresh file starts on next append
    expect(existsSync(f + '.1')).toBe(true); // previous generation retained
  });

  it('never throws when the file does not exist', () => {
    // A hook must not break a tool call because telemetry had nothing to rotate.
    expect(() => rotateIfNeeded(join(tmp, 'nope.jsonl'), 10)).not.toThrow();
    expect(rotateIfNeeded(join(tmp, 'nope.jsonl'), 10)).toBe(false);
  });
});
