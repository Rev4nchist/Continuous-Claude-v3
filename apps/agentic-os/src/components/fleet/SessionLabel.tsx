import { cn } from '@/lib/utils';

/**
 * "name #sid8": the session name, then the first 8 characters of the id in muted text.
 * A session with no name reads "unnamed #sid8", all muted. Never amber: amber already means
 * "waiting on Dave", an open ask, or a quiet session (decision D7).
 *
 * The label is its own element with its own testid. `card.name` (the project/branch/id4
 * composite) stays in the elements it always had.
 */
export function SessionLabel({
  name,
  shortId,
  className,
}: {
  name: string | null;
  shortId: string;
  className?: string;
}) {
  return (
    <span
      data-testid="session-label"
      data-named={name === null ? 'false' : 'true'}
      className={cn('min-w-0 font-mono text-xs [overflow-wrap:anywhere]', name === null && 'text-muted-foreground', className)}
    >
      <span className={name === null ? undefined : 'font-bold'}>{name ?? 'unnamed'}</span>{' '}
      <span className="text-muted-foreground">{`#${shortId}`}</span>
    </span>
  );
}
