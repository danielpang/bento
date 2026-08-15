import pg from "pg";
import type { AgentEvent } from "@bento/core";
import type { BusWirePayload, EventBus } from "./events.js";

const CHANNEL = "bento_bus";

/**
 * NOTIFY rejects payloads near 8000 bytes. Only deltas can grow past
 * that (a huge pasted fragment), and a delta is loss-tolerant by
 * contract: the persisted message follows, and the client's offset
 * check tears down a draft with a hole in it rather than rendering
 * it. So an oversized delta is dropped, not split.
 */
const MAX_PAYLOAD_BYTES = 7500;

export interface PgBusOptions {
  bus: EventBus;
  /** For publishing; short queries, a connection is never held. */
  pool: pg.Pool;
  /** For the dedicated LISTEN connection. */
  connectionString: string;
  /**
   * Resolves a replicated run event's payload from run_events. The
   * row is persisted before the emit that produced the notification,
   * so a miss means the run was deleted in between, and the event is
   * dropped with it.
   */
  loadRunEvent: (runId: string, seq: number) => Promise<AgentEvent | null>;
}

export interface PgBus {
  stop(): Promise<void>;
}

/**
 * Replicates the in-process EventBus across server processes with
 * Postgres LISTEN/NOTIFY, so an SSE viewer on one machine sees a run
 * executing on another. Durability comes from run_events, not from
 * here: notifications carry coordinates for persisted events and the
 * payload itself only for ephemeral, loss-tolerant ones.
 *
 * Each process tags what it publishes with a boot-scoped origin id
 * and drops its own notifications on receipt (local delivery already
 * happened at emit), which also makes republication loops impossible.
 */
export async function attachPgBus(options: PgBusOptions): Promise<PgBus> {
  const { bus, pool, connectionString, loadRunEvent } = options;
  const origin = crypto.randomUUID();
  let stopped = false;
  let client: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /**
   * Notifications are handled strictly in arrival order. Dispatch is
   * async (a run_event fetches its payload), and two fetches racing
   * can resolve out of order; the stream's seq guard would then
   * discard the earlier event as stale and the viewer would lose it
   * until a resync that only fires on connection loss.
   */
  let dispatchChain: Promise<void> = Promise.resolve();

  bus.setPublisher((payload: BusWirePayload) => {
    const body = JSON.stringify({ origin, ...payload });
    // Bytes, not code units: NOTIFY's limit is a byte count, and a
    // multibyte delta can double its length on the wire.
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
      if (payload.kind === "run_delta") return;
      // Nothing else should ever get here: run events travel as
      // coordinates and the rest is small by construction.
      console.error(`pg bus: dropping oversized ${payload.kind} notification (${body.length} bytes)`);
      return;
    }
    // Fire and forget: the emit paths have already persisted their
    // event and must not fail after the fact. A lost notification
    // degrades to the pre-replication behaviour for remote viewers,
    // and the resync on reconnect is the recovery for outages.
    pool.query("select pg_notify($1, $2)", [CHANNEL, body]).catch((err) => {
      console.error("pg bus: publish failed:", err);
    });
  });

  const dispatch = async (raw: string): Promise<void> => {
    let message: { origin: string } & BusWirePayload;
    try {
      message = JSON.parse(raw);
    } catch {
      console.error("pg bus: ignoring unparseable notification");
      return;
    }
    if (message.origin === origin) return;
    switch (message.kind) {
      case "run_event": {
        // Skip the fetch when nobody here is watching the run.
        if (!bus.hasRunEventListeners(message.runId)) return;
        const event = await loadRunEvent(message.runId, message.seq);
        if (event) bus.deliverRunEvent({ runId: message.runId, seq: message.seq, event });
        return;
      }
      case "run_delta":
        // Delivered even with no listener: the draft bookkeeping is
        // what serves a viewer who subscribes here mid message.
        bus.deliverRunDelta(message.runId, message.delta);
        return;
      case "run_done":
        bus.deliverRunDone(message.runId, message.status);
        return;
      case "board":
        bus.deliverBoardEvent(message.event);
        return;
    }
  };

  const connect = async (attempt: number): Promise<void> => {
    if (stopped) return;
    const next = new pg.Client({ connectionString });
    try {
      await next.connect();
      await next.query(`listen ${CHANNEL}`);
    } catch (err) {
      await next.end().catch(() => {});
      throw err;
    }
    client = next;
    next.on("notification", (msg) => {
      if (msg.payload === undefined) return;
      const raw = msg.payload;
      dispatchChain = dispatchChain
        .then(() => dispatch(raw))
        .catch((err) => {
          console.error("pg bus: dispatch failed:", err);
        });
    });
    // A dead LISTEN connection makes this process deaf, not fine:
    // reconnect, and then tell local streams to re-query what they
    // may have missed while the ear was down.
    const onLost = (err?: Error) => {
      if (err) console.error("pg bus: listen connection lost:", err.message);
      next.removeAllListeners();
      void next.end().catch(() => {});
      if (client === next) client = null;
      scheduleReconnect();
    };
    next.once("error", onLost);
    next.once("end", () => onLost());
    if (attempt > 0) bus.emitResync();
  };

  const scheduleReconnect = (attempt = 1): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(attempt).catch((err) => {
        console.error("pg bus: reconnect failed:", err);
        scheduleReconnect(attempt + 1);
      });
    }, delay);
  };

  // The first connect is awaited so a boot with an unreachable
  // database fails loudly instead of serving deaf.
  await connect(0);

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const current = client;
      client = null;
      if (current) {
        current.removeAllListeners();
        await current.end().catch(() => {});
      }
    },
  };
}
