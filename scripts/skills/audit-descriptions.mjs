#!/usr/bin/env node
// Skill description audit. A skill description is a TRIGGER, not a summary: it is always in
// context, so it must say what the skill does and WHEN to load it ("Does X. Use when Y.").
//
// This file keeps its name because AGENTS.md, README.md and scripts/precommit-build-guard.sh
// call it. There is ONE implementation: it runs the description subset of audit-skills.mjs
// (G01 G02 G08-G14 G30 G31) with the same baseline. Flags are the audit-skills flags
// (--include-active, --json, --quiet, --verbose, --update-baseline, --root, --skill).
//
// Usage: node scripts/skills/audit-descriptions.mjs [audit-skills flags]

import { main } from './audit-skills.mjs';
import { DESCRIPTION_RULES } from './lib/skill-rules.mjs';

process.exit(main([...process.argv.slice(2), '--rules', DESCRIPTION_RULES.join(',')]));
