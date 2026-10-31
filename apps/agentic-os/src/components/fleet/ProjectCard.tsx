import type { ProjectSummary } from '@/server/queries/projects';

import { cn } from '@/lib/utils';

import { formatAgo, formatCount, plural, statusClasses } from './format';

/**
 * One project in the fleet grid.
 *
 * Three numbers, and the two smaller ones keep the big one honest:
 *   sessionCount — EVERY session attributed here, across every harness
 *   byHarness    — which harness wrote them (Claude Code / removed CLI / legacy)
 *   rawSpellings — how many distinct `sessions.project` strings collapsed to get there
 *
 * `continuous-claude` shows 1,456 sessions from 23 spellings. Without the spelling
 * count that number looks like double-counting; with it, it reads as what it is —
 * subdirectories, worktrees, slash-direction and case variants of one path.
 *
 * The harness split is not decoration. Until 2026-07-28 this card said "sessions"
 * and meant "Claude Code sessions", while 41% of agent-arch's were actually the removed CLI
 * and 1,483 legacy registrations were excluded entirely. A single number could not
 * be both totals at once, so it silently was neither.
 *
 * The mapping behind all of it is hand-authored, so the count proves nothing was
 * DROPPED and nothing here can prove a row went to the RIGHT project.
 */
export function ProjectCard({
  project,
  onSelect,
  selected = false,
}: {
  project: ProjectSummary;
  /** When set, the title is a button that selects this project (the session-card filter). */
  onSelect?: (key: string) => void;
  selected?: boolean;
}) {
  const idle = project.sessionCount === 0;

  return (
    <article
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors',
        'hover:border-foreground/20',
        idle && 'opacity-60',
        selected && 'border-doing ring-1 ring-doing/60',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium tracking-tight [overflow-wrap:anywhere]" title={project.displayName}>
            {onSelect ? (
              // The button holds ONLY the name, so its accessible name is the display name.
              // The pseudo-element stretches the click target over the whole card.
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(project.key)}
                className="block max-w-full text-left [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']"
              >
                {project.displayName}
              </button>
            ) : (
              project.displayName
            )}
          </h3>
          {project.displayName !== project.key && (
            <p className="truncate font-mono text-xs text-muted-foreground">{project.key}</p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
            statusClasses(project.status),
          )}
        >
          {project.status}
        </span>
      </header>

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {formatCount(project.sessionCount)}
        </span>
        <span className="text-xs text-muted-foreground">
          {plural(project.sessionCount, 'session')}
        </span>
      </div>

      {project.sessionCount > 0 && (
        <p className="-mt-1 font-mono text-[0.6875rem] text-muted-foreground">
          {/* Only non-zero harnesses, so a Claude-only project does not carry a
              permanent zero for a harness that is not writing new rows. */}
          {(
            [
              ['claude', project.byHarness.claude],
              ['uuidv7', project.byHarness.uuidv7],
              ['legacy', project.byHarness.legacy],
              ['other', project.byHarness.other],
            ] as const
          )
            .filter(([, n]) => n > 0)
            .map(([name, n]) => `${name} ${formatCount(n)}`)
            .join('  ·  ')}
        </p>
      )}

      <dl className="mt-auto grid gap-1 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex items-baseline justify-between gap-3">
          <dt>Last active</dt>
          <dd className="tabular-nums text-foreground/80">
            {formatAgo(project.lastActivitySecondsAgo)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt
            title="Distinct raw sessions.project strings that normalize to this project — subdirectories, worktrees, slash and case variants."
            className="relative z-10 cursor-help decoration-dotted underline-offset-2 hover:underline"
          >
            Path spellings
          </dt>
          <dd className="tabular-nums text-foreground/80">{project.rawSpellings || '—'}</dd>
        </div>
        {(project.port !== null || project.url !== null) && (
          <div className="flex items-baseline justify-between gap-3">
            <dt>Dev</dt>
            <dd className="truncate font-mono text-[0.6875rem] text-foreground/80">
              {project.url ?? `:${project.port}`}
            </dd>
          </div>
        )}
      </dl>
    </article>
  );
}
