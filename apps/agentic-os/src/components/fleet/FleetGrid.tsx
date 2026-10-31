import type { ProjectSummary } from '@/server/queries/projects';

import { ProjectCard } from './ProjectCard';

/**
 * The fleet. Ordered by session count descending (in SQL), so the projects with
 * history lead and the empty ones sink — no client-side re-sort that could
 * disagree with the query's own ordering.
 */
export function FleetGrid({
  projects,
  selectedKey = null,
  onSelect,
}: {
  projects: ProjectSummary[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  if (projects.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No projects in <code className="text-xs">agentic_os.project</code>. Seed them with{' '}
        <code className="text-xs">node apps/agentic-os/scripts/seed-projects.mjs</code>.
      </p>
    );
  }

  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
      {projects.map((project) => (
        <ProjectCard
          key={project.key}
          project={project}
          onSelect={onSelect}
          selected={selectedKey === project.key}
        />
      ))}
    </div>
  );
}
