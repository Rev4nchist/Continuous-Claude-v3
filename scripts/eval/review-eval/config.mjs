// Loads config.json. A test or the CLI can pass another path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, 'config.json');

export function loadConfig(file = CONFIG_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** True when a path has a `local-review` folder segment (LR-PIN reads there; `local-review-shadow` is a different folder). */
export const underLocalReview = (p) => /(^|[\\/])local-review([\\/]|$)/.test(String(p));
