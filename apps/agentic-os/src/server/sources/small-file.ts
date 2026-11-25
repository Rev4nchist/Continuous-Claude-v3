import 'server-only';

import { lstat, readFile } from 'node:fs/promises';

import { bytesRead } from '@/lib/reader-sources';

/**
 * A small JSON file, read once (card agentic-os-readers). Three outcomes, kept apart on purpose:
 *   text === null   the file does not exist (ENOENT): "missing", a normal state for some feeds;
 *   text === ''     it exists but cannot be used (a link, not a file, a read error): the parser calls that "unreadable";
 *   text  = string  the file content. `bytes` is the size on disk, so a file over the cap is "too large" without a read.
 * A corrupt file is never folded to "missing" and never to an empty store: that is the bug this reader exists to prevent.
 */
export async function readSmallFile(path: string, maxBytes: number): Promise<{ text: string | null; bytes: number; mtimeMs: number | null }> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return { text: '', bytes: 0, mtimeMs: null };
    if (info.size > maxBytes) return { text: '', bytes: info.size, mtimeMs: info.mtimeMs };
    const text = await readFile(path, 'utf8');
    return { text, bytes: bytesRead(info.size, text), mtimeMs: info.mtimeMs }; // a file that grew after lstat still reads as too large
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { text: null, bytes: 0, mtimeMs: null };
    return { text: '', bytes: 0, mtimeMs: null };
  }
}
