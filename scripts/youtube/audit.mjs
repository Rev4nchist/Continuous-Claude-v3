#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOPICS_ROOT, slugify } from './lib/config.mjs';
import { auditVideoCoverage } from './lib/coverage.mjs';
import { findVideoEvidence } from './lib/corpus.mjs';
import { writeJsonAtomic } from './lib/records.mjs';

const args = process.argv.slice(2);
const subject = args[0];
if (!subject) {
  console.error('Usage: audit.mjs <video-id|topic> [--accept <entry-key> --reason <text>]');
  process.exit(1);
}

try {
  const evidencePath = findVideoEvidence(subject);
  if (evidencePath) {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const audit = auditVideoCoverage(evidence, evidence.analysis || {});
    console.log(JSON.stringify(audit, null, 2));
    if (audit.status !== 'READY') process.exitCode = 2;
  } else {
    const path = join(TOPICS_ROOT, slugify(subject), 'coverage.json');
    if (!existsSync(path)) throw new Error(`No video or topic coverage found for "${subject}".`);
    const coverage = JSON.parse(readFileSync(path, 'utf8'));
    const acceptIndex = args.indexOf('--accept');
    if (acceptIndex !== -1) {
      const reasonIndex = args.indexOf('--reason');
      const entryKey = args[acceptIndex + 1];
      const reason = reasonIndex === -1 ? null : args[reasonIndex + 1];
      if (!entryKey || !reason) throw new Error('Accepted exclusions require --accept <entry-key> and --reason <text>.');
      coverage.acceptedExclusions = [...(coverage.acceptedExclusions || []).filter((item) => item.entryKey !== entryKey), { entryKey, reason, acceptedAt: new Date().toISOString() }];
      coverage.status = 'BLOCKED';
      coverage.note = 'Exclusion recorded; rerun topic reconciliation to recompute readiness.';
      writeJsonAtomic(path, coverage);
    }
    console.log(JSON.stringify(coverage, null, 2));
    if (coverage.status !== 'READY') process.exitCode = 2;
  }
} catch (error) {
  console.error(`audit failed: ${error.message}`);
  process.exit(1);
}
