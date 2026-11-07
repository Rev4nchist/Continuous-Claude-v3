import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The script is plain .mjs with no types. Load it by a variable path so tsc does not need a declaration.
const scriptPath = '../../scripts/normalize-dist-paths.mjs';
const load = async (): Promise<{ normalizeDistText: (t: string) => string; normalizeDistDir: (d: string) => string[] }> => import(scriptPath);

const PRIMARY = [
  '// node_modules/postgres-array/index.js',
  'var require_postgres_array = __commonJS({',
  '  "node_modules/postgres-array/index.js"(exports) {',
  '    "use strict";',
  '  }',
  '});',
].join('\n');

const VIA_STORE = PRIMARY.replace(/node_modules\//g, '../../../node_modules/');

describe('normalize-dist-paths', () => {
  it('rewrites the esbuild comment and the module key from the store-link form to the primary form', async () => {
    const { normalizeDistText } = await load();
    expect(VIA_STORE).not.toBe(PRIMARY);
    expect(normalizeDistText(VIA_STORE)).toBe(PRIMARY);
  });

  it('leaves the primary form alone (idempotent)', async () => {
    const { normalizeDistText } = await load();
    expect(normalizeDistText(PRIMARY)).toBe(PRIMARY);
    expect(normalizeDistText(normalizeDistText(VIA_STORE))).toBe(PRIMARY);
  });

  it('does not touch a ../node_modules string that is real code', async () => {
    const { normalizeDistText } = await load();
    const code = 'const p = join(here, "../../node_modules/x");\nconsole.log("// ../node_modules/not-a-comment");';
    expect(normalizeDistText(code)).toBe(code);
  });

  it('rewrites every .mjs in a folder, skips other files, and reports what changed', async () => {
    const { normalizeDistDir } = await load();
    const dir = mkdtempSync(join(tmpdir(), 'normdist-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), VIA_STORE);
      writeFileSync(join(dir, 'b.mjs'), PRIMARY);
      writeFileSync(join(dir, 'c.json'), VIA_STORE);
      expect(normalizeDistDir(dir)).toEqual(['a.mjs']);
      expect(readFileSync(join(dir, 'a.mjs'), 'utf8')).toBe(PRIMARY);
      expect(readFileSync(join(dir, 'c.json'), 'utf8')).toBe(VIA_STORE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
