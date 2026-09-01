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

/**
 * The servers worth seeing first, in the order they are shown.
 *
 * Curated, because the registry carries no popularity signal of any
 * kind: no installs, no stars, no ratings. Ranking by namespace instead
 * would be worse than nothing, since a domain namespace only proves
 * control of that name. `com.trycloudflare.*` is anyone with a tunnel
 * and `app.vercel.*` is anyone with a deployment, so a "verified"
 * ordering would promote strangers as though they were the vendor.
 *
 * Held in full rather than as names to look up. Resolving these cost a
 * registry request each, and the public registry is slow and uneven
 * under that pattern: a cold browse took ten seconds against a warm
 * five milliseconds, and one bad moment returned nothing at all. A
 * server's name, URL and transport change about as often as a vendor
 * renames itself, so keeping them here trades a rare stale row for a
 * page that always opens instantly and works when the registry is down.
 *
 * Each was checked to exist in the registry with a remote. To refresh,
 * search the registry for the name and copy the current values.
 */
interface FeaturedServer {
  name: string;
  title: string;
  description: string;
  url: string;
  transport: "http" | "sse";
}

const FEATURED: FeaturedServer[] = [
  {
    name: "com.notion/mcp",
    title: "",
    description:
      "Official Notion MCP server",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
  },
  {
    name: "app.linear/linear",
    title: "Linear",
    description:
      "MCP server for Linear project management and issue tracking",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
  },
  {
    name: "io.github.PostHog/mcp",
    title: "PostHog MCP Server",
    description:
      "Official PostHog MCP Server for product analytics, feature flags, experiments, and more.",
    url: "https://mcp.posthog.com/mcp",
    transport: "http",
  },
  {
    name: "com.stripe/mcp",
    title: "",
    description:
      "MCP server integrating with Stripe - tools for customers, products, payments, and more.",
    url: "https://mcp.stripe.com",
    transport: "http",
  },
  {
    name: "com.figma.mcp/mcp",
    title: "Figma MCP Server",
    description:
      "The Figma MCP server brings Figma design context directly into your AI workflow.",
    url: "https://mcp.figma.com/mcp",
    transport: "http",
  },
  {
    name: "com.vercel/vercel-mcp",
    title: "",
    description:
      "An MCP server for Vercel",
    url: "https://mcp.vercel.com",
    transport: "http",
  },
  {
    name: "com.atlassian/atlassian-mcp-server",
    title: "Atlassian Rovo MCP Server",
    description:
      "Connect to Atlassian Jira, Confluence, and Compass to search, create, and manage your work.",
    url: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
  },
  {
    name: "com.cloudflare.mcp/mcp",
    title: "",
    description:
      "Cloudflare MCP servers",
    url: "https://docs.mcp.cloudflare.com/mcp",
    transport: "http",
  },
  {
    name: "com.supabase/mcp",
    title: "Supabase",
    description:
      "MCP server for interacting with the Supabase platform",
    url: "https://mcp.supabase.com/mcp",
    transport: "http",
  },
  {
    name: "com.airtable/mcp",
    title: "",
    description:
      "Official Airtable MCP server — database and operations layer for agents.",
    url: "https://mcp.airtable.com/mcp",
    transport: "http",
  },
  {
    name: "co.huggingface/hf-mcp-server",
    title: "Hugging Face",
    description:
      "Connect to Hugging Face Hub and thousands of Gradio AI Applications",
    url: "https://huggingface.co/mcp?login",
    transport: "http",
  },
  {
    name: "ai.exa/exa",
    title: "",
    description:
      "Fast, intelligent web search and web crawling.\n\nNew mcp tool: Exa-code is a context tool for coding",
    url: "https://mcp.exa.ai/mcp",
    transport: "http",
  },
  {
    name: "com.zapier/mcp",
    title: "Zapier",
    description:
      "Hosted MCP server connecting AI assistants to 9,000+ apps and 40,000+ actions via Zapier.",
    url: "https://mcp.zapier.com/api/v1/connect",
    transport: "http",
  },
  {
    name: "com.gitlab/mcp",
    title: "",
    description:
      "Official GitLab MCP Server",
    url: "https://gitlab.com/api/v4/mcp",
    transport: "http",
  },
  {
    name: "io.prisma/mcp",
    title: "",
    description:
      "MCP server for managing Prisma Postgres.",
    url: "https://mcp.prisma.io/mcp",
    transport: "http",
  },
  {
    name: "com.webflow/mcp",
    title: "",
    description:
      "AI-powered design and management for Webflow Sites",
    url: "https://mcp.webflow.com/mcp",
    transport: "http",
  },
  {
    name: "com.wix/mcp",
    title: "",
    description:
      "A Model Context Protocol server for Wix AI tools",
    url: "https://mcp.wix.com/mcp",
    transport: "http",
  },
  {
    name: "com.monday/monday.com",
    title: "",
    description:
      "MCP server for monday.com integration.",
    url: "https://mcp.monday.com/mcp",
    transport: "http",
  },
  {
    name: "com.paypal.mcp/mcp",
    title: "",
    description:
      "PayPal MCP server provides access to PayPal services and operations for AI assistants",
    url: "https://mcp.paypal.com/mcp",
    transport: "http",
  },
  {
    name: "ai.fireflies/fireflies",
    title: "Fireflies.ai",
    description:
      "Search and analyze meeting transcripts, summaries, soundbites and analytics from Fireflies.ai",
    url: "https://api.fireflies.ai/mcp",
    transport: "http",
  },
  {
    name: "com.egnyte/mcp-server",
    title: "Egnyte Remote MCP Server",
    description:
      "Egnyte's remote MCP server for secure AI access, search, upload and file management in your account.",
    url: "https://mcp-server.egnyte.com/mcp",
    transport: "http",
  },
  {
    name: "com.close/close-mcp",
    title: "",
    description:
      "Close CRM to manage your sales pipeline. Learn more at https://close.com or https://mcp.close.com",
    url: "https://mcp.close.com/mcp",
    transport: "http",
  },
];

