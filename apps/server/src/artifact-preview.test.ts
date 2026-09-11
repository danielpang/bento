import assert from "node:assert/strict";
import test from "node:test";
import { artifactPreviewPage, ARTIFACT_PREVIEW_POLICY } from "./artifact-preview.js";

test("HTML artifacts and hostile filenames stay inside an opaque sandboxed frame", () => {
  const html = artifactPreviewPage(
    { id: "test", path: "</h1><script>alert(1)</script>", kind: "html", mime: "text/html" },
    Buffer.from(
      '<h1>Preview</h1><script>document.body.dataset.ready="yes"</script><div title="quoted">Hi</div>',
    ),
  );
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin|<script>/);
  assert.match(html, /&lt;script&gt;document.body.dataset.ready=&quot;yes&quot;&lt;\/script&gt;/);
  assert.match(html, /href="\/api\/artifacts\/test\/content"/);
  assert.match(ARTIFACT_PREVIEW_POLICY, /connect-src 'none'/);
});

test("image bytes are embedded and text artifacts are escaped rather than executed", () => {
  const image = artifactPreviewPage(
    { id: "i", path: "image.png", kind: "image", mime: "image/png" },
    Buffer.from([1, 2, 3]),
  );
  assert.match(image, /data:image\/png;base64,AQID/);
  const text = artifactPreviewPage(
    { id: "t", path: "notes.md", kind: "markdown", mime: "text/markdown" },
    Buffer.from("<script>alert(1)</script>"),
  );
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&amp;lt;script&amp;gt;/);
});
