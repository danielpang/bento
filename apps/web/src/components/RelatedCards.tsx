import { useEffect, useState } from "react";
import type { BentoClient, RelatedCard, RelatedGroup } from "@bento/api-client";
import { Modal } from "./Modal.js";

/**
 * A card that was split, with an arrow to every part it was split into.
 *
 * The board stays lanes of cards: nothing is ever drawn between them.
 * This is where the shape of a group is visible, opened from either
 * end, and it is deliberately one level deep. The arrows mean "this
 * card spawned these" and nothing else, which is why they carry no
 * labels, no direction of dependency and no ordering.
 *
 * Rows come from the server rather than from the board the viewer has
 * open, so a part that is already finished, or that somebody dragged
 * into another lane, is still in the picture. Missing one of them
 * would be the failure this view exists to prevent.
 */

/** Geometry, in the coordinate space the SVG and the cards share. */
const PARENT_W = 232;
const CHILD_W = 300;
const CARD_H = 74;
const ROW_GAP = 16;
/** The gutter the trunk runs down, between the two columns. */
const TRUNK_GAP = 88;
/** How far short of a card the line stops, leaving room for the head. */
const ARROW_LEN = 9;

export interface GroupBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GroupLink {
  /** Path data. Only M, H and V: a diagonal cannot be expressed here. */
  d: string;
  /** Where the head points, at the child's left edge. */
  tip: { x: number; y: number };
}

export interface GroupLayout {
  width: number;
  height: number;
  parent: GroupBox;
  children: GroupBox[];
  links: GroupLink[];
}

/**
 * Where everything sits, from the number of parts alone.
 *
 * Computed rather than measured, so the arrows cannot disagree with
 * the cards: both read these numbers. Orthogonality is a property of
 * the construction, not a rule anybody has to remember. Every segment
 * is emitted as an H or a V, so there is no command in the output that
 * could draw a diagonal even if the arithmetic were wrong.
 */
export function layoutGroup(count: number): GroupLayout {
  const stack = count > 0 ? count * CARD_H + (count - 1) * ROW_GAP : 0;
  const height = Math.max(stack, CARD_H);
  const width = PARENT_W + TRUNK_GAP + CHILD_W;
  const childX = PARENT_W + TRUNK_GAP;
  const trunkX = PARENT_W + Math.round(TRUNK_GAP / 2);
  const parent: GroupBox = { x: 0, y: Math.round((height - CARD_H) / 2), w: PARENT_W, h: CARD_H };
  const top = Math.round((height - stack) / 2);
  const children: GroupBox[] = [];
  const links: GroupLink[] = [];
  const fromY = parent.y + Math.round(CARD_H / 2);
  for (let i = 0; i < count; i += 1) {
    const box: GroupBox = { x: childX, y: top + i * (CARD_H + ROW_GAP), w: CHILD_W, h: CARD_H };
    children.push(box);
    const toY = box.y + Math.round(CARD_H / 2);
    // Out of the parent's right edge, down or up the shared trunk,
    // then in to the child's left edge. A part level with the parent
    // gets a zero length V, which draws nothing and stays a straight
    // line rather than becoming a special case.
    links.push({
      d: `M ${PARENT_W} ${fromY} H ${trunkX} V ${toY} H ${childX - ARROW_LEN}`,
      tip: { x: childX, y: toY },
    });
  }
  return { width, height, parent, children, links };
}

/** The dot the board uses, in the words this view has room for. */
function cardTone(card: RelatedCard): string {
  if (card.status === "done") return "done";
  if (card.status === "cancelled") return "cancelled";
  if (card.runStatus && ["queued", "starting", "running"].includes(card.runStatus)) return "running";
  if (card.status === "gated") return "gated";
  if (card.runStatus === "succeeded") return "succeeded";
  if (card.runStatus === "failed") return "failed";
  return "idle";
}

function toneWords(tone: string): string {
  switch (tone) {
    case "running":
      return "agent working";
    case "succeeded":
      return "agent finished";
    case "failed":
      return "agent failed";
    case "gated":
      return "waiting at gate";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "not started";
  }
}

