// Probes refuse a database that is not a scratch database (rule O3.9, gap 12, lane coord-probe-scratch-guard).
//
// Ways this can fail, one test each:
//   T1  a probe with a guard on the env URL loses it, or runs it after its first connection: it does not exit 2 with the refusal line.
//   T2  a probe under scripts/ names a database URL, docker exec or psql and has no scratch check at all (a new probe added with none).
//   T3  a probe sends SQL to the live database by its fixed name (psql -d continuous_claude), so the env URL guard cannot protect it.
//
// T1 never reaches a database: the URL names the live database but points at port 1, where nothing listens.
// So a probe with no guard fails T1 by its exit code or its text, and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DEAD_LIVE = 'postgresql://x:y@127.0.0.1:1/continuous_claude';

// The nine probes of gap 12. Each refuses a live name before it connects, runs psql or starts a child process.
const GUARDED = [
  'claim-sql', 'dm-delivery', 'session-autoname', 'session-identity',
  'lease', 'load', 'degradation', 'event-recording', 'session-lifecycle',
];

const env = () => {
  const e = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: DEAD_LIVE };
  delete e.DATABASE_URL;
  delete e.OPC_POSTGRES_URL;
  return e;
};

for (const name of GUARDED) {
  test(`T1 ${name}-probe refuses a database that is not a scratch database, exit 2, before any connection`, () => {
    // Breaks when: the guard is removed, or it runs after the first connection (then the dead port gives another exit and text).
    const r = spawnSync(process.execPath, [join(HERE, `${name}-probe.mjs`)], { env: env(), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${name}-probe: refusing to run: database 'continuous_claude' is not a scratch database`));
    assert.doesNotMatch(r.stdout, /PASS|FAIL/, 'no check ran');
  });
}

/** Every *-probe.mjs under scripts/, found by a walk, not a hand list. */
function probeFiles() {
  return readdirSync(join(REPO, 'scripts'), { recursive: true })
    .map(String)
    .filter((p) => /(^|[\\/])[^\\/]*-probe\.mjs$/.test(p))
    .map((p) => join(REPO, 'scripts', p));
}

// Real access only: an env URL read, or docker exec called with an argument list. A command string that a probe feeds to a hook
// as test input (scripts/rules/rule-router-probe.mjs) is not access.
const TOUCHES_DB = /process\.env\.(CONTINUOUS_CLAUDE_DB_URL|DATABASE_URL|OPC_POSTGRES_URL)|['"]docker['"]\s*,\s*\[\s*['"]exec['"]/;
const HAS_GUARD = (t) => /\bassertScratchUrl\(/.test(t) || (/\bdbNameOf\(/.test(t) && /lanes_pr1_/.test(t));

test('T2 every probe under scripts/ that names a database URL, docker exec or psql has a scratch check', () => {
  // Breaks when: a probe with database access is added or edited with no assertScratchUrl (or dbNameOf plus the lanes_pr1_ prefix).
  const files = probeFiles();
  assert.ok(files.length >= 17, `the walk found ${files.length} probe files`);
  const missing = files.filter((f) => { const t = readFileSync(f, 'utf8'); return TOUCHES_DB.test(t) && !HAS_GUARD(t); })
    .map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(missing, []);
});

test('T3 no probe under scripts/ sends psql to the live database by its fixed name', () => {
  // Breaks when: a probe passes '-d', 'continuous_claude' to psql in an argument list again.
  const live = probeFiles().filter((f) => /['"]-d['"]\s*,\s*['"]continuous_claude['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(live, []);
});
