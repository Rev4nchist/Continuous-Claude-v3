import type { ReactNode } from 'react';

import type { DetailUnavailable, SessionDetail as Detail } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

import { formatAgo } from './format';

const WRAP = '[overflow-wrap:anywhere]';

const CHIP_TONE: Record<string, string> = {
  working: 'border-doing/40 text-doing',
  'waiting-on-dave': 'border-warn/50 bg-warn/10 text-warn',
  blocked: 'border-bad/50 bg-bad/10 text-bad',
  done: 'border-done/40 text-done',
  idle: 'border-border text-muted-foreground',
};

const STEP_TONE: Record<string, string> = {
  done: 'text-done',
  doing: 'text-doing',
  blocked: 'text-bad',
  todo: 'text-muted-foreground',
};

/** "45s", "3m 05s", "2h 10m". Input is a number of seconds the server computed. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3_600)}h ${String(Math.floor((seconds % 3_600) / 60)).padStart(2, '0')}m`;
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

function Section({
  name,
  title,
  children,
}: {
  name: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={`detail-${name}`} className="min-w-0 space-y-2 border-t pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p data-testid="section-empty" className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The session detail: the six sections of the terminal Pane (Goal, Plan, Now, Done, Ask, Health)
 * and Decisions when there are any. Pure props. Every string came redacted and clipped from the
 * reader; long text wraps anywhere so a 120 character word cannot widen the page.
 */
