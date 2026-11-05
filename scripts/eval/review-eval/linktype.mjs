// The linkType of each real Major: what a reviewer had to read to see the bug.
//   within-hunk         the cause is in the changed lines
//   same-file           the cause is in the same file, outside the changed lines
//   cross-file-static   the cause is in another file, reached by an import or a call
//   cross-file-dynamic  the cause is in another file, tied by a string, a config key, a rule text or a workflow (no import or call)
// The labels are model labels (agent-claude, agent-grok), never Dave's. File: linktype-labels.json beside this module (tracked),
// { classes, raters, agreement, labels: { "<dataset key>": { "agent-claude": class, "agent-grok": class, final: class, disputed? } } }.
// final is the agreed class, or the class of the first rater when the raters split (the key is then listed in agreement.disputed).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HERE } from './config.mjs';

export const LINK_TYPES = Object.freeze(['within-hunk', 'same-file', 'cross-file-static', 'cross-file-dynamic']);
export const LINKTYPE_PATH = path.join(HERE, 'linktype-labels.json');

/** { key: class } from the labels file. A missing file is {}. Throws on a file without `labels` or with a class outside LINK_TYPES. */
export function loadLinkTypes(file = LINKTYPE_PATH) {
  if (!existsSync(file)) return {};
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json === null || typeof json.labels !== 'object' || json.labels === null) throw new Error(`${file}: expected { labels: { key: { final } } }`);
  const out = {};
  for (const [key, row] of Object.entries(json.labels)) {
    if (!LINK_TYPES.includes(row?.final)) throw new Error(`${file}: ${key} has the class "${row?.final}", not one of ${LINK_TYPES.join(', ')}`);
    out[key] = row.final;
  }
  return out;
}
