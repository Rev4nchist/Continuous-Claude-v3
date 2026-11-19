/**
 * One freshness rule for session-start-init-check and hook-health-monitor.
 *
 * Cause of the false positive: both checks compared mtimes. A git checkout
 * and a copy-based sync (scripts/sync-to-active.sh) stamp mtimes in write
 * order, not build order, so a source file copied after its bundle looks
 * newer even when the bundle was built from those exact bytes.
 *
 * The rule ignores mtime. `npm run build` writes dist/.build-inputs.json,
 * a sha256 of each build input. A source is stale only when that hash
 * differs, or the file is missing from the manifest. When the manifest is
 * absent (an install that has not been rebuilt since this change), the
 * check does not warn: an mtime guess is the false positive. The caller
 * prints one info line instead.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const BUILD_INPUTS_NAME = '.build-inputs.json';

export const MANIFEST_MISSING_INFO =
  '[i] Hook dist freshness manifest missing (.build-inputs.json); not using mtime, so no stale warning. Run: cd ~/continuous-claude/.claude/hooks && npm run build';

export interface BuildInputsManifest {
  version: 1;
  algorithm: 'sha256';
  inputs: Record<string, string>;
  /** Files the bundler read from outside src (item 14): repo-relative posix path to { sha256 }. Empty for an older manifest. */
  external: Record<string, { sha256: string }>;
}

export interface TreeFreshness {
  state: 'fresh' | 'stale' | 'unknown';
  staleFiles: string[];
  srcCount: number;
  /** Repo-relative keys of the external inputs that changed or are missing, sorted. */
  staleExternal?: string[];
  info?: string;
}

export interface FileFreshness {
  state: 'fresh' | 'stale' | 'unknown';
  info?: string;
}

/**
 * Hash the LF form of the text. A Windows checkout with core.autocrlf=true
 * stores the same source with CR bytes; those must not look stale.
 * write-build-inputs.mjs strips CR the same way before it records the manifest.
 */
export function sha256(content: Buffer | string): string {
  const text = (typeof content === 'string' ? content : content.toString('utf8')).replace(/\r/g, '');
  return createHash('sha256').update(text).digest('hex');
}

/** Relative posix path from the hooks src root. The build script uses the same key. */
export function srcKey(srcRoot: string, filePath: string): string {
  return path.relative(srcRoot, filePath).split(path.sep).join('/');
}

export function listSrcFiles(srcRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(srcRoot);
  return out;
}

export function loadBuildInputs(distDir: string): BuildInputsManifest | null {
  const manifestPath = path.join(distDir, BUILD_INPUTS_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<BuildInputsManifest>;
    if (parsed.version !== 1 || parsed.algorithm !== 'sha256' || !parsed.inputs || typeof parsed.inputs !== 'object') {
      return null;
    }
    const ext = parsed.external;
    const external = ext && typeof ext === 'object' && !Array.isArray(ext) ? ext : {};
    return { version: 1, algorithm: 'sha256', inputs: parsed.inputs, external };
  } catch {
    return null;
  }
}

export function assessFileFreshness(
  srcPath: string,
  srcRoot: string,
  manifest: BuildInputsManifest | null,
): FileFreshness {
  if (!manifest) return { state: 'unknown', info: MANIFEST_MISSING_INFO };
  let current: string;
  try {
    current = sha256(fs.readFileSync(srcPath));
  } catch {
    return { state: 'stale' };
  }
  const recorded = manifest.inputs[srcKey(srcRoot, srcPath)];
  if (!recorded || recorded !== current) return { state: 'stale' };
  return { state: 'fresh' };
}

/**
 * The external inputs of the manifest whose file under `repoRoot` changed or is missing, sorted.
 * The caller names the repo root: it is the tree the bundle was built from, never ~/.claude.
 */
export function staleExternalKeys(manifest: BuildInputsManifest, repoRoot: string): string[] {
  const stale: string[] = [];
  for (const [key, recorded] of Object.entries(manifest.external)) {
    let current: string | null = null;
    try {
      current = sha256(fs.readFileSync(path.join(repoRoot, ...key.split('/'))));
    } catch {
      current = null;
    }
    if (current === null || typeof recorded?.sha256 !== 'string' || current !== recorded.sha256) stale.push(key);
  }
  return stale.sort();
}

/** `repoRoot` is the repo the hooks were built in; by default the folder three levels above `srcRoot` (<repo>/.claude/hooks/src). */
export function assessTreeFreshness(srcRoot: string, distDir: string, repoRoot: string = path.resolve(srcRoot, '..', '..', '..')): TreeFreshness {
  const srcFiles = listSrcFiles(srcRoot);
  const manifest = loadBuildInputs(distDir);
  if (!manifest) {
    return { state: 'unknown', staleFiles: [], srcCount: srcFiles.length, info: MANIFEST_MISSING_INFO };
  }
  const staleFiles = srcFiles.filter(file => assessFileFreshness(file, srcRoot, manifest).state === 'stale');
  const staleExternal = staleExternalKeys(manifest, repoRoot);
  return {
    state: staleFiles.length + staleExternal.length > 0 ? 'stale' : 'fresh',
    staleFiles,
    srcCount: srcFiles.length + Object.keys(manifest.external).length,
    staleExternal,
  };
}

export function formatStaleDistWarning(srcRoot: string, result: TreeFreshness): string | null {
  if (result.state === 'unknown') return result.info ?? MANIFEST_MISSING_INFO;
  if (result.state !== 'stale') return null;
  const all = [...result.staleFiles.map(file => srcKey(srcRoot, file)), ...(result.staleExternal ?? [])];
  const names = all.slice(0, 3).join(', ');
  const more = all.length > 3 ? `, +${all.length - 3} more` : '';
  return `[!] Hook dist/ is stale -- ${all.length} of ${result.srcCount} sources differ from the build manifest (${names}${more}). Run: cd ~/continuous-claude/.claude/hooks && npm run build`;
}
