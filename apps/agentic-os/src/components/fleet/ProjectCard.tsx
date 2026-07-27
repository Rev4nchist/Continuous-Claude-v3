import type { ProjectSummary } from '@/server/queries/projects';

import { cn } from '@/lib/utils';

import { formatAgo, formatCount, plural, statusClasses } from './format';

/**
 * One project in the fleet grid.
 *
 * Two numbers, and the second is the one that keeps the first honest:
 *   sessionCount — real Claude Code sessions attributed to this project
 *   rawSpellings — how many distinct `sessions.project` strings collapsed to get there
 *
 * `continuous-claude` shows 639 sessions from 16 spellings. Without the second
 * number that 639 looks like double-counting; with it, it reads as what it is —
 * subdirectories, worktrees, slash-direction and case variants of one path. The
 * mapping behind it is hand-authored, so the count proves nothing was DROPPED
 * and nothing here can prove a row went to the RIGHT project.
 */
export function ProjectCard({ project }: { project: ProjectSummary }) {
  const idle = project.sessionCount === 0;

  return (
    <article
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors',
        'hover:border-foreground/20',
        idle && 'opacity-60',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium tracking-tight" title={project.displayName}>
            {project.displayName}
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
            className="cursor-help decoration-dotted underline-offset-2 hover:underline"
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
