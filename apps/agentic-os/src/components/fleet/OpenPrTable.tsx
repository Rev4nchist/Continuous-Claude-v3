import type { ReactNode } from 'react';

import type { PrFeedSnapshot } from '@/server/sources/pr-feed';
import type { LandedSource, PrLane, PrRowView, PrSpend } from '@/server/queries/pr-feed-parse';

import { cn } from '@/lib/utils';

import { formatCtStamp } from './flow-age';
import { formatUsd } from './format';

/** Risk bands that need a person look warm. */
const WARM_BANDS = new Set(['ELEVATED', 'HIGH', 'CRITICAL']);

function ageText(minutes: number | null): string {
  if (minutes === null) return 'time unknown';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

const LANDED_SOURCE_WORDS: Record<LandedSource, string> = {
  github: 'from GitHub',
  ledger: 'from the land ledger',
  nightly: 'from the nightly spend file',
  none: '',
};

/** "Last landed, from GitHub, updated 10 min ago". The nightly file says how old it is, so a 19 h list is not read as current. */
function landedHead(feed: PrFeedSnapshot): string {
  const source = LANDED_SOURCE_WORDS[feed.landedSource];
  if (feed.landedAgeMinutes === null) return `Last landed, ${source}, time unknown`;
  return feed.landedSource === 'nightly'
    ? `Last landed, ${source}, ${ageText(feed.landedAgeMinutes)} old`
    : `Last landed, ${source}, updated ${ageText(feed.landedAgeMinutes)} ago`;
}

function laneText(lane: PrLane): string {
  if (lane.kind === 'one') return lane.id;
  return lane.kind === 'many' ? `${lane.count} lanes` : '-';
}

function spendText(spend: PrSpend): string {
  if (spend.state === 'none-recorded') return 'none in the nightly file';
  if (spend.state === 'no-data' || (spend.usd === null && spend.engineRuns === null)) return 'no data';
  const parts = [
    spend.usd === null ? 'CodeRabbit no data' : `${formatUsd(spend.usd)} CodeRabbit`,
    spend.engineRuns === null ? 'engine no data' : `${spend.engineRuns} engine run${spend.engineRuns === 1 ? '' : 's'}`,
  ];
  return parts.join(', ');
}

function readyText(row: PrRowView, staleAge: string | null): string {
  const word = row.ready === true ? 'READY' : row.ready === false ? 'not ready' : 'unknown';
  return staleAge === null ? word : `${word} (${staleAge} old)`;
}

function Field({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0 font-mono [overflow-wrap:anywhere]">
        {children}
      </dd>
    </>
  );
}

function PrCard({ row, staleAge }: { row: PrRowView; staleAge: string | null }) {
  return (
    <li data-testid="open-pr-row" data-pr={row.pr} className="min-w-0 space-y-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-testid="open-pr-number" className="font-mono text-sm font-semibold">{`#${row.pr}`}</span>
        {row.draft && <span className="rounded border px-1.5 text-[0.6875rem] text-muted-foreground">draft</span>}
        <span
          data-testid="open-pr-ready"
          className={cn(
            'ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
            row.ready === true ? 'border-done/50 bg-done/10 text-done' : 'border-border text-muted-foreground',
          )}
        >
          {readyText(row, staleAge)}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Field label="lane" testId="open-pr-lane">{laneText(row.lane)}</Field>
        <Field label="risk band" testId="open-pr-band">
          <span className={cn(row.band !== null && WARM_BANDS.has(row.band) && 'text-warn')}>{row.band ?? '-'}</span>
        </Field>
        <Field label="last tap" testId="open-pr-tap">
          {row.tap === null ? 'none' : `${row.tap.step}: ${row.tap.label}${row.tap.headMatches ? '' : ' (older head)'}`}
        </Field>
        <Field label="review path" testId="open-pr-review">{row.reviewPath ?? '-'}</Field>
        {/* Only CodeRabbit dollars and engine runs are per PR; headless runs and session tokens are not (C14). */}
        <Field label="CodeRabbit + engine" testId="open-pr-spend">{spendText(row.spend)}</Field>
        <Field label="CI" testId="open-pr-ci">{row.ci.length === 0 ? '-' : row.ci.join(', ')}</Field>
        <Field label="land commit" testId="open-pr-land">{row.landSha ?? '-'}</Field>
        {row.status !== 'ok' && <Field label="check" testId="open-pr-status">{row.status}</Field>}
      </dl>
    </li>
  );
}

function Body({ feed }: { feed: PrFeedSnapshot }) {
  if (feed.status !== 'ok') {
    return (
      <p data-testid="open-pr-absent" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {feed.status === 'other-repo' ? 'The open-PR feed names another repo.' : 'No open-PR feed yet.'}
      </p>
    );
  }
  if (feed.rows.length === 0) {
    return (
      <p data-testid="open-pr-empty" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No open pull requests.
      </p>
    );
  }
  const staleAge = feed.stale ? ageText(feed.ageMinutes) : null;
  return (
    <ul className="space-y-2">
      {feed.rows.map((row) => (
        <PrCard key={row.pr} row={row} staleAge={staleAge} />
      ))}
    </ul>
  );
}

/**
 * Open pull requests (card prflow-pr-row): one read-only card per open PR, from the local open-PR feed and the
 * nightly spend file. Pure props. It shows no head ref, sha, label or title: the server sends none.
 * The old PrPanel (PRs that live sessions watch) stays as it is.
 */
export function OpenPrTable({ feed }: { feed: PrFeedSnapshot }) {
  return (
    <section data-testid="open-pr-table" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm font-medium tracking-tight">
        <span>Open pull requests</span>
        {feed.status === 'ok' && (
          <span
            data-testid={feed.stale ? 'open-pr-stale' : 'open-pr-age'}
            className={cn('text-xs font-normal', feed.stale ? 'text-warn' : 'text-muted-foreground')}
          >
            {feed.stale ? `stale: ${ageText(feed.ageMinutes)} old` : `updated ${ageText(feed.ageMinutes)} ago`}
          </span>
        )}
      </div>

      <Body feed={feed} />

      {feed.landed.length > 0 && (
        <div className="space-y-1 text-xs">
          <p data-testid="open-pr-landed-head" className="text-muted-foreground">
            {landedHead(feed)}
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono">
            {feed.landed.map((l) => (
              <li key={l.pr} data-testid="open-pr-landed-row">
                {[`#${l.pr}`, l.sha7, l.mergedAt === null ? null : formatCtStamp(Date.parse(l.mergedAt))].filter((x) => x !== null).join(' ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p data-testid="open-pr-note" className="text-xs text-muted-foreground">
        {[
          'From the local open-PR feed (every 15 minutes) and the nightly spend file.',
          feed.capped ? 'Only the newest 20 PRs show.' : null,
          feed.skipped > 0 ? `${feed.skipped} row${feed.skipped === 1 ? '' : 's'} skipped.` : null,
          feed.laneLookup === 'failed' ? 'Lane lookup failed.' : null,
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
    </section>
  );
}
