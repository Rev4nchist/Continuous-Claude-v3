import type { StatTiles as StatTilesData } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

import { formatCount } from './format';

type Tone = 'plain' | 'warn' | 'bad';

/**
 * Five numbers, in a fixed order. Needs Dave is amber when above zero (a person is needed),
 * Blocked is red when above zero. Everything else is plain.
 */
export function StatTiles({ tiles }: { tiles: StatTilesData }) {
  const items: { label: string; value: number; tone: Tone }[] = [
    { label: 'Live sessions', value: tiles.liveSessions, tone: 'plain' },
    { label: 'Needs Dave', value: tiles.needsDave, tone: tiles.needsDave > 0 ? 'warn' : 'plain' },
    { label: 'Blocked', value: tiles.blocked, tone: tiles.blocked > 0 ? 'bad' : 'plain' },
    { label: 'Active lanes', value: tiles.activeLanes, tone: 'plain' },
    { label: 'Open PRs', value: tiles.openPrs, tone: 'plain' },
  ];

  return (
    <div data-testid="stat-tiles" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          data-testid="stat-tile"
          className="min-w-0 rounded-lg border bg-card p-3"
        >
          <div className="truncate text-xs text-muted-foreground">{item.label}</div>
          <div
            className={cn(
              'mt-1 text-2xl font-semibold tabular-nums',
              item.tone === 'warn' && 'text-warn',
              item.tone === 'bad' && 'text-bad',
            )}
          >
            {formatCount(item.value)}
          </div>
        </div>
      ))}
    </div>
  );
}
