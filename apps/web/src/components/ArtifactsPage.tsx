import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type BentoClient, type ProjectArtifactCard, type RunArtifact } from "@bento/api-client";
import { Markdown } from "./Markdown.js";
import { createRequestGate } from "../latest-request.js";
import {
  artifactBaseName,
  artifactCountLabel,
  artifactKindLabel,
  formatUpdatedAgo,
} from "../artifacts-format.js";
import { captureArtifactOpened, captureArtifactsTabOpened } from "../posthog.js";
import { ArtifactsDetailSkeleton, ArtifactsGridSkeleton } from "./Skeleton.js";

const ArtifactViewer = lazy(() =>
  import("./ArtifactViewer.js").then((m) => ({ default: m.ArtifactViewer })),
);

function KindIcon({ kind }: { kind: string }) {
  return (
    <span className="artifacts-kind-icon" aria-hidden="true">
      {artifactKindLabel(kind)}
    </span>
  );
}

function TilePreview({
  client,
  card,
}: {
  client: BentoClient;
  card: ProjectArtifactCard;
}) {
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
  return <KindIcon kind={preview.kind} />;
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
  const [openArtifact, setOpenArtifact] = useState<RunArtifact | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
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
    setLoadFailed(false);
    setProjectMissing(false);
    setCardMissing(false);
    if (cardId) void refreshDetail();
    else void refreshGrid();
  }, [refreshGrid, refreshDetail, cardId, projectId]);

  const closeViewer = () => {
    setOpenArtifact(null);
    openerRef.current?.focus();
    openerRef.current = null;
  };

  const openViewer = (artifact: RunArtifact, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setOpenArtifact(artifact);
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

  if (cardId) {
    return (
      <div className="artifacts-screen" aria-busy={detail === null && !loadFailed && !cardMissing ? true : undefined}>
        <div className="surface-heading">
          <a className="artifacts-back" href="/artifacts">
            ← All artifacts
          </a>
          <h1 className="artifacts-title">{detailTitle ?? "Card"}</h1>
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
        ) : (
          <>
            <ul className="artifacts-detail-list">
              {detail.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    className="artifacts-detail-row"
                    aria-label={`${artifactBaseName(artifact.path)}, ${artifactKindLabel(artifact.kind)}`}
                    onClick={(event) => openViewer(artifact, event.currentTarget)}
                  >
                    <span className="chip">{artifactKindLabel(artifact.kind)}</span>
                    <span className="artifacts-detail-name">{artifactBaseName(artifact.path)}</span>
                    <span className="artifacts-detail-meta">{artifact.stageName}</span>
                  </button>
                  <a className="artifacts-open-tab" href={`/artifact/${artifact.id}`} target="_blank" rel="noreferrer">
                    Open in new tab
                  </a>
                </li>
              ))}
            </ul>
            {detail.length === 200 && (
              <p className="muted artifacts-cap">Showing the 200 most recent artifacts.</p>
            )}
          </>
        )}
        {openArtifact && (
          <Suspense fallback={null}>
            <ArtifactViewer client={client} artifact={openArtifact} onClose={closeViewer} />
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <div className="artifacts-screen" aria-busy={cards === null && !loadFailed && !projectMissing ? true : undefined}>
      <div className="surface-heading">
        <h1 className="artifacts-title">Artifacts</h1>
        <p className="artifacts-lede">Everything your agents produced, by card.</p>
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
            When an agent produces a write-up, mockup, or screenshot on a card, it will show up here.
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
                  {artifactCountLabel(card.artifactCount)}
                  <span aria-hidden="true"> · </span>
                  {formatUpdatedAgo(card.latestCreatedAt)}
                </span>
                <span className="artifacts-tile-kinds">
                  {card.kinds.map((kind) => (
                    <span key={kind} className="chip">
                      {artifactKindLabel(kind)}
                    </span>
                  ))}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
