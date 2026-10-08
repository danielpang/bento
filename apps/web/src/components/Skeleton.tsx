import { rememberedStageCount, skeletonStageCount, type StorageWindow } from "../board-shape.js";
import { COLUMN_PITCH, NODE_HEIGHT, NODE_WIDTH, ROW_PITCH } from "../swarm/layout.js";
import { BrandLockup } from "./BrandLockup.js";
import { TabScroll } from "./TabScroll.js";

/**
 * Placeholder shapes that hold layout while a fetch is in flight.
 *
 * Empty copy is a claim ("there is nothing here"). A skeleton is not:
 * it keeps the page's shape so the real content can sit down without
 * a flash of the wrong screen.
 */

export function Skeleton({
  className,
  width,
  height,
  radius,
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
  radius?: string | number;
}) {
  return (
    <span
      className={className ? `skeleton ${className}` : "skeleton"}
      aria-hidden="true"
      style={{
        width: width ?? undefined,
        height: height ?? undefined,
        borderRadius: radius ?? undefined,
      }}
    />
  );
}

function LoadingStatus({ label }: { label: string }) {
  return (
    <span className="visually-hidden" role="status">
      {label}
    </span>
  );
}

/** One card-shaped bone, matching a lane card's padding and radius. */
function SkeletonCard({ title = "72%" }: { title?: string }) {
  return (
    <div className="skeleton-card">
      <Skeleton height={13} width={title} />
      <Skeleton height={10} width="42%" />
    </div>
  );
}

/**
 * The board's own columns, unnamed.
 *
 * Stage names are data. Printing "Product investigation" here would be
 * another claim about a pipeline that has not arrived, and a custom
 * pipeline would then swap the labels. How many stage columns is data
 * too: this draws as many as the project's board last loaded with
 * (board-shape.ts), and the seeded pipeline's length for a project
 * this browser has not loaded or whose pipeline is longer than the
 * five columns a skeleton draws at most. The project is a required prop so no
 * caller can forget it; pass null where there is none to read. Backlog
 * and done frame every board, so they are always here; the real board
 * replaces this wholesale once it knows.
 */
const BACKLOG_LANE = { title: "4.6rem", cards: ["78%", "54%"] };
const DONE_LANE = { title: "3.2rem", cards: [] as string[] };
/** Stage columns cycle through these, so no two neighbours look stamped. */
const STAGE_LANES = [
  { title: "7.2rem", cards: ["66%"] },
  { title: "5.4rem", cards: ["71%", "48%"] },
  { title: "6.8rem", cards: ["63%"] },
  { title: "8.1rem", cards: ["62%"] },
  { title: "6.0rem", cards: ["74%", "58%"] },
];

export function skeletonLanes(stages: number) {
  const count = skeletonStageCount(stages);
  return [
    BACKLOG_LANE,
    ...Array.from({ length: count }, (_, i) => STAGE_LANES[i % STAGE_LANES.length]!),
    DONE_LANE,
  ];
}

