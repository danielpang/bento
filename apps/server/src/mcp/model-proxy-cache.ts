import type { ResolvedGrant } from "./grants.js";

/**
 * The model proxy's per-process memory of a token: the grant it
 * resolved to, and the keys (and saved base URLs) it decrypted for it,
 * so a run's model calls after the first cost no database read and no
 * decryption.
 *
 * Nothing here outlives the TTL (five minutes) or the grant's own
 * expiry, whichever is sooner: an entry is deleted by a timer when it
 * lapses, decrypted keys with it, whether or not it is asked for again.
 * Inside that window an entry ends early on any of:
 *
 * - its run leaving the active statuses, or its grant row changing
 *   (revoked, re-minted, stamped or cleared, extended, deleted): the
 *   database announces both on the bus (migration 0068, pg-bus.ts) to
 *   every process, and `evictRun` drops every token of that run;
 * - the bus's LISTEN connection dropping and coming back (`clear`),
 *   since announcements may have been missed while it was down;
 * - the provider refusing the key (the proxy drops that provider's
 *   credentials), so a key rotated mid-run is read again at once.
 *
 * Keyed by the token's hash, never the token. A read of the database
 * that raced an eviction is not cached: `generation` moves on every
 * eviction, and a result read under an older generation serves its own
 * request and is then forgotten, so a run cancelled while its grant was
 * being read cannot be cached as live.
 */

export const MODEL_PROXY_CACHE_TTL_MS = 5 * 60_000;
/** A bound on memory, far above the runs one process serves at once. */
const MAX_ENTRIES = 5_000;

export interface ProviderCredentials {
  key: string;
  /** The base URL the organization saved for this provider, when the grant names it. */
  savedBase: string | null;
}

export interface CachedGrant {
  grant: ResolvedGrant;
  /** Decrypted per provider key, filled as the run first calls each provider. */
  credentials: Map<string, ProviderCredentials>;
}

interface Entry extends CachedGrant {
  tokenHash: string;
  /** When this entry lapses: the TTL or the grant's expiry, whichever is sooner. */
  lapsesAt: number;
  timer: NodeJS.Timeout;
}

export class ModelProxyCache {
  private byToken = new Map<string, Entry>();
  private byRun = new Map<string, Set<string>>();
  private evictions = 0;

  constructor(private readonly ttlMs = MODEL_PROXY_CACHE_TTL_MS) {}

  /** Moves on every eviction; read before a database lookup, passed to `put`. */
  get generation(): number {
    return this.evictions;
  }

  get size(): number {
    return this.byToken.size;
  }

  get(tokenHash: string): CachedGrant | undefined {
    const entry = this.byToken.get(tokenHash);
    if (!entry) return undefined;
    // The timer is the rule; this covers a timer that has not fired yet.
    if (entry.lapsesAt <= Date.now()) {
      this.drop(tokenHash);
      return undefined;
    }
    return entry;
  }

  /**
   * Remembers a grant resolved under `generation`. Returns the cached
   * entry, or a private one when an eviction happened since (the
   * caller serves its request from it either way).
   */
  put(tokenHash: string, grant: ResolvedGrant, generation: number): CachedGrant {
    if (generation !== this.evictions) return { grant, credentials: new Map() };
    this.drop(tokenHash);
    const lifetime = Math.min(this.ttlMs, grant.expiresAt.getTime() - Date.now());
    if (lifetime <= 0) return { grant, credentials: new Map() };
    if (this.byToken.size >= MAX_ENTRIES) {
      const oldest = this.byToken.keys().next().value;
      if (oldest !== undefined) this.drop(oldest);
    }
    const timer = setTimeout(() => this.drop(tokenHash), lifetime);
    timer.unref?.();
    const entry: Entry = { tokenHash, grant, credentials: new Map(), lapsesAt: Date.now() + lifetime, timer };
    this.byToken.set(tokenHash, entry);
    let tokens = this.byRun.get(grant.runId);
    if (!tokens) this.byRun.set(grant.runId, (tokens = new Set()));
    tokens.add(tokenHash);
    return entry;
  }

  /** Stores decrypted credentials on an entry, unless an eviction happened since `generation`. */
  putCredentials(entry: CachedGrant, providerKey: string, credentials: ProviderCredentials, generation: number): void {
    if (generation !== this.evictions) return;
    entry.credentials.set(providerKey, credentials);
  }

  /** Every token of a run: its grant changed, or the run ended. */
  evictRun(runId: string): void {
    this.evictions += 1;
    const tokens = this.byRun.get(runId);
    if (!tokens) return;
    for (const tokenHash of [...tokens]) this.drop(tokenHash);
  }

  clear(): void {
    this.evictions += 1;
    for (const tokenHash of [...this.byToken.keys()]) this.drop(tokenHash);
  }

  private drop(tokenHash: string): void {
    const entry = this.byToken.get(tokenHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.credentials.clear();
    this.byToken.delete(tokenHash);
    const tokens = this.byRun.get(entry.grant.runId);
    tokens?.delete(tokenHash);
    if (tokens && tokens.size === 0) this.byRun.delete(entry.grant.runId);
  }
}
