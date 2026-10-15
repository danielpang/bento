import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiskSpaceMonitor, diskSpaceStatus } from "./disk-space.js";

const GB = 1024 ** 3;

test("no warning while both disks have the threshold free", () => {
  const status = diskSpaceStatus({ hostFreeBytes: 50 * GB, sandboxFreeBytes: 10 * GB }, 10 * GB);
  assert.equal(status.low, false);
  assert.equal(status.warning, null);
});

test("warns when the host is below the threshold", () => {
  const status = diskSpaceStatus({ hostFreeBytes: 1.5 * GB, sandboxFreeBytes: null }, 10 * GB);
  assert.equal(status.low, true);
  assert.match(status.warning!, /this computer has 1\.5 GB free/);
  assert.match(status.warning!, /every running agent stalls/);
  assert.doesNotMatch(status.warning!, /[–—]/);
});

test("names both disks when both are low", () => {
  const status = diskSpaceStatus({ hostFreeBytes: 2 * GB, sandboxFreeBytes: 3 * GB }, 10 * GB);
  assert.match(status.warning!, /this computer has 2\.0 GB free, and the sandboxes' Docker disk has 3\.0 GB free/);
});

test("a zero threshold never warns", () => {
  assert.equal(diskSpaceStatus({ hostFreeBytes: 0, sandboxFreeBytes: 0 }, 0).warning, null);
});

test("unknown readings never warn", () => {
  assert.equal(diskSpaceStatus({ hostFreeBytes: null, sandboxFreeBytes: null }, 10 * GB).warning, null);
});

test("the monitor caches a reading for its window", async () => {
  let clock = 0;
  let probes = 0;
  const monitor = createDiskSpaceMonitor({
    hostPath: "/",
    thresholdBytes: 10 * GB,
    cacheMs: 60_000,
    now: () => clock,
    hostFree: async () => {
      probes += 1;
      return 1 * GB;
    },
  });
  assert.equal((await monitor.check())?.low, true);
  clock = 30_000;
  await monitor.check();
  assert.equal(probes, 1);
  clock = 61_000;
  await monitor.check();
  assert.equal(probes, 2);
});

test("a slow probe does not hold up the caller", async () => {
  let release: (bytes: number) => void = () => {};
  const monitor = createDiskSpaceMonitor({
    hostPath: "/",
    thresholdBytes: 10 * GB,
    waitMs: 10,
    hostFree: () => new Promise<number>((resolve) => (release = resolve)),
  });
  assert.equal(await monitor.check(), null);
  release(1 * GB);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await monitor.check())?.low, true);
});

test("a failing probe reads as unknown, not low", async () => {
  const monitor = createDiskSpaceMonitor({
    hostPath: "/",
    thresholdBytes: 10 * GB,
    hostFree: async () => {
      throw new Error("statfs failed");
    },
    driver: { freeDiskBytes: async () => null },
  });
  assert.equal((await monitor.check())?.warning, null);
});
