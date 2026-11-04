import { beforeEach, expect, it } from 'vitest';
import { readState, resetState, writeState } from './state-file';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetState();
});

it('records the last hook that ran', async () => {
  writeState({ lastHook: 'pre-pr' });
  await sleep(200);
  expect(readState().lastHook).toBe('pre-pr');
});
