/**
 * Intent Extractor (shared helper)
 *
 * Pulls the *what* (topic/intent) out of a user-facing prompt by stripping
 * meta-language ("can you", "help me", "recall", etc.) and falling back to
 * keyword extraction for very short prompts.
 *
 * Used by:
 *   - agent-recall-injector.ts (PreToolUse on Task — injects recall context
 *     into subagent prompts before they run)
 *   - memory-awareness.ts will adopt these helpers in Wave 3 of the
 *     memory hardening v2 work. TODO(memory-hardening-2026-05-16, Wave 3):
 *     replace the inline `extractIntent` / `extractKeywords` in
 *     memory-awareness.ts with imports from this file. The function bodies
 *     here are byte-identical to memory-awareness.ts at the time of
 *     extraction so swapping is safe — see commit history of that file.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  's', 't', 'just', 'don', 'now', 'i', 'me', 'my', 'you', 'your', 'we', 'help', 'with',
  'our', 'they', 'them', 'their', 'it', 'its', 'this', 'that', 'these',
  'what', 'which', 'who', 'whom', 'and', 'but', 'if', 'or', 'because',
  'until', 'while', 'about', 'against', 'also', 'get', 'got', 'make',
  'want', 'need', 'look', 'see', 'use', 'like', 'know', 'think', 'take',
  'come', 'go', 'say', 'said', 'tell', 'please', 'help', 'let', 'sure',
  'recall', 'remember', 'similar', 'problems', 'issues'
]);

const META_PATTERNS: RegExp[] = [
  /^(can you|could you|would you|please|help me|i want to|i need to|let's|lets)\s+/gi,
  /^(show me|tell me|find|search for|look for|recall|remember)\s+/gi,
  /^(how do i|how can i|how to|what is|what are|where is|where are)\s+/gi,
  /\s+(for me|please|thanks|thank you)$/gi,
  /\?$/g,
];

/**
 * Extract meaningful keywords from a prompt (stop-word filter + dedupe).
 * Used as a fallback when `extractIntent` strips too much.
 */
export function extractKeywords(prompt: string): string {
  if (typeof prompt !== 'string') return '';
  const words = prompt
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 5).join(' ');
}

/**
 * Extract the INTENT from a prompt — strip meta-phrases that describe HOW
 * the user is asking rather than WHAT they want. Falls back to keyword
 * extraction if stripping leaves <5 chars.
 */
export function extractIntent(prompt: string): string {
  if (typeof prompt !== 'string') return '';
  let intent = prompt.trim();
  for (const pattern of META_PATTERNS) {
    intent = intent.replace(pattern, '');
  }
  intent = intent.trim();

  if (intent.length < 5) {
    return extractKeywords(prompt);
  }
  return intent;
}

// ---------------------------------------------------------------------------
// QW-07: intent-pollution filter (findings D2c-01 / D3b-05 / D3c-04)
//
// Machine-generated prompts (Claude Code synthetic <task-notification> blobs,
// system reminders, command stdout/stderr, hook wrappers) accounted for 24.6%
// of recall queries. They are not real user intent, so they must be dropped
// UPSTREAM of recall/intent extraction.
// ---------------------------------------------------------------------------

// Known Claude Code synthetic-prompt wrapper tags + any *-hook wrapper.
// agent-message / teammate-message: subagent hand-backs and peer messages arrive as a
// UserPromptSubmit turn too; one was stored as a "User confirmed" memory (2026-09-23 eval, P29).
const SYNTHETIC_TAG =
  /^<\/?(?:task-notification|system-reminder|local-command-(?:stdout|stderr)|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|agent-message|teammate-message|user-prompt-submit-hook|[a-z][a-z0-9-]*-hook)\b/i;

const MAX_HUMAN_PROMPT_LEN = 8000;

/**
 * True only for an EXPLICIT harness wrapper (<task-notification>, <agent-message>,
 * <system-reminder>, command output, *-hook). Unlike isMachineGeneratedPrompt it does NOT
 * use the length or XML-density heuristics, so a long human prompt, or one that pastes
 * some XML, is never mistaken for harness text. Use it where a false positive would drop
 * a real human signal (user-confirmation-detector).
 */
export function isHarnessWrappedPrompt(prompt: string): boolean {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim();
  return SYNTHETIC_TAG.test(t) || t.includes('<task-notification');
}

/**
 * True when a prompt is machine-generated content (Claude Code synthetic
 * wrappers, dense XML, or oversized blobs) rather than a real user intent.
 * Used UPSTREAM of recall/intent extraction to drop the 24.6% pollution.
 */
export function isMachineGeneratedPrompt(prompt: string): boolean {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim();
  if (t.length === 0) return false;
  if (SYNTHETIC_TAG.test(t)) return true;
  if (t.includes('<task-notification')) return true;
  if (t.length > MAX_HUMAN_PROMPT_LEN) return true;
  // XML-tag density: >= 3 DISTINCT tag names ⇒ machine content.
  const names = new Set<string>();
  for (const m of t.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    names.add(m[1].toLowerCase());
    if (names.size >= 3) return true;
  }
  return false;
}

/**
 * Detect git operations and expand query for better memory matching.
 * E.g., "push" → "git push remote fork origin" to catch repo-specific
 * preferences. Moved here from memory-awareness.ts (QW-07) so it can be
 * unit-tested without the stdin/spawn auto-run path.
 *
 * Returns the expansion string, ``prompt + ' git remote workflow'``, or null.
 */
export function expandGitQuery(prompt: string): string | null {
  const lower = prompt.toLowerCase().trim();

  // Git operation patterns and their expanded queries
  const gitExpansions: Record<string, string> = {
    'push': 'git push remote fork origin upstream',
    'git push': 'git push remote fork origin upstream',
    'commit': 'git commit message workflow',
    'git commit': 'git commit message workflow',
    'pr': 'pull request pr create review',
    'create pr': 'pull request pr create github',
    'pull request': 'pull request pr create github',
    'merge': 'git merge branch main',
    'rebase': 'git rebase branch workflow',
    'checkout': 'git checkout branch switch',
    'branch': 'git branch create switch',
    'stash': 'git stash save pop',
    'reset': 'git reset hard soft',
    'force push': 'git push force dangerous',
  };

  // Check for exact or partial matches
  for (const [pattern, expansion] of Object.entries(gitExpansions)) {
    if (lower === pattern || lower.startsWith(pattern + ' ') || lower.endsWith(' ' + pattern)) {
      return expansion;
    }
  }

  // Check if prompt contains git-related words. WHOLE-WORD membership (not
  // substring) — the old `lower.includes('pr')` swallowed "improve",
  // "approach", "represent", and any blob containing "process"/"approve".
  const gitKeywords = ['git', 'push', 'commit', 'pr', 'merge', 'rebase', 'branch', 'pull'];
  const words = new Set(lower.split(/[^a-z]+/).filter(Boolean));
  const hasGitContext = gitKeywords.some(kw => words.has(kw));

  if (hasGitContext) {
    // Add git context to the search
    return prompt + ' git remote workflow';
  }

  return null;
}
