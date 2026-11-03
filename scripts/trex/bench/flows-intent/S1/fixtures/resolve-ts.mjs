import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stub = new URL('./server-only-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, url: stub };
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = join(dirname(fileURLToPath(context.parentURL)), specifier);
    if (!existsSync(base) && existsSync(`${base}.ts`)) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
