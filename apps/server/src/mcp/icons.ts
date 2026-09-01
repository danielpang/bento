import { safeFetch, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * Service marks for the catalog, fetched by the server rather than the
 * browser.
 *
 * A logo makes a list of connections readable at a glance, and the
 * registry publishes none, so the icon comes from the service's own
 * site. Letting the console load it directly would tell every vendor in
 * the list who is browsing Bento's settings page and when, so the
 * server fetches it, caches it, and serves the bytes from our own
 * origin. Hosts are limited to ones the catalog actually offered, so
 * this is not a general fetcher.
 */

const CACHE_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** A favicon is small; anything larger is not one. */
const MAX_BYTES = 256 * 1024;

/**
 * The content type is decided from the bytes, never from the header the
 * service sent. One catalog service serves a PNG labelled as an ICO,
 * and because these are proxied with nosniff (they are third-party
 * bytes on our origin) the browser cannot rescue a wrong label: it
 * would simply fail to decode. Sniffing here is both more accurate and
 * stricter, since anything unrecognised is refused rather than served.
 */
function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  const head = Buffer.from(bytes.slice(0, 256)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

export interface ServiceIcon {
  body: Uint8Array;
  contentType: string;
}

/** Hosts the catalog has offered, so this cannot fetch anywhere. */
const allowedHosts = new Set<string>();
const cache = new Map<string, { at: number; icon: ServiceIcon | null }>();

export function allowIconHosts(hosts: string[]): void {
  for (const host of hosts) if (host) allowedHosts.add(host.toLowerCase());
}

export function isIconHostAllowed(host: string): boolean {
  return allowedHosts.has(host.toLowerCase());
}

/** Test seam. */
export function clearIconState(): void {
  allowedHosts.clear();
  cache.clear();
}

/**
 * The service's icon, or null when it has none worth showing. Null is a
 * normal answer: the console falls back to a monogram, which is better
 * than a broken image.
 */
export async function fetchServiceIcon(host: string, policy: SafeFetchPolicy): Promise<ServiceIcon | null> {
  const key = host.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.icon;

  // The MCP endpoint is often on a subdomain that serves no icon, so the
  // registrable parent is tried too: mcp.notion.com, then notion.com.
  const icon = (await tryHost(key, policy)) ?? (await tryHost(parentHost(key), policy));
  cache.set(key, { at: Date.now(), icon });
  return icon;
}

async function tryHost(host: string, policy: SafeFetchPolicy): Promise<ServiceIcon | null> {
  if (!host) return null;
  try {
    const response = await safeFetch(
      `https://${host}/favicon.ico`,
      { headers: { accept: "image/*" }, headersTimeoutMs: FETCH_TIMEOUT_MS },
      policy,
    );
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readCapped(response);
    if (!body || body.byteLength === 0) return null;
    const contentType = sniffImageType(body);
    return contentType ? { body, contentType } : null;
  } catch {
    return null;
  }
}

/** Drops the leftmost label: mcp.notion.com becomes notion.com. */
function parentHost(host: string): string {
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : "";
}

async function readCapped(response: Awaited<ReturnType<typeof safeFetch>>): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}
