# Why is the code this way?

Use these steps before you change code, a rule or a hook whose reason you do not know. Debugging
step 2, refactors and rule or hook edits use them. Run them inline. Do not spawn an agent per source.

## 1. Anchor on the code

- `git blame -L <a>,<b> <file>`: the commit that wrote each line.
- `git log --follow --oneline -- <file>`: the file's history across renames.
- `git log -S '<string>' --oneline`: the commit that added or removed a string.
- Read the commit subjects for PR numbers (`Merge pull request #N`, `(#N)`).

## 2. Read the review

- `gh pr view <n> --json title,body,comments,reviews`. A reviewer finding often says why a line exists.
- In CCv3, add `-R Rev4nchist/Continuous-Claude-v3`. Without it, `gh` can read the upstream repo.

## 3. Check the CCv3 records

- Notion 📬 Handoffs and the 📌 Key Decisions Log (the `notion-bridge` skill has the IDs).
- Memory: `/recall <topic>`.
- `docs/self-improvement/audits/` and `docs/self-improvement/proposals/`.

## 4. Label each claim

Write each finding with its source and how sure you are:

| Level | Meaning |
|---|---|
| said so | a commit message, PR or note states it |
| line cited | you read the code at file:line |
| ran it | you ran a command that shows it |

A claim with no source is `[Speculation]`.

## 5. List the null results

Name every source you checked that found nothing ("blame: the line predates the rename; PR #41: no
comments"). A missing reason is a finding. It is not proof that there was no reason.

## 6. When a change follows

End with four lines:
- **Preserve:** what the current code does on purpose.
- **Change:** what you will change.
- **Avoid:** the earlier fix or approach that failed.
- **Risk:** what can break, and the check that catches it.
