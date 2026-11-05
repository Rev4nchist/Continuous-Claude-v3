// Does the home mirror of project-registry.json agree with the repo copy on what picks a lane board?
//
// lane.mjs reads the mirror (~/.claude/project-registry.json). The repo copy (primary checkout) is canonical. Until the
// post-merge sync, a stale mirror gives a nested app the board of its own key and `add` writes lanes with that
// project_key (CodeRabbit PR 297, project-registry.json:129).
//
// Board-relevant fields, per entry key: the board (laneBoard, else the key), the status (lowercase), the normalised root and
// the phone page url (laneArtifact: the hooks nag for that page, so a mirror without it leaves the Stop gate blind).
// Names, notes, stacks and every other field are ignored: they pick no board.
//
// Not in lane-board.mjs on purpose: that file has a TypeScript twin (.claude/hooks/src/shared/lane-board.ts) and a parity
// test. The hooks do not need this check.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRegistry } from './lane-board.mjs';

/** The registry file lane-board.mjs reads when no registryPath is passed. Keep the chain in step with its registryFile(). */
export function mirrorRegistryPath(env = process.env) {
  return env.LANE_REGISTRY_PATH || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude', 'project-registry.json');
}

/** 'ok', 'absent' or 'unreadable' (not JSON, or no projects array). */
function probe(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  try {
    return Array.isArray(JSON.parse(text).projects) ? 'ok' : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** key -> board-relevant fields of the entries with that key, in registry order. */
function fieldsByKey(file) {
  const byKey = new Map();
  for (const e of loadRegistry({ registryPath: file, env: {} })) {
    const list = byKey.get(e.key) ?? [];
    list.push({ board: e.board, status: e.status.toLowerCase(), root: e.root, laneArtifact: e.artifact });
    byKey.set(e.key, list);
  }
  return byKey;
}

/**
 * Compare the board-relevant fields of two registry files.
 * @returns {{ state: 'same'|'differ'|'repo-absent'|'mirror-absent'|'unreadable', diffs: string[] }}
 *   `diffs` names each key and field, for example `agentic-os: board repo=continuous-claude mirror=agentic-os`.
 *   Only 'differ' has diffs. A file that cannot be judged is never 'same'.
 */
export function registryDrift(repoFile, mirrorFile) {
  const a = probe(repoFile);
  const b = probe(mirrorFile);
  if (a === 'unreadable' || b === 'unreadable') return { state: 'unreadable', diffs: [] };
  if (a === 'absent') return { state: 'repo-absent', diffs: [] };
  if (b === 'absent') return { state: 'mirror-absent', diffs: [] };
  const repo = fieldsByKey(repoFile);
  const mirror = fieldsByKey(mirrorFile);
  const diffs = [];
  for (const key of [...new Set([...repo.keys(), ...mirror.keys()])].sort()) {
    const r = repo.get(key);
    const m = mirror.get(key);
    if (!m) { diffs.push(`${key}: only in the repo copy`); continue; }
    if (!r) { diffs.push(`${key}: only in the mirror`); continue; }
    if (r.length !== m.length) { diffs.push(`${key}: ${r.length} entries in the repo copy, ${m.length} in the mirror`); continue; }
    r.forEach((re, i) => {
      for (const field of ['board', 'status', 'root', 'laneArtifact']) {
        if (re[field] !== m[i][field]) diffs.push(`${key}: ${field} repo=${re[field] || '(none)'} mirror=${m[i][field] || '(none)'}`);
      }
    });
  }
  return { state: diffs.length ? 'differ' : 'same', diffs };
}
