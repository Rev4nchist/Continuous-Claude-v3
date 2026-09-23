# Fourth builds (CCv3)

Read this before Step 1 whenever the brand is Fourth, Fourth iQ, or a Fourth
product. The ten approved examples in [approved-collection.md](approved-collection.md)
are all consumer brands; this page adapts the same standard to a B2B platform
for hospitality operators. Load the `fourth-brand-guidelines` skill first. Where
it and this skill disagree about brand, the guidelines win. Where they disagree
about page mechanics (motion, verification, budgets), this skill wins.

## 1. The brand floor

Take these from `fourth-brand-guidelines` and its `references/` files, not from
memory. Starting token map for `:root`, to check against `references/colors.md`:

| scroll-craft token | Fourth colour | Note |
|---|---|---|
| `--sc-canvas` | Soft White `#F5F5F5`, or Deep Blue `#0C4A7D` for a dark act | Midnight Navy is a text colour, never a background |
| `--sc-ink` | Midnight Navy `#002747` or Dark Gray `#373e42` | Body text at 4.5:1 or better |
| `--sc-accent` | Teal Green `#00B69F` | CTAs and the iQ signal only. Teal on white is 2.4:1, so never body text |
| `--sc-font-display` / `--sc-font-text` | Poppins | Headlines Semibold, emphasis Medium or Semibold, no italic |

- Write "iQ": lowercase i, uppercase Q. The tagline is "Powered by iQ".
- "Fourth Dimension" is always explained as the extra dimension of
  intelligence and tied to an outcome.
- Keep this skill's em-dash ban. The guidelines use em dashes in examples but
  do not require them.
- Copy follows the four tone pillars (energetic, insightful, human, confident):
  active voice, second person, sentences under 25 words.

## 2. The focal subject is the operation, not an invented object

The layer contract in approved-collection.md §2 still applies. The planes fit a
product platform differently:

| Plane | Fourth version |
|---|---|
| Far environment | A real hospitality setting: a kitchen pass, a bar, a hotel front desk, a store floor |
| Midground | The working surface: a counter, a rota board, a stock room shelf |
| Focal subject | A person using the product: a device showing a real Fourth screen with demo data |
| Near foreground | A product detail at readable scale: a schedule cell, a forecast line, an alert |
| Atmosphere | Service light and movement, never a haze that hides the screen |

- The guidelines forbid "technology without people". A floating dashboard hero
  fails the brand, however layered it is.
- The signature move should show the product doing its job under the reader's
  hand: a rota filling as they scroll, a forecast line resolving, a stock count
  settling. Pick one, and make it true to the product.
- Grammars that suit a platform: Chaptered editorial and Live surface
  ([uniqueness.md](uniqueness.md) §2.2 and §2.3) often fit better than filmic
  one-shot. The fingerprint gate still applies.

## 3. Real screens, demo data, no borrowed credibility

- Product screens come from the real product with demo or synthetic data. Never
  a real customer's names, rotas, sales or logos without written approval.
- No invented numbers. A statistic needs a source Dave can name; otherwise it
  is not on the page (this matches the skill's own counter rule).
- Generated people may appear as staff in a setting. They never appear as a
  named customer, a quoted testimonial, or a case study.
- Case-study imagery uses the customer's real venue photography and logo, only
  with approval.

## 4. Generation and spend

- Never upload Fourth customer material, unreleased screens, or internal
  documents to kie.ai as a `--ref`. Treat every upload as public (CCv3 rule
  `design-work.md`).
- Prefer supplied Fourth photography and real screen captures over generation.
  It is cheaper and it is the brand's own photography rule.
- Every paid call is confirm-first and lands in `kie-spend.jsonl`.

## 5. Acceptance additions

On top of verify.md and the budgets:

- Run the `fourth-brand-guidelines` review workflow (brand identity, tone,
  message clarity, structure) on the final page, and record the result in
  `BUILD-REPORT.md`.
- Check every screen crop at phone size: a product screen that is unreadable on
  a phone is decoration, and decoration is not the product.
- Confirm no customer data, names or logos appear anywhere, including alt text,
  file names and generated-image prompts.
