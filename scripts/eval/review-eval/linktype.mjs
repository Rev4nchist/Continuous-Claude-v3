// The linkType of each real Major: what a reviewer had to read to see the bug.
//   within-hunk         the cause is in the changed lines
//   same-file           the cause is in the same file, outside the changed lines
//   cross-file-static   the cause is in another file, reached by an import or a call
//   cross-file-dynamic  the cause is in another file, tied by a string, a config key, a rule text or a workflow (no import or call)
// The labels are model labels (agent-claude, agent-grok), never Dave's. File: linktype-labels.json beside this module (tracked),
// { classes, raters, agreement, labels: { "<dataset key>": { "agent-claude": class, "agent-grok": class, final: class, disputed? } } }.
// final is the agreed class, or the class of the first rater when the raters split (the key is then listed in agreement.disputed).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HERE } from './config.mjs';

export const LINK_TYPES = Object.freeze(['within-hunk', 'same-file', 'cross-file-static', 'cross-file-dynamic']);
export const LINKTYPE_PATH = path.join(HERE, 'linktype-labels.json');
/** The claude rater of the labels file: the model family and settings that wrote its labels. */
export const CLAUDE_RATER = Object.freeze({ family: 'anthropic', model: 'opus', effort: 'high' });

/**
 * { key: class } from the labels file. A missing file is {}. Throws on a file that does not parse, a file without `labels`, or a class
 * outside LINK_TYPES. The messages are fixed text and a count: a key is a PR number and a comment id, and callers print the message.
 */
export function loadLinkTypes(file = LINKTYPE_PATH) {
  if (!existsSync(file)) return {};
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file}: not valid JSON`); }
  if (json === null || typeof json.labels !== 'object' || json.labels === null) throw new Error(`${file}: expected { labels: { key: { final } } }`);
  const out = {};
  let bad = 0;
  for (const [key, row] of Object.entries(json.labels)) {
    if (LINK_TYPES.includes(row?.final)) out[key] = row.final;
    else bad += 1;
  }
  if (bad > 0) throw new Error(`${file}: ${bad} label(s) have a class outside ${LINK_TYPES.join(', ')}`);
  return out;
}

/** The default rater name of the claude labels. */
export const CLAUDE_RATER_NAME = 'agent-claude';
/** A rater key of a label entry: anything but final and disputed. */
const ratersOf = (entry) => Object.keys(entry ?? {}).filter((k) => k !== 'final' && k !== 'disputed');

/**
 * Merges { key: class } entries from one rater (the single key of `raters`) into the labels file, by temp file and rename. A missing file
 * starts the shape { classes, raters, agreement: null, labels }. With one rater, final is that rater's class. An existing entry with
 * another rater is kept. Throws before any write when a class is outside LINK_TYPES (fixed text and a count, never a key). Returns { added, kept }.
 */
export function writeLinkTypeLabels(file, entries, raters = { [CLAUDE_RATER_NAME]: CLAUDE_RATER }) {
  const names = Object.keys(raters);
  if (names.length !== 1) throw new Error('writeLinkTypeLabels takes exactly one rater');
  const [rater] = names;
  const bad = Object.values(entries).filter((cls) => !LINK_TYPES.includes(cls)).length;
  if (bad > 0) throw new Error(`${bad} entry class(es) outside ${LINK_TYPES.join(', ')}; nothing written`);
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const labels = { ...(json.labels ?? {}) };
  let kept = 0;
  for (const [key, cls] of Object.entries(entries)) {
    if (ratersOf(labels[key]).some((k) => k !== rater)) { kept += 1; continue; }
    labels[key] = { [rater]: cls, final: cls };
  }
  const next = { ...json, classes: json.classes ?? [...LINK_TYPES], raters: { ...(json.raters ?? {}), ...raters }, agreement: json.agreement ?? null, labels };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
  renameSync(tmp, file);
  return { added: Object.keys(entries).length - kept, kept };
}
