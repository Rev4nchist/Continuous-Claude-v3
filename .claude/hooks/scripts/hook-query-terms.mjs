#!/usr/bin/env node
/**
 * Build the recall search term the memory-awareness hook builds, for a batch of prompts.
 *
 * stdin:  JSON array of prompt strings
 * stdout: JSON array of { prompt, intent, term, skipped } in the same order.
 *         `skipped` is null, or the reason the hook would not run recall at all.
 *
 * It bundles the REAL src/shared/intent-extractor.ts with esbuild and calls
 * deriveRecallIntent + cleanSearchTerm, the functions memory-awareness.ts calls, so the
 * recall eval (opc/scripts/core/recall_eval_v2.py) cannot drift from the hook.
 * The skip gates mirror main() in memory-awareness.ts (prompt length, slash command,
 * machine-generated prompt, intent length).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(join(hooksDir, 'package.json'))('esbuild');

const bundle = await build({
  entryPoints: [join(hooksDir, 'src', 'shared', 'intent-extractor.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const code = Buffer.from(bundle.outputFiles[0].contents).toString('base64');
const { deriveRecallIntent, cleanSearchTerm, isMachineGeneratedPrompt } = await import(
  `data:text/javascript;base64,${code}`
);

function skipReason(prompt, intent) {
  if (prompt.length < 15) return 'prompt shorter than 15 chars';
  if (prompt.trim().startsWith('/')) return 'slash command';
  if (isMachineGeneratedPrompt(prompt)) return 'machine-generated prompt';
  if (intent.length < 3) return 'intent shorter than 3 chars';
  return null;
}

const prompts = JSON.parse(readFileSync(0, 'utf-8'));
const out = prompts.map((prompt) => {
  const intent = deriveRecallIntent(prompt);
  return { prompt, intent, term: cleanSearchTerm(intent), skipped: skipReason(prompt, intent) };
});
process.stdout.write(JSON.stringify(out));
