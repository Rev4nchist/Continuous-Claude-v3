/**
 * Pick the handoff that THIS session wrote (package A2).
 *
 * A handoff carries `session_id: <full uuid>` in its frontmatter. SessionStart on
 * compact or clear selects by that id BEFORE it sorts by mtime. A handoff of another
 * session never matches. No match means no handoff, with no cross-session fallback.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A handoff older than this is not offered on any source. */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap for the pointer text. */
export const POINTER_MAX = 300;

/** Outcomes that end a handoff. PARTIAL_PLUS and PARTIAL_MINUS stay resumable. */
const TERMINAL_OUTCOMES = ['SUCCEEDED', 'FAILED'];
const TERMINAL_STATUSES = ['complete', 'completed', 'done'];

export interface SelectedHandoff {
  path: string;
  content: string;
  mtime: number;
}

function isHandoffFile(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.yaml') || name.endsWith('.yml');
}

/** The text between the first two `---` lines. Null if the file does not start with `---`. */
function frontmatter(content: string): string | null {
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? m[1] : null;
}

/** A top-level `key: value` from the frontmatter block only, never from the body. */
export function readFrontmatterField(content: string, key: string): string | null {
  const fm = frontmatter(content);
  if (fm === null) return null;
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*\\r?$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** 'terminal' (done, SUCCEEDED, FAILED), 'stale' (over 7 days), or null when the handoff is offered. */
export function handoffSkipReason(content: string, mtimeMs: number, now: number = Date.now()): 'terminal' | 'stale' | null {
  const status = content.match(/^status:\s*(\w+)/m)?.[1]?.toLowerCase() ?? '';
  const outcome = content.match(/^outcome:\s*(\w+)/m)?.[1]?.toUpperCase() ?? '';
  if (TERMINAL_STATUSES.includes(status) || TERMINAL_OUTCOMES.includes(outcome)) return 'terminal';
  if (now - mtimeMs > STALE_THRESHOLD_MS) return 'stale';
  return null;
}

/**
 * The newest handoff whose frontmatter `session_id` equals one of `sessionIds`.
 * The newest match decides: if it is terminal or stale the answer is null, not an older file.
 * Scans every folder under `handoffsBase`.
 */
export function selectSessionHandoff(
  handoffsBase: string,
  sessionIds: string[],
  now: number = Date.now(),
): SelectedHandoff | null {
  const wanted = new Set(sessionIds.filter(Boolean).map((s) => s.toLowerCase()));
  if (wanted.size === 0 || !fs.existsSync(handoffsBase)) return null;

  let best: SelectedHandoff | null = null;
  try {
    for (const dir of fs.readdirSync(handoffsBase)) {
      const dirPath = path.join(handoffsBase, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dirPath)) {
        if (!isHandoffFile(file)) continue;
        const filePath = path.join(dirPath, file);
        let st: fs.Stats;
        let content: string;
        try {
          st = fs.statSync(filePath);
          if (!st.isFile() || (best && st.mtimeMs <= best.mtime)) continue;
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }
        const sid = readFrontmatterField(content, 'session_id');
        if (!sid || !wanted.has(sid.toLowerCase())) continue;
        best = { path: filePath, content, mtime: st.mtimeMs };
      }
    }
  } catch {
    return null;
  }
  if (!best || handoffSkipReason(best.content, best.mtime, now)) return null;
  return best;
}

function goalAndNow(content: string): { goal: string; now: string } {
  const pick = (key: string): string => {
    const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ') : '';
  };
  return { goal: pick('goal'), now: pick('now') };
}

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** A pointer to this session's own handoff: path, goal, now. At most POINTER_MAX chars. */
export function buildHandoffPointer(handoffPath: string, content: string, projectDir: string): string {
  const rel = path.relative(projectDir, handoffPath).replace(/\\/g, '/');
  const shown = rel && !rel.startsWith('..') ? rel : handoffPath.replace(/\\/g, '/');
  const { goal, now } = goalAndNow(content);
  const head = `Your handoff: ${shown}\n`;
  const left = POINTER_MAX - head.length - 'goal: \nnow: '.length;
  const goalMax = Math.max(0, Math.min(goal.length, Math.floor(left / 2)));
  const goalText = clip(goal, goalMax);
  const nowText = clip(now, left - goalText.length);
  return `${head}goal: ${goalText}\nnow: ${nowText}`.slice(0, POINTER_MAX);
}
