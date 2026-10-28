import { describe, expect, test } from 'claude-code/testing'

import { redact, redactDeep } from '../hooks/shared/redact'

// The TS port of opc/scripts/core/db/memory_redact.py. The fixtures are the ones in
// opc/tests/unit/test_memory_redact.py and opc/tests/unit/fake_secrets.py, so the two stay in step.
// Every secret is joined at run time: no secret-shaped literal sits in this file.
// R1 a pattern kind stops matching (one case per kind, as in the Python CASES)
// R2 a placeholder value is redacted
// R3 a second pass finds hits or changes text (idempotence)
// R4 a word that merely ends in "sk-" is tagged (the lookbehind)
// R5 a PEM with no END line leaks its body
// R6 hits carry matched text
// R7 redactDeep stops recursing, touches non-strings, or mutates its input
// R8 prose or code after a credential name is redacted
// R9 a secret-shaped value after a bare name is not redacted
// R10 a URL password with "/" or "@" is cut short, a host:port/path?mail=a@b URL is redacted
// R11 the SECRET_KEY name family is dropped
// R12 a URL with an empty user (redis://:pw@host) leaks
// R13 redact throws on empty input or returns a non-string

const anthropicKey = (n = 40) => 'sk-' + 'ant-' + 'a'.repeat(n)
const githubToken = () => 'gh' + 'p_' + 'b'.repeat(36)
const slackToken = () => 'xox' + 'b-' + '1234567890-abcdefghij'
const awsKeyId = () => 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'
const googleKey = () => 'AI' + 'za' + 'c'.repeat(35)
const stripeKey = () => 'sk' + '_live_' + 'd'.repeat(24)
const npmToken = () => 'npm' + '_' + 'e'.repeat(36)
const gitlabToken = () => 'glpat' + '-' + 'f'.repeat(22)
const supermemoryKey = () => 'sm' + '_' + 'g'.repeat(24)
const jwt = () => 'ey' + 'J' + 'h'.repeat(12) + '.' + 'i'.repeat(12) + '.' + 'j'.repeat(20)
const pemBlock = (withEnd = true) =>
  '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIEow' + 'A'.repeat(60) + '\n' + (withEnd ? '-----END ' + 'RSA PRIVATE KEY-----' : '')
const dbUrl = (password = 'pw' + 'Hunter99') => 'postgres' + '://' + 'admin' + ':' + password + '@db.internal:5432/app'
const PASSWORD_BODY = '9x7' + 'Lm2' + 'Zp4' + 'Rt'
const passwordAssignment = (value = 'q' + PASSWORD_BODY) => 'DB_' + 'PASSWORD' + '=' + value

