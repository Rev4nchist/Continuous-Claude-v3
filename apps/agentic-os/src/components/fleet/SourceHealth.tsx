import type { DataSource } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

const DOT: Record<DataSource['status'], string> = {
  ok: 'bg-done',
  degraded: 'bg-warn',
  error: 'bg-bad',
};

const TEXT: Record<DataSource['status'], string> = {
  ok: 'text-done',
  degraded: 'text-warn',
  error: 'text-bad',
};

/**
 * One row per data source: its status and what it read. A failing source shows here and
 * leaves the rest of the page alone. The detail text holds counts, never file content.
 */
export function SourceHealth({ sources }: { sources: DataSource[] }) {
  return (
    <section data-testid="source-health" className="space-y-3">
      <h2 className="text-sm font-medium tracking-tight">
        Data sources
        <span className="ml-2 font-normal text-muted-foreground">{sources.length} read</span>
      </h2>
      <ul className="grid grid-cols-1 gap-2">
        {sources.map((source) => (
          <li
            key={source.id}
            data-testid={`source-${source.id}`}
            className="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-3"
          >
            <span
              aria-hidden
              className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[source.status])}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm font-medium">{source.label}</span>{' '}
                <span className={cn('text-xs font-medium', TEXT[source.status])}>
                  {source.status}
                </span>
              </div>{' '}
              <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">
                {source.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
