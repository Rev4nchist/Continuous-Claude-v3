/**
 * The G6 table of the paid-run guard (design 2026-11-18-prflow-paid-run-guard-design.md, "Superseded rev 3 text", R1), as DATA.
 * Plain strings, no shell parsing and no vitest import, so the same rows feed (a) decision-gate-paid-tripwire.test.ts, which calls decide()
 * on the source, and (b) a run against the BUILT hook: for each row and each tool name, pipe
 *   {"tool_name":"Bash"|"PowerShell","tool_input":{"command":<row.command>},"cwd":<a checkout>}
 * into node .claude/hooks/dist/decision-gate.mjs and read permissionDecision / permissionDecisionReason from stdout.
 * `payloadOf` below builds that JSON.
 *
 * The hook is a TRIPWIRE, not an allowlist: it names the intent of a paid request in raw text. It closes no route. The control is postPaid
 * (scripts/github/cr-paid.mjs), which refuses a stamp that is not an interactive session.
 */

/** The sentence every tripwire deny carries (decision-gate adds its BLOCKED prefix). */
export const PAID_TRIPWIRE_SENTENCE = 'a paid CodeRabbit request runs only through node scripts/github/cr-paid.mjs post --pr N, which reads Dave\'s priced yes.';

export interface PaidRow {
  /** The shell text of the call. */
  command: string;
  /** deny: the tripwire denies it. allow: it does not. */
  expect: 'deny' | 'allow';
  /** Why the row is here. */
  note: string;
}

export const TOOL_NAMES = ['Bash', 'PowerShell'] as const;

export const PAID_ROWS: readonly PaidRow[] = [
  // deny: both words in the raw text
  { command: 'gh pr comment 12 --body "@coderabbitai review --use-credits"', expect: 'deny', note: 'inline body, hyphen flag' },
  { command: 'gh pr comment 12 -b "@CodeRabbitAI review --use_credits"', expect: 'deny', note: 'case-insensitive, underscore flag' },
  { command: 'node scripts/github/cr-paid.mjs post --pr 12; gh pr comment 12 --body "@coderabbitai review --use-credits"', expect: 'deny', note: 'the real script first does not exempt the chain' },
  { command: 'gh pr comment 12 --body @"\n@coderabbitai review --use-credits\n"@', expect: 'deny', note: 'PowerShell here-string body (raw text, no blanking)' },
  { command: 'gh pr comment 12 --body-file - <<\'EOF\'\n@coderabbitai review --use credits\nEOF', expect: 'deny', note: 'Bash heredoc body, spaced spelling' },

  // allow: the two words apart, or one word alone
  { command: 'rg -n "use-credits" scripts', expect: 'allow', note: 'search for the flag' },
  { command: 'git log --grep use-credits', expect: 'allow', note: 'history search for the flag' },
  { command: 'cat scripts/github/cr-paid.mjs', expect: 'allow', note: 'read the script' },
  { command: 'git commit -m "docs: the --use-credits flag"', expect: 'allow', note: 'commit message with one word' },
  { command: 'gh pr comment 12 --body "@coderabbitai review"', expect: 'allow', note: 'the free review request' },
  { command: 'gh pr comment 12 --body "Thanks, fixed in abc123."', expect: 'allow', note: 'plain comment' },
  { command: 'node scripts/github/cr-paid.mjs post --pr 12', expect: 'allow', note: 'the paid path holds neither word' },
  { command: 'node scripts/github/reply-thread.mjs 12 --top --body-file r.md', expect: 'allow', note: 'reply script' },

  // allow, by design: the control is postPaid. The tripwire is not an allowlist and closes no route. These payloads came from a security
  // read of the dropped allowlist. They are recorded so nobody reads them as a gap later.
  { command: 'gh.exe pr comment 12 --body-file c.md', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr comment 12 --body-file c.md', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: '"gh" pr comment 12 -F c.md', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh -R o/r pr comment 12 --body-file c.md', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh pr -R o/r comment 12 --body-file c.md', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh api -H "X: y" graphql -f query=\'mutation{addComment(input:{subjectId:"X",body:"hi"}){clientMutationId}}\'', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh api graphql -F query=@q.graphql', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh api graphql --input q.json', expect: 'allow', note: 'allow, by design: the control is postPaid' },
  { command: 'gh api repos/O/R/pulls/comments/1/reactions -f content=\'+1\'', expect: 'allow', note: 'the documented reactions call' },
];

/** The hook input of one row under one tool name: what the harness sends to a PreToolUse hook. */
export function payloadOf(row: PaidRow, tool: (typeof TOOL_NAMES)[number], cwd: string): { tool_name: string; tool_input: { command: string }; cwd: string } {
  return { tool_name: tool, tool_input: { command: row.command }, cwd };
}
