import { safeFetch, SafeFetchRefused, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * The public catalog of MCP servers people can connect, read from the
 * official registry at registry.modelcontextprotocol.io.
 *
 * Browsing comes before typing: most teams want Notion or Sentry, not a
 * URL they have to go and look up, so the console lists what is
 * available and a custom URL is the fallback. Bento only speaks remote
 * MCP, so entries without a remote (stdio packages that run as a
 * command) are dropped rather than offered and then refused at connect
 * time.
 *
 * Fetched server side, never from the browser: it keeps the request
 * inside safeFetch's egress policy, avoids a cross-origin call from the
 * console, and lets one cache serve every tenant. The catalog is public
 * data, identical for everyone, so a process-wide cache is correct.
 */

export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

/** The registry is public and slow moving; a few minutes is plenty. */
const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** One page is a browsable list, not a database dump. */
const PAGE_LIMIT = 100;

export interface CatalogEntry {
  /** Reverse-DNS registry name, stable across versions. */
  name: string;
  /** Human title, falling back to the registry name. */
  title: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  /** The namespace that published it, so nobody mistakes a wrapper for the vendor. */
  publisher: string;
}

interface RegistryRemote {
  type?: string;
  url?: string;
}

interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  remotes?: RegistryRemote[];
}

const cache = new Map<string, { at: number; entries: CatalogEntry[] }>();

/** Test seam: drops the cache so a fixture registry is read again. */
export function clearCatalogCache(): void {
  cache.clear();
}

export interface CatalogOptions {
  registryUrl?: string | undefined;
  search?: string | undefined;
}

/**
 * Lists connectable servers, newest version of each. Answers an empty
 * list rather than throwing when the registry is unreachable: a catalog
 * that will not load must not stop somebody adding a URL by hand.
 */
export async function fetchCatalog(
  policy: SafeFetchPolicy,
  opts: CatalogOptions = {},
): Promise<{ entries: CatalogEntry[]; reachable: boolean }> {
  const base = (opts.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, "");
  const search = (opts.search ?? "").trim().slice(0, 100);
  const key = `${base} ${search.toLowerCase()}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { entries: hit.entries, reachable: true };

  const url = new URL(`${base}/v0/servers`);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  // Every published version is its own row, so ask for the current ones
  // or one server appears three times.
  url.searchParams.set("version", "latest");
  if (search) url.searchParams.set("search", search);

  let body: string;
  try {
    const response = await safeFetch(
      url.toString(),
      { headers: { accept: "application/json" }, headersTimeoutMs: FETCH_TIMEOUT_MS },
      policy,
    );
    if (!response.ok) return { entries: [], reachable: false };
    body = await response.text();
  } catch (err) {
    if (!(err instanceof SafeFetchRefused)) {
      console.warn("could not read the MCP registry:", err);
    }
    return { entries: [], reachable: false };
  }

  let parsed: { servers?: { server?: RegistryServer }[] };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { entries: [], reachable: false };
  }

  const entries = toEntries(parsed.servers ?? []);
  cache.set(key, { at: Date.now(), entries });
  return { entries, reachable: true };
}

/** Registry rows to the shape the console shows, remotes only. */
export function toEntries(rows: { server?: RegistryServer }[]): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>();
  for (const row of rows) {
    const server = row.server;
    if (!server?.name) continue;
    const remote = pickRemote(server.remotes ?? []);
    if (!remote) continue; // stdio only: Bento cannot reach it.
    // The registry can still carry more than one row per name; the
    // first is the one the API considered current.
    if (byName.has(server.name)) continue;
    byName.set(server.name, {
      name: server.name,
      title: server.title?.trim() || server.name,
      description: (server.description ?? "").trim().slice(0, 300),
      url: remote.url,
      transport: remote.transport,
      publisher: publisherOf(server.name),
    });
  }
  return [...byName.values()];
}

/**
 * The remote Bento can talk to. Streamable HTTP is preferred: it is
 * what the gateway proxies best and what most servers now publish.
 */
function pickRemote(remotes: RegistryRemote[]): { url: string; transport: "http" | "sse" } | null {
  const usable = remotes
    .map((r) => {
      if (!r.url || !/^https?:\/\//i.test(r.url)) return null;
      if (r.type === "streamable-http") return { url: r.url, transport: "http" as const };
      if (r.type === "sse") return { url: r.url, transport: "sse" as const };
      return null;
    })
    .filter((r): r is { url: string; transport: "http" | "sse" } => r !== null);
  return usable.find((r) => r.transport === "http") ?? usable[0] ?? null;
}

/**
 * The publishing namespace, shown so an official server reads
 * differently from somebody's wrapper of it. Registry names are
 * reverse-DNS, so the part before the first slash is the publisher.
 */
function publisherOf(name: string): string {
  const namespace = name.split("/")[0] ?? name;
  return namespace.startsWith("io.github.") ? namespace.slice("io.github.".length) : namespace;
}

/**
 * The tool name agents see. Registry names are reverse-DNS, and a great
 * many are published as "<vendor>/mcp", so the tail alone would make
 * Notion, Linear, and Sentry all want the slug "mcp" and collide on the
 * second one added. A generic tail falls back to the vendor.
 */
const GENERIC_TAILS = new Set(["mcp", "server", "mcp-server", "mcpserver", "api", "remote"]);

export function slugFor(entry: { name: string; title?: string }): string {
  const [namespace = "", tail = ""] = splitName(entry.name);
  const candidates = [
    tail,
    // com.notion -> notion, io.github.alice -> alice
    namespace.split(".").pop() ?? "",
    entry.title ?? "",
  ];
  for (const candidate of candidates) {
    const slug = clean(candidate);
    if (slug && !GENERIC_TAILS.has(slug)) return slug;
  }
  return clean(entry.name) || "mcp-server";
}

function splitName(name: string): [string, string] {
  const at = name.indexOf("/");
  return at === -1 ? [name, ""] : [name.slice(0, at), name.slice(at + 1)];
}

function clean(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
