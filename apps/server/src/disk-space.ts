import { statfs } from "node:fs/promises";
import type { SandboxDriver } from "@bento/sandbox";

const GB = 1024 ** 3;

export interface DiskSpaceReading {
  hostFreeBytes: number | null;
  /** The sandboxes' own disk, when they run in a VM (OrbStack, Docker Desktop). */
  sandboxFreeBytes: number | null;
}

export interface DiskSpaceStatus extends DiskSpaceReading {
  thresholdBytes: number;
  low: boolean;
  /** What to tell a person, or null when there is room. */
  warning: string | null;
}

function gb(bytes: number): string {
  const value = bytes / GB;
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

export function diskSpaceStatus(reading: DiskSpaceReading, thresholdBytes: number): DiskSpaceStatus {
  const lows: string[] = [];
  if (thresholdBytes > 0) {
    if (reading.hostFreeBytes !== null && reading.hostFreeBytes < thresholdBytes) {
      lows.push(`this computer has ${gb(reading.hostFreeBytes)} GB free`);
    }
    if (reading.sandboxFreeBytes !== null && reading.sandboxFreeBytes < thresholdBytes) {
      lows.push(`the sandboxes' Docker disk has ${gb(reading.sandboxFreeBytes)} GB free`);
    }
  }
  const warning =
    lows.length === 0
      ? null
      : `Disk space is low: ${lows.join(", and ")}. ` +
        "When the disk fills, Docker (or OrbStack) stops, and every running agent stalls with it. " +
        `Free up space to keep at least ${gb(thresholdBytes)} GB available.`;
  return { ...reading, thresholdBytes, low: warning !== null, warning };
}

export interface DiskSpaceMonitor {
  /**
   * The latest reading, refreshed when older than the cache window.
   * Never waits longer than `waitMs` for a refresh: a slow probe answers
   * with the previous reading (or null) and finishes in the background.
   */
  check(): Promise<DiskSpaceStatus | null>;
}

export function createDiskSpaceMonitor(input: {
  hostPath: string;
  thresholdBytes: number;
  driver?: Pick<SandboxDriver, "freeDiskBytes">;
  cacheMs?: number;
  waitMs?: number;
  now?: () => number;
  hostFree?: (path: string) => Promise<number | null>;
}): DiskSpaceMonitor {
  const cacheMs = input.cacheMs ?? 60_000;
  const waitMs = input.waitMs ?? 2_000;
  const now = input.now ?? Date.now;
  const hostFree = input.hostFree ?? readHostFree;
  let last: { at: number; status: DiskSpaceStatus } | null = null;
  let inflight: Promise<DiskSpaceStatus> | null = null;

  const refresh = (): Promise<DiskSpaceStatus> => {
    inflight ??= (async () => {
      const [host, sandbox] = await Promise.all([
        hostFree(input.hostPath).catch(() => null),
        input.driver?.freeDiskBytes ? input.driver.freeDiskBytes().catch(() => null) : Promise.resolve(null),
      ]);
      const status = diskSpaceStatus({ hostFreeBytes: host, sandboxFreeBytes: sandbox }, input.thresholdBytes);
      last = { at: now(), status };
      return status;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async check() {
      if (input.thresholdBytes <= 0) return null;
      if (last && now() - last.at < cacheMs) return last.status;
      const pending = refresh();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
      const answer = await Promise.race([pending, timedOut]);
      clearTimeout(timer);
      return answer ?? last?.status ?? null;
    },
  };
}

async function readHostFree(path: string): Promise<number | null> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}
