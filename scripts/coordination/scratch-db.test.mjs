import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratchUrl } from './scratch-db.mjs';

const U = (db) => `postgresql://claude:x@localhost:5432/${db}`;

test('accepts a scratch database name', () => {
  assert.equal(assertScratchUrl(U('lanes_pr1_0123abcd')), 'lanes_pr1_0123abcd');
});

test('refuses the live database and look-alikes', () => {
  for (const db of ['continuous_claude', 'postgres', 'xlanes_pr1_0123abcd', 'lanes_pr1', '', 'LANES_PR1_ABCD']) {
    assert.throws(() => assertScratchUrl(U(db)), /refusing/, db);
  }
});

test('refuses a name that could break out of the quoted identifier', () => {
  assert.throws(() => assertScratchUrl(U('lanes_pr1_x%22%3B%20DROP%20DATABASE%20continuous_claude')), /refusing/);
});

test('refuses an unparseable URL', () => {
  assert.throws(() => assertScratchUrl('not a url'), /refusing/);
});

import { createDatabase, dropDatabase, loadPg, maskUrl } from './scratch-db.mjs';
import { candidateRoots } from '../lib/resolve-deps.mjs';

test('maskUrl hides the password and keeps host and database', () => {
  assert.equal(maskUrl('postgresql://claude:s3cret@localhost:5432/lanes_pr1_ab'), 'postgresql://claude:***@localhost:5432/lanes_pr1_ab');
});

// CodeRabbit PR 297, session-lifecycle-probe.mjs:173. A libpq URL can carry the password in the query string.
// Each test names the change that breaks it: dropping the query redaction in maskUrl.
test('maskUrl hides a password in the query string and keeps the other parameters', () => {
  const masked = maskUrl('postgresql://claude:s3cret@localhost:5432/lanes_pr1_ab?sslmode=require&password=qsecret&application_name=x');
  assert.equal(masked, 'postgresql://claude:***@localhost:5432/lanes_pr1_ab?sslmode=require&password=***&application_name=x');
});

test('maskUrl hides every sensitive query parameter, in any case, percent-encoded or not, and handles a URL with no userinfo', () => {
  for (const key of ['password', 'PASSWORD', 'Passfile', 'sslpassword', 'sslkey', 'sslcert', 'pass%77ord']) {
    const masked = maskUrl(`postgresql://localhost/lanes_pr1_ab?${key}=topsecret#frag`);
    assert.ok(!masked.includes('topsecret'), `${key}: ${masked}`);
    assert.ok(masked.startsWith('postgresql://localhost/lanes_pr1_ab?') && masked.endsWith('=***#frag'), masked);
  }
});

test('maskUrl leaves a URL without secrets unchanged', () => {
  const u = 'postgresql://localhost:5432/lanes_pr1_ab?sslmode=require&connect_timeout=5';
  assert.equal(maskUrl(u), u);
});

// End to end: the real probe, pointed at a refused port, prints its target line and exits 2. The line must not hold the secret.
test('session-lifecycle-probe does not print a password from --db-url, in userinfo or in the query', () => {
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'session-lifecycle-probe.mjs');
  const r = spawnSync(process.execPath, [probe, '--db-url', 'postgresql://u:userinfosecret@127.0.0.1:1/lanes_pr1_x?password=querysecret&sslmode=disable'],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const all = `${r.stdout}${r.stderr}`;
  assert.match(all, /database\s+postgresql:\/\/u:\*\*\*@127\.0\.0\.1:1\/lanes_pr1_x/, all);
  assert.ok(!all.includes('querysecret'), all);
  assert.ok(!all.includes('userinfosecret'), all);
});

// CodeRabbit PR 297 round 3, scratch-db.mjs:105. WHATWG and pg split userinfo at the LAST '@' of the authority.
// Each test fails if maskUrl goes back to a regex that stops at the first '@' or reads past the authority.
test('maskUrl hides all of a password that holds an unencoded @', () => {
  assert.equal(maskUrl('postgres://u:p@ss@host:5432/lanes_pr1_ab'), 'postgres://u:***@host:5432/lanes_pr1_ab');
});

test('maskUrl does not rewrite a port, path or query when the authority has no userinfo', () => {
  const u = 'postgres://host:5432/db?user=a@b';
  assert.equal(maskUrl(u), u);
});

// CodeRabbit PR 297 round 3, scratch-db.mjs:196. A failed create must not leave lanes_pr1_* on the shared server.
// Fails if createDatabase stops dropping on failure. It uses the server of the env chain, never the live database.
const adminUrl = () => {
  const u = new URL(process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude');
  u.pathname = '/postgres';
  return u.toString();
};
const dbExists = async (name) => {
  const { Client } = loadPg();
  const c = new Client({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });
  await c.connect();
  try { return (await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount === 1; } finally { await c.end(); }
};

// CodeRabbit PR 297 round 4: pg may live under only one of .claude/hooks and apps/agentic-os. The tests must find it in either.
// Fails if loadPg stops trying the next anchor, or if the test goes back to one hard-coded location.
test('loadPg falls back to the next location when pg is missing from the first, and throws when it is in none', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The real anchors: this checkout's two and, in a bare worktree, the primary's two (scripts/lib/resolve-deps.mjs).
  const real = candidateRoots(join(here, '..', '..'));
  const nowhere = join(tmpdir(), 'no-such-dir-for-pg', 'package.json');
  // pg is installed under at least one real anchor, not necessarily all: a missing first anchor must fall through to the rest.
  assert.equal(typeof loadPg([nowhere, ...real]).Client, 'function');
  assert.equal(typeof loadPg([nowhere, nowhere, ...real.reverse()]).Client, 'function');
  assert.throws(() => loadPg([nowhere, nowhere]), /cannot resolve the `pg` module/);
});

test('createDatabase drops the new database and rethrows when the build step fails', async () => {
  const name = `lanes_pr1_${randomBytes(4).toString('hex')}`;
  await assert.rejects(createDatabase(adminUrl(), name, async () => {
    assert.equal(await dbExists(name), true, 'the database exists while the build step runs');
    throw new Error('build step failed');
  }), /build step failed/);
  assert.equal(await dbExists(name), false, `orphan database ${name} left behind`);
});

test('createDatabase keeps the database when the build step succeeds', async () => {
  const name = `lanes_pr1_${randomBytes(4).toString('hex')}`;
  try {
    await createDatabase(adminUrl(), name, async () => {});
    assert.equal(await dbExists(name), true);
  } finally {
    await dropDatabase(adminUrl(), name);
  }
});
