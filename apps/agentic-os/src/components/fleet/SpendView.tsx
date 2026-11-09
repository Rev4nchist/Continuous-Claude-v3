import type { SpendView as SpendData } from '@/server/queries/mission-control';
import { engineKind, formatCtClock, RUN_CAP, type EngineSum, type EstRow, type Usd } from '@/server/queries/spend-fold';
import type { RollupView } from '@/server/queries/spend-rollup-parse';

import { cn } from '@/lib/utils';

import { costLabel, formatUsd } from './format';
import { SessionLabel } from './SessionLabel';

/**
 * The Spend tab. Pure props: it fetches nothing and holds no state. The data is `snapshot.spend`, filled only
 * for `view=spend` (src/server/queries/mission-control.ts).
 *
 * Five labels, one meaning each, and nothing else: engine, est, at least, unpriced, no data. A number never
 * shows without its label. A run with no price never reads $0.00. A null engine never reads as 0.
 *
 * Raw values sit in `data-*` attributes (cents, the same numbers the text shows) so a test reads numbers, not prose.
 * The residual line keeps the labels of both operands (engine, est, at least, unpriced); the fold rounds each
 * shown number to the cent first, so the line adds up. The rollup shows as a
 * list of cards, not a wide table: a phone must not scroll sideways. Ids wrap anywhere.
 */

const SECTION = 'rounded-md border bg-card';
const SECTION_HEAD = 'border-b px-3 py-2 text-xs text-muted-foreground';
const DASHED = 'rounded-lg border border-dashed p-4 text-sm text-muted-foreground';
const WRAP = 'min-w-0 [overflow-wrap:anywhere]';

const signedUsd = (value: number): string => (value < 0 ? `-${formatUsd(-value)}` : formatUsd(value));
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The engine number with its label: "no data", "engine $9.00", "est $9.00", "at least engine $9.00", "at least est $9.00". */
function engineOperand(engine: EngineSum): string {
  const kind = engineKind(engine);
  if (kind === 'no data' || engine.usd === null) return 'no data';
  const prefix = kind === 'at least' ? (engine.live ? 'at least est ' : 'at least engine ') : `${kind} `;
  return `${prefix}${formatUsd(engine.usd)}`;
}

/** The engine sum in words: the labelled number, then the no-data and since-resume counts. */
function engineText(engine: EngineSum): string {
  if (engine.usd === null) return 'no data';
  const parts = [engineOperand(engine)];
  if (engine.noData > 0) parts.push(`${engine.noData} no data`);
  if (engine.resumed > 0) parts.push(`${engine.resumed} since resume`);
  return parts.join(' · ');
}

/** The ledger sum: est, with the floor and unpriced words of `costLabel`. */
function estText(est: Usd): string {
  const base = costLabel(est);
  if (base === 'unpriced') return base;
  return est.floor ? base.replace(/^at least /, 'at least est ') : `est ${base}`;
}

