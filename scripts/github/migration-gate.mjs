#!/usr/bin/env node
/**
 * migration-gate.mjs - land-pr.ps1 refuses to merge a PR that adds a drizzle migration the live database has not applied.
 *
 * Why: code that needs a column ships with the migration that adds it. If the merge comes first, every session that syncs
 * main runs code against a database without the column. The order is: apply the migration, then merge (Dave: strict, apply-first).
 *
 * Usage: node scripts/github/migration-gate.mjs <head-sha-or-ref> [--repo-path <dir>] [--base main] [--remote <name>] [--fixture <file>]
 *   --repo-path  the git checkout that holds the PR head (default: the repo that holds this script). A worktree shares the object store.
 *   --base       the branch the PR merges into (default main). The new migrations are the .sql files the PR adds since the merge base.
 *   --remote     when <head> is not in the checkout, fetch it from this remote once.
 *   --fixture    { newMigrations: [...], journalCount, dbCount, dbError }: no git and no database (tests).
 * Database: CONTINUOUS_CLAUDE_DB_URL, then DATABASE_URL, then OPC_POSTGRES_URL, then the live default (same chain as lane.mjs).
 * It reads agentic_os.__migrations (the drizzle table, see apps/agentic-os/drizzle.config.ts) in one READ ONLY transaction and writes nothing.
 *
 * Exit: 0 = no new migration, or the database has them all. 1 = refused: the database is behind, the head is unknown,
 * or the PR adds a migration and the database cannot be read ("cannot verify migrations; refusing").
 * A PR with no new migration never needs the database: it passes even when the database is down.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DRIZZLE_REL = 'apps/agentic-os/drizzle';
const JOURNAL_REL = `${DRIZZLE_REL}/meta/_journal.json`;

/** The decision, without any I/O. `newMigrations` are the tags the PR adds. */
export function decide({ newMigrations, journalCount, dbCount, dbError }) {
  if (!newMigrations.length) return { ok: true, message: 'migration gate: the PR adds no migration; nothing to check' };
  const tags = newMigrations.join(', ');
  if (dbError) return { ok: false, message: `migration gate: cannot verify migrations; refusing. The PR adds ${tags} and the database could not be read (${dbError}).` };
  if (dbCount < journalCount) {
    return {
      ok: false,
      message: `migration gate: the database is behind. It has ${dbCount} migration(s) applied, the PR head's journal lists ${journalCount} (new: ${tags}). ` +
        'Apply the migration first (drizzle-kit migrate, after reading the SQL), then land the PR.',
    };
  }
  return { ok: true, message: `migration gate: the database has ${dbCount} migration(s), the PR head's journal lists ${journalCount}; ${tags} is applied` };
}

/** The row count of agentic_os.__migrations. Throws a short message when it cannot be read (a missing pg is the one ENV: message). */
export async function countAppliedMigrations(url) {
  // Loaded here, not at the top: a PR with no migration never needs pg or the database. The resolver finds pg in this
  // checkout or the primary one (scripts/lib/resolve-deps.mjs).
  const { Client } = requireDep('pg', { repoRoot: REPO });
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 4000, query_timeout: 8000 });
  try {
    await c.connect();
    await c.query('BEGIN READ ONLY');
    if (!(await c.query("SELECT to_regclass('agentic_os.__migrations') AS t")).rows[0].t) throw new Error('agentic_os.__migrations does not exist');
    const n = Number((await c.query('SELECT count(*) AS n FROM agentic_os.__migrations')).rows[0].n);
    await c.query('ROLLBACK');
    return n;
  } finally { await c.end().catch(() => {}); }
}

/**
 * The numbered .sql files among `names` (repo paths): case-blind, like the Windows checkout (aegis F3 on PR 673: `apps/agentic-os/DRIZZLE/0009_x.SQL` is a migration too).
 * Only a file directly in the drizzle folder counts, not one in a sub folder.
 */
export const addedMigrationFiles = (names) => names.filter((f) => new RegExp(`^${DRIZZLE_REL}/\\d{4}_[^/]+\\.sql$`, 'i').test(f));

const git = (repoPath, args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/** { newMigrations, journalCount } for the PR head, from git only. Throws a short message when the head is unknown. */
export function readPrFacts({ head, repoPath, base = 'main', remote }) {
  const has = () => { try { git(repoPath, ['rev-parse', '--verify', `${head}^{commit}`]); return true; } catch { return false; } };
  if (!has()) {
    if (remote) { try { git(repoPath, ['fetch', '-q', remote, head]); } catch { /* reported below */ } }
    if (!has()) throw new Error(`head ${head} is not in ${repoPath}${remote ? ` and could not be fetched from ${remote}` : ''}; fetch it and run again`);
  }
  const mergeBase = git(repoPath, ['merge-base', base, head]).trim();
  // --no-renames: a deleted migration plus a similar new one is a rename to git, and --diff-filter=A would drop the new file.
  // :(icase): git matches the folder case-blind too, so an upper-case folder name is read
  const added = addedMigrationFiles(git(repoPath, ['diff', '--no-renames', '--name-only', '--diff-filter=A', mergeBase, head, '--', `:(icase)${DRIZZLE_REL}`]).split(/\r?\n/));
  let tags = [];
  try {
    tags = JSON.parse(git(repoPath, ['show', `${head}:${JOURNAL_REL}`])).entries.map((e) => e.tag);
  } catch {
    // Fail closed: a PR that adds a numbered .sql file and has no readable journal cannot be told from a migration.
    if (added.length) throw new Error(`the PR adds ${added.map((f) => f.split('/').pop()).join(', ')} but the journal at the head (${JOURNAL_REL}) cannot be read`);
  }
  // Only files the journal lists are migrations: 0004_down.sql is documentation.
  // The tag in the journal is the name; the file name may differ in case.
  const newMigrations = added.map((f) => f.slice(DRIZZLE_REL.length + 1, -4)).map((name) => tags.find((tag) => tag.toLowerCase() === name.toLowerCase())).filter(Boolean);
  return { newMigrations, journalCount: tags.length };
}

const dbUrl = () => process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

async function main(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const fixtureFile = opt('--fixture');
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  let facts;
  if (fixtureFile) {
    facts = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  } else {
    const head = positional[0];
    if (!head) { console.error('usage: migration-gate.mjs <head-sha> [--repo-path <dir>] [--base main] [--remote <name>]'); return 2; }
    try {
      facts = readPrFacts({ head, repoPath: resolve(opt('--repo-path', REPO)), base: opt('--base', 'main'), remote: opt('--remote') });
    } catch (e) {
      console.log(`migration gate: refusing. ${String(e.message).trim().split('\n')[0]}`);
      return 1;
    }
    // The database is read only when the PR adds a migration: a docs PR must not depend on it being up.
    if (facts.newMigrations.length) {
      try { facts.dbCount = await countAppliedMigrations(dbUrl()); } catch (e) { facts.dbError = String(e.message).split('\n')[0]; }
    }
  }
  const verdict = decide({ newMigrations: [], dbCount: 0, journalCount: 0, ...facts });
  console.log(verdict.message);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
}
