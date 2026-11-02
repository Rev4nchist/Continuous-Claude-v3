// Process-tree helpers shared by pre-pr.mjs and cursor-review.mjs.
// Moved unchanged from pre-pr.mjs so the review engine does not import pre-pr (and review-router, review-status, cr-paid, cr-fix).
import { spawnSync } from 'node:child_process';

/**
 * A lookup from a pid to the pids of its direct children, from CIM through powershell (Windows only). The process table is read
 * once, on the first lookup. It runs only when a review is stopped by its time limit.
 */
export function processChildren() {
  let table = null;
  const load = () => {
    // One CIM call (about 5 s on this machine) lists every pid with its parent pid; the tree is then walked in memory.
    const query = `Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const byParent = new Map();
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const [pid, parent] = line.trim().split(' ').map(Number);
      if (Number.isInteger(pid) && Number.isInteger(parent) && pid > 0) byParent.set(parent, [...(byParent.get(parent) ?? []), pid]);
    }
    return byParent;
  };
  return (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return [];
    table ??= load();
    return table.get(pid) ?? [];
  };
}

/**
 * Stops a process and everything it started, children first. The tree-kill switch of the Windows task killer is forbidden on
 * this machine, so Windows walks the tree through `children` and stops each pid. POSIX kills the process group (the child
 * is spawned detached, so it leads one). A pid that is already gone is ignored.
 */
export function killTree(pid, { platform = process.platform, children = processChildren(), kill = (p) => process.kill(p, 'SIGKILL') } = {}) {
  const stop = (p) => { try { kill(p); } catch { /* already gone */ } };
  if (platform !== 'win32') {
    try { kill(-pid); } catch { stop(pid); }
    return;
  }
  const seen = new Set();
  const walk = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const c of children(p)) walk(c);
    stop(p);
  };
  walk(pid);
}