const CASES: [string, string, string][] = [
  ['private_key', pemBlock(), 'MIIEow'],
  ['url_credentials', 'connect ' + dbUrl() + ' now', 'Hunter99'],
  ['credential', passwordAssignment(), PASSWORD_BODY],
  ['credential', 'OPENAI_' + 'API_KEY' + ': ' + 'zz'.repeat(10), 'zzzzzz'],
  ['credential', '{"client_' + 'secret": "' + 'w'.repeat(20) + '"}', 'wwwwww'],
  ['bearer_token', 'Authorization: Bear' + 'er ' + 't'.repeat(30), 'tttttt'],
  ['basic_auth', 'Authorization: Ba' + 'sic ' + 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==', 'QWxhZGRpbjpv'],
  ['provider_token', 'key ' + anthropicKey(), 'aaaaaaaa'],
  ['provider_token', githubToken(), 'bbbbbbbb'],
  ['provider_token', slackToken(), 'abcdefghij'],
  ['provider_token', 'id ' + awsKeyId(), 'ABCDEFGHIJKLMNOP'],
  ['provider_token', googleKey(), 'cccccccc'],
  ['provider_token', stripeKey(), 'dddddddd'],
  ['provider_token', npmToken(), 'eeeeeeee'],
  ['provider_token', gitlabToken(), 'ffffffff'],
  ['provider_token', supermemoryKey(), 'gggggggg'],
  ['jwt', 'token is ' + jwt(), 'hhhhhhhh'],
]

describe('redact parity with memory_redact.py', () => {
  for (const [kind, text, body] of CASES) {
    test(`R1 ${kind} becomes its marker (${body.slice(0, 4)}...)`, () => {
      const result = redact(text)
      expect(result.hits).toContain(kind)
      expect(result.text).toContain(`[REDACTED:${kind}]`)
      expect(result.text).not.toContain(body)
    })
  }

  const PLACEHOLDERS = [
    'API_' + 'KEY=your-key-goes-here',
    'TOKEN=${' + 'TOKEN}',
    'PASSWORD=<' + 'your-password>',
    'SECRET=' + '{{' + 'secret_value}}',
    'API_' + 'KEY=' + '$' + 'SOME_ENV_VARIABLE',
    'PASS' + 'WORD=' + '*'.repeat(12),
    'api_' + 'key = process' + '.env.THE_KEY_NAME',
    'TOKEN=' + 'change' + 'me-please',
    'Bear' + 'er ' + '[REDACTED:bearer_token]',
  ]
  test('R2 placeholder values stay', () => {
    for (const text of PLACEHOLDERS) {
      const result = redact(text)
      expect([text, result.hits]).toEqual([text, []])
      expect(result.text).toBe(text)
    }
  })

  test('R3 a second pass is a no-op', () => {
    const text = CASES.map(one => one[1]).join(' ')
    const first = redact(text)
    const second = redact(first.text)
    expect(first.hits.length).toBeGreaterThan(0)
    expect(second.hits).toEqual([])
    expect(second.text).toBe(first.text)
  })

  test('R4 a word prefix before sk- is not a token', () => {
    const text = 'task-' + 'a'.repeat(24) + ' and desk-' + 'b'.repeat(24) + ' and disk-' + 'c'.repeat(24)
    expect(redact(text).hits).toEqual([])
  })

  test('R5 a PEM with no END line is cut to the end of the text', () => {
    const result = redact('before\n' + pemBlock(false))
    expect(result.hits).toContain('private_key')
    expect(result.text).not.toContain('MIIEow')
    expect(result.text.startsWith('before\n')).toBe(true)
  })

  test('R6 hits hold kinds, never values', () => {
    const result = redact(anthropicKey() + ' ' + passwordAssignment() + ' ' + dbUrl())
    const shown = JSON.stringify(result.hits)
    expect(shown).not.toContain('aaaa')
    expect(shown).not.toContain('Hunter99')
    expect(shown).not.toContain('9x7L')
    const kinds = ['private_key', 'url_credentials', 'credential', 'bearer_token', 'basic_auth', 'provider_token', 'jwt']
    for (const hit of result.hits) expect(kinds).toContain(hit)
  })

  test('R7 redactDeep recurses into objects and arrays, only strings change, the input is kept', () => {
    const obj = { a: anthropicKey(), n: 5, flag: true, nested: { tags: ['ok', githubToken()], x: null } }
    const out = redactDeep(obj)
    expect(out.value.n).toBe(5)
    expect(out.value.flag).toBe(true)
    expect(out.value.nested.x).toBeNull()
    expect(out.value.a).not.toContain('aaaa')
    expect(out.value.nested.tags[0]).toBe('ok')
    expect(out.value.nested.tags[1]).not.toContain('bbbb')
    expect(out.hits.filter(hit => hit === 'provider_token').length).toBe(2)
    expect(obj.a).toContain('aaaa')
  })

  test('R8 prose and code after a credential name are not redacted', () => {
    const texts = [
      'commit ' + 'a'.repeat(40),
      'hash 0123456789abcdef and 123e4567-e89b-12d3-a456-426614174000',
      'the refresh token: expiration is 30 days',
      'secret: rotation happens weekly',
      'param token: Optional[str] = None',
      'password=hashed_password',
      'accessToken: AccessTokenType',
      'Bearer authentication-required',
      'api_key = get_key(settings)',
      'password: config.yaml holds it',
      'self.api_' + 'key = config.api_key',
      'DB_' + 'PASSWORD=settings.db_password',
      'client_' + 'secret = app.settings.client_secret',
      'token = os.environ["GH_TOKEN"]',
      'api_key = load_secret(name)',
    ]
    for (const text of texts) {
      const result = redact(text)
      expect([text, result.hits]).toEqual([text, []])
      expect(result.text).toBe(text)
    }
  })

  test('R9 secret-shaped values after bare names are still redacted', () => {
    const texts = [
      'password: ' + 'abc' + '12345',
      'my token=' + 'a1b2c3' + 'd4e5f6',
      'GITHUB_' + 'TOKEN=' + 'plainlowercaseword',
      'secret = ' + 'Zq' + '8Lm2Xp',
      'DB_' + 'PASSWORD=settings.db' + '_password9',
      'API_' + 'KEY=' + 'abcd.efgh' + '1234',
      'PASS' + 'WORD=' + 'Xk9(mP2' + '!qR',
      'API_' + 'KEY=' + 'aB3[x9' + '!Lm2',
      'DB_' + 'PASSWORD=' + '"Qw(e7' + 'rT!z"',
      'TOKEN=' + 'abc(def' + 'ghij',
    ]
    for (const text of texts) expect([text, redact(text).hits.includes('credential')]).toEqual([text, true])
  })

  test('R10 a URL password with / or @ is cut whole; host:port/path?mail=a@b is not a credential', () => {
    for (const password of ['pa/ss' + 'Word9', 'pa@ss' + 'Word9', 'a/b@c' + 'd/e12']) {
      const url = 'postgres' + '://' + 'admin' + ':' + password + '@db.internal:5432/app'
      const result = redact('connect ' + url + ' now')
      expect(result.hits).toContain('url_credentials')
      expect(result.text).toBe('connect postgres://[REDACTED:url_credentials]@db.internal:5432/app now')
    }
    expect(redact('see http://host:8080/path?mail=foo@bar.com for details').hits).toEqual([])
  })

  test('R11 the SECRET_KEY family names are redacted', () => {
    const names = ['SECRET_' + 'KEY', 'DJANGO_SECRET_' + 'KEY', 'JWT_SECRET_' + 'KEY', 'SECRET-' + 'KEY', 'ENCRYPTION_' + 'KEY', 'SIGNING_' + 'KEY', 'PRIVATE_' + 'KEY', 'secret_' + 'key']
    for (const name of names) {
      const result = redact(name + '=' + 'Zq' + '8Lm2Xp4Rt9')
      expect([name, result.hits.includes('credential')]).toEqual([name, true])
      expect(result.text).not.toContain('8Lm2Xp4Rt9')
    }
  })

  test('R12 a URL with an empty user is redacted', () => {
    for (const pw of ['pass' + 'word99', 'Zq' + '8Lm2' + 'Xp4Rt']) {
      const result = redact('cache ' + 'redis' + '://' + ':' + pw + '@cache.internal:6379 up')
      expect(result.hits).toContain('url_credentials')
      expect(result.text).toBe('cache redis://[REDACTED:url_credentials]@cache.internal:6379 up')
    }
  })

  test('R13 empty input comes back as an empty string with no hits', () => {
    expect(redact('')).toEqual({ text: '', hits: [] })
  })
})
