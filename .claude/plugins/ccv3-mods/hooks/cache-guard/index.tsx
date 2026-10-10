import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CacheClock, CacheHold } from '../../types'
import { isDesktop } from '../shared/diag'
import { coldCost, warmCost } from '../shared/price'
import { TONE } from '../shared/tones'
import { DROP_REASON, cardLines, isCold, isPlainPrompt, ttlMinutes } from './model'

// Cache Guard: holds the first send after the prompt cache went cold, once, and shows what it would cost.
// The held text goes straight back into the prompt box, so the person's next Enter sends it as their
// own message (mentions and all). Interactive desktop-app sessions only: Dave keeps the terminal as is, and a
// held prompt in a -p run or a scheduled script would never be seen.

/** Stamped by the agentic-os turn.complete hook (the plugin's one unmatched turn.complete hook). */
const cacheClock = atom({ plugin: 'ccv3-mods', key: 'cacheClock' } as const, { lastReplyAt: null, heldFor: null } as CacheClock)
const cacheHold = atom({ plugin: 'ccv3-mods', key: 'cacheHold' } as const, null as CacheHold | null)
/** The surface this session draws on; Cache Guard holds only in the desktop app. */
const cacheSurface = atom({ plugin: 'ccv3-mods', key: 'cacheSurface' } as const, null as string | null)
/** Set at session.start by agentic-os (and pr-loop): the same atom, declared here to read it. */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')

const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_CACHE_OFF')) === '1'

export const cacheGuard = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await update($, cacheSurface, () => e.surface ?? null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear and compaction start a fresh context: nothing cached is worth guarding.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cacheClock, () => ({ lastReplyAt: null, heldFor: null }))
      await update($, cacheHold, () => null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own plain Enter at the prompt, between turns: no slash or bang command,
    // no attachment (a re-send couldn't carry it), in an interactive terminal or desktop session.
    if (e.origin.kind !== 'composer' || e.turnId !== undefined || !isPlainPrompt(e.text, e.attachments?.length ?? 0)) return next(e)
    if ((await isOff($)) || (await read($, mode)) !== 'interactive') return next(e)
    const surface = await read($, cacheSurface)
    if (!isDesktop(surface, await $.env.get('CCV3_FORCE_SURFACE'))) return next(e)
    // A new message while the card is up goes through (this window was held once) and clears the card.
    if ((await read($, cacheHold)) !== null) await update($, cacheHold, () => null)
    const clock = await read($, cacheClock)
    if (clock.lastReplyAt === null || clock.heldFor === clock.lastReplyAt) return next(e)
    const usage = await $.session.usage()
    const isSubscription = usage.rateLimits.length > 0
    const ttlMin = ttlMinutes(await $.env.get('CCV3_CACHE_TTL_MIN'), isSubscription)
    const now = await $.clock.now()
    if (!isCold(clock.lastReplyAt, now, ttlMin)) return next(e)
    const model = await $.session.model()
    const tokens = usage.context.tokens ?? null
    await update($, cacheClock, c => ({ ...c, heldFor: c.lastReplyAt }))
    await update($, cacheHold, () => ({
      text: e.text,
      idleMs: now - (clock.lastReplyAt ?? now),
      ttlMin,
      tokens,
      coldUsd: tokens === null ? null : coldCost(tokens, model, isSubscription),
      warmUsd: tokens === null ? null : warmCost(tokens, model),
    }))
    // Back into the box once the drop has landed: the next Enter sends it as the person's own words.
    const text = e.text
    $.clock.after(1, () => void $.prompt.fill({ text }).catch(() => undefined))
    return { drop: DROP_REASON }
  }).catch(($, e, next) => next(e))

  // The card replaces the band while a send is held; otherwise the band (agentic-os) draws as usual.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hold = await read($, cacheHold)
    if (hold === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box key="row-cache" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        {cardLines(hold).map((spans, i) => (
          <Text key={`l${i}`} wrap="truncate-end">
            {spans.map((span, j) => (
              <Text key={`s${j}`} {...TONE[span.tone]}>
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
        <Box flexDirection="row" gap={2}>
          <Button key="cg-dismiss" label="Dismiss" onPress={() => void update($, cacheHold, () => null)} />
        </Box>
      </Box>
    )
  })
}
