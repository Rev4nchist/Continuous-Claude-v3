/**
 * PR C2b of card coord-guard-shell-parser: the hand reader of the create, land and merge guards is gone, so decide() and handle() read the parse that withParsed
 * makes (as the hook does in production). A call with no parse and a text that names a guarded call is denied `parser-unavailable`. A test that wants the verdict of
 * a command goes through these two helpers: they parse first, then decide. A row that sets `parsed` or `parseLate` itself keeps it (the parse is not made twice).
 * The parse is a pure function of the text and the tool, so one parse per (tool, text) is kept for the file (the PowerShell walker costs about 300 ms).
 */
import { decide, handle, withParsed, type Deps } from '../../decision-gate.js';

type Input = Parameters<typeof decide>[0];
const cache = new Map<string, Pick<Deps, 'parsed' | 'parseLate'>>();

/** The deps of the call with the parse of its text (made once for the same raw payload). */
export async function parsedDeps(raw: string, deps: Deps): Promise<Deps> {
  if (deps.parsed !== undefined || deps.parseLate !== undefined) return deps;
  if (deps.parseOpts !== undefined || deps.parseBudgetMs !== undefined) return withParsed(raw, deps); // a row that sets a parser seam gets its own parse
  let key = raw;
  try { const i = JSON.parse(raw) as { tool_name?: string; tool?: string; tool_input?: unknown; command?: unknown }; key = JSON.stringify([i.tool_name ?? i.tool, i.tool_input ?? i.command]); } catch { /* keep the raw text */ }
  const hit = cache.get(key);
  if (hit) return { ...deps, ...hit };
  const w = await withParsed(raw, deps);
  if (w.parsed !== undefined || w.parseLate !== undefined) cache.set(key, { ...(w.parsed !== undefined ? { parsed: w.parsed } : {}), ...(w.parseLate !== undefined ? { parseLate: w.parseLate } : {}) });
  return w;
}
/** decide() with the parse of the input made first. */
export async function decideParsed(input: Input, deps: Deps, found?: Parameters<typeof decide>[2]): Promise<ReturnType<typeof decide>> {
  return decide(input, await parsedDeps(JSON.stringify(input), deps), found);
}
/** handle() with the parse of the raw payload made first. */
export async function handleParsed(raw: string, deps: Deps): Promise<string> {
  return handle(raw, await parsedDeps(raw, deps));
}
