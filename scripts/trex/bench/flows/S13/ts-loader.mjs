import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shims = {
  'server-only': new URL('./shims/server-only.mjs', import.meta.url),
  'drizzle-orm': new URL('./shims/drizzle-orm.mjs', import.meta.url),
  '@/db': new URL('./shims/db.mjs', import.meta.url),
};

async function fileUrl(url) {
  const path = fileURLToPath(url);
  const hasExt = /\.(?:ts|tsx|mjs|js|cjs)$/.test(path);
  const suffixes = hasExt ? [''] : ['.ts', '.tsx', '.mjs', '.js'];
  for (const suffix of suffixes) {
    try {
      const info = await stat(path + suffix);
      if (info.isFile()) return pathToFileURL(path + suffix).href;
    } catch {
      /* try the next suffix */
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const shim = shims[specifier];
  if (shim) return { url: shim.href, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const mapped = new URL(`../../../../../apps/agentic-os/src/${specifier.slice(2)}`, import.meta.url);
    const hit = await fileUrl(mapped);
    if (hit) return { url: hit, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const hit = await fileUrl(new URL(specifier, context.parentURL));
    if (hit) return { url: hit, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
