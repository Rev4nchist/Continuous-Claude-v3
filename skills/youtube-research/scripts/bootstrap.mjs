#!/usr/bin/env node
// bootstrap.mjs — get a working yt-dlp with zero user setup.
//
//   node bootstrap.mjs [--force] [--json]
//
// Order of preference (mirrors config.mjs resolution):
//   1. YTDLP_EXE env override        — respected, never replaced
//   2. yt-dlp already on PATH        — respected, never replaced (unless --force)
//   3. previously bootstrapped copy  — reused if it still runs
//   4. download the official single-file release for this platform into
//      <STATE_ROOT>/bin/ and verify it runs
//
// Why download-at-runtime instead of bundling: yt-dlp MUST track YouTube's
// breakage cadence (see SKILL.md Known limits), so a copy baked into the plugin
// zip is stale on arrival — and it would bloat a 35KB plugin to 30MB+.
//
// The bootstrapped copy self-updates with `<path> -U`, or re-run with --force.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE_ROOT } from './lib/config.mjs';

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

// Pure — tested. Maps (platform, arch) to the official single-file release asset.
// Windows/mac assets are arch-agnostic (the x64 exe runs on ARM Windows via
// emulation; yt-dlp_macos is universal). Linux is per-arch static builds.
export function assetForPlatform(platform, arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    if (arch === 'x64') return 'yt-dlp_linux';
    if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
    if (arch === 'arm') return 'yt-dlp_linux_armv7l';
    throw new Error(`No yt-dlp release asset for linux/${arch}`);
  }
  throw new Error(`No yt-dlp release asset for platform "${platform}"`);
}

// Pure — tested. Where the bootstrapped copy lives. Always a fixed local name so
// config.mjs can find it without knowing which asset it came from.
export function bootstrapPath(stateRoot, platform) {
  return join(stateRoot, 'bin', platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function runs(exe) {
  const res = spawnSync(exe, ['--version'], {
    timeout: 30_000, windowsHide: true, encoding: 'utf8', input: '',
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A release binary is many MB; a tiny body is an error page, not yt-dlp.
  if (buf.length < 1_000_000) {
    throw new Error(`Download suspiciously small (${buf.length} bytes) — refusing to install it`);
  }
  writeFileSync(dest, buf);
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  return buf.length;
}

export async function ensureYtdlp({ force = false } = {}) {
  const envOverride = process.env.YTDLP_EXE;
  if (envOverride) {
    const v = runs(envOverride);
    if (v) return { exe: envOverride, version: v, source: 'YTDLP_EXE' };
    throw new Error(`YTDLP_EXE is set to "${envOverride}" but it does not run. Fix or unset it.`);
  }

  if (!force) {
    const onPath = runs('yt-dlp');
    if (onPath) return { exe: 'yt-dlp', version: onPath, source: 'PATH' };
  }

  const dest = bootstrapPath(STATE_ROOT, process.platform);
  if (!force && existsSync(dest)) {
    const v = runs(dest);
    if (v) return { exe: dest, version: v, source: 'bootstrapped (existing)' };
    // exists but broken -> fall through and re-download over it
  }

  const asset = assetForPlatform(process.platform, process.arch);
  const url = `${RELEASE_BASE}/${asset}`;
  mkdirSync(join(STATE_ROOT, 'bin'), { recursive: true });
  process.stderr.write(`Downloading ${asset} (latest release, ~10-35MB)...\n`);
  const bytes = await download(url, dest);

  const v = runs(dest);
  if (!v) throw new Error(`Downloaded ${dest} (${bytes} bytes) but it does not run on this system.`);
  return { exe: dest, version: v, source: 'bootstrapped (downloaded)', bytes };
}

async function main() {
  const force = process.argv.includes('--force');
  const json = process.argv.includes('--json');
  const r = await ensureYtdlp({ force });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`yt-dlp ${r.version} ready (${r.source})`);
    console.log(`  ${r.exe}`);
    if (r.source.startsWith('bootstrapped')) {
      console.log('  Every plugin command finds this copy automatically. Update later with:');
      console.log(`  "${r.exe}" -U   (or re-run bootstrap with --force)`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`bootstrap failed: ${e.message}`); process.exit(1); });
}