/**
 * Categories, also curated: the registry has no taxonomy, and guessing
 * one from description text misfiles constantly, because descriptions
 * are vendor marketing copy. An unmapped server has no category and
 * appears only under "All", which is honest about what is known.
 */
export const CATALOG_CATEGORIES = [
  "Analytics",
  "Dev tools",
  "Data",
  "Design",
  "Docs",
  "Project",
  "Payments",
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

const CATEGORY_BY_NAME: Record<string, CatalogCategory> = {
  "io.github.PostHog/mcp": "Analytics",
  "com.cloudflare.mcp/mcp": "Dev tools",
  "com.vercel/vercel-mcp": "Dev tools",
  "com.gitlab/mcp": "Dev tools",
  "co.huggingface/hf-mcp-server": "Dev tools",
  "ai.exa/exa": "Dev tools",
  "com.zapier/mcp": "Dev tools",
  "com.supabase/mcp": "Data",
  "com.airtable/mcp": "Data",
  "io.prisma/mcp": "Data",
  "com.egnyte/mcp-server": "Data",
  "com.figma.mcp/mcp": "Design",
  "com.webflow/mcp": "Design",
  "com.wix/mcp": "Design",
  "com.notion/mcp": "Docs",
  "ai.fireflies/fireflies": "Docs",
  "app.linear/linear": "Project",
  "com.atlassian/atlassian-mcp-server": "Project",
  "com.monday/monday.com": "Project",
  "com.close/close-mcp": "Project",
  "com.stripe/mcp": "Payments",
  "com.paypal.mcp/mcp": "Payments",
};

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
  /** Host the icon is fetched from, proxied so the console calls nobody. */
  iconHost: string;
  /** On the curated list, so it leads the browse view. */
  featured: boolean;
  /** Curated category, or null when this server is not mapped. */
  category: CatalogCategory | null;
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

/**
 * Tails that name no vendor. Registry names are mostly "<vendor>/mcp",
 * so these fall back to the namespace for both the title and the slug.
 */
const GENERIC_TAILS = new Set(["mcp", "server", "mcp-server", "mcpserver", "api", "remote"]);

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

/**
 * The featured servers, built from the table above with no network at
 * all. This used to resolve each name against the registry, which put
 * twenty-two upstream requests on the browse view's cold path and made
 * the section only as reliable as the registry was that minute.
 */
export function featuredEntries(): CatalogEntry[] {
  return FEATURED.map((entry) => ({
    name: entry.name,
    title: displayTitle(entry.name, entry.title),
    description: entry.description,
    url: entry.url,
    transport: entry.transport,
    publisher: publisherOf(entry.name),
    iconHost: hostOf(entry.url),
    featured: true,
    category: CATEGORY_BY_NAME[entry.name] ?? null,
  }));
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
      title: displayTitle(server.name, server.title),
      description: (server.description ?? "").trim().slice(0, 300),
      url: remote.url,
      transport: remote.transport,
      publisher: publisherOf(server.name),
      iconHost: hostOf(remote.url),
      featured: FEATURED.some((entry) => entry.name === server.name),
      category: CATEGORY_BY_NAME[server.name] ?? null,
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
 * A name worth reading. Most registry entries carry no title, and the
 * raw reverse-DNS name ("com.notion/mcp") is not something to put in a
 * list, so the vendor is recovered from the name and capitalised.
 */
export function displayTitle(name: string, title?: string): string {
  const given = title?.trim();
  if (given) return given;
  const [namespace = "", tail = ""] = name.includes("/")
    ? [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)]
    : [name, ""];
  const word =
    GENERIC_TAILS.has(tail.toLowerCase()) || !tail ? vendorLabel(namespace) ?? name : stripTld(tail);
  const parts = word.split(/[-_.]/).filter(Boolean);
  // "vercel-mcp" is Vercel and "close-mcp" is Close: the suffix says
  // what it is, which every row here already is.
  while (parts.length > 1 && GENERIC_TAILS.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The publishing namespace, shown so an official server reads
 * differently from somebody's wrapper of it. Registry names are
 * reverse-DNS, so the part before the first slash is the publisher.
 */
/**
 * The vendor label in a reverse-DNS namespace, skipping generic tails.
 * `com.cloudflare.mcp` is Cloudflare, not "Mcp": taking the last label
 * blindly titled two different featured servers "Mcp".
 */
function vendorLabel(namespace: string): string | null {
  const labels = namespace.split(".").filter(Boolean);
  while (labels.length > 1 && GENERIC_TAILS.has(labels[labels.length - 1]!.toLowerCase())) {
    labels.pop();
  }
  return labels.pop() ?? null;
}

/** `monday.com` is Monday; the suffix is address, not name. */
function stripTld(tail: string): string {
  return tail.replace(/\.(com|io|ai|dev|app|sh|co|net|org)$/i, "");
}

function publisherOf(name: string): string {
  const namespace = name.split("/")[0] ?? name;
  return namespace.startsWith("io.github.") ? namespace.slice("io.github.".length) : namespace;
}

/**
 * The tool name agents see, from the same vendor rule as the title so
 * Notion, Linear, and Sentry do not all want the slug "mcp".
 */
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
