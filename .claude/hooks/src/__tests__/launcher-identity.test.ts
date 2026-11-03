/**
 * The claude-hud launcher rewrites stdin.session_name as "<name> #<sid8>" and writes nothing.
 *
 * Failure list, one test each:
 *   H1  the launcher writes an identity file (the hooks own it; two writers disagree on name)
 *   H2  a named session does not reach the HUD as "<clipped name> #<sid8>"
 *   H3  an unnamed session does not reach the HUD as "#<sid8>"
 *   H4  a malformed stdin or a non-hex session id is not passed through raw
 *
 * Runs the real launcher against a fake HUD (an index.js that echoes its stdin).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LAUNCHER = fileURLToPath(new URL('../../../plugins/claude-hud/launcher.mjs', import.meta.url));
const UUID = 'abcdef12-aaaa-4bbb-8ccc-222222222222';
let root: string;
let identityDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'launcher-'));
  identityDir = join(root, 'identity');
  const dist = join(root, 'plugins', 'cache', 'claude-hud', 'claude-hud', '1.0.0', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), "process.stdin.pipe(process.stdout);\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function hud(stdin: string): string {
  const r = spawnSync(process.execPath, [LAUNCHER], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: root, CCV3_IDENTITY_DIR: identityDir },
  });
  return r.stdout;
}

describe('claude-hud launcher label', () => {
  it('H1+H2: a named session shows the clipped label and no identity file is written', () => {
    const out = JSON.parse(hud(JSON.stringify({ session_id: UUID, session_name: '  a very   long\nsession name here ' })));
    expect(out.session_name).toBe('a very long sess #abcdef12');
    expect(() => readdirSync(identityDir)).toThrow(); // the folder was never created
  });

  it('H3: an unnamed session shows #sid8', () => {
    expect(JSON.parse(hud(JSON.stringify({ session_id: UUID }))).session_name).toBe('#abcdef12');
  });

  it('H4: malformed JSON and a non-hex session id pass through raw', () => {
    expect(hud('{not json')).toBe('{not json');
    const raw = JSON.stringify({ session_id: 'not-hex-session-id', session_name: 'x' });
    expect(hud(raw)).toBe(raw);
  });
});
