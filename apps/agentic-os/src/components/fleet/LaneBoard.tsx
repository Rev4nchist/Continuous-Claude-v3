import type { BoardColumn, BoardLane, LaneBoard as LaneBoardData } from '@/server/queries/lane-board';

import { cn } from '@/lib/utils';

/** Colour by state follows the mockup. The owner state also has text, never colour alone. */
const COLUMN_TONE: Record<BoardColumn['state'], string> = {
  backlog: 'border-border text-muted-foreground',
  ready: 'border-border text-muted-foreground',
  active: 'border-doing/50 text-doing',
  blocked: 'border-bad/50 text-bad',
  review: 'border-warn/50 text-warn',
  done: 'border-done/50 text-done',
};

const OWNER_TONE: Record<NonNullable<BoardLane['owner']>, string> = {
  live: 'text-done',
  quiet: 'text-warn',
  ended: 'text-muted-foreground',
  unknown: 'text-bad',
};

/** The middle dot, by code point: source files stay ASCII. */
const DOT = String.fromCharCode(0xb7);

function countText(column: BoardColumn): string {
  return column.shown < column.count ? `${column.shown} of ${column.count}` : String(column.count);
}

/**
 * The read-only Work board: six state columns of lane cards. Pure props. A card has no button, no
 * link and is not draggable (P2 adds moving). Columns are at least 210 px wide and wrap: six in one
 * row from about 1340 px, one column on a phone, so a phone has no horizontal scroll.
 * A failed lane read shows one error line instead of six empty columns.
 * The header names the board key (`Work board, middle dot, <key>`); the data is that one board's lanes (project_key).
 */
export function LaneBoard({ board }: { board: LaneBoardData }) {
  return (
    <section data-testid="work-board" className="space-y-3">
      <div
        data-testid="board-header"
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm font-medium tracking-tight"
      >
        <span data-testid="board-key" data-board={board.board}>{`Work board ${DOT} ${board.board} ${DOT} lane states`}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {`read-only in P1 ${DOT} drag to move in P2`}
        </span>
      </div>
      <p data-testid="board-scope-note" className="text-xs text-muted-foreground">
        {`This board lists the lanes of ${board.board} only. The active-lanes tile counts all boards.`}
      </p>

      {board.status === 'error' ? (
        <p
          data-testid="board-error"
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm [overflow-wrap:anywhere]"
        >
          {`Lane registry unavailable: ${board.error ?? 'read failed'}`}
        </p>
      ) : (
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr))]">
          {board.columns.map((column) => (
            <Column key={column.state} column={column} />
          ))}
        </div>
      )}
    </section>
  );
}

function Column({ column }: { column: BoardColumn }) {
  return (
    <div
      data-testid="board-column"
      data-state={column.state}
      className="min-w-0 space-y-2 rounded-lg border bg-card p-2"
    >
      <div className={cn('flex items-baseline justify-between gap-2 border-b pb-1', COLUMN_TONE[column.state])}>
        <h3 data-testid="board-column-heading" className="text-xs font-semibold">
          {column.state}
        </h3>
        <span data-testid="board-column-count" className="font-mono text-xs tabular-nums">
          {countText(column)}
        </span>
      </div>
      {column.lanes.length === 0 ? (
        <p data-testid="board-column-empty" className="px-1 py-2 text-xs text-muted-foreground">
          empty
        </p>
      ) : (
        <div className="space-y-2">
          {column.lanes.map((lane) => (
            <Lane key={lane.id} lane={lane} />
          ))}
        </div>
      )}
    </div>
  );
}

function Lane({ lane }: { lane: BoardLane }) {
  return (
    <div
      data-testid="board-lane"
      data-lane-id={lane.id}
      className="min-w-0 space-y-1 rounded-md border bg-background p-2"
    >
      <p data-testid="board-lane-id" className="font-mono text-xs font-bold [overflow-wrap:anywhere]">
        {lane.id}
      </p>
      <p data-testid="board-lane-title" className="text-xs [overflow-wrap:anywhere]">
        {lane.title}
      </p>
      {(lane.owner !== null || lane.leaseLapsed || lane.branch !== null) && (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[0.6875rem] text-muted-foreground">
          {lane.owner !== null && (
            <span data-testid="board-lane-owner" data-owner-state={lane.owner}>
              {lane.ownerShortId}{' '}
              <span className={OWNER_TONE[lane.owner]}>{lane.owner}</span>
            </span>
          )}{' '}
          {lane.leaseLapsed && (
            <span data-testid="board-lane-lease" className="text-warn">
              lease lapsed
            </span>
          )}{' '}
          {lane.branch !== null && (
            <span data-testid="board-lane-branch" className="[overflow-wrap:anywhere]">
              {lane.branch}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
