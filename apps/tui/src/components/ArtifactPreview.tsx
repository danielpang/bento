import { useKeyboardInput as useInput } from "../mouse.js";
import { useEffect, useState } from "react";
import { Box, Text, useStdin, useWindowSize } from "ink";
import type { BentoClient, RunArtifact } from "@bento/api-client";
import { MAX_PREVIEW_BYTES, previewPixels, renderArtifact } from "../artifact-preview.js";
import { terminalText } from "../terminal.js";
import { useMouseTarget } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";

type Pixels = Awaited<ReturnType<typeof previewPixels>>;
export function ArtifactPreview({
  client,
  artifact,
  onClose,
}: {
  client: BentoClient;
  artifact: RunArtifact;
  onClose: () => void;
}) {
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const width = Math.max(10, Math.min(columns - 4, 240));
  const height = Math.max(2, rows - (columns < 65 ? 9 : 8));
  const [image, setImage] = useState<Buffer | null>(null);
  const [pixels, setPixels] = useState<Pixels | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (artifact.size > MAX_PREVIEW_BYTES)
        throw new Error("Preview is limited to 10 MB. Save this artifact to inspect it.");
      const bytes = await client.getArtifactBytes(artifact.id, {
        signal: controller.signal,
        maxBytes: MAX_PREVIEW_BYTES,
      });
      const result = await renderArtifact(bytes, artifact.kind, controller.signal);
      if (!controller.signal.aborted) setImage(result);
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [client, artifact.id]);
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    void previewPixels(image, Math.min(960, width * zoom), Math.min(4096, height * 2 * zoom))
      .then((result) => {
        if (!cancelled) setPixels(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [image, width, height, zoom]);
  const left = Math.min(offset.x, Math.max(0, (pixels?.width ?? 0) - width));
  const top = Math.min(offset.y, Math.max(0, Math.ceil((pixels?.height ?? 0) / 2) - height));
  const mouse = useMouseTarget({
    onScroll: (event) => {
      const dx = event.kind === "left" ? -4 : event.kind === "right" ? 4 : 0;
      const dy = event.kind === "up" ? -2 : event.kind === "down" ? 2 : 0;
      setOffset((value) => ({
        x: Math.max(0, Math.min(Math.max(0, (pixels?.width ?? 0) - width), value.x + dx)),
        y: Math.max(0, Math.min(Math.max(0, Math.ceil((pixels?.height ?? 0) / 2) - height), value.y + dy)),
      }));
    },
  });
  useInput(
    (input, key) => {
      if (key.escape || input === "q") onClose();
      if (input === "+" || input === "=") setZoom((z) => Math.min(8, z * 2));
      if (input === "-") setZoom((z) => Math.max(1, z / 2));
      if (input === "0") {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      }
      const dx = key.leftArrow || input === "h" ? -4 : key.rightArrow || input === "l" ? 4 : 0;
      const dy =
        key.upArrow || input === "k"
          ? -1
          : key.downArrow || input === "j"
            ? 1
            : key.pageDown
              ? height
              : key.pageUp
                ? -height
                : 0;
      if (dx || dy)
        setOffset({
          x: Math.max(0, Math.min(Math.max(0, (pixels?.width ?? 0) - width), left + dx)),
          y: Math.max(0, Math.min(Math.max(0, Math.ceil((pixels?.height ?? 0) / 2) - height), top + dy)),
        });
    },
    { isActive: isRawModeSupported === true },
  );
  function row(y: number) {
    if (!pixels) return null;
    const pixel = (x: number, py: number) =>
      py >= pixels.height
        ? "#ffffff"
        : `#${pixels.data.subarray((py * pixels.width + x) * 3, (py * pixels.width + x) * 3 + 3).toString("hex")}`;
    const spans: { foreground: string; background: string; count: number }[] = [];
    for (let x = left; x < Math.min(pixels.width, left + width); x++) {
      const foreground = pixel(x, y * 2),
        background = pixel(x, y * 2 + 1);
      const last = spans.at(-1);
      if (last?.foreground === foreground && last.background === background) last.count++;
      else spans.push({ foreground, background, count: 1 });
    }
    return (
      <Text key={y}>
        {spans.map((span, i) => (
          <Text key={i} color={span.foreground} backgroundColor={span.background}>
            {"▀".repeat(span.count)}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Box ref={mouse} flexDirection="column" paddingX={1}>
      <Text bold>
        {terminalText(artifact.path)} · {zoom}×
      </Text>
      {error ? (
        <Text color="red">{terminalText(error)}</Text>
      ) : !pixels ? (
        <Text color="cyan">Rendering preview…</Text>
      ) : (
        Array.from({ length: Math.min(height, Math.ceil(pixels.height / 2) - top) }, (_, i) => row(top + i))
      )}
      <Text dimColor wrap="truncate-end">
        +/- zoom · 0 fit · arrows pan · wheel scroll · Esc back
      </Text>
      <MouseActions>
        <MouseButton label="Back" onClick={onClose} />
        <MouseButton
          label="Zoom in"
          onClick={() => setZoom((z) => Math.min(8, z * 2))}
          disabled={!pixels || zoom >= 8}
        />
        <MouseButton
          label="Zoom out"
          onClick={() => setZoom((z) => Math.max(1, z / 2))}
          disabled={!pixels || zoom <= 1}
        />
        <MouseButton
          label="Fit"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
          disabled={!pixels}
        />
      </MouseActions>
      {artifact.kind === "html" && (
        <Text dimColor wrap="truncate-end">
          Static preview. Scripts and external assets are disabled. First 6000 pixels shown.
        </Text>
      )}
    </Box>
  );
}