function MiniCard({
  card,
  box,
  role,
  current,
  onSelect,
}: {
  card: RelatedCard;
  box: GroupBox;
  role: "parent" | "child";
  /** The card the view was opened from, so it is findable in its own group. */
  current: boolean;
  onSelect: (featureId: string) => void;
}) {
  const tone = cardTone(card);
  return (
    <button
      type="button"
      className="related-card"
      data-role={role}
      data-current={current ? "" : undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={() => onSelect(card.id)}
    >
      <span className="related-card-title" title={card.title}>
        {card.title}
      </span>
      <span className="related-card-meta">
        <span className="status">
          <span className="dot" data-state={tone} />
          {toneWords(tone)}
        </span>
        <span className="related-card-stage">{card.stageName ?? "Backlog"}</span>
        {card.costUsd !== null && <span className="related-card-spend">${card.costUsd.toFixed(2)}</span>}
        {card.prNumber !== null && <span className="chip">PR #{card.prNumber}</span>}
      </span>
    </button>
  );
}

/**
 * The drawn group. Split out from the fetching so a test can render a
 * known group without a client, which is how the arrows are checked.
 */
export function RelatedGraph({
  group,
  currentId,
  onSelect,
}: {
  group: RelatedGroup;
  currentId: string;
  onSelect: (featureId: string) => void;
}) {
  const layout = layoutGroup(group.children.length);
  return (
    <div className="related-graph" style={{ width: layout.width, height: layout.height }}>
      {/*
        Under the cards, and inert. The arrows are the relationship
        drawn, not a control: everything clickable in here is a card.
      */}
      <svg
        className="related-links"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
        focusable="false"
      >
        {layout.links.map((link, i) => (
          <g key={group.children[i]?.id ?? i}>
            <path className="related-link" d={link.d} />
            {/* A polygon rather than a path, so the only path data in
                this view stays free of anything but M, H and V. */}
            <polygon
              className="related-arrowhead"
              points={`${link.tip.x - ARROW_LEN},${link.tip.y - 5} ${link.tip.x},${link.tip.y} ${link.tip.x - ARROW_LEN},${link.tip.y + 5}`}
            />
          </g>
        ))}
      </svg>
      <MiniCard
        card={group.parent}
        box={layout.parent}
        role="parent"
        current={group.parent.id === currentId}
        onSelect={onSelect}
      />
      {group.children.map((child, i) => (
        <MiniCard
          key={child.id}
          card={child}
          box={layout.children[i]!}
          role="child"
          current={child.id === currentId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function RelatedCardsDialog({
  client,
  featureId,
  onClose,
  onSelect,
}: {
  client: BentoClient;
  featureId: string;
  onClose: () => void;
  /** Selects a card on the board behind, and closes this. */
  onSelect: (featureId: string) => void;
}) {
  const [group, setGroup] = useState<RelatedGroup | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void client
      .relatedFeatures(featureId)
      .then((result) => {
        if (cancelled) return;
        setGroup(result);
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [client, featureId]);

  const total = group?.children.length ?? 0;
  return (
    <Modal
      title="Related cards"
      description={
        state === "ready" && group
          ? `“${group.parent.title}” was split into ${total === 1 ? "1 part" : `${total} parts`}. Each part is an ordinary card with its own branch.`
          : undefined
      }
      wide
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {state === "loading" && <p className="muted">Loading…</p>}
      {state === "failed" && (
        <p className="error" role="alert">
          Could not load the related cards. Close this and try again.
        </p>
      )}
      {state === "ready" && !group && <p className="muted">This card is not part of a split.</p>}
      {state === "ready" && group && (
        <div className="related-scroll">
          <RelatedGraph
            group={group}
            currentId={featureId}
            onSelect={(id) => {
              onSelect(id);
              onClose();
            }}
          />
        </div>
      )}
    </Modal>
  );
}
