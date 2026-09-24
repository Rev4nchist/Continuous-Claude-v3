# Claude Bridge HQ — Section Map

## v2.0 | 2026-09-24 (HQ rebuilt around the 📬 Handoffs database)

Page: `30e76fd7ac8281e99fe1c0b257088b34` (https://www.notion.so/30e76fd7ac8281e99fe1c0b257088b34).
Always `notion-fetch` it first and copy `old_str` values from that fetch.

## Authority

- **Handoffs** live in the 📬 Handoffs database, not on this page. There are no queue sections to edit.
- **Decisions** live in the 📌 Key Decisions Log page; HQ holds only a pointer.
- **Implementation history** lives in the 📚 Implementation Log — Full History page; HQ keeps the latest 3.
- **Sprints before 2026-09-24** live in the 🗄️ Claude Bridge Archive page (read-only history).

## Sections, top to bottom

| # | Section | Who edits | How |
|---|---|---|---|
| 0 | Intro line + 📬 blockquote | Dave | leave as is |
| 1 | `#### 📋 Active Context {toggle="true"}` | Eve (and Code after a restructure) | `update_content`: replace the indented lines under the toggle; keep `Last Updated: YYYY-MM-DD` current |
| 2 | `## 📌 Key Decisions Log` | nobody (pointer only) | add decisions to the child page, newest first |
| 3 | `## 📬 Handoffs` + the inline `<database>` tag | nobody | never remove or edit the `<database url="https://app.notion.com/p/ea95daf2b1a24ddabbe64f6d056c9346" ...>` tag |
| 4 | `#### 🧠 Architecture & Technical Notes {toggle="true"}` | Claude Code | `update_content` inside the relevant sub-toggle; keep it evergreen |
| 5 | `## ⚡ Current Sprint State` | Eve, Donna, Code | one `<callout>` per item: `🟡 **Name** \| Owner: X \| Status: Y \| detail`; never tables |
| 6 | `## 📚 Implementation Log` | Claude Code | insert the new `### YYYY-MM-DD — Title` entry directly under the section's blockquote; delete the 4th entry; add the same entry at the top of the full-history page |
| 7 | `## 🔧 Bridge Protocol: How to Use This Page` | Dave | change only when the protocol changes |
| 8 | Child pages: `<page>` tags for Archive, Key Decisions Log, Cross-Project Alignment Register, Implementation Log — Full History | nobody | never remove a `<page>` tag: that deletes the child page |

## Entry formats

Implementation Log entry:

```
### YYYY-MM-DD — What was built or done
- What shipped, with evidence (test counts, commits, URLs)
- Decision or follow-up, if any
```

Sprint State item:

```
<callout icon="🧭" color="blue_bg">
	🟡 **Item name** \| Owner: name \| Status: Active \| One line of detail
</callout>
```

## Selection-string cautions

- `notion-fetch` shows links as `[text](url)`; Notion stores `<mention-page url="..."/>`. End an
  `old_str` before any link or mention.
- Prefer small, unique `old_str` values. If an update fails with a mismatch, re-fetch and shorten it.
- `replace_content` on HQ must carry every `<page>` tag and the `<database>` tag, or the tool deletes
  those children (or refuses). Avoid it.

## Retired (v1, before 2026-09-24)

The six HQ queue sections (Eve ↔ Code, Donna ↔ Code, Eve ↔ Donna), their one-liner format, their
selection strings, and the "move child pages to the Archive on bridge sync" rule. All 59 handoff pages
from that era are rows in the Handoffs database now; use the ✅ Closed view for history.
