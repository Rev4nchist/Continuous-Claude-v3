'use client';

/**
 * The error boundary of the whole app (card agentic-os-tiles-truth, fault C11).
 *
 * Before this file a throw while the page rendered left Next with its own bare error page. Now a first load that
 * fails shows a plain reason and a retry. The polling endpoint no longer throws for one failed core read (the
 * snapshot names the failed source instead), so this boundary catches only what that does not: a render bug or a
 * read that fails before the snapshot exists.
 *
 * Next 16: the prop is `retry` (re-fetch and re-render), not `reset`; `error` is `unknown`. The text shown is
 * fixed. A server error message is generic in production and a raw one could hold a path, so only the digest
 * (an opaque hash that matches the server log line) is printed.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    error instanceof Error && 'digest' in error && typeof (error as { digest?: unknown }).digest === 'string'
      ? (error as { digest: string }).digest
      : null;
  return (
    <main className="mx-auto max-w-xl p-6">
      <div
        data-testid="app-error"
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
      >
        <p className="font-medium">Agentic OS could not load this page.</p>
        <p className="text-muted-foreground">
          A read failed before the page was ready. The data is not shown, and no number here is a zero from a failed read.
          {digest === null ? '' : ` Log id: ${digest}.`}
        </p>
        <button
          type="button"
          data-testid="app-error-retry"
          onClick={() => retry()}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
