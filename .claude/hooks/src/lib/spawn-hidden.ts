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
 * A caller's 'error' listener sees only relay failures. When the real command cannot
 * start (missing exe, access denied), the relay writes the reason to its stderr and
 * appends it to RELAY_ERROR_LOG (override: CCV3_SPAWN_HIDDEN_LOG), then exits 127.
 *
 * Other platforms: a plain detached spawn, unchanged.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

/** Where the relay records commands it could not start. */
export const RELAY_ERROR_LOG = join(tmpdir(), 'ccv3-spawn-hidden.log');

/** Exit code of the relay when the real command cannot start. */
export const RELAY_LAUNCH_FAILED = 127;

/** Relay body for `node -e`. argv after `--` is the real command and its args. */
export const RELAY_SCRIPT =
  "const{spawn}=require('child_process');" +
  'const[c,...a]=process.argv.slice(1);' +
  "const p=spawn(c,a,{stdio:'inherit',windowsHide:true});" +
  "p.on('error',(e)=>{" +
  "const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';" +
  'try{process.stderr.write(m)}catch{}' +
  "try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||" +
  "require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}" +
  `process.exit(${RELAY_LAUNCH_FAILED})});` +
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
