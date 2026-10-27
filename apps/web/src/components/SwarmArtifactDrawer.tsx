import { useEffect, useRef } from "react";
import { formatBytes } from "@bento/core";
import type { BentoClient } from "@bento/api-client";
import { PopOutMark, useArtifactCanvas } from "./ArtifactViewer.js";
import { useDismissable } from "./ui.js";
import { ChevronMark, CloseMark } from "./SwarmMarks.js";
import { artifactSourceLabel, artifactTypeLabel, splitArtifactPath } from "../swarm/artifacts.js";
import { formatAge } from "../swarm/time.js";
import type { SwarmArtifact, SwarmTask } from "../swarm/types.js";

/**
 * One of a swarm's artifacts, in a drawer that slides in from the left.
 *
 * From the left because the swarm page's own drawers (a task, the
 * planner's conversation) come in from the right, and an artifact is
 * often read beside one of those rather than instead of it.
 *
 * The rendering is `useArtifactCanvas`, the same one the card board's
 * viewer uses, so every rule about agent bytes stays in one place:
 * markdown with raw HTML off, HTML only inside the sandboxed iframe,
 * anything else as a download. Nothing here draws an artifact itself.
 *
 * Escape and a press outside close it, as every drawer on the page
 * does. Left and right step through the swarm's artifacts in the order
 * the page lists them, except while a field has the keys.
 */
