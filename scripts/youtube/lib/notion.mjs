// notion.mjs — thin ntn wrapper for the YouTube Research registry.
// ESM, no external deps.
//
// NTN_EXE is imported from project-cards/lib/config.mjs, which that file declares
// the single source of truth for the executable path. Do NOT re-hardcode it here.
//
// Honors the ntn non-interactive contract on every call (closed stdin, hard
// timeout, windowsHide, fail-loud) per .claude/rules/notion-cli-safety.md.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NTN_EXE } from '../../project-cards/lib/config.mjs';
import { YT_ROOT } from './config.mjs';

export const IDS_PATH = join(YT_ROOT, 'youtube-research.ids.json');
const TIMEOUT_MS = Number(process.env.NTN_TIMEOUT_MS || 60_000);
const TRANSIENT_RE = /429|rate|timeout|5\d\d|ECONN|ETIMEDOUT|Failed to execute public API request/i;
const MAX_ATTEMPTS = 3;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runNtn(args, { input = '' } = {}) {
  let lastDetail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = spawnSync(NTN_EXE, args, {
      input,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Pin the API version so a call never triggers a per-call OpenAPI fetch and
      // so data-source semantics (2025-09-03) stay stable.
      env: { ...process.env, NOTION_API_VERSION: process.env.NOTION_API_VERSION || '2025-09-03' },
    });

    if (!res.error && res.status === 0) return res.stdout;

    const detail = res.error
      ? `spawn failed: ${res.error.message}`
      : (res.stderr || res.stdout || '').trim();
    lastDetail = detail;

    if (TRANSIENT_RE.test(detail) && attempt < MAX_ATTEMPTS) {
      const backoff = 500 * 2 ** (attempt - 1);
      console.error(`[ntn] transient failure attempt ${attempt}/${MAX_ATTEMPTS}: ${detail} — retrying in ${backoff}ms`);
      sleepMs(backoff);
      continue;
    }

    throw new Error(`ntn failed [${args[0]} ${args[1] ?? ''}]: ${detail}`);
  }
  throw new Error(`ntn failed after ${MAX_ATTEMPTS} attempts: ${lastDetail}`);
}

function parseJson(out, what) {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${what} returned non-JSON: ${String(out).slice(0, 400)}`);
  }
}

export function apiGet(path) {
  return parseJson(runNtn(['api', path]), `GET ${path}`);
}

export function apiPost(path, body) {
  return parseJson(runNtn(['api', path, '-X', 'POST'], { input: JSON.stringify(body) }), `POST ${path}`);
}

export function apiPatch(path, body) {
  return parseJson(runNtn(['api', path, '-X', 'PATCH'], { input: JSON.stringify(body) }), `PATCH ${path}`);
}

// Create a page from Markdown. ntn does the markdown -> Notion block conversion,
// which is why digests are authored as markdown and never as hand-built blocks.
export function createPageFromMarkdown(parentSpec, markdown) {
  const out = runNtn(['pages', 'create', '--parent', parentSpec, '--content', markdown, '--json']);
  return parseJson(out, 'pages create');
}

// --- ids file ----------------------------------------------------------------
export function readIds() {
  if (!existsSync(IDS_PATH)) return null;
  try { return JSON.parse(readFileSync(IDS_PATH, 'utf8')); } catch { return null; }
}

export function writeIds(ids) {
  writeFileSync(IDS_PATH, `${JSON.stringify(ids, null, 2)}\n`, 'utf8');
  return IDS_PATH;
}

export function requireIds() {
  const ids = readIds();
  if (!ids?.dataSourceId) {
    throw new Error(
      `YouTube Research DB not set up yet (${IDS_PATH} missing or incomplete).\n` +
      'Run: node scripts/youtube/setup-notion.mjs --confirm',
    );
  }
  return ids;
}

// --- property helpers --------------------------------------------------------
export const title = (s) => ({ title: [{ type: 'text', text: { content: String(s).slice(0, 2000) } }] });
export const richText = (s) => ({
  rich_text: s === null || s === undefined || s === ''
    ? []
    : [{ type: 'text', text: { content: String(s).slice(0, 2000) } }],
});
export const select = (s) => ({ select: s ? { name: String(s) } : null });
export const number = (n) => ({ number: n === null || n === undefined ? null : Number(n) });
export const date = (d) => ({ date: d ? { start: String(d) } : null });
export const url = (u) => ({ url: u || null });
