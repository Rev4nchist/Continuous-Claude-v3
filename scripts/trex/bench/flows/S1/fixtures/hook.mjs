const empty = new URL('./empty.mjs', import.meta.url).href;
const hasExt = /\.(?:[cm]?js|[cm]?ts)$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { format: 'module', shortCircuit: true, url: empty };
  }
  if (specifier.startsWith('.') && !hasExt.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