function SectionTitle({ children, note }: { children: string; note?: string }) {
  return (
    <header className={cn(SECTION_HEAD, 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1')}>
      <h3 className="text-foreground">{children}</h3>
      {note !== undefined && <span>{note}</span>}
    </header>
  );
}

function EstTable({
  testId,
  title,
  note,
  rows,
  total,
}: {
  testId: string;
  title: string;
  note: string;
  rows: EstRow[];
  total: number;
}) {
  return (
    <section data-testid={testId} className={cn(SECTION, 'min-w-0')}>
      <SectionTitle note={note}>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">No subagent runs today.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row, index) => (
            <li
              key={`${row.key}-${index}`}
              data-testid={`${testId}-row`}
              data-key={row.key}
              data-usd={row.usd}
              data-floor={row.floor ? 'true' : 'false'}
              data-unpriced={row.unpriced}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
            >
              <span className={cn(WRAP, 'font-mono text-xs')}>{row.key}</span>
              <span className="text-xs text-muted-foreground">
                {plural(row.runs, 'run')} · {estText(row)}
                {total > 0 && row.usd > 0 ? ` · ${Math.round((row.usd / total) * 100)}%` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TOKEN_FIELDS = [
  ['requests', 'requests'],
  ['input', 'input'],
  ['cacheRead', 'cache read'],
  ['write5m', 'write 5m'],
  ['write1h', 'write 1h'],
  ['writeRem', 'write other'],
  ['output', 'output'],
  ['thinking', 'thinking'],
  ['webSearches', 'searches'],
] as const;

function RollupRows({ rollup }: { rollup: RollupView }) {
  return (
    <ul className="divide-y">
      {rollup.rows.map((row, index) => (
        <li
          key={`${row.model}-${row.effort}-${row.kind}-${index}`}
          data-testid="spend-rollup-row"
          data-model={row.model}
          data-effort={row.effort ?? ''}
          data-kind={row.kind}
          data-est-usd={row.estUsd ?? ''}
          className="space-y-1 px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className={cn(WRAP, 'font-mono text-xs')}>
              {row.model} · {row.effort ?? (row.kind === 'helper' ? 'helper, no effort' : 'no effort')} · {row.kind}
            </span>
            <span data-testid="spend-rollup-est" className="text-xs text-muted-foreground">
              {row.estUsd === null ? 'no est' : `est ${formatUsd(row.estUsd)}`}
              {row.sharePct === null ? '' : ` · ${row.sharePct}%`}
            </span>
          </div>
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {TOKEN_FIELDS.map(([key, label]) => (
              <div key={key} className="flex gap-1">
                <dt>{label}</dt>
                <dd className="tabular-nums text-foreground">{row[key].toLocaleString('en-US')}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Rollup({ result }: { result: SpendData['rollup'] }) {
  if (result.status === 'unknown-schema') {
    return (
      <p data-testid="spend-rollup-schema" className={DASHED}>
        Engine by model: rollup schema not known.
      </p>
    );
  }
  if (result.status === 'absent') {
    return (
      <p data-testid="spend-rollup-missing" className={DASHED}>
        Engine by model: rollup not built yet.
      </p>
    );
  }
  const { rollup } = result;
  return (
    <section data-testid="spend-rollup" className={cn(SECTION, 'min-w-0')}>
      <SectionTitle note={`built ${formatCtClock(Date.parse(rollup.builtAt))}`}>Engine by model</SectionTitle>
      <ul className="divide-y border-b">
        {rollup.models.map((model) => (
          <li
            key={model.model}
            data-testid="spend-rollup-model"
            data-model={model.model}
            data-engine-usd={model.engineUsd ?? ''}
            data-est-usd={model.estUsd ?? ''}
            data-residual-usd={model.residualUsd ?? ''}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
          >
            <span className={cn(WRAP, 'font-mono text-xs')}>{model.model}</span>
            <span className="text-xs text-muted-foreground">
              {model.engineUsd === null ? 'no engine data' : `engine ${formatUsd(model.engineUsd)}`}
              {model.estUsd === null ? ' · no est' : ` · est ${formatUsd(model.estUsd)}`}
              {model.residualUsd === null ? '' : ` · residual ${signedUsd(model.residualUsd)}`}
              {model.sharePct === null ? '' : ` · ${model.sharePct}%`}
            </span>
          </li>
        ))}
      </ul>
      <RollupRows rollup={rollup} />
    </section>
  );
}

export function SpendView({ spend }: { spend: SpendData }) {
  const { engine, est, quota, quality } = spend;
  const estTotal = est.usd;
  const rollup = spend.rollup.status === 'ok' ? spend.rollup.rollup : null;
  return (
    <div data-testid="spend-view" className="min-w-0 space-y-3.5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold">
          Spend <span className="font-normal text-muted-foreground">· sessions seen today, {spend.day}</span>
        </h2>
        <span data-testid="spend-as-of" className="text-xs text-muted-foreground">
          as of {formatCtClock(Date.parse(spend.asOf))}
        </span>
      </header>

      {engine.sessions === 0 ? (
        <p data-testid="spend-empty" className={DASHED}>
          No session state files today.
        </p>
      ) : (
        <section className={cn(SECTION, 'space-y-1 p-3')}>
          <p
            data-testid="spend-engine"
            data-kind={engineKind(engine)}
            data-usd={engine.usd ?? undefined}
            className={cn(WRAP, 'text-lg font-semibold')}
          >
            {engineText(engine)}
          </p>
          <p
            data-testid="spend-est"
            data-usd={est.usd}
            data-floor={est.floor ? 'true' : 'false'}
            data-unpriced={est.unpriced}
            className={cn(WRAP, 'text-sm text-muted-foreground')}
          >
            {estText(est)} <span className="text-xs">subagent ledger, API-rate estimate, not the bill</span>
          </p>
          <p
            data-testid="spend-residual"
            data-usd={spend.residualUsd ?? undefined}
            className={cn(WRAP, 'text-xs text-muted-foreground')}
          >
            {spend.residualUsd === null || engine.usd === null
              ? 'not in ledger: no data'
              : `${engineOperand(engine)} minus ${estText(est)} not in ledger: ${signedUsd(spend.residualUsd)}`}
          </p>
        </section>
      )}

      <p
        data-testid="spend-quota"
        data-tone={quota.amber ? 'warn' : undefined}
        className={cn(SECTION, 'p-3 text-sm', quota.amber ? 'text-warn' : 'text-muted-foreground')}
      >
        {quota.sevenDayPct === null
          ? '7-day quota not reported'
          : `7-day quota ${Math.round(quota.sevenDayPct)}% used${
              quota.asOfMs === null ? '' : ` · as of ${formatCtClock(quota.asOfMs)}`
            }`}
      </p>

      <div className="grid min-w-0 gap-3.5 lg:grid-cols-3">
        <EstTable testId="spend-by-model" title="Est by model" note="est" rows={spend.byModel} total={estTotal} />
        <EstTable
          testId="spend-by-effort"
          title="Est by effort"
          note="requested effort, not applied"
          rows={spend.byEffort}
          total={estTotal}
        />
        <EstTable testId="spend-by-type" title="Est by agent type" note="top 8 and other" rows={spend.byType} total={estTotal} />
      </div>

      <section data-testid="spend-by-session" className={cn(SECTION, 'min-w-0')}>
        <SectionTitle note="top 10 by engine">By session</SectionTitle>
        {spend.bySession.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No sessions today.</p>
        ) : (
          <ul className="divide-y">
            {spend.bySession.map((row) => (
              <li
                key={row.sessionId}
                data-testid="spend-by-session-row"
                data-session={row.sessionId}
                data-usd={row.engine.usd ?? undefined}
                data-tone={row.amber ? 'warn' : undefined}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
              >
                <SessionLabel name={row.name} shortId={row.shortId} />
                <span className={cn('text-xs', row.amber ? 'text-warn' : 'text-muted-foreground')}>
                  {engineText(row.engine)} · {estText(row.est)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Rollup result={spend.rollup} />

      <p
        data-testid="spend-quality"
        data-no-data={quality.noData}
        data-unpriced-runs={quality.unpricedRuns}
        data-at-cap={quality.atCap}
        data-resumed={quality.resumed}
        className={cn(SECTION, 'space-y-1 p-3 text-xs text-muted-foreground')}
      >
        <span className="block">
          {quality.noData} with no data · {plural(quality.unpricedRuns, 'unpriced run')} · {quality.atCap} at the{' '}
          {RUN_CAP}-run cap · {quality.resumed} resumed
        </span>
        {rollup !== null && (
          <span className="block">
            rollup: {rollup.quality.clean} of {rollup.quality.sessions} sessions clean
            {rollup.quality.residualBandPct === null ? '' : ` · residual band ${rollup.quality.residualBandPct}%`}
          </span>
        )}
        <span className="block">subagent $ misses runs past the {RUN_CAP}-run cap</span>
      </p>

      <p data-testid="spend-not-built" className="text-xs text-muted-foreground">
        Not in this view yet: hourly against median, 7-day history, anomalies, by lane. They need the rollup history.
      </p>
    </div>
  );
}
