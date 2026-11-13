// The prompt freeze (v0). checkFreeze compares sha256(buildPrompt(...)) with the recorded hash.
// The blob of cursor-review.mjs is recorded for information only: other edits to that file (the C0 hardening) are not a prompt change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPrompt } from '../../github/cursor-review.mjs';
import { buildEnginePrompt, PROMPT_VERSION, PROMPT_VERSIONS } from '../../github/local-review/prompt.mjs';
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
export function enginePromptSha256({ build = buildEnginePrompt, promptVersion = PROMPT_VERSION } = {}) {
  return { full: build({ mode: 'full', promptVersion }).promptSha256, delta: build({ mode: 'delta', promptVersion }).promptSha256 };
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
  // engineFreeze is the v1 freeze. When a versioned v1 entry exists, refresh it too, so score and replay read one v1 hash.
  const versioned = cfg.engineFreezes?.[LEGACY_ENGINE_VERSION] ? { engineFreezes: { ...cfg.engineFreezes, [LEGACY_ENGINE_VERSION]: { promptVersion: LEGACY_ENGINE_VERSION, ...engineFreeze } } } : {};
  writeFileSync(cfgPath, `${JSON.stringify({ ...cfg, engineFreeze, ...versioned }, null, 2)}\n`);
  return engineFreeze;
}

// ---------- versioned engine freezes (map "Eval contract files") ----------
// config.engineFreezes = { v1: {...}, v2: {...} }, keyed by promptVersion. engineFreeze stays: it holds the v1 freeze
// recorded before this key, so v1 (and only v1) falls back to it. contextVersion joins in re-p4-harness.
export const LEGACY_ENGINE_VERSION = 'v1';

const knownVersion = (v) => PROMPT_VERSIONS.includes(v);

/** The frozen full hash of an engine prompt version, or null. engineFreezes[v] first, then engineFreeze for v1 only. */
export function frozenEngineSha(cfg, promptVersion = LEGACY_ENGINE_VERSION) {
  const own = cfg?.engineFreezes?.[promptVersion]?.promptSha256?.full;
  if (own) return own;
  return promptVersion === LEGACY_ENGINE_VERSION ? (cfg?.engineFreeze?.promptSha256?.full ?? null) : null;
}

/** { ok, promptVersion, promptSha256, reason? }. An unknown version or a version with no freeze is not ok. */
export function checkVersionedFreeze(cfg, { promptVersion = LEGACY_ENGINE_VERSION, build = enginePromptSha256 } = {}) {
  if (!knownVersion(promptVersion)) return { ok: false, promptVersion, promptSha256: null, reason: `unknown prompt version ${JSON.stringify(promptVersion)}: use ${PROMPT_VERSIONS.join(', ')}` };
  const frozen = frozenEngineSha(cfg, promptVersion);
  const now = build({ promptVersion }).full;
  if (!frozen) return { ok: false, promptVersion, promptSha256: now, reason: `no engine freeze for ${promptVersion}: run \`cli.mjs freeze --engine --prompt-version ${promptVersion}\` first` };
  if (frozen !== now) return { ok: false, promptVersion, promptSha256: now, reason: `the ${promptVersion} engine prompt changed since the freeze (frozen ${frozen.slice(0, 12)}, now ${now.slice(0, 12)})` };
  return { ok: true, promptVersion, promptSha256: now };
}

/** Records engineFreezes[promptVersion] and leaves engineFreeze, freeze and the other versions. An unknown version throws (BAD_INPUT). */
export function recordVersionedFreeze({ git, promptVersion, cfgPath = CONFIG_PATH, build = enginePromptSha256, now = Date.now } = {}) {
  if (!knownVersion(promptVersion)) throw Object.assign(new Error(`unknown prompt version ${JSON.stringify(promptVersion)}: use ${PROMPT_VERSIONS.join(', ')}`), { code: 'BAD_INPUT' });
  const rev = (spec) => { const r = git(['rev-parse', spec]); return r.status === 0 ? r.stdout.trim() : null; };
  const entry = { promptVersion, commit: rev('HEAD'), blob: rev('HEAD:scripts/github/local-review/prompt.mjs'), promptSha256: build({ promptVersion }), at: new Date(now()).toISOString() };
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // v1 also rewrites engineFreeze: replay reads only engineFreeze (checkEngineFreeze), so the two v1 hashes never drift.
  const legacy = promptVersion === LEGACY_ENGINE_VERSION ? { engineFreeze: { commit: entry.commit, blob: entry.blob, promptSha256: entry.promptSha256, at: entry.at } } : {};
  writeFileSync(cfgPath, `${JSON.stringify({ ...cfg, ...legacy, engineFreezes: { ...(cfg.engineFreezes ?? {}), [promptVersion]: entry } }, null, 2)}\n`);
  return entry;
}
