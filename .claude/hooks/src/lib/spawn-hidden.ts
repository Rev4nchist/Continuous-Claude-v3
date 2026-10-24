/**
 * Start a fire-and-forget background command without a console window popping up.
 *
 * Why a plain `spawn(cmd, args, { detached: true, windowsHide: true })` is not enough
 * on Windows: `detached` sets DETACHED_PROCESS, and Windows ignores CREATE_NO_WINDOW
 * (what `windowsHide` sets) in that case. The child runs with no console at all.
 * Every console program the child then starts (uv -> python, tldr.exe -> python)
 * gets a NEW, VISIBLE console window that takes keyboard focus.
 *
 * Fix: start a small detached Node relay. The relay starts the real command with
 * `windowsHide: true` and no `detached`, so the command gets a hidden console that
 * its own children share. The relay waits for the command to exit, because a
 * non-detached child is killed when its parent exits (libuv job object).
 * Measured 2026-10-24: detached python -> python shows a visible window; through
 * this relay it does not (`.claude/cache/e2e/2026-10-24-spawn-hidden.txt`).
 *
 * Other platforms: a plain detached spawn, unchanged.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

/** Relay body for `node -e`. argv after `--` is the real command and its args. */
export const RELAY_SCRIPT =
  "const{spawn}=require('child_process');" +
  'const[c,...a]=process.argv.slice(1);' +
  "const p=spawn(c,a,{stdio:'inherit',windowsHide:true});" +
  "p.on('error',()=>process.exit(1));" +
  "p.on('exit',(code)=>process.exit(code??1));";

type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

export function spawnDetachedHidden(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions = {},
  spawnFn: SpawnFn = spawn,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const opts: SpawnOptions = { ...options, detached: true, windowsHide: true };
  if (platform !== 'win32') return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ['-e', RELAY_SCRIPT, '--', cmd, ...args], opts);
}
