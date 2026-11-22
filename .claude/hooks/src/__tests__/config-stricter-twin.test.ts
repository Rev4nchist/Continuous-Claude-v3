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
import { stricterConfig, viewOf } from '../shared/config-stricter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CASES = JSON.parse(readFileSync(join(REPO, 'scripts', 'github', 'fixtures', 'stricter-config-cases.json'), 'utf8')).rows as Array<{
  id: string; name: string; main: unknown; branch: unknown; expect: unknown;
}>;

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

