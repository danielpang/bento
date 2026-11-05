import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { ApiError, type BentoClient, type ProjectArtifactCard, type RunArtifact } from "@bento/api-client";
import { Markdown } from "./Markdown.js";
import { PopOutMark, useArtifactCanvas } from "./ArtifactViewer.js";
import { createRequestGate } from "../latest-request.js";
import {
  artifactBaseName,
  artifactCountLabel,
  artifactKindLabel,
  formatUpdatedAgo,
} from "../artifacts-format.js";
import {
  clampPaneWidth,
  PANE_DEFAULT,
  PANE_MAX,
  PANE_MIN,
  rememberedPaneWidth,
  rememberPaneWidth,
} from "../artifacts-pane.js";
import { captureArtifactOpened, captureArtifactsTabOpened } from "../posthog.js";
import { ArtifactsDetailSkeleton, ArtifactsGridSkeleton } from "./Skeleton.js";

/** Arrow keys move the divider this far; Shift moves it four times as far. */
const PANE_STEP = 16;
/** What the reader keeps when the list is dragged wide. */
const READER_MIN = 360;

const KIND_EXT: Record<string, string> = {
  markdown: "MD",
  mermaid: "MMD",
  image: "IMG",
  html: "HTML",
  file: "FILE",
};

function kindExt(kind: string, path?: string): string {
  if (kind === "file" && path) {
    const ext = path.split(".").pop();
    if (ext && ext !== path && ext.length <= 4) return ext.toUpperCase();
  }
  return KIND_EXT[kind] ?? "FILE";
}

/** A drawing of what a diagram or a page looks like, for tiles whose newest artifact is one. */
function TileSketch({ kind }: { kind: string }) {
  if (kind === "mermaid") {
    return (
      <div className="artifacts-sketch artifacts-sketch-diagram" aria-hidden="true">
        <span />
        <i />
        <span />
        <i />
        <span className="artifacts-sketch-accent" />
      </div>
    );
  }
  if (kind === "html") {
    return (
      <div className="artifacts-sketch artifacts-sketch-page" aria-hidden="true">
        <div className="artifacts-sketch-chrome">
          <b />
          <b />
          <b />
        </div>
        <div className="artifacts-sketch-body">
          <div>
            <em />
            <span />
            <span />
            <strong />
          </div>
          <aside />
        </div>
      </div>
    );
  }
  return (
    <span className="artifacts-sketch-ext" aria-hidden="true">
      {kindExt(kind)}
    </span>
  );
}

function TilePreview({ client, card }: { client: BentoClient; card: ProjectArtifactCard }) {
  const [imageFailed, setImageFailed] = useState(false);
  const { preview } = card;
  if (preview.kind === "image" && !imageFailed) {
    return (
      <img
        className="artifacts-tile-image"
        src={client.artifactContentUrl(preview.artifactId)}
        alt=""
        onError={() => setImageFailed(true)}
      />
    );
  }
  if (preview.kind === "markdown" && preview.markdownExcerpt) {
    return (
      <div className="artifacts-tile-markdown">
        <Markdown text={preview.markdownExcerpt} />
      </div>
    );
  }
  return <TileSketch kind={preview.kind} />;
}

/**
 * The divider between the file list and the reader. Drag it, use the
 * arrow keys on it, or double click it to go back to the default.
 */
