/**
 * COPY of .claude/plugins/ccv3-mods/hooks/shared/redact.ts. The plugin lives outside the app
 * root, so Next and tsc cannot import it. Change a rule in both files or in neither.
 *
 * Secret redaction: a TypeScript port of opc/scripts/core/db/memory_redact.py.
 * Pure: no engine imports, no `$`. The tests feed it the same fixtures as the Python tests
 * (tests/redact.test.ts), so the two stay in step. Change a rule in both files or in neither.
 *
 * A match becomes `[REDACTED:<kind>]`. `hits` holds kinds, one per replacement, never values.
 * Idempotent: a marker counts as a placeholder. Rule order matters: credential runs before
 * provider_token, so API_KEY=<sk-key> is a "credential".
 */

export type RedactResult = { text: string; hits: string[] }

const MIN_VALUE_CHARS = 8
const marker = (kind: string): string => `[REDACTED:${kind}]`

const PLACEHOLDER_PREFIXES = ['your', 'example', 'placeholder', 'replace', 'insert', 'changeme', 'redacted']
const PLACEHOLDER_WORDS = new Set(['password', 'token', 'api-key', 'api_key', 'apikey', 'secret', 'dummy'])
const ENV_LOOKUP_PREFIXES = ['process.env', 'os.environ', 'os.getenv', 'getenv', 'env.', 'env[']