export function SessionDetail({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const project = detail.projectDisplayName ?? detail.projectKey ?? 'unmapped';

  return (
    <article
      data-testid="session-detail"
      data-session-id={detail.id}
      data-availability={detail.availability}
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4"
    >
      <div data-testid="detail-header" className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={cn('min-w-0 text-sm font-medium', WRAP)}>
          {`Session \u00b7 ${project} / ${detail.id.slice(0, 4)}`}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {detail.chip !== null && (
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
                CHIP_TONE[detail.chip],
              )}
            >
              {detail.chip}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
          >
            Close
          </button>
        </div>
      </div>

      <GoalSection detail={detail} />
      <PlanSection detail={detail} />
      <NowSection detail={detail} />
      <DoneSection detail={detail} />
      <AskSection detail={detail} />
      <HealthSection detail={detail} />
      {detail.decisions.length > 0 && (
        <Section name="decisions" title="Decisions">
          <ul className="space-y-1">
            {detail.decisions.map((d, index) => (
              <li key={index} data-testid="decision-item" className={cn('text-xs', WRAP)}>
                {d.text}
                <span className="ml-2 text-muted-foreground">{`${d.by}, ${formatAgo(d.ageSeconds)}`}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p data-testid="detail-footer" className={cn('border-t pt-3 text-xs text-muted-foreground', WRAP)}>
        {`Same six sections as the terminal Pane. Open in terminal: claude --resume ${detail.id}`}
      </p>
    </article>
  );
}

function GoalSection({ detail }: { detail: Detail }) {
  const where = [
    detail.repo !== null ? `repo ${detail.repo}` : null,
    detail.branch !== null ? `branch ${detail.branch}` : null,
    detail.worktree !== null ? `worktree ${detail.worktree}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <Section name="goal" title="Goal">
      {!detail.hasBrief && <p className="text-xs text-muted-foreground">No brief yet.</p>}
      {detail.title !== null && <p className={cn('text-sm font-medium', WRAP)}>{detail.title}</p>}
      {detail.goal !== null && <p className={cn('text-xs', WRAP)}>{detail.goal}</p>}
      {detail.stopAt !== null && (
        <p className={cn('text-xs text-muted-foreground', WRAP)}>{`Stop at: ${detail.stopAt}`}</p>
      )}
      {where.length > 0 && (
        <p className={cn('font-mono text-[0.6875rem] text-muted-foreground', WRAP)}>
          {where.join('  ')}
        </p>
      )}
      {detail.laneIds.length > 0 && (
        <p className={cn('font-mono text-[0.6875rem] text-muted-foreground', WRAP)}>
          {`lanes ${detail.laneIds.join(', ')}`}
        </p>
      )}
    </Section>
  );
}

function PlanSection({ detail }: { detail: Detail }) {
  const pct = detail.planTotal > 0 ? Math.round((detail.planDone / detail.planTotal) * 100) : 0;
  return (
    <Section name="plan" title="Plan">
      {detail.planTotal === 0 ? (
        <Empty>No tasks or plan steps yet.</Empty>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-done" style={{ width: `${pct}%` }} />
            </span>
            <span className="shrink-0 tabular-nums">{`${detail.planDone} of ${detail.planTotal}`}</span>
          </div>
          <ul className="space-y-1">
            {detail.steps.map((step, index) => (
              <li
                key={`${step.id}:${index}`}
                data-testid="plan-step"
                data-status={step.status}
                className={cn('flex gap-2 text-xs', WRAP)}
              >
                <span className={cn('w-12 shrink-0 font-mono text-[0.6875rem]', STEP_TONE[step.status])}>
                  {step.status}
                </span>
                <span className="min-w-0 flex-1">{step.text}</span>
              </li>
            ))}
          </ul>
          {detail.planMore > 0 && (
            <p className="text-xs text-muted-foreground">{`and ${detail.planMore} more`}</p>
          )}
        </>
      )}
    </Section>
  );
}

function NowSection({ detail }: { detail: Detail }) {
  return (
    <Section name="now" title="Now">
      {detail.step === null && detail.agents.length === 0 ? (
        <Empty>No tool call or agent running.</Empty>
      ) : (
        <>
          {detail.step !== null && (
            <p data-testid="now-step" className={cn('text-xs', WRAP)}>
              <span className="mr-2 font-mono text-doing">{detail.step.tool}</span>
              {detail.step.label}
              <span className="ml-2 text-muted-foreground tabular-nums">
                {formatElapsed(detail.step.elapsedSeconds)}
              </span>
            </p>
          )}
          {detail.agents.length > 0 && (
            <ul className="space-y-1">
              {detail.agents.map((a, index) => (
                <li key={index} data-testid="now-agent" className={cn('text-xs', WRAP)}>
                  <span className="mr-2 font-mono text-agent">{a.type}</span>
                  {a.description}
                  <span className="ml-2 text-muted-foreground">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function DoneSection({ detail }: { detail: Detail }) {
  return (
    <Section name="done" title="Done">
      {detail.done.length === 0 ? (
        <Empty>Nothing done yet.</Empty>
      ) : (
        <ul className="space-y-1">
          {detail.done.map((item, index) => (
            <li key={`${item.id}:${index}`} data-testid="done-item" className={cn('text-xs', WRAP)}>
              {item.text}
              {item.proof !== null ? (
                <span className="ml-2 font-mono text-[0.6875rem] text-done">{item.proof.artifact}</span>
              ) : (
                <span className="ml-2 font-mono text-[0.6875rem] text-warn">UNPROVEN</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AskSection({ detail }: { detail: Detail }) {
  return (
    <Section name="ask" title="Ask">
      {detail.asks.length === 0 ? (
        <Empty>Nothing open.</Empty>
      ) : (
        <ul className="space-y-2">
          {detail.asks.map((a, index) => (
            <li
              key={index}
              data-testid="ask-item"
              data-answered={a.answered ? 'true' : 'false'}
              className={cn('text-xs', WRAP, a.answered && 'opacity-60')}
            >
              <span className="mr-2 rounded-full border border-warn/40 px-2 py-0.5 text-[0.6875rem] text-warn">
                {a.kind}
              </span>
              {a.text}
              {a.recommend !== null && (
                <span className="mt-1 block text-muted-foreground">{`Recommend: ${a.recommend}`}</span>
              )}
              <span className="mt-1 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-muted-foreground">
                {a.stale && <span>stale</span>}
                {a.answered && <span>answered?</span>}
                {a.parsed && <span>[parsed]</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HealthSection({ detail }: { detail: Detail }) {
  const runs = detail.agentRuns;
  return (
    <Section name="health" title="Health">
      <ul className="space-y-1 font-mono text-[0.6875rem]">
        <li data-testid="health-ctx">{`ctx ${detail.ctxPct === null ? '-' : `${detail.ctxPct}%`}`}</li>
        <li data-testid="health-cache">
          {detail.cache === null
            ? 'cache -'
            : `cache ${detail.cache.hitPct}% hit, saved ${usd(detail.cache.savedUsd)}`}
        </li>
        <li data-testid="health-agent-cost">
          {runs === null
            ? 'agents -'
            : `agents ${usd(runs.costUsd)} (${runs.count} ${runs.count === 1 ? 'run' : 'runs'}, ${runs.running} running)`}
        </li>
        <li data-testid="health-session-cost">session cost - (not recorded)</li>
        <li data-testid="health-limits">limits - (not recorded)</li>
        {detail.prs.map((p) => (
          <li key={p.pr} data-testid="health-pr">
            {p.state === null ? `#${p.pr}` : `#${p.pr} ${p.state}`}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The selected session has no detail. Shows the reason class only, never a path. */
export function SessionUnavailable({
  unavailable,
  onClose,
}: {
  unavailable: DetailUnavailable;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="detail-unavailable"
      data-reason={unavailable.reason}
      className="min-w-0 space-y-2 rounded-lg border border-dashed p-4 text-sm"
    >
      <p className="font-medium">Session not available</p>
      <p className="text-xs text-muted-foreground">{`Reason: ${unavailable.reason}`}</p>
      <button
        type="button"
        onClick={onClose}
        className="rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
      >
        Close
      </button>
    </div>
  );
}
