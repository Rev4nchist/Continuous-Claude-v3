import type { ProjectSummary } from '@/server/queries/projects';

import { cn } from '@/lib/utils';

import { formatAgo, formatCount, plural, statusClasses } from './format';

/**
 * One project in the fleet grid, drawn like the mockup card (Fleet.dc.html, board 3): the name, one dim
 * counts line and one dim status line. Everything else sits behind a native, closed `<details>` so the
 * Projects panel stays short and Live sessions start in the first screen (Dave, 2026-10-31).
 *
 * The mockup also puts a dot in the project colour before the name. The data has no colour per
 * project, so no dot is drawn: an invented colour would not match the dots a later page gives sessions.
 *
 * Behind the disclosure, three numbers, and the two smaller ones keep the big one honest:
 *   sessionCount — EVERY session attributed here, across every harness (the counts line)
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
        'group relative flex flex-col gap-1 rounded-lg border bg-card p-3 transition-colors',
        'hover:border-foreground/20',
        idle && 'opacity-60',
        selected && 'border-doing ring-1 ring-doing/60',
      )}
    >
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
        <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{project.key}</p>
      )}

      <p data-testid="project-counts" className="text-xs tabular-nums text-muted-foreground">
        {`${formatCount(project.sessionCount)} ${plural(project.sessionCount, 'session')}`}
      </p>
      <p data-testid="project-status" className="text-xs text-muted-foreground">
        {project.status}
      </p>

      {/* z-10 lifts the disclosure above the name button's click-through layer, so it opens on its own. */}
      <details data-testid="project-more" className="relative z-10 mt-1 text-xs text-muted-foreground">
        <summary className="inline-block cursor-pointer select-none py-1 hover:text-foreground">Details</summary>
        <div className="mt-1 space-y-2">
          <span
            className={cn(
              'inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
              statusClasses(project.status),
            )}
          >
            {project.status}
          </span>

          {project.sessionCount > 0 && (
            <p className="font-mono text-[0.6875rem]">
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

          <dl className="grid gap-1 border-t pt-2">
            <div className="flex items-baseline justify-between gap-3">
              <dt>Last active</dt>
              <dd className="tabular-nums text-foreground/80">{formatAgo(project.lastActivitySecondsAgo)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt
                title="Distinct raw sessions.project strings that normalize to this project — subdirectories, worktrees, slash and case variants."
                className="cursor-help decoration-dotted underline-offset-2 hover:underline"
              >
                Path spellings
              </dt>
              <dd className="tabular-nums text-foreground/80">{project.rawSpellings || '—'}</dd>
            </div>
            {(project.port !== null || project.url !== null) && (
              <div className="flex items-baseline justify-between gap-3">
                <dt>Dev</dt>
                <dd className="font-mono text-[0.6875rem] text-foreground/80 [overflow-wrap:anywhere]">
                  {project.url ?? `:${project.port}`}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </details>
    </article>
  );
}
