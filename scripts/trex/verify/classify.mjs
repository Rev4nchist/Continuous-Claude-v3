// classify.mjs: a pure pre-filter for TREX verify. No model, no file reads, no process state.
// It classifies one FINDING by the file it cites, not a whole row by its host. It answers one question:
// can a probe in the TREX container reproduce this finding, or must it be blocked before any spend?
//
//   classify(finding, { source? }) -> { blocked: reason | null, surface }
//
// reason is one of the fixed blocked reasons of the verify design (section 3): windows-only,
// surface-unverifiable, mods-host. `source` is the text of the cited file at the PR head. It is optional:
// only the mods-host rule reads it, and without it that rule goes by the path alone.
//
// mods-host evidence (P0, 2026-11-03):
//  - The mod-event driver (drivers/mod-event.mjs) runs `claude plugin test <name>` on the HOST profile only.
//  - The TREX image has Node and the root lockfile packages. It has no JSX loader (no esbuild, no tsx) and no
//    `claude-code` module, and node --experimental-strip-types does not read .tsx.
//  - The bench flows that touch ccv3-mods (S4, S5, S10) import pure .ts models (brief.ts, os-tabs-model.ts,
//    model.ts) with strip-types plus a resolve hook. They never import index.tsx.
// So a ccv3-mods .tsx entry file, and a .ts file that imports `claude-code` at run time, need the live host.
// A ccv3-mods .ts model with no such import does not: it is not blocked.

const WINDOWS_EXT = new Set(['ps1', 'psm1', 'psd1', 'bat', 'cmd']);
const UI_EXT = new Set(['css', 'scss', 'html', 'htm']);
const DOC_EXT = new Set(['md', 'mdx', 'markdown']);
const NODE_EXT = new Set(['mjs', 'cjs', 'js', 'ts', 'tsx', 'jsx']);
const SHELL_EXT = new Set(['sh', 'bash']);

const RULES_DIR = /(^|\/)\.claude\/rules[^/]*\//;
const SKILLS_DIR = /(^|\/)\.claude\/skills\//;
const AGENTS_DIR = /(^|\/)\.claude\/agents\//;
const MODS_DIR = /(^|\/)\.claude\/plugins\/ccv3-mods\//;
/** The branch of process.platform that is Windows, or a plain win32-only / Windows-only statement. `!==` is the other branch and does not match. */
const WIN32_BRANCH = /process\.platform\s*===?\s*['"]win32['"]|\bwin32[- ]only\b|\bwindows[- ]only\b|\bonly on windows\b/i;
/** An import of `claude-code` that survives type stripping. `import type` is erased and does not count. */
const RUNTIME_HOST_IMPORT = /^[ \t]*import\s+(?!type\b)[^;\n]*?\bfrom\s+['"]claude-code['"]/m;

const normalize = (file) => String(file).replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
const extOf = (p) => (/\.([a-z0-9]+)$/.exec(p.slice(p.lastIndexOf('/') + 1)) ?? [])[1] ?? '';
const result = (blocked, surface) => ({ blocked, surface });

function pathClass(p, ext) {
  if (WINDOWS_EXT.has(ext)) return result('windows-only', 'windows-script');
  if (p.split('/').includes('scheduled')) return result('windows-only', 'scheduled');
  if (RULES_DIR.test(p)) return result('surface-unverifiable', 'rule');
  if (SKILLS_DIR.test(p) || p.endsWith('/skill.md') || p === 'skill.md') return result('surface-unverifiable', 'skill');
  if (AGENTS_DIR.test(p)) return result('surface-unverifiable', 'agent');
  if (DOC_EXT.has(ext)) return result('surface-unverifiable', 'doc');
  if (UI_EXT.has(ext)) return result('surface-unverifiable', 'ui');
  return null;
}

function modsClass(p, ext, source) {
  if (!MODS_DIR.test(p)) return null;
  if (ext === 'tsx') return result('mods-host', 'mods-entry');
  if (ext !== 'ts') return null;
  if (typeof source === 'string' && RUNTIME_HOST_IMPORT.test(source)) return result('mods-host', 'mods-engine');
  return result(null, 'mods-model');
}

/** True when classify can use the file text: only a ccv3-mods .ts file, where a run-time claude-code import means mods-host. */
export const wantsSource = (file) => MODS_DIR.test(normalize(file)) && extOf(normalize(file)) === 'ts';

const plainSurface = (ext) => (NODE_EXT.has(ext) ? 'node' : SHELL_EXT.has(ext) ? 'shell' : 'other');

/**
 * @param {{file: string, title?: string, body?: string}} finding
 * @param {{source?: string}} [opts] the cited file's text at the PR head, for the mods-host import check
 * @returns {{blocked: 'windows-only'|'surface-unverifiable'|'mods-host'|null, surface: string}}
 */
export function classify(finding, opts = {}) {
  if (typeof finding?.file !== 'string' || finding.file === '') throw new TypeError('classify: finding.file is required');
  const p = normalize(finding.file);
  const ext = extOf(p);
  const byPath = pathClass(p, ext);
  if (byPath) return byPath;
  const mods = modsClass(p, ext, opts?.source);
  if (mods?.blocked) return mods;
  if (WIN32_BRANCH.test(`${finding.title ?? ''}\n${finding.body ?? ''}`)) return result('windows-only', 'win32-branch');
  return mods ?? result(null, plainSurface(ext));
}
