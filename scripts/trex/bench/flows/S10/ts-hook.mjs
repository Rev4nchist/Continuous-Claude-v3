const empty = new URL('./empty-mod.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../../types' || specifier.endsWith('/types')) return { url: empty, shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
}
