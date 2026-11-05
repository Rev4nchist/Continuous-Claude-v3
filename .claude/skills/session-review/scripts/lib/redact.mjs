// Redaction for session-review. Runs BEFORE truncation, on every text field, in both scripts.
// Over-redaction is the safe failure: a lost word costs little, a leaked token costs a lot.

const NAMED_ENV = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN'];
const MARK = '[REDACTED]';

// Order matters: URLs and named env first, then token shapes, then generic KEY=value.
const PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@[^\s'"`]+/gi, // scheme://user:pass@host
  /\b(?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s'"`]+/gi,
  new RegExp(`\\b(?:${NAMED_ENV.join('|')})\\s*[=:]\\s*("[^"]*"|'[^']*'|\\S+)`, 'g'),
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // No leading \b on the specific prefixes: a token glued to a word character must still match.
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /gh[posur]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{8,}/g,
  /ntn_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email
];
// KEY=value and KEY: value where the key holds API_KEY, TOKEN, SECRET, PASSWORD or PASSWD. Plain 'pass' and 'key' words stay.
const KEY_VALUE = /\b([A-Za-z0-9_.-]*(?:API_?KEY|SECRET_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;

/** Replace secrets with [REDACTED]. Accepts any value; non-strings give ''. */
export function redact(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let s = input;
  for (const name of NAMED_ENV) {
    const v = process.env[name];
    if (v && v.length >= 8) s = s.split(v).join(MARK);
  }
  for (const re of PATTERNS) s = s.replace(re, MARK);
  s = s.replace(KEY_VALUE, (m, key, val) => (val.includes('REDACTED') ? m : `${key}=${MARK}`));
  return s;
}

/** Redact first, then cut to n characters, so a cut-off token cannot slip past a pattern. */
export function redactTruncate(input, n) {
  const s = redact(input);
  return s.length > n ? s.slice(0, n) : s;
}

/** Collapse whitespace to single spaces, for one-line fields. */
export function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}
