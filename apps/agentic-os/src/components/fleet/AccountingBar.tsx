import type { FleetOverview } from '@/server/queries/projects';

import { cn } from '@/lib/utils';

import { formatCount } from './format';

/**
 * THE ARITHMETIC, SHOWN.
 *
 * This bar exists because the fleet grid's per-project counts are only
 * trustworthy if the number they FAIL to account for is on screen next to them.
 * Every row in `public.sessions` lands in exactly one of four buckets, and they
 * sum to the table's row count:
 *
 *   mapped + unmatched + duplicates + nullProject = totalSessionRows
 *
 * `reconciles` is that check, run in the query against a single snapshot rather
 * than asserted in a test. If it is ever false the projection is lying, and this
 * component says so instead of rendering a confident total — the failure state is
 * the reason the flag travels in the DTO at all.
 *
 * What the sum proves: no session row was dropped or double-counted.
 * What it does NOT prove: that any row went to the RIGHT project. Only the
 * hand-authored mapping decides that, and nothing on this screen can validate it.
 */
export function AccountingBar({ fleet }: { fleet: FleetOverview }) {
  const mapped = fleet.projects.reduce((sum, p) => sum + p.sessionCount, 0);

  const buckets = [
    {
      label: 'Attributed',
      value: mapped,
      hint: 'Real sessions mapped to a project in the grid above.',
      tone: 'text-foreground',
    },
    {
      label: 'Unaccounted',
      value: fleet.unmatched.sessionCount,
      hint: `${fleet.unmatched.rawCount} raw project values with no confident mapping.`,
      tone: fleet.unmatched.sessionCount > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-foreground',
    },
    {
      label: 'Duplicates',
      value: fleet.duplicates,
      hint:
        'Pre-2026-07-26 s-* registrations collapsed into the uuid row for the SAME session, ' +
        'so they are not counted twice. Matched on identical raw path within 90 seconds — ' +
        'a strict heuristic, so this is a floor and some twins go undetected.',
      tone: 'text-muted-foreground',
    },
    {
      label: 'No project',
      value: fleet.nullProject,
      hint: 'Rows with a NULL or empty project column.',
      tone: 'text-muted-foreground',
    },
  ];

  return (
    <section className="space-y-3">
      {!fleet.reconciles && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          <p className="font-medium text-destructive">
            These numbers do not add up — treat the grid as unreliable.
          </p>
          <p className="mt-1 text-muted-foreground">
            The four buckets below sum to {formatCount(mapped + fleet.unmatched.sessionCount + fleet.duplicates + fleet.nullProject)}
            , but <code className="text-xs">public.sessions</code> holds{' '}
            {formatCount(fleet.totalSessionRows)} rows. A session has been dropped or
            double-counted by the partition, which means every per-project count above may
            be wrong. This is a query bug, not a data problem.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {buckets.map((bucket) => (
          <div key={bucket.label} className="bg-card p-4" title={bucket.hint}>
            <div className={cn('text-xl font-semibold tabular-nums', bucket.tone)}>
              {formatCount(bucket.value)}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{bucket.label}</div>
          </div>
        ))}
      </div>

      {/* WHICH HARNESS. Orthogonal to the arithmetic above, not another slice of it:
          these three sum to Attributed, and they answer a different question — not
          "can we account for this row" but "what wrote it". The removed CLI is broken out
          because it was previously counted as Claude Code, silently: agent-arch was
          41% that CLI under a card that said "sessions". */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
        {(
          [
            {
              key: 'claude',
              label: 'Claude Code',
              value: fleet.byHarness.claude,
              hint: 'UUIDv4 session ids — written by this repo’s own hooks.',
            },
            {
              key: 'retired',
              label: 'Removed CLI',
              value: fleet.byHarness.retired,
              hint:
                'Historical UUIDv7 thread ids from the removed cross-model CLI. ' +
                'That hook install is deleted. These rows are not still being written.',
            },
            {
              key: 'legacy',
              label: 'Legacy',
              value: fleet.byHarness.legacy,
              hint:
                'Pre-2026-07-26 s-* registrations, after removing provable duplicates. ' +
                'An UPPER bound: undetected twins may still be inside it. Production of ' +
                'this id shape has stopped, so the number is frozen, not growing.',
            },
          ] as const
        ).map((h) => (
          <div key={h.key} className="bg-card p-4" title={h.hint}>
            <div className="text-xl font-semibold tabular-nums">{formatCount(h.value)}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{h.label}</div>
          </div>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {fleet.reconciles ? (
          <>
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              Reconciled.
            </span>{' '}
            Those four buckets sum to exactly {formatCount(fleet.totalSessionRows)} — every
            row in <code className="text-[0.7rem]">public.sessions</code>, counted once.
          </>
        ) : (
          <>Partition check FAILED against {formatCount(fleet.totalSessionRows)} total rows.</>
        )}{' '}
        Per-project counts include sessions started in <strong>subdirectories and git
        worktrees</strong> of that project, which is why one project can show hundreds of
        sessions across a dozen path spellings without double-counting. The check proves no
        row was lost; it cannot prove a row was attributed to the right project — that
        depends on a hand-authored alias mapping.
      </p>
    </section>
  );
}
