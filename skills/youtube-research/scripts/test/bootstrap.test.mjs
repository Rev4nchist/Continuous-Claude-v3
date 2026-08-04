// bootstrap.test.mjs — the pure halves of bootstrap.mjs: asset selection and
// install-path naming. The network/download path is exercised live, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assetForPlatform, bootstrapPath } from '../bootstrap.mjs';

test('assetForPlatform maps every supported platform/arch to an official asset', () => {
  assert.equal(assetForPlatform('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(assetForPlatform('win32', 'arm64'), 'yt-dlp.exe'); // arch-agnostic on Windows
  assert.equal(assetForPlatform('darwin', 'x64'), 'yt-dlp_macos');
  assert.equal(assetForPlatform('darwin', 'arm64'), 'yt-dlp_macos'); // universal binary
  assert.equal(assetForPlatform('linux', 'x64'), 'yt-dlp_linux');
  assert.equal(assetForPlatform('linux', 'arm64'), 'yt-dlp_linux_aarch64');
  assert.equal(assetForPlatform('linux', 'arm'), 'yt-dlp_linux_armv7l');
});

test('assetForPlatform throws on unsupported combinations rather than guessing', () => {
  assert.throws(() => assetForPlatform('linux', 'riscv64'), /linux\/riscv64/);
  assert.throws(() => assetForPlatform('freebsd', 'x64'), /"freebsd"/);
});

test('bootstrapPath uses a FIXED local name so config.mjs can resolve it blind', () => {
  // config.mjs reconstructs this exact path without importing bootstrap.mjs —
  // the two must agree or the fallback silently never fires.
  assert.equal(bootstrapPath('/s', 'linux'), join('/s', 'bin', 'yt-dlp'));
  assert.equal(bootstrapPath('/s', 'darwin'), join('/s', 'bin', 'yt-dlp'));
  assert.equal(bootstrapPath('C:\\s', 'win32'), join('C:\\s', 'bin', 'yt-dlp.exe'));
});
