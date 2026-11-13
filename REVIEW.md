# REVIEW.md: paths no PR review bot reads

Greptile and CodeRabbit both skip the paths below. This file is the one list. `.greptile/config.json`
(`ignorePatterns`) and `.coderabbit.yaml` (`reviews.path_filters`, as `!` entries) must hold exactly these
globs. `node scripts/ratchets/review-skip-sync.mjs` exits 1 when a bot config differs from this list.

Some globs overlap (`**/dist/**` covers `.claude/hooks/dist/**`). The overlap is kept on purpose: the
two bots match globs with different engines, and the narrow form still works if the wide form does not.

## Skip paths

```
**/*.min.js
**/*.lock
**/package-lock.json
**/dist/**
.claude/hooks/dist/**
.claude/cache/**
docs/reviews/**
scripts/github/fixtures/**
docs/**
thoughts/**
.claude/skills/_vendor/**
scripts/eval/review-eval/gold/**
scripts/eval/review-eval/seeds/**
scripts/eval/review-eval/rubrics/**
scripts/eval/review-eval/linktype-labels.json
```
