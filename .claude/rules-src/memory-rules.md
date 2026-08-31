# Memory Rules (pointer)

Canonical source: `.claude/skills/memory/SKILL.md`. Four former stub rules now live here as one line each.

- **Dynamic recall.** Query memory before work that may have precedent, on tricky errors, and before
  architecture decisions. RRF scores of 0.01-0.03 are good matches; do not read them as low relevance.
- **Proactive capture.** Store at the moment of insight: non-trivial fixes (3+ attempts or multi-file),
  decisions, failed approaches, user corrections. Tag `scope:project` or `scope:global`.
- **Quality bar.** Manual stores are rare and high-value; hooks auto-extract the rest and a gate drops
  NOISE (<3). Ask: "Would a future session benefit, or can it find this in 10 seconds?" Recall first.
- **Agents.** kraken, architect, phoenix, spark check memory before implementing. A `MEMORY MATCH` in
  context means run `/recall` for the full entry.
