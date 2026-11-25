/**
 * decision-gate on the shared parser (card coord-guard-shell-parser, PR B): RED row for the round 3 limit at decision-gate.ts:2725.
 *   PB-4  a hard deny found in one folder of a push is lost when a later folder of the same push throws: with enforceAppPush false
 *         the call comes back as a warning and the push runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRegistry } from '../shared/tap-scope.js';
import { handle, type Deps } from '../decision-gate.js';

const HEAD = 'a'.repeat(40);
let scratch = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_GUARD_DECISIONS_LOG'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dg-pb4-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = `${scratch}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

const APP = '/work/app-x';
const URL = 'https://github.com/acme/app-x.git';
const REGISTRY = JSON.stringify({ projects: [{ key: 'app-x', path: APP }] });
/** enforce on, enforceAppPush the literal false: a soft deny of an app push comes back as a warning. */
const OFF = JSON.stringify({ decisions: { enforce: true, enforcePush: false, enforceAppPush: false } });

/** /work/app-x has remote up and remote.up.mirror true (a hard deny, push-unsafe). /gone throws on every git call. */
function deps(): Deps {
  return {
    env: { ...process.env },
    home: '/home/tester',
    readFile: (p) => (p.replace(/\\/g, '/') === '/home/tester/continuous-claude/review-router.config.json' ? OFF : null),
    git: (cwd, args) => {
      const a = args.join(' ');
      const dir = cwd.replace(/\\/g, '/');
      if (dir === '/gone') throw new Error('spawnSync git ETIMEDOUT');
      if (dir !== APP) return { status: 128, stdout: '' };
      const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
      if (a === 'remote -v') return ok(`up\t${URL} (fetch)\nup\t${URL} (push)`);
      if (a === 'remote') return ok('up');
      if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${APP}\n${APP}/.git`);
      if (/^remote get-url (?:--push )?(?:--all )?(?:--end-of-options )?up$/.test(a)) return ok(URL);
      if (a.startsWith('config --get-regexp ')) return ok('remote.up.mirror true');
      if (a === 'branch --show-current') return ok('feat');
      if (a === 'rev-parse HEAD') return ok(HEAD);
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => readRegistry({ path: '/reg/project-registry.json', deps: { readFile: () => REGISTRY, realpath: (p) => p } }),
      realpath: (p) => p,
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };
}
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: APP, session_id: 's-pb4' });
const out = (input: object): { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } =>
  JSON.parse(handle(JSON.stringify(input), deps())).hookSpecificOutput ?? {};

describe('PB-4: a hard deny found in one folder survives a throw in a later folder', () => {
  it('PB-4a (control): the mirror push alone is a hard deny with enforceAppPush false', () => {
    expect(out(bash('git push up feat')).permissionDecision).toBe('deny');
  });
  it('PB-4 (limit :2725): the mirror push, then a push in a folder whose git throws, is still a deny', () => {
    // Breaks when: judgePushAt keeps no deny found before the throw, so the outer catch sees only the throw and enforceAppPush false warns.
    // The limit text: one push, judged in each folder of its cd chain (the app folder first, then the folder whose git throws).
    for (const c of ['cd /work/app-x; cd /gone; git push up feat', 'cd /work/app-x && cd /gone && git push up feat']) {
      const o = out(bash(c));
      expect(o.permissionDecision, c).toBe('deny');
      expect(o.permissionDecisionReason, c).not.toMatch(/could not verify/);
    }
  });
});
