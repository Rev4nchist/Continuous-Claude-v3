/**
 * isEngineHost: true only for a hook payload sent by cursor-agent (the review engine).
 * Seat ruling C1: exact, case-sensitive event names; no env signals. Seat ruling 2 (card
 * engine-run-hook-silence-2): 'preToolUse' is in the set by convention, not measured.
 *
 * How the helper can fail, one test each (the source change that breaks it):
 *  1. a measured cursor-agent name gives false -> the name is dropped from the set (engine run voided again)
 *  2. the Claude Code PascalCase name gives true -> a case-insensitive compare
 *  3. 'preToolUse' (by convention) gives false -> the name is dropped from the set
 *  4. null, missing, undefined or non-object input throws or gives true -> no type guard
 *  5. a non-string event gives true -> String() coercion of the event
 *  6. an Object.prototype key gives true -> an object-literal lookup instead of a Set
 *  7. a name with extra characters gives true -> a substring or unanchored regex match
 *  8. an env variable alone gives true -> CURSOR_INVOKED_AS or CCV3_BASH_GUARD read from process.env
 *  9. a throwing getter on the payload escapes -> no try/catch around the read
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isEngineHost } from '../shared/engine-host.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isEngineHost', () => {
  it.each(['sessionStart', 'postToolUse', 'sessionEnd'])('measured cursor-agent name %s gives true', (name) => {
    expect(isEngineHost({ hook_event_name: name })).toBe(true);
  });

  it.each(['SessionStart', 'PostToolUse', 'SessionEnd', 'PreToolUse', 'UserPromptSubmit', 'Stop', 'posttooluse', 'POSTTOOLUSE'])(
    'Claude Code or other-case name %s gives false',
    (name) => {
      expect(isEngineHost({ hook_event_name: name })).toBe(false);
    },
  );

  it('preToolUse gives true: in the set by convention (not measured; Claude Code sends PascalCase only)', () => {
    expect(isEngineHost({ hook_event_name: 'preToolUse' })).toBe(true);
  });

  it.each([
    ['undefined input', undefined],
    ['null input', null],
    ['string input', 'postToolUse'],
    ['number input', 42],
    ['empty object', {}],
    ['null event', { hook_event_name: null }],
    ['empty event', { hook_event_name: '' }],
  ])('%s gives false and does not throw', (_label, input) => {
    expect(() => isEngineHost(input)).not.toThrow();
    expect(isEngineHost(input)).toBe(false);
  });

  it.each([
    ['array', ['postToolUse']],
    ['object with toString', { toString: () => 'postToolUse' }],
    ['number', 1],
  ])('a non-string event (%s) gives false', (_label, event) => {
    expect(isEngineHost({ hook_event_name: event })).toBe(false);
  });

  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty'])('prototype key %s gives false', (name) => {
    expect(isEngineHost({ hook_event_name: name })).toBe(false);
  });

  it.each(['postToolUse ', ' postToolUse', 'xpostToolUse', 'postToolUseX', 'postToolUse\n'])(
    'name with extra characters %j gives false',
    (name) => {
      expect(isEngineHost({ hook_event_name: name })).toBe(false);
    },
  );

  it('env signals alone give false (seat ruling: no env signal until the probe proves one)', () => {
    vi.stubEnv('CURSOR_INVOKED_AS', 'cursor-agent');
    vi.stubEnv('CCV3_BASH_GUARD', '1');
    expect(isEngineHost({ hook_event_name: 'PostToolUse' })).toBe(false);
    expect(isEngineHost(undefined)).toBe(false);
    expect(isEngineHost({})).toBe(false);
  });

  it('a throwing getter on the payload gives false and does not throw', () => {
    const input = {
      get hook_event_name(): string {
        throw new Error('boom');
      },
    };
    expect(() => isEngineHost(input)).not.toThrow();
    expect(isEngineHost(input)).toBe(false);
  });
});
