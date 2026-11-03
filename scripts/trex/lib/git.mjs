// The git function every TREX module uses: (args) => {status, stdout, stderr}.
// It differs from pre-pr makeGit in one way: the child gets stripEnv(process.env), so no Anthropic key
// or Claude Code session variable reaches a git child (hooks and aliases run inside it).

import { spawnSync } from 'node:child_process';
import { stripEnv } from './strip-env.mjs';

/** deps: { spawn } for tests. */
export function makeTrexGit(root, { spawn = spawnSync } = {}) {
  return (args) => {
    const r = spawn('git', args, {
      cwd: root, encoding: 'utf8', windowsHide: true, env: stripEnv(process.env), maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}
