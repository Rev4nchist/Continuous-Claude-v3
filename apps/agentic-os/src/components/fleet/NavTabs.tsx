import { cn } from '@/lib/utils';

export type ViewId = 'overview' | 'board' | 'sessions';

type Tab = { id: string; label: string; tag: 'NEXT' | 'LATER' | null };

/** Mockup order. A tab with a tag is not built yet: it is a real disabled button. */
const TABS: Tab[] = [
  { id: 'overview', label: 'Overview', tag: null },
  { id: 'board', label: 'Board', tag: null },
  { id: 'sessions', label: 'Sessions', tag: null },
  { id: 'workflows', label: 'Workflows', tag: 'NEXT' },
  { id: 'handoffs', label: 'Handoffs', tag: 'NEXT' },
  { id: 'notes', label: 'Notes', tag: 'NEXT' },
  { id: 'evidence', label: 'Evidence', tag: 'NEXT' },
  { id: 'swarm', label: 'Swarm', tag: 'LATER' },
];

const isLive = (tab: Tab): tab is Tab & { id: ViewId } => tab.tag === null;

/**
 * The top bar: the mark and the view tabs. Pure props. Only Overview, Board and Sessions work; the rest
 * are disabled buttons (not focusable) with a NEXT or LATER tag. The active tab has
 * aria-current="page". Wraps on a phone.
 */
export function NavTabs({ view, onSelect }: { view: ViewId; onSelect: (view: ViewId) => void }) {
  return (
    <nav
      data-testid="nav-tabs"
      aria-label="Views"
      className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border bg-card p-1"
    >
      <span className="px-2 font-mono text-xs font-semibold tracking-tight">agentic-os</span>
      {TABS.map((tab) => {
        const active = isLive(tab) && tab.id === view;
        return (
          <button
            key={tab.id}
            type="button"
            data-testid="nav-tab"
            data-tab={tab.id}
            disabled={!isLive(tab)}
            aria-current={active ? 'page' : undefined}
            onClick={isLive(tab) ? () => onSelect(tab.id) : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
              active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
              isLive(tab) ? 'hover:bg-accent hover:text-foreground' : 'cursor-not-allowed opacity-60',
            )}
          >
            {tab.label}
            {tab.tag !== null && (
              <span
                data-testid="nav-tab-tag"
                className="rounded border px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground"
              >
                {tab.tag}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
