import { useEffect, useState } from "react";
import type { BentoClient, RunArtifact } from "@bento/api-client";
import { Markdown, MermaidDiagram } from "./Markdown.js";
import { Modal } from "./Modal.js";
import { Skeleton } from "./Skeleton.js";

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
  const needsText = artifact.kind !== "image" && (artifact.kind !== "file" || artifact.mime.startsWith("text/"));
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (!needsText) return;
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
  }, [client, artifact.id, needsText]);

  function body() {
    if (failed) {
      return (
        <p className="error" role="alert">
          Could not load this artifact. Check the connection and open it again.
        </p>
      );
    }
    if (artifact.kind === "image") {
      return <img className="artifact-image" src={client.artifactContentUrl(artifact.id)} alt={artifact.path} />;
    }
    if (needsText && text === null) {
      return (
        <div className="skeleton-stack" aria-busy="true">
          <Skeleton height={12} width="88%" />
          <Skeleton height={12} width="74%" />
          <Skeleton height={12} width="81%" />
          <Skeleton height={12} width="62%" />
          <Skeleton height={12} width="70%" />
        </div>
      );
    }
    if (artifact.kind === "markdown") return <Markdown text={text!} />;
    if (artifact.kind === "mermaid") return <MermaidDiagram source={text!} />;
    if (artifact.kind === "html") {
      return showSource ? (
        <pre className="artifact artifact-source">{text}</pre>
      ) : (
        <iframe className="artifact-frame" sandbox="allow-scripts" srcDoc={text!} title={artifact.path} />
      );
    }
    if (needsText) return <pre className="artifact artifact-source">{text}</pre>;
    return <p className="muted">This file has no preview. Download it to look at it.</p>;
  }

  return (
    <Modal
      title={artifact.path}
      description={`From the ${artifact.stageName} stage`}
      wide
      onClose={onClose}
      actions={
        <>
          {artifact.kind === "html" && text !== null && (
            <button className="btn" onClick={() => setShowSource((on) => !on)}>
              {showSource ? "Preview" : "View source"}
            </button>
          )}
          <a className="btn" href={client.artifactContentUrl(artifact.id)} download>
            Download
          </a>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="artifact-view">{body()}</div>
    </Modal>
  );
}
