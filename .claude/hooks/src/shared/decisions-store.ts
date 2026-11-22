/**
 * Typed door to the decision store (scripts/github/lib/decisions.mjs). The pathway-flow-v2 hooks
 * (decision-ledger, decision-gate) use it. esbuild bundles the .mjs into each hook, so the built hook has no
 * runtime path into scripts/.
 *
 * Do not import a file whose own main() runs on load (pre-pr-gate.ts): the bundle would run it inside the hook.
 */
import { readFileSync } from 'fs';
// @ts-ignore TS7016: decisions.mjs has no declaration file.
import * as store from '../../../../scripts/github/lib/decisions.mjs';

export type Step = 'ship' | 'open-pr' | 'review' | 'land' | 'paid-round' | 'cli-skip';
export interface Triple { step: Step; key: string; head: string }
export interface Offer extends Triple {
  nonce: string;
  labels: string[];
  spec: { header?: string; question?: string; options?: { label: string }[] };
  open: boolean;
}

export const MAX_REASKS: number = store.MAX_REASKS;
export const offerList: () => Offer[] = store.offerList;
export const offerWrite: (a: Triple & { spec: object; tree?: string | null; cwd?: string }) => { ok: true; nonce: string } | { ok: false; reason: string } = store.offerWrite;
export const decisionRead:(t: Triple) => { label: string; at: string } | null = store.decisionRead;
/** `entry` is the entry point of the recording process (CLAUDE_CODE_ENTRYPOINT of the hook); the store stamps it and `tapAt` on the decision. */
export const decisionRecord: (t: Triple & { label: string; entry?: string | null }) => { ok: true } | { ok: false; reason: string } = store.decisionRecord;
/** The stamp of a stored decision: the tap time and the entry point it was recorded under (null when the row has none). */
export interface DecisionStamp { label: string; at: string; tapAt: string | null; entry: string | null }
/** The label, the row time and the stamp of a decision, or null. */
export const decisionRowRead: (t: Triple) => DecisionStamp | null = store.decisionRowRead;
/** The cap in whole cents that a label names with "up to $X", or null (no price, no paid yes). */
export const capCentsOfLabel: (label: unknown) => number | null = store.capCentsOfLabel;
/** Writes the paid-round row of a paid pick (the confirm script writes it, with the stamp of the tap it used up). */
export const paidRoundWrite: (a: { key: string; head: string; label: string; tapAt: string | null; entry: string | null }) => { ok: true } | { ok: false; reason: string } = store.paidRoundWrite;
/**
 * Uses the decision up (single use). Call it only after the action it allows is decided. With a label, the row is used only when it still holds that label (reason `label-changed` otherwise).
 * `at`, `check` and `returnRow` are the options of decisions.mjs: a tap time guard, a row check run under the lock, and the used row's stamp in the result.
 */
export const decisionUse: (t: Triple & { label?: string; at?: string; check?: (row: unknown) => boolean; returnRow?: boolean }) => { ok: true; row?: DecisionStamp } | { ok: false; reason: string } = store.decisionUse;
export const missCount: (t: Triple) => number = store.missCount;
export const missBump: (t: Triple) => number = store.missBump;
export const decisionKey: (a: { repo?: string; pr?: number | string; branch?: string }) => string = store.decisionKey;
export const decisionsPath: (env?: NodeJS.ProcessEnv) => string = store.decisionsPath;

/** `tree` is the git tree the offer was bound to (decisions.mjs offerWrite -> decisionRecord), or null when the offer bound none or the value is not text. */
export interface DecisionRow { step: string; key: string; head: string; label: string; tree: string | null }

/**
 * Every recorded decision, read from the store file. decisions.mjs has no list call, and the land gate has no head to ask for
 * (a PreToolUse hook must not call GitHub), so it reads the rows. A missing or corrupt file is an empty list (fail closed).
 * The row id is "<step>\n<key>\n<head>" (decisions.mjs idOf). decisions-store.test.ts writes through the real store and reads here,
 * so a change of the id format fails that test.
 */
export function decisionRows(env: NodeJS.ProcessEnv = process.env): DecisionRow[] {
  try {
    const parsed = JSON.parse(readFileSync(decisionsPath(env), 'utf8')) as { decisions?: Record<string, { label?: unknown; tree?: unknown }> } | null;
    // Same rule as decisions.mjs readStore: any section that is not a plain object makes the whole store corrupt (fail closed).
    const plain = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!plain(parsed) || ['offers', 'decisions', 'misses'].some((k) => !plain((parsed as Record<string, unknown>)[k]))) return [];
    return Object.entries(parsed?.decisions ?? {}).flatMap(([id, d]) => {
      const [step, key, head] = id.split('\n');
      const tree = typeof d?.tree === 'string' && d.tree !== '' ? d.tree : null;
      return head !== undefined && typeof d?.label === 'string' ? [{ step, key, head, label: d.label, tree }] : [];
    });
  } catch {
    return [];
  }
}
