import type { UnmatchedBucket } from '@/server/queries/projects';

import { formatCount, plural } from './format';

/**
 * What the grid above is NOT accounting for, split three ways.
 *
 * The split is the point. Lumped together, "58 unmatched sessions" is a number
 * you learn to ignore. Split, it is three different pieces of work:
 *
 *   rejected      nothing to do — reviewed and correctly excluded
 *   notOnboarded  a REAL project missing from the registry; add it
 *   unseen        nobody has looked at it yet; review it
 *
 * Rendering this from day one is a hard requirement of the lane, not a nicety.
 * A fleet grid that silently folds strays into the nearest project is the one
 * outcome worse than shipping no grid at all, and this panel is what makes that
 * failure mode visible rather than invisible.
 */
export function UnmatchedPanel({ unmatched }: { unmatched: UnmatchedBucket }) {
  const rows = [
    {
      key: 'notOnboarded',
      label: 'Real project, not in the registry',
      bucket: unmatched.notOnboarded,
      action: 'Add it to project-registry.json and re-seed.',
    },
    {
      key: 'unseen',
      label: 'Never reviewed',
      bucket: unmatched.unseen,
      action: 'No alias row exists yet — classify it.',
    },
    {
      key: 'rejected',
      label: 'Reviewed and rejected',
      bucket: unmatched.rejected,
      action: 'Temp dirs, installer paths, $HOME. Correctly excluded.',
    },
  ];

  if (unmatched.sessionCount === 0) {
    return (
      <section className="rounded-lg border border-dashed p-4">
        <h2 className="text-sm font-medium tracking-tight">Unaccounted sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          None. Every non-heartbeat session row maps to a project.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium tracking-tight">
          Unaccounted sessions
          <span className="ml-2 font-normal text-muted-foreground">
            {formatCount(unmatched.sessionCount)} across {formatCount(unmatched.rawCount)}{' '}
            raw {plural(unmatched.rawCount, 'path', 'paths')}
          </span>
        </h2>
      </div>

      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-4 p-4">
            <div className="w-16 shrink-0 text-right">
              <div className="text-lg font-semibold tabular-nums">
                {formatCount(row.bucket.sessionCount)}
              </div>
              <div className="text-[0.6875rem] text-muted-foreground">
                {formatCount(row.bucket.rawCount)}{' '}
                {plural(row.bucket.rawCount, 'path', 'paths')}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">{row.label}</div>
              <p className="text-xs text-muted-foreground">{row.action}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs leading-relaxed text-muted-foreground">
        These sessions are real and are deliberately not folded into any project above.
        Only the first two rows are work; the third is the mapping doing its job.
      </p>
    </section>
  );
}