function PaneDivider({
  width,
  splitRef,
  onChange,
}: {
  width: number;
  splitRef: RefObject<HTMLDivElement | null>;
  onChange: (width: number, done: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const available = () => (splitRef.current?.clientWidth ?? Infinity) - READER_MIN;

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    onChange(clampPaneWidth(start.width + event.clientX - start.x, available()), false);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onChange(width, true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? PANE_STEP * 4 : PANE_STEP;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "Home") next = PANE_MIN;
    else if (event.key === "End") next = PANE_MAX;
    if (next === null) return;
    event.preventDefault();
    onChange(clampPaneWidth(next, available()), true);
  }

  return (
    <div
      className="artifacts-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file list"
      aria-valuenow={width}
      aria-valuemin={PANE_MIN}
      aria-valuemax={PANE_MAX}
      tabIndex={0}
      data-dragging={dragging ? "true" : undefined}
      title="Drag to resize. Double click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange(clampPaneWidth(PANE_DEFAULT, available()), true)}
      onKeyDown={onKeyDown}
    />
  );
}

function ArtifactReader({ client, artifact }: { client: BentoClient; artifact: RunArtifact }) {
  const canvas = useArtifactCanvas(client, artifact);
  return (
    <section className="artifacts-reader" aria-label={`Preview of ${artifactBaseName(artifact.path)}`}>
      <header className="artifacts-reader-head">
        <div className="artifacts-reader-name">
          <span className="artifacts-reader-title">{artifactBaseName(artifact.path)}</span>
          <span className="artifacts-reader-path" title={artifact.path}>
            {artifact.path}
          </span>
        </div>
        {canvas.sourceToggle}
        <a
          className="btn btn-ghost icon-button"
          href={`/artifact/${artifact.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in a new tab"
          title="Open in a new tab"
        >
          <PopOutMark />
        </a>
        <a
          className="btn btn-ghost icon-button"
          href={client.artifactContentUrl(artifact.id)}
          download
          aria-label="Download"
          title="Download"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
          </svg>
        </a>
      </header>
      <div className="artifacts-reader-body artifact-view">{canvas.body}</div>
    </section>
  );
}

export function ArtifactsPage({
  client,
  projectId,
  cardId,
}: {
  client: BentoClient;
  projectId: string | null;
  cardId: string | null;
}) {
  const [cards, setCards] = useState<ProjectArtifactCard[] | null>(null);
  const [detail, setDetail] = useState<RunArtifact[] | null>(null);
  const [detailTitle, setDetailTitle] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [projectMissing, setProjectMissing] = useState(false);
  const [cardMissing, setCardMissing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState(() => rememberedPaneWidth());
  const splitRef = useRef<HTMLDivElement>(null);
  const gridGate = useRef(createRequestGate());
  const detailGate = useRef(createRequestGate());
  const openedTab = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    if (openedTab.current === projectId) return;
    openedTab.current = projectId;
    captureArtifactsTabOpened(projectId);
  }, [projectId]);

  const refreshGrid = useCallback(async () => {
    if (!projectId || cardId) return;
    const seq = gridGate.current.next();
    setProjectMissing(false);
    try {
      const rows = await client.listProjectArtifacts(projectId);
      if (!gridGate.current.isCurrent(seq)) return;
      setCards(rows);
      setLoadFailed(false);
    } catch (err) {
      if (!gridGate.current.isCurrent(seq)) return;
      if (err instanceof ApiError && err.status === 404) {
        setProjectMissing(true);
        setCards([]);
        setLoadFailed(false);
        return;
      }
      setLoadFailed(true);
    }
  }, [client, projectId, cardId]);

  const refreshDetail = useCallback(async () => {
    if (!projectId || !cardId) return;
    const seq = detailGate.current.next();
    setCardMissing(false);
    try {
      const [rows, feature] = await Promise.all([
        client.listArtifacts(cardId),
        client.getFeature(cardId).catch(() => null),
      ]);
      if (!detailGate.current.isCurrent(seq)) return;
      setDetail(rows);
      if (feature) setDetailTitle(feature.title);
      setLoadFailed(false);
    } catch (err) {
      if (!detailGate.current.isCurrent(seq)) return;
      if (err instanceof ApiError && err.status === 404) {
        setCardMissing(true);
        setDetail(null);
        setLoadFailed(false);
        return;
      }
      setLoadFailed(true);
    }
  }, [client, projectId, cardId]);

  useEffect(() => {
    setCards(null);
    setDetail(null);
    setSelectedId(null);
    setLoadFailed(false);
    setProjectMissing(false);
    setCardMissing(false);
    if (cardId) void refreshDetail();
    else void refreshGrid();
  }, [refreshGrid, refreshDetail, cardId, projectId]);

  const select = (artifact: RunArtifact) => {
    setSelectedId(artifact.id);
    if (projectId && cardId) {
      captureArtifactOpened({
        source: "tab",
        project_id: projectId,
        feature_id: cardId,
        artifact_id: artifact.id,
        kind: artifact.kind,
      });
    }
  };

  const resizePane = (width: number, done: boolean) => {
    setPaneWidth(width);
    if (done) rememberPaneWidth(width);
  };

  if (cardId) {
    const selected = detail?.find((artifact) => artifact.id === selectedId) ?? detail?.[0] ?? null;
    return (
      <div
        className="artifacts-screen artifacts-screen-detail"
        aria-busy={detail === null && !loadFailed && !cardMissing ? true : undefined}
      >
        <div className="artifacts-heading">
          <div className="artifacts-heading-copy">
            <a className="artifacts-back" href="/artifacts">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path d="M10 3.5 5.5 8l4.5 4.5" />
              </svg>
              All artifacts
            </a>
            <h1 className="artifacts-title">{detailTitle ?? "Card"}</h1>
          </div>
          {projectId && (
            <a className="btn" href={`/?project=${encodeURIComponent(projectId)}&feature=${encodeURIComponent(cardId)}`}>
              Open card
            </a>
          )}
        </div>
        {cardMissing ? (
          <div className="artifacts-empty">
            <p>This card no longer exists.</p>
            <a className="btn" href="/artifacts">
              Back to all artifacts
            </a>
          </div>
        ) : loadFailed && detail === null ? (
          <div className="setup-prompt" role="alert">
            <span>Couldn&apos;t load artifacts.</span>
            <button className="btn" type="button" onClick={() => void refreshDetail()}>
              Try again
            </button>
          </div>
        ) : detail === null ? (
          <ArtifactsDetailSkeleton />
        ) : detail.length === 0 ? (
          <div className="artifacts-empty">
            <p className="artifacts-empty-title">No artifacts on this card</p>
            <p className="muted">When an agent produces a write up, mockup, or screenshot here, it will show up.</p>
          </div>
        ) : (
          <div
            ref={splitRef}
            className="artifacts-split"
            style={{ "--artifacts-pane": `${paneWidth}px` } as CSSProperties}
          >
            <nav className="artifacts-files" aria-label="Files">
              <p className="artifacts-files-count">
                {detail.length === 1 ? "1 file" : `${detail.length} files`}
              </p>
              <ul>
                {detail.map((artifact) => {
                  const current = artifact.id === selected?.id;
                  return (
                    <li key={artifact.id}>
                      <button
                        type="button"
                        className="artifacts-file"
                        aria-current={current ? "true" : undefined}
                        onClick={() => select(artifact)}
                      >
                        <span className="artifacts-file-ext" aria-hidden="true">
                          {kindExt(artifact.kind, artifact.path)}
                        </span>
                        <span className="artifacts-file-text">
                          <span className="artifacts-file-name" title={artifact.path}>
                            {artifactBaseName(artifact.path)}
                          </span>
                          <span className="artifacts-file-meta">
                            {artifact.stageName}
                            <span aria-hidden="true"> · </span>
                            {artifactKindLabel(artifact.kind)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {detail.length === 200 && (
                <p className="muted artifacts-cap">Showing the 200 most recent artifacts.</p>
              )}
            </nav>
            <PaneDivider width={paneWidth} splitRef={splitRef} onChange={resizePane} />
            {selected && <ArtifactReader key={selected.id} client={client} artifact={selected} />}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="artifacts-screen" aria-busy={cards === null && !loadFailed && !projectMissing ? true : undefined}>
      <div className="artifacts-heading">
        <div className="artifacts-heading-copy">
          <h1 className="artifacts-title">Artifacts</h1>
          <p className="artifacts-lede">Everything your agents produced, by card.</p>
        </div>
      </div>
      {projectMissing ? (
        <div className="artifacts-empty" role="alert">
          <p>This project isn&apos;t available. It may have been removed, or you may not have access.</p>
          <button className="btn" type="button" onClick={() => { window.location.href = "/"; }}>
            Choose another project
          </button>
        </div>
      ) : loadFailed && cards === null ? (
        <div className="setup-prompt" role="alert">
          <span>Couldn&apos;t load artifacts.</span>
          <button className="btn" type="button" onClick={() => void refreshGrid()}>
            Try again
          </button>
        </div>
      ) : cards === null ? (
        <ArtifactsGridSkeleton framed={false} />
      ) : cards.length === 0 ? (
        <div className="artifacts-empty">
          <p className="artifacts-empty-title">No artifacts yet</p>
          <p className="muted">
            When an agent produces a write up, mockup, or screenshot on a card, it will show up here.
          </p>
          <a className="btn" href="/">
            Go to Board
          </a>
        </div>
      ) : (
        <div className="artifacts-grid">
          {cards.map((card) => (
            <a
              key={card.featureId}
              className="artifacts-tile"
              href={`/artifacts/${card.featureId}`}
              aria-label={`${card.title}, ${artifactCountLabel(card.artifactCount)}, ${formatUpdatedAgo(card.latestCreatedAt)}`}
            >
              <div className="artifacts-tile-preview">
                <TilePreview client={client} card={card} />
              </div>
              <div className="artifacts-tile-body">
                <span className="artifacts-tile-title">{card.title}</span>
                <span className="artifacts-tile-meta">
                  <span>
                    {artifactCountLabel(card.artifactCount)}
                    <span aria-hidden="true"> · </span>
                    {formatUpdatedAgo(card.latestCreatedAt)}
                  </span>
                  <span className="artifacts-tile-kinds">
                    {card.kinds.map((kind) => (
                      <span key={kind} className="artifacts-kind">
                        {kindExt(kind)}
                      </span>
                    ))}
                  </span>
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
