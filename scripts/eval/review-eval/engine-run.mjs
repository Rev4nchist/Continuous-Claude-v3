// One replayed round, reviewed by the local review engine (reviewHead in local-review.mjs) instead of cursor-review.mjs runReview.
// What the replay changes about the engine run, and nothing else:
//  - the head is the round's sha (the PR's real head may be later), and the base is the round's base: the gh answer for the PR is patched;
//  - the band config comes from the current checkout, because every dataset PR predates the matrix block and the engine refuses a base config without one;
//  - the run is --fresh and --engine-here, so the record says trusted:false;
//  - records and slots go to a state folder of this run, never under a local-review/ folder (LR-PIN reads there).
// toEvalFindings turns the engine record into the { file, line, lineEnd, severity, title } shape that evaluateRuns reads.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { readAtSha as realReadAtSha } from '../../github/local-review/context.mjs';
import { reviewHead as realReviewHead } from '../../github/local-review.mjs';
import { defaultGh } from './github.mjs';

const CONFIG_FILE = 'review-router.config.json';

/**
 * The engine record as eval findings: { findings, funnel, withdrawn, tracePath, runId, model, cursorAgentVersion, promptSha256, durationMs, usage }.
 * Only open findings count. line is the engine's startLine (the shape evaluateRuns and the cursor-review findings file use).
 */
export function toEvalFindings(record, { tracePath = null } = {}) {
  const last = (record.runs ?? []).at(-1) ?? {};
  return {
    runId: record.runId, model: record.model ?? null, cursorAgentVersion: record.cursorAgentVersion ?? null, promptSha256: record.promptSha256 ?? null,
    durationMs: last.durationMs ?? null, usage: last.usage ?? null, modelVerified: Boolean(last.modelVerified), trusted: record.trusted === true,
    funnel: record.funnel ?? null, withdrawn: record.withdrawn ?? [], tracePath,
    findings: (record.findings ?? []).filter((f) => (f.status ?? 'open') === 'open').map((f) => ({
      id: f.id, file: f.file, line: f.startLine ?? null, lineEnd: f.endLine ?? f.startLine ?? null, severity: f.severity, title: f.title, confidence: f.confidence ?? null,
    })),
  };
}

/** gh with the PR answer patched to the round: head sha, base sha, not a draft, no labels (the band then comes from the files only). */
function roundGh({ gh, repo, pr, sha40, base40 }) {
  return async (args) => {
    const out = await gh(args);
    const isPull = args[0] === 'api' && String(args[1]).endsWith(`/pulls/${pr}`);
    if (!isPull) return out;
    return { ...out, draft: false, labels: [], head: { ...out.head, sha: sha40 }, base: { ...out.base, sha: base40 } };
  };
}

/**
 * Runs the engine on one round. Never throws.
 * args: { pr, sha40, base40, root, stateRoot, stateDir, ledgerPath, env, configText, repo, gh, log, bodyMode }
 * bodyMode 'withheld' (the default) keeps the PR body out of CONTEXT.md: the body of a merged PR holds the findings and their fixes. 'full' keeps it.
 * deps (tests): { reviewHead, readAtSha, readFile }
 * -> { status: 'ok' | 'incomplete' | 'failed' | 'cap', reason?, record|null, recordPath|null, tracePath|null, baseConfig: { source, sha256 } }
 */
export async function runEngine(args, deps = {}) {
  const { pr, sha40, base40, root, stateRoot, stateDir, ledgerPath, env, configText, repo = DEFAULT_REPO, log = () => {}, bodyMode = 'withheld' } = args;
  const reviewHead = deps.reviewHead ?? realReviewHead;
  const base = deps.readAtSha ?? realReadAtSha;
  const baseConfig = { source: 'current checkout', sha256: createHash('sha256').update(configText).digest('hex') };
  const readAtSha = (r, s, p) => (p === CONFIG_FILE ? configText : base(r, s, p));
  const gh = roundGh({ gh: args.gh ?? defaultGh, repo, pr, sha40, base40 });
  let res;
  try {
    res = await reviewHead({ pr, fresh: true, engineHere: true, withholdBody: bodyMode !== 'full', evalRun: true, root, repo }, { env, gh, readAtSha, stateRoot, stateDir, cursorLedger: ledgerPath, stderr: log });
  } catch (err) {
    return { status: 'failed', reason: `reviewHead threw: ${err.message}`, record: null, recordPath: null, tracePath: null, baseConfig };
  }
  if (res.exit === 3) return { status: 'cap', reason: res.reason ?? 'cap reached', record: null, recordPath: null, tracePath: null, baseConfig };
  if (!res.recordPath) return { status: 'failed', reason: res.skipReason ? `skipped: ${res.skipReason}` : (res.reason ?? `exit ${res.exit}`), record: null, recordPath: null, tracePath: null, baseConfig };
  let record;
  try { record = JSON.parse((deps.readFile ?? ((f) => readFileSync(f, 'utf8')))(res.recordPath)); } catch (err) {
    return { status: 'failed', reason: `cannot read the record: ${err.message}`, record: null, recordPath: res.recordPath, tracePath: null, baseConfig };
  }
  const tracePath = res.recordPath.replace(/\.json$/, '.trace.json');
  // Same rule as isComplete in local-review.mjs: an ok record that did not cover every file is 'incomplete', never ok (its Majors would score as misses).
  const done = res.exit === 0 && record.status === 'ok';
  const ok = done && record.coverage?.complete === true;
  const status = ok ? 'ok' : done ? 'incomplete' : 'failed';
  const why = record.problems?.length ? record.problems.join('; ').slice(0, 300) : (res.reason ?? (done ? 'coverage incomplete' : `record status ${record.status}`));
  return { status, ...(ok ? {} : { reason: why }), record, recordPath: res.recordPath, tracePath, baseConfig };
}
