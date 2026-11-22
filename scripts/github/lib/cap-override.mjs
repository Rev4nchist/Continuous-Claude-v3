// RED stub (coord-cap-override PART B): models the behaviour before the change, so each test fails on an assertion, not on an import.
// The real helper replaces this file in the code commit.
import { decisionKey } from './decisions.mjs';

export const FLAG_USD = '--cli-cap-usd';
export const FLAG_EXTRA = '--cli-extra-run';
export const CAP_LIFT_LABEL = 'Lift the cap for this one run';
export const CAP_KEEP_LABEL = 'Keep the cap';
export const takeCapFlags = (argv) => ({ usd: null, extraRun: false, rest: [...argv] });
export const capFlagText = () => '';
export const capOverrideKey = ({ branch }) => decisionKey({ branch });
export const isLiftLabel = () => false;
export const claimCapOverride = () => ({ ok: false, reason: 'not implemented' });
