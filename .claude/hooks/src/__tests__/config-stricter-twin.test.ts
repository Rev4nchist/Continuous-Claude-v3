/**
 * A7 (coord-cap-override PR A): the TypeScript twin (shared/config-stricter.ts) and the .mjs helper (scripts/github/config-stricter.mjs)
 * give one answer on every row of scripts/github/fixtures/stricter-config-cases.json. The test fails when the two copies differ.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore TS7016: config-stricter.mjs has no declaration file. The REAL .mjs twin: A7 compares the two copies.
import * as mjs from '../../../../scripts/github/config-stricter.mjs';
import { mainConfigOf, stricterConfig, viewOf } from '../shared/config-stricter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CASES = JSON.parse(readFileSync(join(REPO, 'scripts', 'github', 'fixtures', 'stricter-config-cases.json'), 'utf8')).rows as Array<{
  id: string; name: string; main: unknown; branch: unknown; expect: unknown;
}>;

// The git-read side: the same stub git for both copies. The ref state and the texts cover the fail-closed rules (CLI findings 1 to 3).
const GOOD_TRUE = JSON.stringify({ checkpoint: { enforce: true } });
const GOOD_FALSE = JSON.stringify({ checkpoint: { enforce: false } });
const READS: Array<{ name: string; fork: string | 'absent' | 'fails'; local: string | 'absent' | 'fails'; throws?: boolean; exit128?: boolean }> = [
  { name: 'fork good, local loose', fork: GOOD_TRUE, local: GOOD_FALSE },
  { name: 'fork absent, local good', fork: 'absent', local: GOOD_TRUE },
  { name: 'fork absent, local absent', fork: 'absent', local: 'absent' },
  { name: 'fork bad JSON, local loose', fork: '{not json', local: GOOD_FALSE },
  { name: 'fork show fails, local loose', fork: 'fails', local: GOOD_FALSE },
  { name: 'fork array, local loose', fork: '[]', local: GOOD_FALSE },
  { name: 'fork absent, local bad JSON', fork: 'absent', local: '{not json' },
  { name: 'existence check exits 128', fork: GOOD_TRUE, local: GOOD_TRUE, exit128: true },
  { name: 'git throws', fork: GOOD_TRUE, local: GOOD_TRUE, throws: true },
];
const FORK_REF = 'refs/remotes/fork/main';
const LOCAL_REF = 'refs/heads/main';

describe('A7b: the git-read side of the twin and of the .mjs helper agree on every ref state', () => {
  for (const r of READS) {
    it(r.name, () => {
      const stub = (args: string[]) => {
        if (r.throws) throw new Error('spawn git ENOENT');
        const key = args.join(' ');
        const state = (ref: string) => (ref === FORK_REF ? r.fork : r.local);
        for (const ref of [FORK_REF, LOCAL_REF]) {
          if (key === `rev-parse --verify --quiet ${ref}`) return r.exit128 && ref === FORK_REF ? { status: 128, stdout: '' } : { status: state(ref) === 'absent' ? 1 : 0, stdout: '' };
          if (key === `show ${ref}:review-router.config.json`) return state(ref) === 'fails' ? { status: 128, stdout: '' } : { status: 0, stdout: state(ref) };
        }
        return { status: 1, stdout: '' };
      };
      const branch = { checkpoint: { enforce: false }, coderabbit: { cli_daily_cap_usd: 7 }, pre_pr: { summary_mode: 'note' } };
      const twin = viewOf(stricterConfig(mainConfigOf('/w', (_cwd, args) => stub(args)), branch));
      const helper = mjs.viewOf(mjs.stricterConfig(mjs.readMainConfig({ git: stub }).config, branch));
      expect(twin).toEqual(helper);
    });
  }
});

describe('A7: the TypeScript twin and the .mjs helper give one answer on every fixture row', () => {
  for (const row of CASES) {
    it(`${row.id}: ${row.name}`, () => {
      const twin = stricterConfig(row.main, row.branch);
      expect(viewOf(twin)).toEqual(row.expect);
      expect(viewOf(twin)).toEqual(mjs.viewOf(mjs.stricterConfig(row.main, row.branch)));
      expect(twin).toEqual(mjs.stricterConfig(row.main, row.branch));
    });
  }
});

