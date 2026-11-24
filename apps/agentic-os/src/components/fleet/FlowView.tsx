import { useEffect, useState } from 'react';

import type { FlowBarView, FlowCardView, FlowFileView, FlowRowView, FlowSeriesView, FlowTone, FlowView as FlowData } from '@/server/queries/lane-dash-parse';

import { cn } from '@/lib/utils';

import { flowAge } from './flow-age';

/** How often the ages on this tab count up. The ages show whole minutes, so 30 seconds is fine. */
const CLOCK_TICK_MS = 30_000;

/**
 * The Flow tab. Pure props: it fetches nothing. Its only state is the clock for the ages. The data is `snapshot.flow`, filled only for
 * `view=flow` (src/server/queries/mission-control.ts). Read only: it shows the rows that the lane-dashboard lane
 * exports to flow.json and factory.json, as given. The meaning of a row is the exporter's; this tab computes nothing.
 *
 * One section per file, one card per id prefix, the card's `<prefix>.summary` on top. Figure and text rows are a
 * label and value list. Day and bar rows are a bar list in rank order. A tone of warn or bad uses the existing
 * `text-warn` and `text-bad` classes; any other tone has no colour.
 *
 * Raw values sit in `data-*` attributes so a test reads values, not prose. The cards are lists, not tables, and
 * every id wraps anywhere: a phone must not scroll sideways.
 */

const SECTION = 'rounded-md border bg-card';
const DASHED = 'rounded-lg border border-dashed p-4 text-sm text-muted-foreground';
const WRAP = 'min-w-0 [overflow-wrap:anywhere]';

const toneClass = (tone: FlowTone | null): string | undefined =>
  tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : undefined;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The shown value of a figure or text row: its text, else its number, else a dash. */
const shown = (row: FlowRowView): string => row.text ?? (row.value === null ? '-' : String(row.value));

function Row({ row }: { row: FlowRowView }) {
  return (
    <li
      data-testid="flow-row"
      data-id={row.id}
      data-kind={row.kind}
      data-tone={row.tone ?? undefined}
      data-value={row.value ?? undefined}
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-1.5 text-sm"
    >
      <span className={cn(WRAP, 'font-mono text-xs text-muted-foreground')}>{row.id}</span>
      <span data-testid="flow-row-value" className={cn(WRAP, 'text-xs tabular-nums', toneClass(row.tone))}>
        {shown(row)}
      </span>
    </li>
  );
}

function Bar({ bar, max }: { bar: FlowBarView; max: number }) {
  const width = bar.value !== null && max > 0 ? Math.max(0, Math.round((bar.value / max) * 100)) : 0;
  return (
    <li
      data-testid="flow-bar"
      data-rank={bar.rank}
      data-label={bar.label}
      data-tone={bar.tone ?? undefined}
      data-value={bar.value ?? undefined}
      className="flex items-center gap-2 px-3 py-1 text-xs"
    >
      <span className={cn(WRAP, 'w-16 shrink-0 text-muted-foreground')}>{bar.label}</span>
      <span className="h-2 min-w-0 flex-1 rounded-sm bg-[var(--line2)]" aria-hidden>
        <span className="block h-2 rounded-sm bg-doing" style={{ width: `${width}%` }} />
      </span>
      <span className={cn('shrink-0 tabular-nums', toneClass(bar.tone))}>{bar.value === null ? '-' : bar.value}</span>
    </li>
  );
}

/** The text of a series when every row carries the same one ("Done", "Landed"); else nothing. */
function seriesText(series: FlowSeriesView): string | null {
  const first = series.rows[0]?.text ?? null;
  return first !== null && series.rows.every((bar) => bar.text === first) ? first : null;
}

function Series({ series }: { series: FlowSeriesView }) {
  const max = series.rows.reduce((top, bar) => Math.max(top, bar.value ?? 0), 0);
  const text = seriesText(series);
  return (
    <div data-testid="flow-series" data-key={series.key} className="min-w-0 border-t py-1.5">
      <p className={cn(WRAP, 'px-3 pb-1 font-mono text-xs text-muted-foreground')}>
        {series.key}
        {text === null ? '' : ` · ${text}`}
      </p>
      <ul>
        {series.rows.map((bar, i) => (
          <Bar key={`${bar.id}:${i}`} bar={bar} max={max} />
        ))}
      </ul>
    </div>
  );
}

function Card({ card }: { card: FlowCardView }) {
  return (
    <section data-testid="flow-card" data-prefix={card.prefix} className={cn(SECTION, 'min-w-0')}>
      <header className="border-b px-3 py-2 text-xs">
        <h4 className={cn(WRAP, 'font-mono text-foreground')}>{card.prefix}</h4>
        {card.summary !== null && (
          <p data-testid="flow-summary" className={cn(WRAP, 'mt-1 text-sm text-foreground')}>
            {card.summary}
          </p>
        )}
      </header>
      {card.rows.length > 0 && (
        <ul className="divide-y">
          {card.rows.map((row, i) => (
            <Row key={`${row.id}:${i}`} row={row} />
          ))}
        </ul>
      )}
      {card.series.map((series) => (
        <Series key={series.key} series={series} />
      ))}
    </section>
  );
}

function FileSection({ file, nowMs }: { file: FlowFileView; nowMs: number }) {
  const age = file.exportedAt === null ? null : flowAge(file.name, file.exportedAt, nowMs);
  return (
    <section data-testid="flow-file" data-file={file.name} data-status={file.status} className="min-w-0 space-y-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-mono text-xs text-foreground">{file.name}.json</h3>
        {age !== null && (
          <span
            data-testid="flow-exported"
            data-stale={age.stale ? 'true' : 'false'}
            suppressHydrationWarning
            className={age.stale ? 'text-xs text-warn' : 'text-xs text-muted-foreground'}
          >
            {age.text}
          </span>
        )}
        {age?.note != null && (
          <span data-testid="flow-file-note" className="basis-full text-xs text-muted-foreground">
            {age.note}
          </span>
        )}
      </header>
      {file.status === 'absent' ? (
        <p data-testid="flow-missing" className={DASHED}>
          Flow export not found.
        </p>
      ) : (
        <>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {file.cards.map((card) => (
              <Card key={card.prefix} card={card} />
            ))}
          </div>
          {file.skipped > 0 && (
            <p data-testid="flow-skipped" className="text-xs text-muted-foreground">
              {plural(file.skipped, 'row')} skipped
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function FlowView({ flow, nowMs }: { flow: FlowData; nowMs?: number }) {
  // The clock is read once at mount and then on a timer, never during render (react-hooks/purity).
  // A caller that passes `nowMs` owns the clock and the timer stays off.
  const [tickMs, setTickMs] = useState(() => Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return;
    const timer = setInterval(() => setTickMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [nowMs]);
  const now = nowMs ?? tickMs;
  return (
    <div data-testid="flow-view" className="min-w-0 space-y-3.5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold">
          Flow <span className="font-normal text-muted-foreground">· lane-dashboard export, read only</span>
        </h2>
      </header>
      {flow.files.map((file) => (
        <FileSection key={file.name} file={file} nowMs={now} />
      ))}
    </div>
  );
}
