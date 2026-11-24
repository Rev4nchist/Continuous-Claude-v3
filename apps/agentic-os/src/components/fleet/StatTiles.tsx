import type { StatTiles as StatTilesData } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';
import { engineKind } from '@/server/queries/spend-fold';

import { costLabel, formatCount, formatUsd } from './format';

type Tone = 'plain' | 'warn' | 'bad';

type Tile = {
  label: string;
  value: string;
  tone: Tone;
  /** Lines under the big number. A `bad` line is red. */
  lines: { text: string; tone?: Tone; title?: string }[];
  /** A small grey line between the label and the number. */
  header?: { text: string; title: string };
  /** Grey words on the same row as the number (keeps the tile short: the first card must stay above the fold). */
  caption?: string;
  title?: string;
  /** Hidden below the `sm` breakpoint (a phone). The node stays in the DOM, so its text still reads. */
  desktopOnly?: boolean;
};

const ESTIMATE_TITLE = 'API-rate estimate, not the bill';

const ENGINE_PREFIX = { 'at least': 'at least est ', est: 'est ', engine: '' } as const;

/** The engine sum, in words. The prefix comes from `engineKind`: a live sum reads est, a resumed one is a floor. */
function engineLine(spend: StatTilesData['spend']['engine']): string {
  const kind = engineKind(spend);
  if (kind === 'no data' || spend.usd === null) return 'no data';
  // The sum covers LIVE sessions only: an ended session leaves it at once. "all sessions" said more than the number knew (C6).
  const parts = [`${ENGINE_PREFIX[kind]}${formatUsd(spend.usd)} live sessions`];
  if (spend.noData > 0) parts.push(`${spend.noData} no data`);
  const text = parts.join(', ');
  return spend.resumed > 0 ? `${text} · ${spend.resumed} since resume` : text;
}

/** The ledger sum: est, or the floor / unpriced words of `costLabel`. */
function subagentLine(tiles: StatTilesData): string {
  const { est } = tiles.spend;
  const base = costLabel(est);
  // The floor reads "at least est $X", the same words as engineLine.
  const text =
    base === 'unpriced' ? base : est.floor ? base.replace(/^at least /, 'at least est ') : `est ${base}`;
  return `of which subagents ${text}`;
}

/**
 * The open PRs of the repo, from the same feed as the table (fault C1). No usable feed reads "-" and "no feed", never 0.
 * A feed with more PRs than the table shows reads "20+". A stale feed keeps its number and says it is stale.
 */
function openPrsTile(tiles: StatTilesData): Tile {
  const count = tiles.openPrs;
  return {
    label: 'Open PRs',
    value: count === null ? '-' : `${formatCount(count)}${tiles.openPrsCapped ? '+' : ''}`,
    tone: 'plain',
    caption: count === null ? 'no feed' : undefined,
    lines: tiles.openPrsStale ? [{ text: 'feed is stale' }] : [],
    desktopOnly: true,
  };
}

function buildTiles(tiles: StatTilesData, databaseOk: boolean): Tile[] {
  const { quota, spend, breaks } = tiles;
  return [
    {
      label: 'Live',
      // Database down: the count is the last good read and may be old. The alert above says so; the tile shows "-".
      value: databaseOk ? formatCount(tiles.liveSessions) : '-',
      tone: 'plain',
      lines: [{ text: `working ${tiles.working}, waiting ${tiles.waiting}` }],
    },
    {
      label: 'Needs Dave',
      value: formatCount(tiles.needsDave),
      tone: tiles.needsDave > 0 ? 'warn' : 'plain',
      lines: [{ text: `blocked ${tiles.blocked}, quiet ${tiles.quiet}`, tone: tiles.blocked > 0 ? 'bad' : 'plain' }],
    },
    {
      label: 'Quota and spend',
      // Shown rounded; the amber test (spend.amber) reads the raw value.
      value: quota.sevenDayPct === null ? '-' : `${Math.round(quota.sevenDayPct)}%`,
      tone: spend.amber ? 'warn' : 'plain',
      header: { text: ESTIMATE_TITLE, title: ESTIMATE_TITLE },
      caption: quota.sevenDayPct === null ? 'quota not reported' : '7-day quota used',
      lines: [
        { text: engineLine(spend.engine) },
        // With no runs the line is left out: T4 already says "no runs", and the tile stays short.
        ...(tiles.breaks.runs === 0
          ? []
          : [{ text: subagentLine(tiles), title: 'subagent runs only; covers part of the session total' }]),
      ],
    },
    {
      label: 'Rule breaks',
      value: formatCount(breaks.distinct),
      tone: breaks.distinct > 0 ? 'bad' : 'plain',
      title: 'requested effort, not applied',
      lines:
        breaks.runs === 0
          ? [{ text: 'no runs' }]
          : [
              { text: `haiku in subagents ${breaks.haiku}, sonnet<high ${breaks.sonnetLow}, drift ${breaks.drift}` },
              { text: `drift checked on ${breaks.driftChecked} of ${breaks.runs} runs`, tone: 'plain' },
            ],
    },
    { label: 'Active lanes', value: formatCount(tiles.activeLanes), tone: 'plain', lines: [], desktopOnly: true },
    openPrsTile(tiles),
  ];
}

/**
 * Six tiles, in this order: Live, Needs Dave, Quota and spend, Rule breaks, Active lanes, Open PRs.
 * A phone shows the first four (Active lanes and Open PRs are `hidden sm:block`). The label is always
 * the first child of a tile; the layout spec reads it there. Needs Dave is amber above zero, Rule breaks
 * is red above zero, Quota and spend is amber at 80% quota or a $150 session. Money here is an
 * estimate at API rates: the header says so.
 */
export function StatTiles({ tiles, databaseOk }: { tiles: StatTilesData; databaseOk: boolean }) {
  return (
    <div data-testid="stat-tiles" className="flex flex-wrap gap-2.5">
      {buildTiles(tiles, databaseOk).map((item) => (
        <div
          key={item.label}
          data-testid="stat-tile"
          data-tone={item.tone === 'plain' ? undefined : item.tone}
          title={item.title}
          className={cn(
            'min-w-0 flex-[1_1_150px] rounded-md border bg-card px-3 py-2.5',
            item.desktopOnly && 'hidden sm:block',
          )}
        >
          <div className="truncate text-xs text-muted-foreground">{item.label}</div>
          {item.header && (
            <div title={item.header.title} className="break-words text-[11px] leading-[14px] text-muted-foreground">
              {item.header.text}
            </div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <div
              data-testid="stat-tile-value"
              className={cn(
                'mt-0.5 text-[22px] font-bold leading-7 tabular-nums',
                item.tone === 'warn' && 'text-warn',
                item.tone === 'bad' && 'text-bad',
              )}
            >
              {item.value}
            </div>
            {item.caption && <div className="min-w-0 break-words text-xs text-muted-foreground">{item.caption}</div>}
          </div>
          {item.lines.map((line) => (
            <div
              key={line.text}
              title={line.title}
              className={cn(
                'break-words text-[11px] leading-[14px] text-muted-foreground',
                line.tone === 'bad' && 'text-bad',
              )}
            >
              {line.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