export function SwarmArtifactDrawer({
  client,
  artifacts,
  index,
  tasks,
  onIndex,
  onClose,
  now = Date.now(),
}: {
  client: BentoClient;
  /** The swarm's artifacts, in the order the page lists them. */
  artifacts: SwarmArtifact[];
  /** Which one is open. */
  index: number;
  tasks: Pick<SwarmTask, "id" | "title">[];
  onIndex: (index: number) => void;
  onClose: () => void;
  now?: number;
}) {
  const artifact = artifacts[index] ?? null;
  const panel = useDismissable<HTMLElement>(onClose);
  const canvas = useArtifactCanvas(client, artifact);
  const step = useRef({ index, count: artifacts.length, onIndex });
  step.current = { index, count: artifacts.length, onIndex };

  // Focus moves into the drawer when it opens and back to whatever
  // opened it when it closes, so a keyboard user keeps their place in
  // the table.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [panel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='tablist']"))) return;
      if (document.querySelector("[data-portal-layer]")) return;
      const { index: at, count, onIndex: go } = step.current;
      const next = event.key === "ArrowLeft" ? at - 1 : at + 1;
      if (next < 0 || next >= count) return;
      event.preventDefault();
      go(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!artifact) return null;
  const { name } = splitArtifactPath(artifact.path);
  const type = artifactTypeLabel(artifact.kind);
  const size = formatBytes(artifact.size);
  const source = artifactSourceLabel(artifact, tasks);
  const age = formatAge(artifact.createdAt, now);
  const previous = index > 0 ? artifacts[index - 1] : undefined;
  const next = index < artifacts.length - 1 ? artifacts[index + 1] : undefined;
  const tabId = `swarm-artifact-${artifact.id}`;

  return (
    <>
      <div className="swarm-adrawer-backdrop" aria-hidden="true" />
      <aside
        ref={panel}
        className="swarm-adrawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Artifact ${name}`}
        tabIndex={-1}
      >
        <div className="swarm-adrawer-strip">
          <button type="button" className="swarm-adrawer-back" aria-label="Back to the swarm" onClick={onClose}>
            <ChevronMark left />
            Artifacts
          </button>
          <span className="swarm-adrawer-crumb">
            <span className="swarm-adrawer-crumb-root">Artifacts</span>
            <span className="swarm-adrawer-crumb-sep" aria-hidden="true">/</span>
            <span className="swarm-adrawer-crumb-name" title={artifact.path}>{name}</span>
          </span>
          <span className="swarm-adrawer-spacer" />
          <span className="swarm-adrawer-position swarm-mono" aria-label={`${index + 1} of ${artifacts.length}`}>
            {index + 1} / {artifacts.length}
          </span>
          <button
            type="button"
            className="swarm-adrawer-step"
            aria-label={previous ? `Previous artifact: ${splitArtifactPath(previous.path).name}` : "Previous artifact"}
            disabled={!previous}
            onClick={() => onIndex(index - 1)}
          >
            <ChevronMark left />
          </button>
          <button
            type="button"
            className="swarm-adrawer-step"
            aria-label={next ? `Next artifact: ${splitArtifactPath(next.path).name}` : "Next artifact"}
            disabled={!next}
            onClick={() => onIndex(index + 1)}
          >
            <ChevronMark right />
          </button>
          <span className="swarm-adrawer-rule" aria-hidden="true" />
          <button type="button" className="swarm-adrawer-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <CloseMark />
          </button>
        </div>

        <div className="swarm-adrawer-head">
          <div className="swarm-adrawer-title-row">
            <div className="swarm-adrawer-title-copy">
              <h2 className="swarm-adrawer-title" title={name}>{name}</h2>
              <span className="swarm-adrawer-path swarm-mono" title={artifact.path}>{artifact.path}</span>
              <span className="swarm-adrawer-meta-line">{[type, size, source, age].filter(Boolean).join(" · ")}</span>
            </div>
            <div className="swarm-adrawer-actions">
              <a className="btn swarm-adrawer-action" href={client.artifactContentUrl(artifact.id)} download>
                <DownloadMark />
                Download
              </a>
              <a
                className="btn swarm-adrawer-action swarm-adrawer-tab"
                href={`/artifact/${artifact.id}`}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in a new tab"
                title="Open in a new tab"
              >
                <span className="swarm-adrawer-tab-label">Open in tab</span>
                <PopOutMark />
              </a>
            </div>
          </div>
          <dl className="swarm-adrawer-meta">
            <div><dt>Type</dt><dd>{type}</dd></div>
            <div><dt>Size</dt><dd className="swarm-mono">{size}</dd></div>
            <div><dt>Source</dt><dd title={source}>{source}</dd></div>
            <div><dt>Updated</dt><dd>{age}</dd></div>
          </dl>
          <div className="swarm-adrawer-tabs" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              id={`${tabId}-preview`}
              aria-selected={!canvas.showSource}
              aria-controls={`${tabId}-body`}
              onClick={() => canvas.setShowSource(false)}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              id={`${tabId}-source`}
              aria-selected={canvas.showSource}
              aria-controls={`${tabId}-body`}
              disabled={!canvas.hasSource}
              title={canvas.hasSource ? undefined : "This kind of file has no source to show."}
              onClick={() => canvas.setShowSource(true)}
            >
              Source
            </button>
          </div>
        </div>

        <div
          className="swarm-adrawer-body artifact-view"
          id={`${tabId}-body`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${canvas.showSource ? "source" : "preview"}`}
        >
          {canvas.body}
        </div>

        <div className="swarm-adrawer-foot">
          <span>{footNote(artifact.kind, artifact.mime)}</span>
          <span className="swarm-adrawer-spacer" />
          <span className="swarm-adrawer-keys">
            <kbd>Esc</kbd> close
          </span>
          <span className="swarm-adrawer-keys">
            <kbd>{"←"}</kbd> <kbd>{"→"}</kbd> next artifact
          </span>
        </div>
      </aside>
    </>
  );
}

/** What the footer says about how this artifact was drawn. */
function footNote(kind: SwarmArtifact["kind"], mime: string): string {
  switch (kind) {
    case "markdown":
      return "Rendered with raw HTML off";
    case "html":
      return "Previewed in a sandboxed frame";
    case "mermaid":
      return "Drawn from its source";
    case "image":
      return "Shown as an image";
    default:
      return mime.startsWith("text/") ? "Shown as plain text" : "Offered as a download";
  }
}

function DownloadMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  );
}
