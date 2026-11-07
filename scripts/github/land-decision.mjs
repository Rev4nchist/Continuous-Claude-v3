#!/usr/bin/env node
// land-decision.mjs - the land-pr.ps1 check of Dave's land tap (pathway flow v2, design N4).
//
// Dave answers the "Land" question (ship-ask.mjs land) with AskUserQuestion. The decision-ledger hook writes his tap to the decision
// store (lib/decisions.mjs). land-pr.ps1 calls this script when decisions.enforce is true:
//   check <pr> --repo <o/r> --head <sha>   exit 0 when the tap for (PR, head) is "Land now" or "Land when READY"; 1 = refused; 2 = bad usage.
//   use   <pr> --repo <o/r> --head <sha>   uses the tap up. land-pr.ps1 calls it AFTER the merge succeeds, never before.
// The tap is bound to the head. A push after the tap moves the head, so the tap no longer counts. Keep open, Return to draft and every
// other label refuse. An unreadable store reads as "no tap" and refuses (fail closed).
// Tests: land-decision.test.mjs. The same label rule is in .claude/hooks/src/decision-gate.ts (isLandLabel).
import { pathToFileURL } from 'node:url';
import { decisionKey, decisionRead, decisionUse } from './lib/decisions.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const LAND_LABEL = /^Land (?:now|when READY)\b/;

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** { pr, repo, head } from the arguments, or null when the usage is wrong. */
function parse(argv) {
  const pr = argv[1];
  const head = flag(argv, '--head');
  if (!/^\d+$/.test(pr ?? '') || !/^[0-9a-f]{7,64}$/i.test(head ?? '')) return null;
  return { pr: Number(pr), repo: flag(argv, '--repo') ?? REPO, head };
}

export function landVerdict({ pr, repo, head }) {
  const triple = { step: 'land', key: decisionKey({ repo, pr }), head };
  const d = decisionRead(triple);
  if (d && LAND_LABEL.test(d.label)) return { ok: true, text: `land decision: Dave tapped "${d.label}" for PR #${pr} at ${head.slice(0, 7)} (${d.at}).`, triple };
  const why = d ? `his tap for this head was "${d.label}", which does not land the PR` : 'no tap from Dave is on record for this PR at this head';
  return { ok: false, triple, text: `REFUSED: ${why}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json and pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets the land run.` };
}

export function main(argv) {
  const mode = argv[0];
  const args = mode === 'check' || mode === 'use' ? parse(argv) : null;
  if (!args) {
    console.error('usage: land-decision.mjs <check|use> <pr> --repo <o/r> --head <sha>');
    return 2;
  }
  const v = landVerdict(args);
  if (mode === 'check') {
    console.log(v.text);
    return v.ok ? 0 : 1;
  }
  console.log(decisionUse(v.triple).ok ? `land decision for PR #${args.pr} used up.` : `no land decision to use up for PR #${args.pr}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
