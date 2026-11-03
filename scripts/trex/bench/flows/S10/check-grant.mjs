import { register } from 'node:module'
await register('./ts-hook.mjs', import.meta.url)
const cp = await import(new URL('../../../../../.claude/plugins/ccv3-mods/hooks/pr-checkpoint/model.ts', import.meta.url))
const die = (m) => { console.error(m); process.exit(1) }
const g = (args) => cp.parseGrantArgs(args)
const yes = g('grant 7 4')
if (!yes || yes === 'usage' || yes.pr !== 7 || yes.round !== 4) die(JSON.stringify(yes))
const hash = g('GRANT #12 1')
if (!hash || hash === 'usage' || hash.pr !== 12 || hash.round !== 1) die('hash')
for (const args of ['grant', 'grant 7', 'grant 7 0', 'grant 0 4', 'grant 7 x', 'grant 7 4 5', 'grant 7 4 --body b.md']) {
  if (g(args) !== 'usage') die(args)
}
if (g('7 coderabbit') !== null || g('') !== null) die('not a grant')
if (!cp.USAGE.includes('grant <pr> <round>')) die(cp.USAGE)
console.log('grant-7-4')
console.log('grant-usage')
