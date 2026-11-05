// The prompt freeze (v0). checkFreeze compares sha256(buildPrompt(...)) with the recorded hash.
// The blob of cursor-review.mjs is recorded for information only: other edits to that file (the C0 hardening) are not a prompt change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPrompt } from '../../github/cursor-review.mjs';
import { buildEnginePrompt } from '../../github/local-review/prompt.mjs';
import { CONFIG_PATH } from './config.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** sha256 of the prompt for a fixed dummy range, so it depends on the prompt text only. */
export function promptSha256({ build = buildPrompt } = {}) {
  return sha256(String(build({ ref: 'range-00000000..00000000', files: ['a.mjs'] })));
}

/** { ok, promptSha256, reason? }. A missing freeze is not ok. */
export function checkFreeze(cfg, { build = buildPrompt } = {}) {
  const frozen = cfg?.freeze?.promptSha256;
  const now = promptSha256({ build });
  if (!frozen) return { ok: false, promptSha256: now, reason: 'no freeze recorded: run `cli.mjs freeze` first' };
  if (frozen !== now) return { ok: false, promptSha256: now, reason: `the prompt changed since the freeze (frozen ${frozen.slice(0, 12)}, now ${now.slice(0, 12)})` };
  return { ok: true, promptSha256: now };
}

/** Records the freeze in config.json. git(args) => { status, stdout }, run in the repo. */
export function recordFreeze({ git, cfgPath = CONFIG_PATH, build = buildPrompt, now = Date.now } = {}) {
  const rev = (spec) => { const r = git(['rev-parse', spec]); return r.status === 0 ? r.stdout.trim() : null; };
  const freeze = { commit: rev('HEAD'), blob: rev('HEAD:scripts/github/cursor-review.mjs'), promptSha256: promptSha256({ build }), at: new Date(now()).toISOString() };
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, `${JSON.stringify({ ...cfg, freeze }, null, 2)}\n`);
  return freeze;
}

/** 12 hex of sha256(model, promptSha256, review-filter blob, context blob). The blobs are empty for v0. */
export function engineVersion({ model, promptSha256: p, filterBlob = '', contextBlob = '' }) {
  return sha256(JSON.stringify([model, p, filterBlob, contextBlob])).slice(0, 12);
}

// ---------- the engine freeze ----------
// The replay can run the local review engine (local-review.mjs) instead of cursor-review.mjs. The engine has its own prompt, so it has its own freeze:
// config.engineFreeze = { commit, blob (local-review/prompt.mjs), promptSha256: { full, delta }, at }. A replayed engine run is always mode full.

/** { full, delta }: the promptSha256 that buildEnginePrompt gives for each mode (the fixed rules only, so the file list does not count). */
export function enginePromptSha256({ build = buildEnginePrompt } = {}) {
  return { full: build({ mode: 'full' }).promptSha256, delta: build({ mode: 'delta' }).promptSha256 };
}

/** { ok, promptSha256 (the full hash), reason? }. A config with no engineFreeze is not ok. */
export function checkEngineFreeze(cfg, { build = enginePromptSha256 } = {}) {
  const frozen = cfg?.engineFreeze?.promptSha256?.full;
  const now = build().full;
  if (!frozen) return { ok: false, promptSha256: now, reason: 'no engine freeze recorded: run `cli.mjs freeze --engine` first' };
  if (frozen !== now) return { ok: false, promptSha256: now, reason: `the engine prompt changed since the freeze (frozen ${frozen.slice(0, 12)}, now ${now.slice(0, 12)})` };
  return { ok: true, promptSha256: now };
}

/** Records the engine freeze in config.json and leaves the old freeze as it is. git(args) => { status, stdout }, run in the repo. */
export function recordEngineFreeze({ git, cfgPath = CONFIG_PATH, build = enginePromptSha256, now = Date.now } = {}) {
  const rev = (spec) => { const r = git(['rev-parse', spec]); return r.status === 0 ? r.stdout.trim() : null; };
  const engineFreeze = { commit: rev('HEAD'), blob: rev('HEAD:scripts/github/local-review/prompt.mjs'), promptSha256: build(), at: new Date(now()).toISOString() };
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, `${JSON.stringify({ ...cfg, engineFreeze }, null, 2)}\n`);
  return engineFreeze;
}