export function BoardSkeleton({
  projectId,
  browser,
}: {
  projectId: string | null;
  /** Tests only: the storage to read instead of the window's. */
  browser?: StorageWindow | null;
}) {
  const stages = browser === undefined ? rememberedStageCount(projectId) : rememberedStageCount(projectId, browser);
  return (
    <div className="board" aria-busy="true" aria-label="Loading board">
      <LoadingStatus label="Loading board" />
      {skeletonLanes(stages).map((lane, i) => (
        <section key={i} className="lane" data-kind="stage">
          <header className="lane-head">
            <div className="lane-title">
              <span className="lane-title-text">
                <Skeleton className="lane-ord" height={28} width={28} />
                <Skeleton height={12} width={lane.title} />
              </span>
              <Skeleton height={11} width="1.1rem" />
            </div>
            <Skeleton height={10} width="5.2rem" />
          </header>
          <div className="lane-policy"><Skeleton height={10} width="6rem" /></div>
          <div className="lane-cards">
            {lane.cards.length === 0 ? (
              <div className="lane-empty skeleton-slot" />
            ) : (
              lane.cards.map((title, j) => <SkeletonCard key={j} title={title} />)
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * A small tree in the swarm diagram's own units: a root and three
 * children. Not the swarm's real plan, which is data; just enough of
 * the shape that the page reads as a swarm and not as a board.
 */
const SWARM_SKELETON_NODES = [
  { col: 1, row: 0, title: "68%" },
  { col: 0, row: 1, title: "74%" },
  { col: 1, row: 1, title: "58%" },
  { col: 2, row: 1, title: "66%" },
];
const SWARM_SKELETON_WIDTH = 2 * COLUMN_PITCH + NODE_WIDTH;
const SWARM_SKELETON_HEIGHT = ROW_PITCH + NODE_HEIGHT;

/** The edge from the root's foot to a child's head, as the tree draws it. */
function swarmSkeletonEdge(col: number): string {
  const x1 = COLUMN_PITCH + NODE_WIDTH / 2;
  const y1 = NODE_HEIGHT;
  const x2 = col * COLUMN_PITCH + NODE_WIDTH / 2;
  const y2 = ROW_PITCH;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/**
 * A swarm's page, before the list or the open swarm has arrived.
 *
 * The header, the goal, the diagram bar and a tree, in the page's own
 * classes, so the real swarm sits down where this was. A swarm has no
 * lanes, which is why this is not the board's skeleton.
 */
export function SwarmPageSkeleton() {
  return (
    <div className="swarm-page swarm-page-skeleton" aria-busy="true" aria-label="Loading swarm">
      <LoadingStatus label="Loading swarm" />
      <header className="swarm-head" aria-hidden="true">
        <div className="swarm-head-lead">
          <Skeleton width={40} height={40} radius="50%" />
          <div className="swarm-head-copy">
            <Skeleton height={26} width="13rem" radius={6} />
            <div className="swarm-head-chips">
              <Skeleton height={12} width="4.2rem" />
              <Skeleton height={12} width="7.4rem" />
              <Skeleton height={12} width="3.6rem" />
            </div>
          </div>
        </div>
        <div className="swarm-head-actions">
          <Skeleton className="skeleton-btn" width="6.4rem" />
          <Skeleton className="skeleton-btn" width="4.8rem" />
          <Skeleton className="skeleton-btn" width="2.6rem" />
        </div>
      </header>

      <section className="swarm-brief" aria-hidden="true">
        <div className="swarm-brief-head">
          <Skeleton height={11} width="2.4rem" />
          <Skeleton className="swarm-skeleton-excerpt" height={12} width="56%" />
        </div>
      </section>

      <div className="swarm-viewbar" aria-hidden="true">
        <Skeleton height={13} width="4.4rem" />
        <Skeleton height={28} width="8.6rem" radius={6} />
      </div>

      <div className="swarm-stage swarm-stage-skeleton" aria-hidden="true">
        <div
          className="swarm-skeleton-tree"
          style={{ aspectRatio: `${SWARM_SKELETON_WIDTH} / ${SWARM_SKELETON_HEIGHT}` }}
        >
          <svg
            className="swarm-edges"
            viewBox={`0 0 ${SWARM_SKELETON_WIDTH} ${SWARM_SKELETON_HEIGHT}`}
            preserveAspectRatio="none"
          >
            {SWARM_SKELETON_NODES.filter((n) => n.row === 1).map((n) => (
              <path
                key={n.col}
                className="swarm-edge swarm-skeleton-edge"
                d={swarmSkeletonEdge(n.col)}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {SWARM_SKELETON_NODES.map((n, i) => (
            <div
              key={i}
              className="swarm-skeleton-node"
              style={{
                left: `${((n.col * COLUMN_PITCH) / SWARM_SKELETON_WIDTH) * 100}%`,
                top: `${((n.row * ROW_PITCH) / SWARM_SKELETON_HEIGHT) * 100}%`,
                width: `${(NODE_WIDTH / SWARM_SKELETON_WIDTH) * 100}%`,
                height: `${(NODE_HEIGHT / SWARM_SKELETON_HEIGHT) * 100}%`,
              }}
            >
              <span className="swarm-node-head">
                <Skeleton width={18} height={18} radius="50%" />
                <span className="skeleton-lines">
                  <Skeleton height={12} width={n.title} />
                  <Skeleton height={12} width="44%" />
                </span>
              </span>
              <span className="swarm-node-foot">
                <Skeleton height={10} width="46%" />
                <Skeleton height={10} width="22%" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The conversation list, one row per placeholder session. */
export function SessionsListSkeleton({
  rows = 6,
  /** Wrap in the sessions page frame when this is the whole screen. */
  framed = false,
}: {
  rows?: number;
  framed?: boolean;
}) {
  const list = (
    <div className="sessions-list" aria-busy="true">
      <LoadingStatus label="Loading sessions" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="session-card" aria-hidden="true">
          <Skeleton className="skeleton-avatar" radius="7px" width={28} height={28} />
          <span className="session-card-main">
            <span className="session-card-top">
              <Skeleton height={13} width={`${58 + ((i * 13) % 22)}%`} />
              <Skeleton height={11} width="2.4rem" />
            </span>
            <Skeleton height={11} width={`${40 + ((i * 9) % 18)}%`} />
          </span>
        </div>
      ))}
    </div>
  );
  if (!framed) return list;
  return <div className="sessions-screen"><div className="surface-heading" aria-hidden="true"><div className="skeleton-lines"><Skeleton height={24} width="7rem" /><Skeleton height={13} width="14rem" /></div></div>{list}</div>;
}

/** Table rows for the spend page, without the intro (the intro is data-free). */
export function SpendPageSkeleton({
  rows = 6,
  framed = true,
}: {
  rows?: number;
  framed?: boolean;
}) {
  const table = (
    <>
      <LoadingStatus label="Loading spend" />
      <table className="spend-table" aria-hidden="true">
        <thead>
          <tr>
            <th scope="col">Card</th>
            <th scope="col" className="spend-col">
              Spend
            </th>
            <th scope="col" className="spend-col">
              Runs
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td>
                <Skeleton height={14} width={`${52 + ((i * 11) % 28)}%`} />
              </td>
              <td className="spend-col">
                <Skeleton height={14} width="3.2rem" />
              </td>
              <td className="spend-col">
                <Skeleton height={14} width="1.4rem" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
  if (!framed) return table;
  return (
    <div className="spend-screen" aria-busy="true">
      <header className="spend-intro" aria-hidden="true">
        <Skeleton height={22} width="6rem" />
        <Skeleton height={13} width="72%" />
        <Skeleton height={13} width="48%" />
      </header>
      {table}
    </div>
  );
}

/** A card's conversation tab, before the transcript has arrived. */
export function SessionPageSkeleton() {
  return (
    <div className="session-page" aria-busy="true">
      <LoadingStatus label="Loading conversation" />
      <header className="session-head">
        <Skeleton height={17} width="42%" />
        <Skeleton height={20} width="4.5rem" radius={3} />
      </header>
      <ChatSkeleton tall />
    </div>
  );
}

/** The chat pane: a few bubbles, no words. */
export function ChatSkeleton({ tall = false }: { tall?: boolean }) {
  return (
    <div className={`chat${tall ? " chat-skeleton-tall" : ""}`} aria-hidden="true">
      <div className="chat-row chat-row-assistant">
        <div className="chat-bubble chat-bubble-assistant skeleton-bubble">
          <Skeleton height={12} width="88%" />
          <Skeleton height={12} width="64%" />
          <Skeleton height={12} width="72%" />
        </div>
      </div>
      <div className="chat-row chat-row-user">
        <div className="chat-bubble chat-bubble-user skeleton-bubble">
          <Skeleton height={12} width="70%" />
        </div>
      </div>
      <div className="chat-row chat-row-assistant">
        <div className="chat-bubble chat-bubble-assistant skeleton-bubble">
          <Skeleton height={12} width="80%" />
          <Skeleton height={12} width="52%" />
        </div>
      </div>
    </div>
  );
}

/** Settings body: a heading bone and a couple of cards. */
export function SettingsBodySkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div aria-busy="true">
      <LoadingStatus label="Loading settings" />
      {Array.from({ length: cards }, (_, i) => (
        <section key={i} className="section settings-card" aria-hidden="true">
          <Skeleton height={14} width="8rem" />
          <div className="skeleton-stack">
            <Skeleton height={12} width="92%" />
            <Skeleton height={12} width="74%" />
            <Skeleton height={12} width="83%" />
          </div>
        </section>
      ))}
    </div>
  );
}

/** The settings page chrome, while mode or the chunk is still arriving. */
export function SettingsPageSkeleton() {
  return (
    <div className="app" aria-busy="true">
      <LoadingStatus label="Loading settings" />
      <header className="topbar">
        <BrandLockup />
        <span className="topbar-spacer" />
        <Skeleton className="skeleton-btn" />
      </header>
      <div className="settings-page">
        <Skeleton height={22} width="7rem" />
        <div className="settings-layout">
        <div className="settings-navigation">
        <TabScroll>
          <div className="tab-row" aria-hidden="true">
            {["5.2rem", "4.4rem", "3.6rem", "3.8rem", "3.6rem", "3.2rem"].map((w) => (
              <Skeleton key={w} height={11} width={w} />
            ))}
          </div>
        </TabScroll>
        </div>
        <div className="settings-content">
          <div className="settings-section-heading skeleton-lines"><Skeleton height={22} width="8rem" /><Skeleton height={13} width="70%" /></div>
          <SettingsBodySkeleton />
        </div>
        </div>
      </div>
    </div>
  );
}

/** One settings card's interior, for Linear / Slack / projects lists. */
export function SettingsCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section className="section settings-card" aria-busy="true">
      <LoadingStatus label="Loading" />
      <Skeleton height={14} width="7rem" />
      <div className="skeleton-stack">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="gate-check" aria-hidden="true">
            <span className="gate-check-text skeleton-lines">
              <Skeleton height={13} width={`${56 + i * 8}%`} />
              <Skeleton height={11} width={`${34 + i * 6}%`} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Rows inside a list that already has its heading (projects, members, repos). */
export function ListRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true">
      <LoadingStatus label="Loading" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="gate-check" aria-hidden="true">
          <span className="gate-check-text skeleton-lines">
            <Skeleton height={13} width={`${60 - i * 7}%`} />
            <Skeleton height={11} width={`${40 + i * 5}%`} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A repository card in the Repositories drawer. */
export function RepoCardSkeleton() {
  return (
    <div className="repo-card" aria-hidden="true">
      <div className="repo-card-head">
        <Skeleton height={10} width="1.4rem" />
        <Skeleton height={14} width="6rem" />
      </div>
      <Skeleton height={11} width="70%" />
      <div className="repo-commands">
        <Skeleton height={36} width="100%" />
        <Skeleton height={36} width="100%" />
      </div>
    </div>
  );
}

/**
 * Signed-out and first-load chrome: the wordmark, and a quiet slab.
 * Not the board and not the empty-project copy, both of which would be
 * a guess about which screen comes next.
 */
export function PageSkeleton() {
  return (
    <div className="app" aria-busy="true">
      <LoadingStatus label="Loading" />
      <header className="topbar">
        <BrandLockup />
        <span className="topbar-spacer" />
      </header>
      <div className="page-skeleton">
        <Skeleton className="page-skeleton-block" />
      </div>
    </div>
  );
}

/** A centered card on an entrance screen (invitations, device login). */
export function CenteredPanelSkeleton() {
  return (
    <div className="center" aria-busy="true">
      <LoadingStatus label="Loading" />
      <div className="card-panel card-panel-centered" aria-hidden="true">
        <Skeleton height={20} width="9rem" />
        <div className="skeleton-stack">
          <Skeleton height={12} width="100%" />
          <Skeleton height={12} width="82%" />
          <Skeleton height={36} width="100%" />
        </div>
      </div>
    </div>
  );
}
