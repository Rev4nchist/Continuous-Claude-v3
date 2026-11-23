// Probes refuse a database that is not a scratch database (rule O3.9, gap 12, lane coord-probe-scratch-guard).
//
// Ways this can fail, one test each:
//   T1  a probe with a guard on the env URL loses it, or runs it after its first connection: it does not exit 2 with the refusal line.
//   T2  a probe under scripts/ names a database URL, docker exec or psql and has no scratch check at all (a new probe added with none).
//   T3  a probe sends SQL to the live database by its fixed name (psql -d continuous_claude), so the env URL guard cannot protect it.
//
// T1 never reaches a database. The URL names the live database but points at port 1, where nothing listens: that stops the
// pg-module probes. The five docker-exec probes ignore the URL's host and port, so T1 also runs every probe with a PATH that
// holds only the node folder: docker and psql cannot start (T1c proves it). So a probe with no guard fails T1 by its exit code
// or its text, and writes nothing (aegis and critic on PR 540).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  delete e.DOCKER_HOST;
  delete e.DOCKER_CONTEXT;
  // Windows keeps the key as Path: drop every spelling, then give only the node folder. The probes start hooks by process.execPath.
  for (const k of Object.keys(e)) if (/^path$/i.test(k)) delete e[k];
  e.PATH = dirname(process.execPath);
  return e;
};