const isPlaceholder = (value: string): boolean => {
  const v = value.trim().replace(/^['"`]+|['"`]+$/g, '').trim()
  const low = v.toLowerCase()
  if (!low || low.includes('[redacted')) return true
  if ((v.startsWith('<') && v.endsWith('>')) || v.startsWith('${') || v.startsWith('{{') || v.startsWith('$')) return true
  if (PLACEHOLDER_PREFIXES.some(prefix => low.startsWith(prefix)) || PLACEHOLDER_WORDS.has(low)) return true
  if (ENV_LOOKUP_PREFIXES.some(prefix => low.startsWith(prefix))) return true
  return /^[*.]*$/.test(v)
}

/** The callback arguments of String.replace that follow the captures: offset, whole string, named groups. */
const tail = (args: unknown[]) => ({
  groups: args[args.length - 1] as Record<string, string>,
  string: args[args.length - 2] as string,
  offset: args[args.length - 3] as number,
})

type Rule = (match: string, ...args: unknown[]) => string | null

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const privateKey: Rule = () => marker('private_key')

// The password may hold "/" or "@": it is greedy up to the last "@" that a host follows. The user may be empty.
const URL_CREDENTIALS = /(?<scheme>\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)(?<user>[^\s:/@]*):(?<pw>[^\s]+)@(?=[^\s@/]+(?:[:/]|\s|$))/g
const PORT_THEN_PATH = /^\d+\//
const urlCredentials: Rule = (match, ...args) => {
  const { groups } = tail(args)
  const pw = groups.pw ?? ''
  if (match.includes('[REDACTED') || isPlaceholder(pw)) return null
  if (PORT_THEN_PATH.test(pw)) return null // host:8080/path?mail=a@b is not user:password@host
  return `${groups.scheme}${marker('url_credentials')}@`
}

const CREDENTIAL_NAMES =
  'API[_-]?KEY|ACCESS[_-]?KEY[_-]?ID|SECRET[_-]?ACCESS[_-]?KEY|ACCESS[_-]?TOKEN' +
  '|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY' +
  '|SECRET[_-]?KEY|ENCRYPTION[_-]?KEY|SIGNING[_-]?KEY' +
  '|PASSWORD|PASSWD|SECRET|TOKEN'
const CREDENTIAL = new RegExp(
  `(?<name>${CREDENTIAL_NAMES})(?<sep>["']?[ \\t]*[:=](?!=)[ \\t]*)(?<val>"[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`,
  'gi',
)

// Values that read as code or prose, not as a secret. A bare name (TOKEN, SECRET, PASSWORD, PASSWD with no
// prefix) is also an ordinary word, so it needs a value with a digit or a symbol.
const BARE_NAMES = new Set(['token', 'secret', 'password', 'passwd'])
const WORD_CHAIN = /^(?:[A-Za-z]+(?:[_-][A-Za-z]+)*)$/
const LOWER_WORD_CHAIN = /^(?:[a-z]+(?:[_-][a-z]+)+)$/
const CAMEL = /^(?:(?:[A-Z][a-z]{2,}){2,}|[a-z]{2,}(?:[A-Z][a-z]{2,})+)$/
const DOTTED_IDENTIFIER = /[A-Za-z]\.[A-Za-z]/
const LOWER_DOTTED_CHAIN = /^(?:[a-z_]+(?:\.[a-z_]+)+)$/
const CALL_OR_INDEX = /^(?:[A-Za-z_][A-Za-z_.]*[([][^\s]*[)\]])$/

const isCodeOrProse = (value: string, bare: boolean): boolean => {
  if (CAMEL.test(value) || LOWER_DOTTED_CHAIN.test(value)) return true
  if (CALL_OR_INDEX.test(value)) return true
  return bare ? WORD_CHAIN.test(value) || DOTTED_IDENTIFIER.test(value) : false
}

const credential: Rule = (_match, ...args) => {
  const { groups, string, offset } = tail(args)
  const val = groups.val ?? ''
  const quote = val[0] === '"' || val[0] === "'" ? val[0] : ''
  const inner = quote && val.length >= 2 && val.endsWith(quote) ? val.slice(1, -1) : val
  if (inner.length < MIN_VALUE_CHARS || isPlaceholder(inner)) return null
  const before = offset > 0 ? (string[offset - 1] ?? ' ') : ' '
  const bare = BARE_NAMES.has((groups.name ?? '').toLowerCase()) && !(/[\p{L}\p{N}]/u.test(before) || before === '_' || before === '-')
  if (isCodeOrProse(inner, bare)) return null
  return `${groups.name}${groups.sep}${quote}${marker('credential')}${quote}`
}

const BEARER = /(?<head>\bBearer\s+)(?<tok>[A-Za-z0-9._~+/=-]{16,})/gi
const bearer: Rule = (_match, ...args) => {
  const { groups } = tail(args)
  const tok = groups.tok ?? ''
  if (isPlaceholder(tok) || LOWER_WORD_CHAIN.test(tok) || CAMEL.test(tok)) return null // "Bearer authentication-required" is prose
  return `${groups.head}${marker('bearer_token')}`
}

const BASIC = /(?<head>Authorization:[ \t]*Basic[ \t]+)(?<tok>[A-Za-z0-9+/=]{16,})/gi
const basic: Rule = (_match, ...args) => `${tail(args).groups.head}${marker('basic_auth')}`

const PROVIDER_TOKEN = new RegExp(
  '(?<![A-Za-z0-9_])(?:' +
    'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}' +
    '|sm_[A-Za-z0-9_]{20,}' +
    '|gh[pousr]_[A-Za-z0-9]{20,}' +
    '|github_pat_[A-Za-z0-9_]{20,}' +
    '|xox[baprs]-[A-Za-z0-9-]{10,}' +
    '|xapp-[A-Za-z0-9-]{10,}' +
    '|(?:AKIA|ASIA)[A-Z0-9]{16}' +
    '|AIza[0-9A-Za-z_-]{35}' +
    '|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}' +
    '|npm_[A-Za-z0-9]{36}' +
    '|glpat-[A-Za-z0-9_-]{20,}' +
    ')',
  'g',
)
const providerToken: Rule = () => marker('provider_token')

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g
const jwt: Rule = () => marker('jwt')

const RULES: [string, RegExp, Rule][] = [
  ['private_key', PRIVATE_KEY, privateKey],
  ['url_credentials', URL_CREDENTIALS, urlCredentials],
  ['credential', CREDENTIAL, credential],
  ['bearer_token', BEARER, bearer],
  ['basic_auth', BASIC, basic],
  ['provider_token', PROVIDER_TOKEN, providerToken],
  ['jwt', JWT, jwt],
]

/** Replaces every secret in `text` with a marker. Total: a failure inside a rule hides the whole text. */
export const redact = (text: string): RedactResult => {
  if (typeof text !== 'string' || text === '') return { text: '', hits: [] }
  try {
    const hits: string[] = []
    let out = text
    for (const [kind, pattern, rule] of RULES) {
      out = out.replace(pattern, (match: string, ...args: unknown[]) => {
        const replacement = rule(match, ...args)
        if (replacement === null) return match
        hits.push(kind)
        return replacement
      })
    }
    return { text: out, hits }
  } catch {
    return { text: marker('error'), hits: ['error'] }
  }
}

const MAX_DEPTH = 24

const deep = (value: unknown, hits: string[], depth: number): unknown => {
  if (typeof value === 'string') {
    const one = redact(value)
    hits.push(...one.hits)
    return one.text
  }
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map(item => deep(item, hits, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deep(item, hits, depth + 1)]))
  }
  return value
}

/** Redacts every string inside objects and arrays. Keys and other values stay. Returns a new value; the input is kept. */
export const redactDeep = <T>(value: T): { value: T; hits: string[] } => {
  const hits: string[] = []
  return { value: deep(value, hits, 0) as T, hits }
}
