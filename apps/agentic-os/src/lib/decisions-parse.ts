/**
 * The strict reader of the decisions store (card agentic-os-readers, reader 3). PURE: no 'server-only', no '@/' import.
 *
 * The store is scripts/github/lib/decisions.mjs:186: {version:1, offers:{}, decisions:{}, misses:{}}. The script reader
 * treats a corrupt file as an EMPTY store (decisions.mjs:193-200). The app must not: a corrupt file is a source error, and
 * only a valid empty store is the zero state. The result holds counts only: no key, head, tree, cwd, nonce or question.
 */

export const DECISIONS_MAX_BYTES = 1024 * 1024;
/** decisions.mjs:27: the steps of an offer. Any other step name is counted as "other" so file text never leaves. */
const STEPS = new Set(['ship', 'open-pr', 'review', 'land', 'paid-round', 'cli-skip']);

export type DecisionsFailure = 'missing' | 'unreadable' | 'not-object' | 'bad-shape' | 'bad-version' | 'too-large';
export type DecisionsView =
  | { ok: true; offers: number; decisions: number; openByStep: Record<string, number> }
  | { ok: false; reason: DecisionsFailure };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDecisionsStore(text: string | null, byteLength?: number): DecisionsView {
  if (text === null) return { ok: false, reason: 'missing' };
  if ((byteLength ?? new TextEncoder().encode(text).length) > DECISIONS_MAX_BYTES) return { ok: false, reason: 'too-large' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!isPlain(doc)) return { ok: false, reason: 'not-object' };
  if (doc.version !== 1) return { ok: false, reason: 'bad-version' };
  if (!isPlain(doc.offers) || !isPlain(doc.decisions) || !isPlain(doc.misses)) return { ok: false, reason: 'bad-shape' };
  const openByStep: Record<string, number> = {};
  for (const offer of Object.values(doc.offers)) {
    const step = isPlain(offer) && typeof offer.step === 'string' && STEPS.has(offer.step) ? offer.step : 'other';
    openByStep[step] = (openByStep[step] ?? 0) + 1;
  }
  return { ok: true, offers: Object.keys(doc.offers).length, decisions: Object.keys(doc.decisions).length, openByStep };
}

/** The open-offer count, or null when the store could not be read: an error never reads as 0. */
export function decisionsOpenCount(view: DecisionsView): number | null {
  return view.ok ? view.offers : null;
}
