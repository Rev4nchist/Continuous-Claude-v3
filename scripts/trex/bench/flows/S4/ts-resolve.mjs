import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hasExt = (specifier) => /\.(?:[cm]?js|[cm]?ts|json|node|wasm)$/.test(specifier)

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL
  if (parent && (specifier.startsWith('./') || specifier.startsWith('../')) && !hasExt(specifier)) {
    const ts = new URL(`${specifier}.ts`, parent)
    if (existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
