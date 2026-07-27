import { getScaffoldHealth } from '@/server/queries/health';

/**
 * Scaffold proof, not product.
 *
 * This page exists to demonstrate that the wiring is real: Next renders, the
 * `agentic_os_app` role connects, and a live read reaches the UI THROUGH the
 * query layer rather than around it. It is intentionally not a fleet grid —
 * that is `aos-fleet-grid`, and it is blocked on `aos-project-identity` for a
 * reason worth restating: the grid's whole value is per-project counts, and a
 * confidently-wrong grid is worse than shipping nothing.
 *
 * So the number below is labelled as the raw row count it actually is.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const health = await getScaffoldHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Agentic OS</h1>
        <p className="text-sm text-muted-foreground">
          Slice 1 scaffold. Local-first, read-only, no auth.
        </p>
      </header>

      <dl className="grid gap-3 rounded-lg border p-4 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">Database</dt>
          <dd className={health.database.ok ? 'font-medium' : 'font-medium text-destructive'}>
            {health.database.ok
              ? `connected as agentic_os_app (${health.database.latencyMs}ms)`
              : health.database.error}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">
            Raw <code className="text-xs">public.sessions</code> rows
          </dt>
          <dd className="font-medium tabular-nums">{health.rawSessionRows ?? '—'}</dd>
        </div>
      </dl>

      <p className="text-xs leading-relaxed text-muted-foreground">
        That row count is raw and not yet meaningful: roughly 1,465 of these rows are{' '}
        <code className="text-[0.7rem]">s-*</code> coordination heartbeats rather than real
        Claude Code sessions. Normalizing 111 raw project values down to ~20 projects — and
        surfacing an unmatched bucket rather than silently folding strays into the wrong
        project — is the <code className="text-[0.7rem]">aos-project-identity</code> lane,
        which gates the fleet grid.
      </p>
    </main>
  );
}
