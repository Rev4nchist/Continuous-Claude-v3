#!/usr/bin/env node
import { readFileSync } from 'fs';

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    prompt: string;
}

// Patterns that indicate code generation requests
const CODE_GEN_PATTERNS = [
    // Direct code requests
    /\b(write|create|implement|build|make|add|generate)\b.*\b(function|class|method|component|module|service|api|endpoint|handler|hook|script|code|program)\b/i,
    // Verb + feature/thing
    /\b(write|create|implement|build|make)\b.*\b(a|an|the|this|that)\b/i,
    // Specific code constructs
    /\b(rate limiter|parser|validator|sanitizer|encoder|decoder|serializer|deserializer|converter|transformer|middleware|interceptor|decorator|factory|singleton|adapter|facade|proxy|observer|iterator|generator)\b/i,
    // Data structures
    /\b(write|create|implement|build)\b.*\b(queue|stack|tree|graph|list|map|set|cache|buffer|pool|registry)\b/i,
    // Algorithm requests
    /\b(write|create|implement)\b.*\b(algorithm|sort|search|hash|encrypt|decrypt|compress|decompress)\b/i,
    // Fix/refactor that involves writing code
    /\b(fix|refactor|rewrite|optimize)\b.*\b(function|class|method|code|implementation)\b/i,
];

// Patterns that indicate this is NOT a code gen request (false positive filters)
const EXCLUDE_PATTERNS = [
    /^(what|how|why|when|where|can|does|is|are|should|would|could)\b/i,  // Questions
    /\b(explain|describe|tell me about|what does|how does)\b/i,          // Explanations
    /\b(find|search|look for|show me|list)\b/i,                           // Search/read operations
    /\b(commit|push|pull|merge|branch|checkout)\b/i,                      // Git operations only
];

function isCodeGenRequest(prompt: string): boolean {
    // First check exclusions
    for (const pattern of EXCLUDE_PATTERNS) {
        if (pattern.test(prompt)) {
            return false;
        }
    }

    // Then check for code gen patterns
    for (const pattern of CODE_GEN_PATTERNS) {
        if (pattern.test(prompt)) {
            return true;
        }
    }

    return false;
}

function generateCodeFieldReminder(): string {
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 CODE FIELD PROTOCOL [C:10] ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BLOCKERS (not suggestions - must resolve):
  ✗ Do NOT write code before stating assumptions
  ✗ Do NOT claim correctness you haven't verified
  ✗ Do NOT handle only the happy path
  ✓ MUST answer "Under what conditions does this work?"

REQUIRED OUTPUT SEQUENCE:
  1. Assumptions (explicit list)
  2. Edge cases & failure modes
  3. Code
  4. Limitations & conditions

Exception: Trivial (<10 lines, obvious) may abbreviate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

async function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        if (isCodeGenRequest(data.prompt)) {
            console.log(generateCodeFieldReminder());
        }

        process.exit(0);
    } catch (err) {
        // Silent failure - don't break the session
        process.exit(0);
    }
}

main();
