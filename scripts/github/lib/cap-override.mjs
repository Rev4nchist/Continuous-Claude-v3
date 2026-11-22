// The one-run CLI cap override (card coord-cap-override, PART B). Two flags, each lifts ONE limit for ONE run:
//   --cli-cap-usd N    lifts the daily USD cap (coderabbit.cli_daily_cap_usd) for that run; N must be above the config cap
//   --cli-extra-run    lifts the per-branch run count (CR_RUN_LIMIT) for that run; the USD cap still applies
// A flag is never written to config and never read from the environment. Dave's tap opens it: a ship-ask cap-override question, stored as
// step `cli-skip` with the key `repo@branch!cap:<flag set>` (the flag set is `usd=N`, `extra` or `usd=N,extra`) and the head. The tap binds
// branch + head + flag set + USD value and is used once (claimCapOverride). The decision-gate rule reads the same key
// (.claude/hooks/src/decision-gate.ts, capOverrideDeny) and only reads: the script claims. Tests: scripts/github/cap-override.test.mjs.
import { decisionKey, decisionRead, decisionUse } from './decisions.mjs';

export const FLAG_USD = '--cli-cap-usd';
export const FLAG_EXTRA = '--cli-extra-run';
export const CAP_LIFT_LABEL = 'Lift the cap for this one run';
export const CAP_KEEP_LABEL = 'Keep the cap';
/** The store step of the tap. The plain-key decision of this step is the flag skip of pre-pr-gate; the `!cap:` key is a different decision. */
export const CAP_STEP = 'cli-skip';

/** A USD value in its one canonical text: a positive number with at most 2 decimals, no sign, no leading or trailing zero, no exponent. */
const USD_TEXT = /^(?:[1-9]\d*|0)(?:\.\d{1,2})?$/;
const canonicalUsd = (text) => {
  if (typeof text !== 'string' || !USD_TEXT.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && String(n) === text ? n : null;
};

/**
 * Take the cap flags out of `argv`. Returns { usd, extraRun, rest } (rest: argv without the cap flags) or { error }.
 * The USD flag takes the next token as its value (no equals form); the extra-run flag takes none. Each may appear once.
 * Only argv is read: no environment variable and no config key lifts a cap.
 */
export function takeCapFlags(argv) {
  let usd = null;
  let extraRun = false;
  let seenUsd = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === FLAG_USD) {
      if (seenUsd) return { error: `${FLAG_USD} was given twice` };
      seenUsd = true;
      const value = argv[i + 1];
      usd = canonicalUsd(value);
      if (usd === null) return { error: `${FLAG_USD} needs one positive number with at most 2 decimals and no trailing zero, for example 6 or 5.5 (got ${value === undefined ? 'nothing' : JSON.stringify(value)})` };
      i += 1;
    } else if (a === FLAG_EXTRA) {
      if (extraRun) return { error: `${FLAG_EXTRA} was given twice` };
      extraRun = true;
    } else if (a.startsWith(`${FLAG_USD}=`) || a.startsWith(`${FLAG_EXTRA}=`)) {
      return { error: `${a.split('=')[0]} takes no equals sign: ${a.startsWith(FLAG_USD) ? `${FLAG_USD} 6` : FLAG_EXTRA}` };
    } else rest.push(a);
  }
  return { usd, extraRun, rest };
}

/** The canonical text of a flag set: `usd=6,extra`, `usd=5.5`, `extra`, or '' for none. */
export function capFlagText({ usd = null, extraRun = false } = {}) {
  return [usd === null || usd === undefined ? '' : `usd=${usd}`, extraRun ? 'extra' : ''].filter(Boolean).join(',');
}

/** The decision key of a tap: the branch key plus `!cap:` and the flag set. */
export function capOverrideKey({ branch, usd = null, extraRun = false, repo }) {
  return `${decisionKey({ branch, ...(repo ? { repo } : {}) })}!cap:${capFlagText({ usd, extraRun })}`;
}

/** The tap label that lifts the cap (the recommended suffix is allowed). */
export const isLiftLabel = (label) => typeof label === 'string' && new RegExp(`^${CAP_LIFT_LABEL}(?: \\(Recommended\\))?$`).test(label);

/**
 * Claim Dave's tap for this branch, head and flag set: read the decision, check the label, use it up. { ok: true, tapAt } or { ok: false, reason }.
 * A second claim is refused (the decision is gone). Any store problem is a refusal (fail closed).
 */
export function claimCapOverride({ branch, head, usd = null, extraRun = false }) {
  try {
    if (!branch || !head || capFlagText({ usd, extraRun }) === '') return { ok: false, reason: 'no-flag-set' };
    const t = { step: CAP_STEP, key: capOverrideKey({ branch, usd, extraRun }), head: String(head).toLowerCase() };
    const d = decisionRead(t);
    if (!d || !isLiftLabel(d.label)) return { ok: false, reason: 'no-decision' };
    const used = decisionUse({ ...t, label: d.label });
    return used.ok === true ? { ok: true, tapAt: d.at } : { ok: false, reason: used.reason ?? 'not-used' };
  } catch (err) {
    return { ok: false, reason: `store-error: ${String(err?.message ?? err).split('\n')[0]}` };
  }
}

/** Like claimCapOverride, read-only: is there a live tap for this branch, head and flag set? Used before a run starts, so a missing tap stops it early. */
export function hasCapOverride({ branch, head, usd = null, extraRun = false }) {
  try {
    if (!branch || !head || capFlagText({ usd, extraRun }) === '') return false;
    const d = decisionRead({ step: CAP_STEP, key: capOverrideKey({ branch, usd, extraRun }), head: String(head).toLowerCase() });
    return Boolean(d) && isLiftLabel(d.label);
  } catch { return false; }
}

/** The text of a refusal, for stderr and for a step detail. */
export const noTapText = (flagText) => `no Dave tap for the cap override (${flagText}) on this branch and head. Ask him first: node scripts/github/ship-ask.mjs cap-override --branch <branch> [--usd N] [--extra-run] --json, pass its JSON to AskUserQuestion word for word, then run the command once. The tap is single use.`;
