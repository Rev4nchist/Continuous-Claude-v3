#!/usr/bin/env node
/**
 * rules-budget-guard.mjs — ratchet on the size of the always-loaded rules.
 *
 * Every file in .claude/rules-src/ syncs to ~/.claude/rules/ and is loaded into EVERY session,
 * so its bytes are paid on every turn. The 2026-09-23 Opus 5.5 eval cut about 25 KB of history
 * and parked-tool detail out of them (P19, P20); without a gate that cut slowly grows back.
 *
 * Counts the bytes of .claude/rules-src/*.md and fails when the total exceeds the budget in
 * scripts/rules/rules-budget.json. With --staged it sizes the STAGED blobs (git index), so a
 * pre-commit run checks exactly what is being committed, not the working tree.
 *
 * Exit 0 = within budget, 1 = over budget, 0 with a note on any internal error (fail-open).
 * Usage: node scripts/rules/rules-budget-guard.mjs [--staged] [--json]
 * Raising the budget is a deliberate edit to rules-budget.json, reviewed like any other change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const RULES = '.claude/rules-src';
const args = process.argv.slice(2);

function stagedSizes() {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-s', '--', `${RULES}/*.md`], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    const sha = meta.split(' ')[1];
    const size = Number(execFileSync('git', ['-C', repo, 'cat-file', '-s', sha], { encoding: 'utf8' }).trim());
    rows.push({ file: path.split('/').pop(), bytes: size });
  }
  return rows;
}

function worktreeSizes() {
  const dir = join(repo, RULES);
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ file: f, bytes: statSync(join(dir, f)).size }));
}

try {
  const budget = JSON.parse(readFileSync(join(here, 'rules-budget.json'), 'utf8'));
  const rows = (args.includes('--staged') ? stagedSizes() : worktreeSizes()).sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const over = total > budget.maxBytes;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ total, maxBytes: budget.maxBytes, over, files: rows.length, largest: rows.slice(0, 5) }));
  } else {
    console.log(`rules-src: ${rows.length} files, ${total} bytes (budget ${budget.maxBytes})${over ? '  OVER BUDGET' : ''}`);
    if (over) {
      console.log('  Largest files:');
      for (const r of rows.slice(0, 5)) console.log(`    ${String(r.bytes).padStart(6)}  ${r.file}`);
      console.log('  Move operator detail into a skill (loaded on trigger), or raise maxBytes in scripts/rules/rules-budget.json deliberately.');
    }
  }
  process.exit(over ? 1 : 0);
} catch (err) {
  console.log(`rules-budget-guard: skipped (${err.message.split('\n')[0]})`);
  process.exit(0);
}
