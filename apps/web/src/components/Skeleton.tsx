import type { CSSProperties } from "react";
import { BrandLockup } from "./BrandLockup.js";

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
 * pipeline would then swap the labels. Eight columns is the seeded
 * shape (backlog, six stages, done); the real board replaces this
 * wholesale once it knows.
 */
const SKELETON_LANES = [
  { title: "4.6rem", cards: [ "78%", "54%" ] },
  { title: "7.2rem", cards: [ "66%" ] },
  { title: "5.4rem", cards: [ "71%", "48%" ] },
  { title: "8.1rem", cards: [ "62%" ] },
  { title: "6.0rem", cards: [ "74%" ] },
  { title: "5.8rem", cards: [ "58%", "69%" ] },
  { title: "6.8rem", cards: [ "63%" ] },
  { title: "3.2rem", cards: [] as string[] },
];

export function BoardSkeleton() {
  return (
    <div className="board" aria-busy="true" aria-label="Loading board">
      <LoadingStatus label="Loading board" />
      {SKELETON_LANES.map((lane, i) => (
        <section key={i} className="lane" style={{ "--skeleton-i": i } as CSSProperties}>
          <header className="lane-head">
            <div className="lane-title">
              <Skeleton height={12} width={lane.title} />
              <Skeleton height={11} width="1.1rem" />
            </div>
            <Skeleton height={10} width="5.2rem" />
          </header>
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
          <Skeleton className="skeleton-avatar" radius="50%" width={38} height={38} />
          <span className="session-card-main">
            <span className="session-card-top">
              <Skeleton height={14} width={`${58 + ((i * 13) % 22)}%`} />
              <Skeleton height={11} width="2.4rem" />
            </span>
            <Skeleton height={12} width={`${40 + ((i * 9) % 18)}%`} />
          </span>
        </div>
      ))}
    </div>
  );
  if (!framed) return list;
  return <div className="sessions-screen">{list}</div>;
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
        <div className="tab-row" aria-hidden="true">
          {["5.2rem", "4.4rem", "3.6rem", "3.8rem", "3.6rem", "3.2rem"].map((w) => (
            <Skeleton key={w} height={11} width={w} />
          ))}
        </div>
        <SettingsBodySkeleton />
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
