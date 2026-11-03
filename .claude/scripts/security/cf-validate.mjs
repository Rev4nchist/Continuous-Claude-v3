#!/usr/bin/env node
// Validate a security-findings.json file against the vendored Cloudflare
// contract (cf-contract/). Works on Windows, where the upstream CLI cannot.
// Usage: node .claude/scripts/security/cf-validate.mjs <security-findings.json>
// Exit 0 = PASS, 1 = FAIL. Differences from upstream: cf-contract/PROVENANCE.md.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cf-contract');

class InputError extends Error {}

function verifyLock() {
  const lock = JSON.parse(readFileSync(join(CONTRACT_DIR, 'vendor.lock.json'), 'utf8'));
  for (const [name, entry] of Object.entries(lock.files)) {
    const hash = createHash('sha256').update(readFileSync(join(CONTRACT_DIR, name))).digest('hex');
    if (hash !== entry.sha256) throw new InputError(`integrity check failed for cf-contract/${name}`);
  }
}

function readInput(file, maxBytes) {
  let stat;
  try { stat = lstatSync(file); } catch { throw new InputError('input could not be opened'); }
  if (stat.isSymbolicLink()) throw new InputError('input must not be a symlink');
  if (!stat.isFile()) throw new InputError('input must be a regular file');
  if (stat.size > maxBytes) throw new InputError(`input exceeds ${maxBytes} byte limit`);
  const bytes = readFileSync(file);
  if (bytes.length > maxBytes) throw new InputError(`input exceeds ${maxBytes} byte limit`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new InputError('input is not valid UTF-8');
  }
}

export function validateFile(file) {
  verifyLock();
  const validator = createRequire(import.meta.url)(join(CONTRACT_DIR, 'validate-findings.cjs'));
  const schema = JSON.parse(readFileSync(join(CONTRACT_DIR, 'report-schema.json'), 'utf8'));
  const text = readInput(file, validator.LIMITS.inputBytes);
  let findings;
  try { findings = JSON.parse(text); } catch { throw new InputError('invalid JSON'); }
  return { count: Array.isArray(findings) ? findings.length : 0, errors: validator.validateDocument(findings, schema) };
}

function main(file) {
  if (!file) {
    console.error('Usage: node cf-validate.mjs <security-findings.json>');
    return 1;
  }
  let result;
  try { result = validateFile(file); } catch (error) {
    const reason = error instanceof InputError ? error.message : 'unexpected validation error';
    console.error(`FAIL: ${reason}`);
    return 1;
  }
  for (const message of result.errors) console.error('ERROR:', message);
  if (result.errors.length > 0) {
    console.error(`FAIL: ${result.errors.length} validation error(s)`);
    return 1;
  }
  console.log(`PASS: ${result.count} findings valid`);
  return 0;
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main(process.argv[2]);
