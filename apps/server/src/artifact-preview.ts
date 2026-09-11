/** Escape both HTML text and a double-quoted srcdoc attribute. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

// srcdoc inherits this policy. Inline scripts can implement the artifact's
// interactions, but the iframe's opaque origin cannot access the wrapper.
// No fetch requests, forms or external scripts are allowed.
export const ARTIFACT_PREVIEW_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function artifactPreviewPage(
  artifact: { id: string; path: string; kind: string; mime: string },
  bytes: Buffer,
): string {
  const title = escapeHtml(artifact.path);
  const download = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
  const content =
    artifact.kind === "html"
      ? bytes.toString("utf8")
      : artifact.kind === "image" &&
          ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].includes(artifact.mime)
        ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#18181b"><img alt="Artifact preview" style="max-width:100%;height:auto" src="data:${artifact.mime};base64,${bytes.toString("base64")}"></body>`
        : `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;font:15px/1.6 monospace">${escapeHtml(bytes.toString("utf8"))}</pre>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Bento</title><style>
*{box-sizing:border-box}body{margin:0;height:100dvh;display:flex;flex-direction:column;background:#18181b;color:#fafafa;font:14px system-ui,sans-serif}header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid #3f3f46}strong{color:#f9a8d4}h1{font:inherit;margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a{color:#a5f3fc;white-space:nowrap}iframe{display:block;flex:1;width:100%;min-height:0;border:0;background:white}
</style></head><body><header><strong>Bento</strong><h1>${title}</h1><a href="${download}" download>Download</a></header><iframe title="Artifact preview" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(content)}"></iframe></body></html>`;
}