test('T1c in the T1 env, docker and psql cannot start', () => {
  // Breaks when: env() keeps a PATH entry with docker or psql in it, so a docker-exec probe with no guard could reach the live container.
  for (const cmd of ['docker', 'psql']) {
    const r = spawnSync(cmd, ['--version'], { env: env(), encoding: 'utf8', timeout: 20_000 });
    assert.ok(r.error?.code === 'ENOENT', `${cmd} started in the T1 env (status ${r.status}): ${r.stdout}${r.stderr}`);
  }
});

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
// Also a direct psql call with an argument list (execFileSync('psql', [...]), spawn('psql', [...])).
const TOUCHES_DB = /process\.env\.(CONTINUOUS_CLAUDE_DB_URL|DATABASE_URL|OPC_POSTGRES_URL)|['"]docker['"]\s*,\s*\[\s*['"]exec['"]|['"]psql(\.exe)?['"]\s*,\s*\[/;
// project-board-probe.mjs guards with dbNameOf plus the lanes_pr1_ prefix (it has an --allow-live flag), not assertScratchUrl.
const HAS_GUARD = (t) => /\bassertScratchUrl\(/.test(t) || (/\bdbNameOf\(/.test(t) && /lanes_pr1_/.test(t));

test('T2 every probe under scripts/ that names a database URL, docker exec or psql has a scratch check', () => {
  // Breaks when: a probe with database access is added or edited with no assertScratchUrl call (or dbNameOf plus the lanes_pr1_ prefix).
  const files = probeFiles();
  assert.ok(files.length >= 17, `the walk found ${files.length} probe files`);
  const missing = files.filter((f) => { const t = readFileSync(f, 'utf8'); return TOUCHES_DB.test(t) && !HAS_GUARD(t); })
    .map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(missing, []);
});

test('T2b the access check sees an env URL read, docker exec and a direct psql call, and not a psql command string fed to a hook', () => {
  // Breaks when: one of the three access forms drops out of TOUCHES_DB (a new probe with that form then passes T2 with no guard),
  // or the check starts to match a command string (scripts/rules/rule-router-probe.mjs would then fail T2).
  for (const src of [
    'const u = process.env.DATABASE_URL;',
    "execFileSync('docker', ['exec', 'pg', 'psql'])",
    "execFileSync('psql', ['-d', 'another_database', '-c', 'select 1'])",
    'spawnSync("psql.exe", ["-c", "x"])',
  ]) assert.match(src, TOUCHES_DB, src);
  assert.doesNotMatch("bash('s13', 'docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c \"SELECT 1\"')", TOUCHES_DB);
});

// The live name as a psql database argument: '-d', 'continuous_claude', '--dbname', 'continuous_claude' or '--dbname=continuous_claude'.
const LIVE_DB_ARG = /['"](-d|--dbname)['"]\s*,\s*['"]continuous_claude['"]|['"]--dbname=continuous_claude['"]/;

test('T3b the live-name check sees -d, --dbname and --dbname= forms', () => {
  // Breaks when: one of the three psql forms drops out of LIVE_DB_ARG, so a probe that writes the live name that way passes T3.
  for (const src of ["['-d', 'continuous_claude']", '["--dbname", "continuous_claude"]', "['--dbname=continuous_claude']"]) assert.match(src, LIVE_DB_ARG, src);
  assert.doesNotMatch("['-d', DB_NAME]", LIVE_DB_ARG);
});

test('T3 no probe under scripts/ sends psql to the live database by its fixed name', () => {
  // Breaks when: a probe passes '-d', 'continuous_claude' to psql in an argument list again.
  const live = probeFiles().filter((f) => LIVE_DB_ARG.test(readFileSync(f, 'utf8')))
    .map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(live, []);
});

// ---- Card coord-probe-scratch-guard-followups: the four follow-ups of PR 540 ----
//   F1  claimKey: one shared copy in canon-home.mjs, equal to the hook's resolveClaimKey, with a preflight (C1 to C4)
//   F2  docker path vs URL host: a docker-exec probe refuses a URL that names another host (L1, L2, T5)
//   F3  the refusal line masks the database name (S1, T4, T4b)
//   F4  CANON and the claim key go into SQL through sqlLit (Q1, Q2, Q3)
const helper = (name) => import(pathToFileURL(join(HERE, name)).href);
const probeText = (name) => readFileSync(join(HERE, `${name}-probe.mjs`), 'utf8');
const DOCKER_PROBES = ['degradation', 'event-recording', 'lease', 'load', 'session-lifecycle'];
// The 14 probes that print the refusal line (PR 540 named nine; five more were added since with the same line).
const REFUSERS = [...GUARDED, 'holder-lane', 'lane-race', 'list-claims-sql', 'portfolio', 'release-one'];

test('C1 claimKey gives the key the hook stores (rows of .claude/hooks/src/__tests__/claim-target.test.ts: 4, 8, 16, harness path, cache)', async () => {
  // Breaks when: the probe copy drifts from resolveClaimKey (.claude/hooks/src/shared/claim-target.ts:131-165): a seeded row no hook ever meets.
  const { claimKey } = await helper('canon-home.mjs');
  const repo = join(tmpdir(), 'ck-repo');
  const at = (...p) => join(repo, ...p);
  assert.equal(claimKey(at('MixedDir', 'File.ts'), { repo, platform: 'win32' }), 'mixeddir/file.ts', 'row 8: win32 folds case');
  assert.equal(claimKey(at('MixedDir', 'File.ts'), { repo, platform: 'darwin' }), 'mixeddir/file.ts', 'row 8: darwin folds case');
  assert.equal(claimKey(at('MixedDir', 'File.ts'), { repo, platform: 'linux' }), 'MixedDir/File.ts', 'row 8: linux keeps case');
  assert.equal(claimKey(at('new', 'deep', 'y.ts'), { repo, platform: 'linux' }), 'new/deep/y.ts', 'row 4: a new file in new folders');
  assert.equal(claimKey(at('..foo', 'x.ts'), { repo, platform: 'linux' }), '..foo/x.ts', 'row 16: a folder named ..foo is a normal folder');
  assert.equal(claimKey(at('.claude', 'hooks', 'src', '__x__.ts'), { repo, platform: 'linux' }), '.claude/hooks/src/__x__.ts', 'a harness path keeps its folders');
});

test('C2 claimKey keys a per-worktree cache file by its absolute path, like the hook (claim-target.ts:149-156)', async () => {
  // Breaks when: a probe seeds a .claude/cache file with the relative key: the hook stores the absolute one and the rows never meet.
  const { claimKey } = await helper('canon-home.mjs');
  const repo = join(tmpdir(), 'ck-repo');
  const abs = join(repo, '.claude', 'cache', 'Z.json');
  assert.equal(claimKey(abs, { repo, platform: 'linux' }), abs.replace(/\\/g, '/'));
  assert.equal(claimKey(abs, { repo, platform: 'win32' }), abs.replace(/\\/g, '/').toLowerCase());
});

test('C3 claimKey is null outside the repo and for the repo itself; assertClaimKey is the preflight that throws', async () => {
  // Breaks when: a path outside the repo gets a key (row 5: the hook returns null), or the preflight lets one through.
  const { claimKey, assertClaimKey } = await helper('canon-home.mjs');
  const repo = join(tmpdir(), 'ck-repo');
  for (const abs of [join(repo, '..', 'other', 'x.ts'), repo, join(tmpdir(), 'elsewhere', 'x.ts')]) {
    assert.equal(claimKey(abs, { repo, platform: 'linux' }), null, abs);
    assert.throws(() => assertClaimKey(abs, { repo, platform: 'linux' }), /claim key/i, abs);
  }
  assert.equal(assertClaimKey(join(repo, 'a', 'b.ts'), { repo, platform: 'linux' }), 'a/b.ts');
});

test('C4 no probe keeps a private claimKey, and the four docker probes import the shared one', () => {
  // Breaks when: a probe defines its own claimKey again (a fifth copy that can drift from the hook).
  const own = probeFiles().filter((f) => /\bconst claimKey\s*=/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(own, []);
  for (const n of ['degradation', 'event-recording', 'lease', 'load']) {
    assert.match(probeText(n), /import\s*\{[^}]*\bassertClaimKey as claimKey\b[^}]*\}\s*from\s*'\.\/canon-home\.mjs'/, n);
  }
});

test('Q1 sqlLit doubles a single quote and leaves a backslash alone (standard_conforming_strings is on)', async () => {
  // Breaks when: sqlLit stops doubling quotes (a home path with a quote breaks the SQL), or escapes a backslash (a Windows key then never matches).
  const { sqlLit } = await helper('canon-home.mjs');
  assert.equal(sqlLit("o'brien"), "o''brien");
  assert.equal(sqlLit("''"), "''''");
  assert.equal(sqlLit(''), '');
  assert.equal(sqlLit('c:\\users\\x'), 'c:\\users\\x');
  assert.equal(sqlLit('plain'), 'plain');
});

test('Q2 canonProject can hold a quote, and the SQL text keeps it as one literal', async () => {
  // Breaks when: CANON is built from the home path and a quote in it is not doubled before it goes into SQL.
  const { canonProject, sqlLit } = await helper('canon-home.mjs');
  const canon = canonProject("C:\\Users\\O'Brien");
  assert.equal(canon, "c:/users/o'brien/continuous-claude");
  assert.equal(`'${sqlLit(canon)}'`, "'c:/users/o''brien/continuous-claude'");
});

test('Q3 no probe puts CANON or a claim key into SQL without sqlLit', () => {
  // Breaks when: a probe interpolates '${CANON}', '${CANONICAL_PROJECT}' or '${claimKey(...)}' inside SQL quotes with no sqlLit.
  const raw = /'\$\{(CANON|CANONICAL_PROJECT|claimKey\([^)]*\))\}'/;
  const bad = probeFiles().filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(bad, []);
  assert.match("'${CANON}'", raw);
  assert.doesNotMatch("'${sqlLit(CANON)}'", raw);
});

test('L1 assertLocalHost accepts localhost, 127.0.0.1, ::1 and [::1], and a host= value only when every one is local', async () => {
  // Breaks when: a local form drops out (a good scratch URL is refused), or a remote host= value rides on a local URL host.
  const { assertLocalHost } = await helper('scratch-db.mjs');
  const u = (host, q = '') => `postgresql://x:y@${host}:5432/lanes_pr1_abcd1234${q}`;
  for (const url of [u('localhost'), u('LOCALHOST'), u('127.0.0.1'), u('[::1]'), u('localhost', '?host=localhost'), u('localhost', '?host=127.0.0.1&host=[::1]')]) {
    assert.doesNotThrow(() => assertLocalHost(url), url);
  }
});

test('L2 assertLocalHost refuses another host, a remote host= or hostaddr=, no host, a parse failure and a host list (fail closed)', async () => {
  // Breaks when: one of these gets through, so a docker-exec probe runs on the local container while the hooks use another server.
  const { assertLocalHost } = await helper('scratch-db.mjs');
  const u = (host, q = '') => `postgresql://x:y@${host}:5432/lanes_pr1_abcd1234${q}`;
  for (const url of [
    u('db.example.com'), u('10.0.0.5'), u('host.docker.internal'), u('0.0.0.0'), u('localhost.example.com'),
    u('localhost', '?host=remote.example'), u('localhost', '?host=localhost&host=remote.example'), u('localhost', '?hostaddr=10.0.0.5'),
    u('localhost', '?HOST=remote.example'), u('localhost', '?ho%73t=remote.example'),
    'postgresql:///lanes_pr1_abcd1234', 'postgresql://x:y@localhost:notaport/lanes_pr1_abcd1234', 'not a url', '',
    'postgresql://localhost,remote.example/lanes_pr1_abcd1234',
  ]) assert.throws(() => assertLocalHost(url), /local/i, url);
});

test('S1 safeDbName keeps a normal name, shows the live name unchanged, masks other characters and cuts a long name', async () => {
  // Breaks when: control bytes, an escape sequence or a long text reach the terminal through the refusal line, or the live name stops showing.
  const { safeDbName } = await helper('scratch-db.mjs');
  const url = (name) => `postgresql://x:y@127.0.0.1:1/${encodeURIComponent(name)}`;
  assert.equal(safeDbName(url('continuous_claude')), 'continuous_claude');
  assert.equal(safeDbName(url('lanes_pr1_ab12.x-y')), 'lanes_pr1_ab12.x-y');
  assert.equal(safeDbName(url('a\u001b[31m\nb')), 'a??31m?b', 'ESC, [ and newline become ?');
  assert.equal(safeDbName(url('x'.repeat(80))), `${'x'.repeat(48)}...`);
  assert.equal(safeDbName('not a url'), '');
});

test('T4 every refusal line masks the database name: no escape byte, one line, the name cut', () => {
  // Breaks when: a probe prints the raw name (dbNameOf) in its refusal line again.
  const evil = `bad\u001b[31m\nname${'z'.repeat(80)}`;
  const e = { ...env(), CONTINUOUS_CLAUDE_DB_URL: `postgresql://x:y@127.0.0.1:1/${encodeURIComponent(evil)}` };
  for (const name of REFUSERS) {
    const r = spawnSync(process.execPath, [join(HERE, `${name}-probe.mjs`)], { env: e, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, `${name}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\u001b/, `${name}: an escape byte reached stderr`);
    assert.match(r.stderr, new RegExp(`${name}-probe: refusing to run: database 'bad\\?\\?31m\\?namez{35}\\.\\.\\.' is not a scratch database`), `${name}: ${r.stderr}`);
  }
});

test('T4b no probe prints the raw dbNameOf value in a template', () => {
  // Breaks when: a probe interpolates dbNameOf(...) into text (the raw name, control bytes and all).
  const bad = probeFiles().filter((f) => /\$\{\s*dbNameOf\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f).replace(/\\/g, '/'));
  assert.deepEqual(bad, []);
});

test('T5 a docker-exec probe refuses a URL that names another host, exit 2, before docker starts', () => {
  // Breaks when: the docker path runs on the local container while the URL (and the hooks) name another server: a false failure with no word.
  const e = { ...env(), CONTINUOUS_CLAUDE_DB_URL: 'postgresql://x:y@remote.example.invalid:5432/lanes_pr1_abcd1234' };
  for (const name of DOCKER_PROBES) {
    const r = spawnSync(process.execPath, [join(HERE, `${name}-probe.mjs`)], { env: e, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, `${name}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${name}-probe: refusing to run: .*local container`), `${name}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /PASS|FAIL/, `${name}: no check ran`);
  }
});

test('T5b session-lifecycle with --db-url (the pg module path) is not refused for its host', () => {
  // Breaks when: the host check also stops the pg-module path, which reaches the URL host itself.
  const e = { ...env(), CONTINUOUS_CLAUDE_DB_URL: 'postgresql://x:y@127.0.0.1:1/continuous_claude' };
  const r = spawnSync(process.execPath, [join(HERE, 'session-lifecycle-probe.mjs'), '--db-url', 'postgresql://x:y@remote.example.invalid:5432/lanes_pr1_abcd1234'],
    { env: e, encoding: 'utf8', timeout: 60_000 });
  assert.doesNotMatch(r.stderr, /local container/, r.stderr);
});
