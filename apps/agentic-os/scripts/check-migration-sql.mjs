#!/usr/bin/env node
/**
 * Migration safety gate.
 *
 * This database is shared with three other applications. 40 tables live in
 * `public` and none of them are ours. This script reads every generated
 * migration and fails if any statement names an object outside `agentic_os`.
 *
 * It checks CREATE and ALTER, not just DROP: extensions, enum types, indexes
 * and privileges can all land in or depend on `public` even when table-level
 * filtering works correctly.
 *
 * Run before `db:migrate`. Exits non-zero on any violation.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const ALLOWED_SCHEMA = 'agentic_os';

if (!existsSync(migrationsDir)) {
  console.log('[db:check] no drizzle/ directory yet — nothing to verify.');
  process.exit(0);
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.log('[db:check] no .sql migrations yet — nothing to verify.');
  process.exit(0);
}

/** Statements that mutate schema and therefore must be scoped. */
const DDL = /\b(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(TABLE|INDEX|SCHEMA|TYPE|EXTENSION|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|FUNCTION|TRIGGER|POLICY)\b/gi;

const violations = [];

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');

  // Strip comments so commentary never trips the scanner.
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  for (const stmt of cleaned.split(/;\s*(?:--> statement-breakpoint)?/)) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    DDL.lastIndex = 0;
    if (!DDL.test(trimmed)) continue;

    const oneLine = trimmed.replace(/\s+/g, ' ').slice(0, 160);

    // Creating our own schema is the one unqualified statement we allow.
    if (/^CREATE\s+SCHEMA\b/i.test(trimmed) && trimmed.includes(ALLOWED_SCHEMA)) continue;

    // Every other DDL statement must name the allowed schema explicitly.
    const namesAllowed =
      trimmed.includes(`"${ALLOWED_SCHEMA}"`) || trimmed.includes(`${ALLOWED_SCHEMA}.`);

    if (!namesAllowed) {
      violations.push({ file, reason: `DDL not scoped to ${ALLOWED_SCHEMA}`, stmt: oneLine });
      continue;
    }

    // Explicit belt-and-braces: never let `public` appear in a DDL statement.
    if (/\bpublic\s*\.|"public"/i.test(trimmed)) {
      violations.push({ file, reason: 'statement references public', stmt: oneLine });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n[db:check] FAILED — ${violations.length} unsafe statement(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
    console.error(`    ${v.stmt}\n`);
  }
  console.error('This database is shared with three other applications.');
  console.error('Do not apply these migrations. Fix the schema definitions first.\n');
  process.exit(1);
}

console.log(`[db:check] OK — ${files.length} migration file(s), all DDL scoped to ${ALLOWED_SCHEMA}.`);
