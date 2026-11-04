import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_PATH = join(tmpdir(), 'ccv3-hook-state.json');

export function readState(): Record<string, unknown> {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(next: Record<string, unknown>): void {
  writeFileSync(STATE_PATH, JSON.stringify({ ...readState(), ...next }));
}

export function resetState(): void {
  writeFileSync(STATE_PATH, '{}');
}
