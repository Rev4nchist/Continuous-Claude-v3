# Archived: the desktop-only mods (2026-10-12)

Cache Guard and CCv3 Skin, moved out of `.claude/plugins/ccv3-mods/`. Dave works in the Claude Code terminal and stopped mod work for the desktop app. Nothing here is loaded, synced or tested.

| Folder | What it was |
|---|---|
| `hooks/cache-guard/` | Held the first send after the prompt cache went cold and showed the cold and warm cost. Desktop app only. |
| `hooks/skin/` | `/skin on|off`: icon rows, timing chips and numbered diff cards for tool calls. Desktop app only. |
| `tests/cache-guard.test.ts`, `tests/skin.test.ts` | Their tests (13 and 9). |

Not archived: `hooks/shared/diff.ts` (`hunksOf`, `diffLines`). Touched Files still counts patch lines with them, so they moved there. The copy in `hooks/skin/model.ts` here is the original.

## Restore

1. `git mv` the two hook folders back into `.claude/plugins/ccv3-mods/hooks/` and the two tests into `.../tests/`.
2. In `hooks/register.tsx` import `cacheGuard` and `skin` again and call them (`cacheGuard` first: its card replaces the band while a send is held).
3. In `types/index.d.ts` bring back `CacheClock`, `CacheHold`, `ToolTime` and the atoms `cacheClock`, `cacheHold`, `cacheSurface`, `originNoted`, `skinOn`, `toolTimes`.
4. In `hooks/agentic-os/index.tsx` bring back the `cacheClock` stamp in `turn.complete` and the `toolTimes` capture in `tool.call`.
5. In `hooks/shared/diag.ts` bring back `isDesktop`. In `skin/model.ts` import `hunksOf` and `diffLines` from `../shared/diff`, and drop the copies.
6. Run `node scripts/mods/validate-mods.mjs`. The commit that archived them (`git log -- archive/ccv3-mods-desktop-2026-10`) shows each edit.

Why they stopped: desktop sessions never started the mod UI (no proof files, no `/ledger`); four diagnostic rounds (PRs #129 to #131) found the cause in the desktop app's own launch, not in the plugin.
