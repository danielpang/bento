import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";

/**
 * Server-side fetch of a tenant-chosen URL.
 *
 * MCP servers are the first place Bento's server fetches an address an
 * organization admin typed in. Every other integration talks to a fixed
 * vendor host, so nothing else guards against a URL like
 * http://169.254.169.254/ or a hostname that resolves to this machine.
 * All MCP traffic (the api-key validation ping, OAuth discovery and
 * token exchange, and the run gateway) must go through this function.
 *
 * In multi mode: https only, no redirects, no address that is not
 * globally routable, and never our own host. The connection is pinned
 * to the addresses that were checked, so a DNS answer cannot change
 * between validation and connect. Local mode is one trusted user
 * configuring their own machine, so only the scheme is constrained.
 */

export class SafeFetchRefused extends Error {}

export interface SafeFetchPolicy {
  mode: "local" | "multi";
  /** Hostnames never fetched in multi mode: our own public host. */
  ownHosts: string[];
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Time allowed for the upstream to answer with headers. */
  headersTimeoutMs?: number;
}

export function safeFetchPolicy(env: { BENTO_MODE: "local" | "multi"; BETTER_AUTH_URL: string }): SafeFetchPolicy {
  const ownHosts: string[] = [];
  try {
    ownHosts.push(new URL(env.BETTER_AUTH_URL).hostname.toLowerCase());
  } catch {
    // An unparseable BETTER_AUTH_URL fails loudly elsewhere; refusing
    // nothing extra here is fine because multi mode still blocks
    // loopback by address.
  }
  return { mode: env.BENTO_MODE, ownHosts };
}

export async function safeFetch(
  url: string,
  init: SafeFetchInit,
  policy: SafeFetchPolicy,
): Promise<UndiciResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeFetchRefused("not a valid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SafeFetchRefused("only http(s) URLs can be fetched");
  }
  if (policy.mode === "multi" && parsed.protocol !== "https:") {
    throw new SafeFetchRefused("MCP servers must use https");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let dispatcher: Agent | undefined;
  if (policy.mode === "multi") {
    if (policy.ownHosts.includes(hostname)) {
      throw new SafeFetchRefused("this server cannot point at Bento itself");
    }
    const addresses = await resolveAll(hostname);
    // Every address must be public. A round-robin answer that mixes a
    // public address with a private one is exactly the rebinding shape
    // this exists to refuse.
    for (const address of addresses) {
      if (!isPublicAddress(address)) {
        throw new SafeFetchRefused("this host resolves to a private address");
      }
    }
    dispatcher = pinnedAgent(addresses, init.headersTimeoutMs);
  } else if (init.headersTimeoutMs) {
    dispatcher = new Agent({ headersTimeout: init.headersTimeoutMs });
  }

  try {
    const response = await undiciFetch(parsed, {
      method: init.method ?? "GET",
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      // A redirect would escape the address we just validated. MCP
      // JSON-RPC has no legitimate need for one, so refuse rather than
      // re-validate hop by hop.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => {});
      throw new SafeFetchRefused("this server answered with a redirect, which is not followed");
    }
    return response;
  } finally {
    // Connections drain in the background; close after the body is
    // consumed without holding the request open.
    if (dispatcher) queueMicrotask(() => void dispatcher.close().catch(() => {}));
  }
}

async function resolveAll(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    const addresses = answers.map((a) => a.address);
    if (!addresses.length) throw new Error("empty answer");
    return addresses;
  } catch {
    throw new SafeFetchRefused("this host does not resolve");
  }
}

/** Connects only to the already-validated addresses, never a fresh lookup. */
function pinnedAgent(addresses: string[], headersTimeoutMs?: number): Agent {
  return new Agent({
    ...(headersTimeoutMs !== undefined ? { headersTimeout: headersTimeoutMs } : {}),
    connect: {
      lookup: (_hostname, options, callback) => {
        const all = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) {
          callback(null, all);
        } else {
          callback(null, all[0]!.address, all[0]!.family);
        }
      },
    },
  });
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicV4(ip);
  if (family === 6) return isPublicV6(ip);
  return false;
}

function isPublicV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && parts[1] === 0 && parts[2] === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(ip: string): boolean {
  // Judged from the 16 bytes, not the text: the URL parser normalizes
  // an IPv4-mapped address like ::ffff:169.254.169.254 to its hex form
  // ::ffff:a9fe:a9fe, so a textual "::ffff:d.d.d.d" match would never
  // fire and the metadata address would slip through.
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return false;

  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  const embeddedV4 = () => `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  // ::ffff:0:0/96 IPv4-mapped: judge by the embedded IPv4.
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) return isPublicV4(embeddedV4());
  // ::/96 IPv4-compatible (deprecated), excluding :: and ::1.
  if (first10Zero && bytes[10] === 0 && bytes[11] === 0) {
    if (bytes.every((b) => b === 0)) return false; // ::
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false; // ::1
    return isPublicV4(embeddedV4());
  }
  // 64:ff9b::/96 NAT64: judge by the embedded IPv4.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0)) {
    return isPublicV4(embeddedV4());
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (bytes[0] === 0xff) return false; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // 2001:db8::/32
  return true;
}

/** Expands any textual IPv6 (including an embedded dotted IPv4) to 16 bytes. */
export function ipv6ToBytes(ip: string): Uint8Array | null {
  let str = ip.split("%")[0]!; // drop any zone id
  // Fold a trailing dotted IPv4 into two hextets.
  const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(str);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hex = `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
    str = str.slice(0, str.length - v4[1]!.length) + hex;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i]!)) return null;
    const v = parseInt(groups[i]!, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}
