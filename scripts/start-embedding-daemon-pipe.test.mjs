// Probe: start-embedding-daemon.ps1 must not hold the caller's stdout pipe open through the daemon it spawns.
// Failure mode: the spawned daemon inherits the caller's pipe, so a reader that waits for EOF
// (`script | cat`, a hook with stdio pipes) hangs until the daemon exits, which is never.
// Safe: a temp HOME, a temp repo root, and a stub `uv.exe` that only sleeps. The live daemon and DB are not touched.
// Run: node --test scripts/start-embedding-daemon-pipe.test.mjs   (Windows only)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'start-embedding-daemon.ps1');
const STUB_SLEEP_MS = 30000; // the stub dies by itself if the test cannot kill it
const PIPE_WAIT_MS = 10000;  // a healthy run closes the pipe in a few seconds

const STUB_SOURCE = `
using System; using System.IO; using System.Threading; using System.Diagnostics; using System.Runtime.InteropServices;
public static class Stub {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public static void Main(string[] args) {
    // Record whether this process owns a console window. The real daemon (uv, then python) inherits the same console.
    IntPtr h = GetConsoleWindow();
    File.WriteAllText(Environment.GetEnvironmentVariable("STUB_MARKER"),
      Process.GetCurrentProcess().Id + "|" + string.Join(" ", args) + "|hwnd=" + h.ToInt64() + "|visible=" + (h != IntPtr.Zero && IsWindowVisible(h)));
    Thread.Sleep(${STUB_SLEEP_MS});
  }
}`;

// Build the stub with Windows PowerShell 5.1 (Add-Type -OutputAssembly is not in pwsh 7).
function buildStub(exePath) {
  const ps = `Add-Type -TypeDefinition @'\n${STUB_SOURCE}\n'@ -OutputAssembly '${exePath}' -OutputType ConsoleApplication`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stub build failed: ${r.stderr}${r.stdout}`);
}

function killQuietly(pid) { try { process.kill(pid); } catch { /* already gone */ } }

test('a piped call returns: the spawned daemon does not hold the caller pipe open', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-pipe-'));
  // TerminateProcess can return before the stub releases bin\uv.exe: retry the delete on EBUSY.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const marker = path.join(root, 'stub-marker.txt');
  for (const d of [home, bin, path.join(repo, 'opc', 'scripts', 'core')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'opc', 'scripts', 'core', 'embedding_daemon.py'), '# stub\n');
  buildStub(path.join(bin, 'uv.exe'));

  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/\\$/, ''), HOMEPATH: home.slice(2),
    CLAUDE_PROJECT_DIR: repo,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    STUB_MARKER: marker,
  };
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });

  // 'close' fires only when every holder of the stdout pipe has closed it: the same wait as `| cat`.
  const outcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('HUNG'), PIPE_WAIT_MS);
    child.on('close', () => { clearTimeout(t); resolve('RETURNED'); });
  });

  // The stub may start a moment after the script exits: wait for its marker before judging.
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  const stubPid = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8').split('|')[0]) : null;
  if (stubPid) killQuietly(stubPid);
  if (outcome === 'HUNG') killQuietly(child.pid);

  assert.ok(stubPid, `the stub daemon never started, so this run proves nothing. script output:\n${out}`);
  assert.match(fs.readFileSync(marker, 'utf8'), /run --project opc python opc\/scripts\/core\/embedding_daemon\.py --daemon/);
  assert.match(out, /Daemon spawned \(pid=\d+\)/);
  // CreateNoWindow gives the daemon a console with no window (hwnd=0). A ShellExecute spawn gives it a new console
  // whose window can show or take focus (the focus-stealing popups in memory windows-detached-spawn-popups.md).
  assert.match(fs.readFileSync(marker, 'utf8'), /\|hwnd=0\|visible=False$/, 'the daemon got a console window: it can pop up and steal focus');
  assert.equal(outcome, 'RETURNED', `the piped caller still waited for EOF after ${PIPE_WAIT_MS} ms: the daemon holds the pipe`);
});
