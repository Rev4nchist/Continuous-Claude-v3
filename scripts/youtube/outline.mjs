#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOPICS_ROOT, slugify } from './lib/config.mjs';
import { findVideoEvidence } from './lib/corpus.mjs';

const subject = process.argv.slice(2).join(' ').trim();
if (!subject) {
  console.error('Usage: outline.mjs <video-id|topic>');
  process.exit(1);
}
const evidencePath = findVideoEvidence(subject);
const path = evidencePath
  ? evidencePath.replace(/\.analysis\.json$/, '.outline.md')
  : join(TOPICS_ROOT, slugify(subject), 'master-outline.md');
if (!existsSync(path)) {
  console.error(`No exhaustive outline exists for "${subject}". Run refresh/audit first.`);
  process.exit(2);
}
process.stdout.write(readFileSync(path, 'utf8'));
