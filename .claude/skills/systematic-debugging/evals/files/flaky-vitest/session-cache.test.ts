import { beforeEach, expect, it } from 'vitest';
import { readState, resetState, writeState } from './state-file';

beforeEach(() => {
  resetState();
});

it('counts open sessions', () => {
  writeState({ sessions: 3 });
  expect(readState().sessions).toBe(3);
});

it('starts with no sessions', () => {
  expect(readState().sessions).toBeUndefined();
});
