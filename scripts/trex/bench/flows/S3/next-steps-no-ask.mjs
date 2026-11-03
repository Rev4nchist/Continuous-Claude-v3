import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const dir = join(tmpdir(), 'trex-s3-brief')
mkdirSync(dir, { recursive: true })
const redactPath = join(dir, 'redact.mjs')
writeFileSync(redactPath, stripTypeScriptTypes(readFileSync(join(repo, '.claude/plugins/ccv3-mods/hooks/shared/redact.ts'), 'utf8')))
const redactHref = pathToFileURL(redactPath).href
const briefSrc = stripTypeScriptTypes(readFileSync(join(repo, '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts'), 'utf8')).replace(/from\s+['"]\.\.\/shared\/redact['"]/, `from ${JSON.stringify(redactHref)}`)
if (!briefSrc.includes(redactHref)) throw new Error('redact import was not rewritten')
const briefPath = join(dir, 'brief.mjs')
writeFileSync(briefPath, briefSrc)
const { parseTurnEnd, mergeParsed, deriveChip } = await import(pathToFileURL(briefPath).href)

const chip = (brief) => deriveChip({ brief, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: 1_000_000 })
const die = (msg) => { console.log('FAIL ' + msg); process.exit(1) }
const asks = (text) => parseTurnEnd(text).ask

const prior = mergeParsed(null, parseTurnEnd('## Next steps\n1. Approve the merge of PR 12?'), 1)
if (chip(prior) !== 'waiting-on-dave') die('prior question did not wait')
const cleared = mergeParsed(prior, parseTurnEnd("Waiting.\n\n## Next steps\n1. None for now. I'm waiting on the workflow."), 2)
if (JSON.stringify(cleared.ask) !== '[]' || chip(cleared) !== 'idle') die('none-for-now left ' + JSON.stringify(cleared.ask))

const shotText = "Opened PR 220 and the workflow is running.\n\n## Next steps\n1. None for now. I'm waiting on the workflow.\n2. Tell me your band width in columns, and whether the advisor call ran in the main chat or in a subagent."
const shot = asks(shotText) ?? []
if (shot.length !== 1 || !shot[0].text.includes('band width') || shot[0].kind !== 'question') die('screenshot ' + JSON.stringify(shot))

const emptyForms = [
  '1. None today.',
  '1. Nothing for you to do. Waiting on the CI run.',
  '1. No action needed — the PR lands at READY.',
  '1. Waiting on the workflow run.',
  "1. I'm waiting on the CodeRabbit review.",
  '1. I’m waiting on the CodeRabbit review.',
  'Nothing for you to do. Waiting on the CI run.',
]
for (const form of emptyForms) {
  if (JSON.stringify(asks('Opened PR 12.\n\n## Next steps\n' + form)) !== '[]') die('still an ask: ' + form)
}

const keepText = [
  '## Next steps',
  '1. Waiting for your decision: one row or two rows.',
  "2. Waiting on Dave's approval.",
  '3. Nothing for me to do.',
  '4. None of the three options fit. Pick another approach.',
  '5. Waiting on you to merge.',
  '6. Waiting on the CI run, then land PR 220 now? Recommend: yes.',
].join('\n')
const kept = asks(keepText) ?? []
if (kept.length !== 6 || !kept.some((one) => one.text.includes('None of')) || kept.find((one) => one.recommend)?.recommend !== 'yes') die('dropped a real ask ' + JSON.stringify(kept))
if (chip(mergeParsed(null, parseTurnEnd(keepText), 4)) !== 'waiting-on-dave') die('real asks did not wait')
console.log('PASS clear=0 shot=1 keep=6')
