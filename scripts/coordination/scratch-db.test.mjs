import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

import { maskUrl } from './scratch-db.mjs';

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
