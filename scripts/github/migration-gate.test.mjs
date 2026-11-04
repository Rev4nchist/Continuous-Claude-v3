/**
 * migration-gate.test -- the land gate for PRs that add a drizzle migration.
 *
 *   node --test scripts/github/migration-gate.test.mjs
 *
 * decide() is pure and tested directly. The rest runs the real script as a child process against a throwaway git repo
 * (a main branch with 4 migrations, a PR branch that adds 0004, a PR branch that only touches docs) and a SCRATCH database
 * (lanes_pr1_*) with an agentic_os.__migrations table that the test fills. It never reads the live database.
 *
 * Ways it can fail, one test each:
 *   decide: a PR with no migration is refused because the database is down; a PR with a migration passes with the database behind;
 *           an unreadable database passes for a PR that adds a migration
 *   script: database behind by one (exit 1, names both counts); database equal (exit 0); database unreachable and a migration (exit 1,
 *           "cannot verify migrations; refusing"); no __migrations table (exit 1); docs-only PR with an unreachable database (exit 0);
 *           an unknown head (exit 1); 0004_down.sql alone is not a migration
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertScratchUrl } from '../coordination/scratch-db.mjs';
import { decide } from './migration-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const GATE = path.join(HERE, 'migration-gate.mjs');
const SCRATCH = path.join(HERE, '..', 'coordination', 'scratch-db.mjs');
const { Client } = createRequire(pathToFileURL(path.join(REPO, '.claude', 'hooks', 'package.json')))('pg');

describe('decide', () => {
  it('a PR with no migration passes even when the database could not be read', () => {
    const v = decide({ newMigrations: [], journalCount: 4, dbCount: 0, dbError: 'connect ECONNREFUSED' });
    assert.equal(v.ok, true);
    assert.match(v.message, /adds no migration/);
  });
  it('a PR with a migration is refused when the database is behind, and the message names both counts and the tag', () => {
    const v = decide({ newMigrations: ['0004_x'], journalCount: 5, dbCount: 4 });
    assert.equal(v.ok, false);
    assert.match(v.message, /has 4 migration\(s\) applied/);
    assert.match(v.message, /lists 5/);
    assert.match(v.message, /0004_x/);
  });
  it('a PR with a migration passes when the database has them all, and when it is ahead', () => {
    assert.equal(decide({ newMigrations: ['0004_x'], journalCount: 5, dbCount: 5 }).ok, true);
    assert.equal(decide({ newMigrations: ['0004_x'], journalCount: 5, dbCount: 6 }).ok, true);
  });
  it('a PR with a migration is refused when the database cannot be read', () => {
    const v = decide({ newMigrations: ['0004_x'], journalCount: 5, dbCount: 0, dbError: 'timeout' });
    assert.equal(v.ok, false);
    assert.match(v.message, /cannot verify migrations; refusing/);
  });
});

describe('the script against a git repo and a scratch database', () => {
  const st = { tmp: '', repo: '', url: '', db: null };
  const git = (...args) => execFileSync('git', ['-C', st.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (rel, text) => { const f = path.join(st.repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const journal = (n) => JSON.stringify({ version: '7', dialect: 'postgresql', entries: Array.from({ length: n }, (_, i) => ({ idx: i, tag: i === 4 ? '0004_per_project_lanes' : `000${i}_m` })) });
  const gate = (head, env = {}, extra = []) => {
    const e = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: st.url, DATABASE_URL: st.url, OPC_POSTGRES_URL: st.url, ...env };
    for (const k of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) assertScratchUrl(e[k]);
    const r = spawnSync(process.execPath, [GATE, head, '--repo-path', st.repo, ...extra], { encoding: 'utf8', env: e });
    return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
  };
  const rows = async (n) => {
    await st.db.query('DELETE FROM agentic_os.__migrations');
    for (let i = 0; i < n; i++) await st.db.query('INSERT INTO agentic_os.__migrations (hash, created_at) VALUES ($1,$2)', [`h${i}`, i]);
  };
  const unreachable = 'postgresql://claude:x@127.0.0.1:1/lanes_pr1_unreachable';
  const heads = {};

  before(async () => {
    const c = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '0'], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    st.url = JSON.parse(c.stdout).url;
    assertScratchUrl(st.url);
    st.db = new Client({ connectionString: st.url });
    await st.db.connect();
    await st.db.query('CREATE TABLE agentic_os.__migrations (id serial primary key, hash text, created_at bigint)');

    st.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-gate-'));
    st.repo = path.join(st.tmp, 'repo');
    fs.mkdirSync(st.repo);
    execFileSync('git', ['init', '-q', '-b', 'main', st.repo], { windowsHide: true });
    for (let i = 0; i < 4; i++) put(`apps/agentic-os/drizzle/000${i}_m.sql`, `-- m${i}\n`);
    put('apps/agentic-os/drizzle/meta/_journal.json', journal(4));
    put('README.md', 'x\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'main');
    git('switch', '-q', '-c', 'pr-mig');
    put('apps/agentic-os/drizzle/0004_per_project_lanes.sql', '-- 0004\n');
    put('apps/agentic-os/drizzle/0004_down.sql', '-- down\n');
    put('apps/agentic-os/drizzle/meta/_journal.json', journal(5));
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'add 0004');
    heads.mig = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pr-docs');
    put('README.md', 'y\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'docs');
    heads.docs = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pr-down-only');
    put('apps/agentic-os/drizzle/0007_down.sql', '-- a down file with no journal entry\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'down only');
    heads.down = git('rev-parse', 'HEAD');
    // A PR that adds a migration and breaks the journal at the head.
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pr-bad-journal');
    put('apps/agentic-os/drizzle/0004_per_project_lanes.sql', '-- 0004\n');
    put('apps/agentic-os/drizzle/meta/_journal.json', '{ not json');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'add 0004 with a broken journal');
    heads.badJournal = git('rev-parse', 'HEAD');
    // A PR that deletes 0000 and adds 0004 with the same text: git reports the pair as a rename, not an add.
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pr-rename');
    fs.rmSync(path.join(st.repo, 'apps/agentic-os/drizzle/0000_m.sql'));
    put('apps/agentic-os/drizzle/0004_per_project_lanes.sql', '-- m0\n');
    put('apps/agentic-os/drizzle/meta/_journal.json', journal(5));
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'rename 0000 to 0004');
    heads.rename = git('rev-parse', 'HEAD');
  });

  after(async () => {
    await st.db?.end().catch(() => {});
    if (st.url) { assertScratchUrl(st.url); spawnSync(process.execPath, [SCRATCH, 'drop', st.url], { encoding: 'utf8' }); }
    if (st.tmp) fs.rmSync(st.tmp, { recursive: true, force: true });
  });

  it('refuses a PR that adds 0004 while the database has 4 migrations, naming 4 and 5', async () => {
    await rows(4);
    const r = gate(heads.mig);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /has 4 migration\(s\) applied/);
    assert.match(r.out, /lists 5/);
    assert.match(r.out, /0004_per_project_lanes/);
    assert.doesNotMatch(r.out, /0004_down/);
  });

  it('passes the same PR once the database has 5', async () => {
    await rows(5);
    const r = gate(heads.mig);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /0004_per_project_lanes is applied/);
  });

  it('refuses a PR that adds a migration when the database is unreachable', () => {
    const r = gate(heads.mig, { CONTINUOUS_CLAUDE_DB_URL: unreachable, DATABASE_URL: unreachable, OPC_POSTGRES_URL: unreachable });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /cannot verify migrations; refusing/);
  });

  it('refuses a PR that adds a migration when agentic_os.__migrations does not exist', async () => {
    await st.db.query('ALTER TABLE agentic_os.__migrations RENAME TO __migrations_off');
    try {
      const r = gate(heads.mig);
      assert.equal(r.code, 1, r.all);
      assert.match(r.out, /cannot verify migrations; refusing/);
      assert.match(r.out, /does not exist/);
    } finally { await st.db.query('ALTER TABLE agentic_os.__migrations_off RENAME TO __migrations'); }
  });

  it('passes a docs-only PR even with an unreachable database', () => {
    const r = gate(heads.docs, { CONTINUOUS_CLAUDE_DB_URL: unreachable, DATABASE_URL: unreachable, OPC_POSTGRES_URL: unreachable });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /adds no migration/);
  });

  it('a lone *_down.sql that the journal does not list is not a migration', () => {
    const r = gate(heads.down, { CONTINUOUS_CLAUDE_DB_URL: unreachable, DATABASE_URL: unreachable, OPC_POSTGRES_URL: unreachable });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /adds no migration/);
  });

  it('refuses a PR that adds a .sql file when the journal at the head cannot be read', () => {
    const r = gate(heads.badJournal);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /refusing/);
    assert.match(r.out, /journal/);
  });

  it('a migration that git reports as a rename still counts as added (an unreachable database refuses it)', () => {
    const r = gate(heads.rename, { CONTINUOUS_CLAUDE_DB_URL: unreachable, DATABASE_URL: unreachable, OPC_POSTGRES_URL: unreachable });
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /cannot verify migrations; refusing/);
  });

  it('refuses a head that is not in the repo', () => {
    const r = gate('0123456789abcdef0123456789abcdef01234567');
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /is not in/);
  });

  it('--fixture bypasses git and the database', () => {
    const f = path.join(st.tmp, 'fixture.json');
    fs.writeFileSync(f, JSON.stringify({ newMigrations: ['0004_x'], journalCount: 5, dbCount: 4 }));
    const r = spawnSync(process.execPath, [GATE, '--fixture', f], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /the database is behind/);
  });
});
