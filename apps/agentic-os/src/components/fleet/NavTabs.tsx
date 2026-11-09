import { cn } from '@/lib/utils';

export type ViewId = 'overview' | 'board' | 'sessions' | 'spend';

type Tab = { id: string; label: string; tag: 'NEXT' | 'LATER' | null };

/** Mockup order. A tab with a tag is not built yet: it is a real disabled button. */
const TABS: Tab[] = [
  { id: 'overview', label: 'Overview', tag: null },
  { id: 'board', label: 'Board', tag: null },
  { id: 'sessions', label: 'Sessions', tag: null },
  { id: 'workflows', label: 'Workflows', tag: 'NEXT' },
  { id: 'handoffs', label: 'Handoffs', tag: 'NEXT' },
  { id: 'notes', label: 'Notes', tag: 'NEXT' },
  { id: 'spend', label: 'Spend', tag: null },
  { id: 'swarm', label: 'Swarm', tag: 'LATER' },
];

const isLive = (tab: Tab): tab is Tab & { id: ViewId } => tab.tag === null;

/**
 * The left half of the top strip: the mark and the view tabs. Pure props. Only Overview, Board,
 * Sessions and Spend work; the rest are disabled buttons (not focusable) with a NEXT or LATER tag. The active
 * tab has aria-current="page" and an underline. The `nav` has no box of its own: MissionControl draws
 * the strip around it and puts the live indicator on the right. Wraps on a phone.
 */
export function NavTabs({ view, onSelect }: { view: ViewId; onSelect: (view: ViewId) => void }) {
  return (
    <nav
      data-testid="nav-tabs"
      aria-label="Views"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <span className="py-2.5 pr-3 text-xs font-bold">{'\u258c'}agentic-os</span>
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
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-2.5 text-xs transition-colors',
              active && 'border-doing text-foreground',
              !active && isLive(tab) && 'text-muted-foreground hover:text-foreground',
              !isLive(tab) && 'cursor-not-allowed text-[#5d6677]',
            )}
          >
            {tab.label}
            {tab.tag !== null && (
              <span
                data-testid="nav-tab-tag"
                className="rounded-[3px] border border-[var(--line2)] px-[5px] text-[0.625rem] tracking-[0.08em] text-[#7d8798]"
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
