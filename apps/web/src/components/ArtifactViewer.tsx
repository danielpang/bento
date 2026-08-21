import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ApiError, type BentoClient, type RunArtifact } from "@bento/api-client";
import { Markdown, MermaidDiagram } from "./Markdown.js";
import { Modal } from "./Modal.js";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

function artifactBaseName(path: string): string {
  const base = path.split("/").pop();
  return base && base.length > 0 ? base : path;
}

/**
 * Opens one artifact: rendered markdown, a drawn diagram, an image, or
 * an HTML preview.
 *
 * HTML is the dangerous one. An artifact is agent output, agent output
 * can carry a prompt injection's payload, and a page rendered on the
 * console's own origin would run script with the user's session. So the
 * preview lives in a sandboxed iframe fed by srcdoc: scripts may run,
 * but in an opaque origin with no cookies, no storage, and no way to
 * reach the console around it. The server backs this up by serving
 * artifact bytes with a sandboxing CSP and, for HTML, as a download.
 */
export function ArtifactViewer({
  client,
  artifact,
  onClose,
}: {
  client: BentoClient;
  artifact: RunArtifact;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canvas = useArtifactCanvas(client, artifact);

  return (
    <Modal
      title={artifact.path}
      description={`From the ${artifact.stageName} stage`}
      wide
      expanded={expanded}
      onClose={onClose}
      headerActions={
        <ArtifactHeadActions artifactId={artifact.id} expanded={expanded} onToggleExpand={() => setExpanded((on) => !on)} />
      }
      actions={
        <>
          {canvas.sourceToggle}
          <a className="btn" href={client.artifactContentUrl(artifact.id)} download>
            Download
          </a>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="artifact-view">{canvas.body}</div>
    </Modal>
  );
}

/**
 * The same viewer as a tab of its own, reached from the pop-out control
 * on the modal. Opening the content URL would download HTML and show
 * mermaid as source; this page is the one that still draws them.
 */
export function ArtifactPage({ client, artifactId }: { client: BentoClient; artifactId: string }) {
  const [artifact, setArtifact] = useState<RunArtifact | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    client.getArtifact(artifactId).then(
      (row) => {
        if (!cancelled) setArtifact(row);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, artifactId, retry]);

  const canvas = useArtifactCanvas(client, artifact);

  const heading = artifact ? artifactBaseName(artifact.path) : "Artifact";

  return (
    <div className="session-page artifact-page">
      <header className="session-head">
        <div className="modal-head-copy">
          <h1 title={artifact?.path}>{heading}</h1>
          {artifact && <p className="muted">From the {artifact.stageName} stage</p>}
        </div>
        <a className="btn btn-ghost" href="/">
          Back
        </a>
      </header>
      {missing ? (
        <>
          <p className="error">This artifact was deleted.</p>
          <p className="muted">It is no longer on the card, and its file went with it.</p>
        </>
      ) : loadFailed ? (
        <>
          <p className="error">Could not load this artifact.</p>
          <p className="muted">Check that the server is reachable and that you are signed in.</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </button>
          </div>
        </>
      ) : !artifact ? (
        <div className="center" />
      ) : (
        <>
          <div className="artifact-page-toolbar">
            {canvas.sourceToggle}
            <a className="btn" href={client.artifactContentUrl(artifact.id)} download>
              Download
            </a>
          </div>
          <div className="artifact-view artifact-page-view">{canvas.body}</div>
        </>
      )}
    </div>
  );
}

function useArtifactCanvas(client: BentoClient, artifact: RunArtifact | null) {
  const needsText =
    !!artifact && artifact.kind !== "image" && (artifact.kind !== "file" || artifact.mime.startsWith("text/"));
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    setText(null);
    setFailed(false);
    setShowSource(false);
    if (!artifact || !needsText) return;
    let cancelled = false;
    client.getArtifactText(artifact.id).then(
      (body) => {
        if (!cancelled) setText(body);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, artifact, needsText]);

  const sourceToggle =
    artifact?.kind === "html" && text !== null ? (
      <button type="button" className="btn" onClick={() => setShowSource((on) => !on)}>
        {showSource ? "Preview" : "View source"}
      </button>
    ) : null;

  let body: ReactNode = null;
  if (!artifact) {
    body = null;
  } else if (failed) {
    body = (
      <p className="error" role="alert">
        Could not load this artifact. Check the connection and open it again.
      </p>
    );
  } else if (artifact.kind === "image") {
    body = (
      <ZoomPane label="image">
        <img
          className="artifact-image"
          src={client.artifactContentUrl(artifact.id)}
          alt={artifact.path}
          draggable={false}
        />
      </ZoomPane>
    );
  } else if (needsText && text === null) {
    body = <p className="muted">Loading...</p>;
  } else if (artifact.kind === "markdown") {
    body = <Markdown text={text!} />;
  } else if (artifact.kind === "mermaid") {
    body = (
      <ZoomPane label="diagram">
        <MermaidDiagram source={text!} />
      </ZoomPane>
    );
  } else if (artifact.kind === "html") {
    body = showSource ? (
      <pre className="artifact artifact-source">{text}</pre>
    ) : (
      <iframe className="artifact-frame" sandbox="allow-scripts" srcDoc={text!} title={artifact.path} />
    );
  } else if (needsText) {
    body = <pre className="artifact artifact-source">{text}</pre>;
  } else {
    body = <p className="muted">This file has no preview. Download it to look at it.</p>;
  }

  return { body, sourceToggle };
}

/**
 * Expand and pop-out on the title row.
 *
 * Expand grows this dialog. The pop-out is a real tab: mermaid and
 * HTML have to keep being drawn here rather than navigated to as
 * bytes, which is why this is an app route and not the content URL.
 */
export function ArtifactHeadActions({
  artifactId,
  expanded,
  onToggleExpand,
}: {
  artifactId: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost icon-button artifact-head-btn"
        aria-pressed={expanded}
        aria-label={expanded ? "Shrink the viewer" : "Expand the viewer"}
        title={expanded ? "Shrink" : "Expand"}
        onClick={onToggleExpand}
      >
        {expanded ? <ShrinkMark /> : <ExpandMark />}
      </button>
      <a
        className="btn btn-ghost icon-button artifact-head-btn"
        href={`/artifact/${artifactId}`}
        target="_blank"
        rel="noreferrer"
        aria-label="Open in a new tab"
        title="Open in a new tab"
      >
        <PopOutMark />
      </a>
    </>
  );
}

/**
 * Zoom for pictures and drawn diagrams, which are the two kinds that
 * get small in the dialog and stay worth inspecting larger.
 *
 * Buttons are the floor. Ctrl (or Cmd) plus the wheel is the same
 * control as browser zoom, so it does not steal ordinary scrolling.
 * Drag pans once the content is larger than the pane.
 */
export function ZoomPane({ children, label }: { children: ReactNode; label: string }) {
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  function zoomTo(next: number) {
    setScale(clampZoom(next));
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setScale((current) => clampZoom(current + delta));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (scale <= 1 || event.button !== 0) return;
    const stage = event.currentTarget;
    stage.setPointerCapture(event.pointerId);
    pan.current = { x: event.clientX, y: event.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    setPanning(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = pan.current;
    if (!start) return;
    event.preventDefault();
    const stage = event.currentTarget;
    stage.scrollLeft = start.sl - (event.clientX - start.x);
    stage.scrollTop = start.st - (event.clientY - start.y);
  }

  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (!pan.current) return;
    pan.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const percent = `${Math.round(scale * 100)}%`;
  const canPan = scale > 1;

  return (
    <div className="zoom-pane">
      <div className="zoom-toolbar" role="toolbar" aria-label={`Zoom the ${label}`}>
        <button
          type="button"
          className="btn btn-ghost zoom-btn"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={scale <= ZOOM_MIN}
          onClick={() => zoomTo(scale - ZOOM_STEP)}
        >
          −
        </button>
        <span className="zoom-level">{percent}</span>
        <button
          type="button"
          className="btn btn-ghost zoom-btn"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={scale >= ZOOM_MAX}
          onClick={() => zoomTo(scale + ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-ghost zoom-btn"
          aria-label="Reset zoom"
          title="Reset zoom"
          disabled={scale === 1}
          onClick={() => zoomTo(1)}
        >
          Reset
        </button>
      </div>
      <div
        ref={stageRef}
        className="zoom-stage"
        data-panning={panning ? "true" : undefined}
        data-can-pan={canPan ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div className="zoom-inner" style={{ zoom: String(scale) }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ExpandMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M3 6.5V3h3.5M10 3h3v3.5M3 10v3h3.5M13 10v3h-3.5" />
    </svg>
  );
}

function ShrinkMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M6.5 3v3.5H3M13 6.5H9.5V3M6.5 13V9.5H3M13 9.5H9.5V13" />
    </svg>
  );
}

function PopOutMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M7 3H3.5v10H13V9" />
      <path d="M9 3h4v4M8 8l5-5" />
    </svg>
  );
}
