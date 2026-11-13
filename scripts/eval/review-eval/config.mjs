// Loads config.json. A test or the CLI can pass another path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, 'config.json');

export function loadConfig(file = CONFIG_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The model family of a model id: 'claude', 'grok', 'composer', or null. */
export function familyOfModel(model) {
  const m = String(model ?? '').toLowerCase();
  if (/^(claude|opus|sonnet|haiku|fable)\b/.test(m) || /^claude-/.test(m)) return 'claude';
  if (/^grok\b/.test(m)) return 'grok';
  if (/^composer\b/.test(m)) return 'composer';
  return null;
}

/**
 * The judge model for a reviewer family (cfg.judgeModels). A judge never shares the reviewer family.
 * No entry throws code NO_JUDGE: there is no default judge. A judge of the same family throws code SAME_FAMILY.
 */
export function judgeModelFor(cfg, family) {
  const model = cfg?.judgeModels?.[family];
  if (!model) throw Object.assign(new Error(`no judge model for reviewer family ${JSON.stringify(family)} in config.json judgeModels`), { code: 'NO_JUDGE' });
  if (familyOfModel(model) === null) throw Object.assign(new Error(`judge ${JSON.stringify(model)} has no known model family: the family check cannot pass`), { code: 'UNKNOWN_FAMILY' });
  if (familyOfModel(model) === family) throw Object.assign(new Error(`judge ${model} is of the reviewer family ${family}: a judge never shares the reviewer family`), { code: 'SAME_FAMILY' });
  return model;
}

/** True when a path has a `local-review` folder segment (LR-PIN reads there; `local-review-shadow` is a different folder). */
export const underLocalReview = (p) => /(^|[\\/])local-review([\\/]|$)/.test(String(p));
