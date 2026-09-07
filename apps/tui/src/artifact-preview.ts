/// <reference lib="dom" />
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;

/** No application session, filesystem URLs, network, or agent JavaScript enters this renderer. */
export async function renderArtifact(bytes: Uint8Array, kind: string, signal?: AbortSignal): Promise<Buffer> {
  if (bytes.length > MAX_PREVIEW_BYTES)
    throw new Error("Preview is limited to 10 MB. Save this artifact to inspect it.");
  signal?.throwIfAborted();
  if (kind === "image") {
    return sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false }).rotate().png().toBuffer();
  }
  if (kind !== "html" && kind !== "mermaid")
    throw new Error("This artifact supports source reading and download.");
  const source = Buffer.from(bytes).toString("utf8");
  if (kind === "mermaid" && source.length > 50_000)
    throw new Error("Diagram is too large to preview. Read its source or save the artifact.");
  const browser = await chromium.launch({ chromiumSandbox: true, timeout: 15_000 }).catch((error: Error) => {
    if (error.message.includes("Executable doesn't exist"))
      throw new Error(
        "Install the preview browser with: pnpm --filter @bento/tui exec playwright install chromium",
      );
    throw error;
  });
  const close = () => {
    void browser.close().catch(() => {});
  };
  const deadline = setTimeout(close, 20_000);
  signal?.addEventListener("abort", close, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({
      javaScriptEnabled: kind === "mermaid",
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("popup", (popup) => {
      void popup.close();
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src ${kind === "mermaid" ? "'unsafe-inline'" : "'none'"}`;
    await page.setContent(
      `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body style="margin:16px;background:white;color:#111"></body></html>`,
    );
    if (kind === "html") {
      // DOMParser keeps artifact head styles while the enforced policy stays ahead of agent bytes.
      await page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc
          .querySelectorAll("script,iframe,frame,object,embed,base,meta,link")
          .forEach((node) => node.remove());
        document.head.append(...Array.from(doc.head.childNodes));
        document.body.replaceWith(doc.body);
      }, source);
    } else {
      const bundle = await readFile(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");
      await page.addScriptTag({ content: bundle });
      await page.evaluate(async (diagram) => {
        const mermaid = (
          globalThis as unknown as {
            mermaid: {
              initialize: (c: unknown) => void;
              render: (id: string, text: string) => Promise<{ svg: string }>;
            };
          }
        ).mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
          maxTextSize: 50_000,
          maxEdges: 500,
          secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges"],
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render("bento_diagram", diagram);
        document.body.innerHTML = svg;
      }, source);
    }
    const height = await page.evaluate(() =>
      Math.min(6000, Math.max(800, document.documentElement.scrollHeight)),
    );
    await page.setViewportSize({ width: 1200, height });
    return await page.screenshot({ animations: "disabled", timeout: 10_000 });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", close);
    await browser.close();
  }
}

export async function previewPixels(bytes: Uint8Array, width: number, height: number) {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .flatten({ background: "#ffffff" })
    .resize({ width, height, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
