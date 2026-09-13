import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createServer } from "node:http";
import {
  MAX_PREVIEW_BYTES,
  previewPixels,
  renderArtifact,
  renderArtifactContent,
} from "../artifact-preview.js";

test("image preview decodes real pixels, preserves aspect ratio and rejects oversized input", async () => {
  const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: "#f00" } })
    .png()
    .toBuffer();
  const pixels = await previewPixels(await renderArtifact(png, "image"), 20, 20);
  assert.equal(pixels.width, 20);
  assert.equal(pixels.height, 10);
  assert.deepEqual([...pixels.data.subarray(0, 3)], [255, 0, 0]);
  await assert.rejects(renderArtifact(new Uint8Array(MAX_PREVIEW_BYTES + 1), "image"), /10 MB/);
  await assert.rejects(renderArtifact(Buffer.from("broken image"), "image"));
});

test(
  "HTML and Mermaid render in real Chromium without executing artifact scripts or fetching assets",
  { skip: !process.env.BENTO_PREVIEW_E2E },
  async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const endpoint = `http://127.0.0.1:${address.port}/leak`;
      const html = `<html><head><style>body{margin:0;background:rgb(255,0,0)}</style></head><body><script>document.body.style.background='lime';fetch('${endpoint}')</script><img src='${endpoint}' onerror="document.body.style.background='lime'"><iframe src='${endpoint}'></iframe><meta http-equiv='refresh' content='0;url=${endpoint}'></body></html>`;
      const image = await renderArtifact(Buffer.from(html), "html");
      const pixel = await sharp(image)
        .extract({ left: 100, top: 100, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.deepEqual([...pixel], [255, 0, 0], "artifact JavaScript cannot change the page");
      assert.equal(requests, 0, "external resources never reach the network");
      const readable = await renderArtifactContent(
        Buffer.from(
          `<h1>Agent settings</h1><p>Choose a harness and model.</p><ul><li>Cursor</li><li>Claude Code</li></ul><button>Save agent</button><p hidden>Hidden text</p><table><tr><th>Name</th><th>Model</th></tr><tr><td>Reviewer</td><td>Auto</td></tr></table><script>document.body.textContent='Injected'</script>`,
        ),
        "html",
      );
      assert.match(readable.text ?? "", /# Agent settings/);
      assert.match(readable.text ?? "", /• Cursor/);
      assert.match(readable.text ?? "", /\[Save agent\]/);
      assert.match(readable.text ?? "", /Reviewer \| Auto/);
      assert.doesNotMatch(readable.text ?? "", /Hidden text|Injected/);
      const diagram = await renderArtifact(
        Buffer.from("graph LR\n A[Plan] --> B[Build] --> C[Review]"),
        "mermaid",
      );
      const stats = await sharp(diagram).stats();
      assert.ok(
        stats.channels.some((channel) => channel.min < 100),
        "diagram contains rendered content",
      );
      await assert.rejects(renderArtifact(Buffer.from("not a diagram"), "mermaid"));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  },
);

test("terminal image viewer renders pixels, zooms, fits and returns to the artifact menu", async () => {
  const React = await import("react");
  const { render } = await import("ink-testing-library");
  const { BentoClient } = await import("@bento/api-client");
  const { ArtifactPreview } = await import("./ArtifactPreview.js");
  const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#f00" } })
    .png()
    .toBuffer();
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async () => new Response(png)) as typeof fetch,
  });
  let closed = false;
  const artifact = {
    id: "image",
    path: "preview.png",
    size: png.length,
    kind: "image",
  } as import("@bento/api-client").RunArtifact;
  const ui = render(
    React.createElement(ArtifactPreview, {
      client,
      artifact,
      onClose: () => {
        closed = true;
      },
    }),
  );
  async function frame(pattern: RegExp) {
    const deadline = Date.now() + 5000;
    while (!pattern.test(ui.lastFrame() ?? "")) {
      if (Date.now() > deadline) throw new Error(`Preview did not render: ${ui.lastFrame()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await frame(/▀/);
    ui.stdin.write("+");
    await frame(/2×/);
    ui.stdin.write("0");
    await frame(/1×/);
    ui.stdin.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, true);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
