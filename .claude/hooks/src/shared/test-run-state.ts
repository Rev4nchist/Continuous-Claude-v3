import * as os from 'os';
import * as path from 'path';

/** One state path for the tracker, the reader and their tests. No truncation: a 36-char UUID must round-trip. */
export function getStateFile(sessionId: string | undefined): string | null {
  // No id, no file: a shared fallback would let one id-less session silence the advisory in another.
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(os.tmpdir(), `claude-recent-test-runs-${safe}.json`);
}
