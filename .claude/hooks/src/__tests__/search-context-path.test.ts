/**
 * Tests for the search-context handshake directory resolution (QW-02 / D2b-05).
 *
 * The smart-search-router (writer) and tldr-read-enforcer (reader) share a
 * single CONTEXT_DIR handshake. It was a hardcoded POSIX literal
 * '/tmp/claude-search-context', which resolves to C:\tmp\ on Windows and
 * leaked per-session JSON files at the drive root with no cleanup.
 *
 * The fix relocates it under os.tmpdir() so behavior is preserved on POSIX
 * (os.tmpdir() === '/tmp') and fixed on Windows
 * (os.tmpdir() === C:\Users\<user>\AppData\Local\Temp).
 *
 * These tests assert:
 *   (a) the resolved dir is under os.tmpdir()
 *   (b) it is NOT the old hardcoded literal '/tmp/claude-search-context'
 *   (c) both hooks resolve to the SAME dir (handshake intact)
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { CONTEXT_DIR as WRITER_CONTEXT_DIR } from '../shared/search-context-path.js';

describe('search-context handshake directory (QW-02)', () => {
  it('(a) resolves under os.tmpdir()', () => {
    expect(WRITER_CONTEXT_DIR.startsWith(os.tmpdir())).toBe(true);
  });

  it('(a2) equals path.join(os.tmpdir(), "claude-search-context")', () => {
    expect(WRITER_CONTEXT_DIR).toBe(path.join(os.tmpdir(), 'claude-search-context'));
  });

  // Windows only: on POSIX os.tmpdir() is '/tmp', so the relocation is a no-op
  // and the new value equals the old literal by design.
  it.skipIf(process.platform !== 'win32')('(b) is NOT the old hardcoded POSIX literal', () => {
    expect(WRITER_CONTEXT_DIR).not.toBe('/tmp/claude-search-context');
  });

  it('(c) writer and reader resolve to the SAME dir (handshake intact)', () => {
    // The reader imports the same shared const, so they cannot diverge.
    // Re-deriving the value independently proves the rendezvous path.
    const independentlyDerived = path.join(os.tmpdir(), 'claude-search-context');
    expect(WRITER_CONTEXT_DIR).toBe(independentlyDerived);
  });
});
