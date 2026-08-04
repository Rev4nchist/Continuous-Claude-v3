#!/usr/bin/env node
// Appends one digest block to docs/self-improvement/PENDING-DIGEST.md from a finished
// proposal's YAML frontmatter. Runs in the PARENT process after claude -p returns — the
// deterministic push promised at run-research.ps1's scope-guard comment. The headless
// session's own fallback append was permission-denied on 5 of its last 7 runs (Edit is
// deliberately not in --allowedTools), so digests for 8 completed runs (07-26..08-03)
// landed in NO queue. This helper closes that gap without widening the session's toolset.
//
// IDEMPOTENT: if the file already has a block for <date> + <componentId> (the headless
// session occasionally succeeds via Write, e.g. 2026-08-04), it skips — never duplicates.
//
// Usage: node append-digest.mjs <date YYYY-MM-DD> <componentId>
// Exit: 0 appended or skipped-duplicate; 1 usage; 2 proposal missing (mirrors record-index).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const DIGEST_HEADER = `# Pending Self-Improvement Digests → Notion Bridge (Code→Eve queue)

Unattended research runs cannot reliably reach the Notion Bridge (headless + fragile HTML/mention
format). Each entry below is a proposal digest awaiting sweep into the Bridge Code→Eve queue by the
next interactive session. After posting one, delete its block from this file.

---
`;

export function parseFrontmatter(body) {
  const fm = {};
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return fm;
}

export function buildDigestBlock({ date, componentId, name, verdict, headline }) {
  return `## ${date} — ${componentId} (${name})

- **Date:** ${date}
- **Component:** ${componentId} — ${name}
- **Verdict:** ${verdict}
- **Headline:** ${headline}
- **Proposal:** \`docs/self-improvement/proposals/${date}-${componentId}.md\`
- **Note:** Deterministic parent-process append (run-research.ps1) — headless session does not write this queue.

---
`;
}

export function hasDigestFor(content, date, componentId) {
  // Heading shape is "## <date> <sep> <componentId> (...)" but the separator and
  // spacing have varied across headless-written entries — match loosely on a heading
  // line that starts with the date and contains the component id as a word.
  const re = new RegExp(`^## ${date}\\b.*\\b${componentId}\\b`, 'm');
  return re.test(content);
}

// Insert the block ABOVE the trailing "*Queue clear..." footer when present (the
// human-readable low-water mark), else append at end.
export function appendDigest(content, block) {
  const footerIdx = content.search(/^\*Queue clear above this line/m);
  if (footerIdx === -1) {
    return `${content.replace(/\s*$/, '\n\n')}${block}`;
  }
  return `${content.slice(0, footerIdx).replace(/\s*$/, '\n\n')}${block}\n${content.slice(footerIdx)}`;
}

function main() {
  const [date, componentId] = process.argv.slice(2);
  if (!date || !componentId) {
    console.error('usage: append-digest.mjs <date YYYY-MM-DD> <componentId>');
    return 1;
  }
  const proposalPath = join(repo, 'docs', 'self-improvement', 'proposals', `${date}-${componentId}.md`);
  const digestPath = join(repo, 'docs', 'self-improvement', 'PENDING-DIGEST.md');
  if (!existsSync(proposalPath)) {
    console.error(`append-digest: proposal not found at ${proposalPath} (research run may have failed) — no digest queued`);
    return 2;
  }
  const fm = parseFrontmatter(readFileSync(proposalPath, 'utf8'));
  const block = buildDigestBlock({
    date,
    componentId,
    name: fm.component_name || componentId,
    verdict: fm.verdict || 'unknown',
    headline: fm.headline || '(no headline in frontmatter)',
  });
  const content = existsSync(digestPath) ? readFileSync(digestPath, 'utf8') : DIGEST_HEADER;
  if (hasDigestFor(content, date, componentId)) {
    process.stdout.write(`append-digest: block for ${date}-${componentId} already present — skipping (idempotent)\n`);
    return 0;
  }
  writeFileSync(digestPath, appendDigest(content, block));
  process.stdout.write(`append-digest: queued digest for ${date}-${componentId} (verdict=${fm.verdict || 'unknown'})\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
