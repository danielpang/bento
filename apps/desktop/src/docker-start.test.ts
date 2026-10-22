import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKER_NOT_INSTALLED_MESSAGE, ensureDockerRunning, type DockerStartDeps } from "./docker-start.js";

/** A Mac whose Docker answers after `answersAfter` pings, with these apps installed. */
function fakeMac(options: { installed: string[]; answersAfter: number; platform?: NodeJS.Platform; hangs?: number }) {
  let clock = 0;
  let pings = 0;
  const launched: string[] = [];
  const deps: DockerStartDeps = {
    ping: async () => {
      pings += 1;
      if (pings <= (options.hangs ?? 0)) return new Promise<void>(() => {});
      if (pings <= options.answersAfter) throw new Error("connect ENOENT");
    },
    exists: async (file) => options.installed.includes(file),
    launch: async (bundlePath) => { launched.push(bundlePath); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    pingTimeoutMs: 20,
    platform: options.platform ?? "darwin",
    applicationDirs: ["/Applications", "/Users/sam/Applications"],
  };
  return { deps, launched, pings: () => pings };
}

test("Docker that already answers is left alone", async () => {
  const mac = fakeMac({ installed: ["/Applications/OrbStack.app"], answersAfter: 0 });
  const progress: string[] = [];
  await ensureDockerRunning(mac.deps, (message) => progress.push(message), () => false);
  assert.deepEqual(mac.launched, []);
  assert.deepEqual(progress, []);
});

test("OrbStack is preferred over Docker Desktop and waited for", async () => {
  const mac = fakeMac({ installed: ["/Applications/Docker.app", "/Applications/OrbStack.app"], answersAfter: 3 });
  const progress: string[] = [];
  await ensureDockerRunning(mac.deps, (message) => progress.push(message), () => false);
  assert.deepEqual(mac.launched, ["/Applications/OrbStack.app"]);
  assert.deepEqual(progress, ["Starting OrbStack..."]);
  assert.equal(mac.pings(), 4);
});

test("a ping that never answers counts as no answer, and the next one is waited for", async () => {
  const mac = fakeMac({ installed: ["/Applications/OrbStack.app"], answersAfter: 2, hangs: 2 });
  const progress: string[] = [];
  await ensureDockerRunning(mac.deps, (message) => progress.push(message), () => false);
  assert.deepEqual(mac.launched, ["/Applications/OrbStack.app"]);
  assert.deepEqual(progress, ["Starting OrbStack..."]);
  assert.equal(mac.pings(), 3);
});

test("Docker Desktop is started when OrbStack is not installed, including from ~/Applications", async () => {
  const mac = fakeMac({ installed: ["/Users/sam/Applications/Docker.app"], answersAfter: 2 });
  const progress: string[] = [];
  await ensureDockerRunning(mac.deps, (message) => progress.push(message), () => false);
  assert.deepEqual(mac.launched, ["/Users/sam/Applications/Docker.app"]);
  assert.deepEqual(progress, ["Starting Docker Desktop..."]);
});

test("neither app installed asks for an install", async () => {
  const mac = fakeMac({ installed: [], answersAfter: Infinity });
  await assert.rejects(ensureDockerRunning(mac.deps, () => {}, () => false), { message: DOCKER_NOT_INSTALLED_MESSAGE });
  assert.deepEqual(mac.launched, []);
});

test("an app that never answers names itself", async () => {
  const mac = fakeMac({ installed: ["/Applications/OrbStack.app"], answersAfter: Infinity });
  await assert.rejects(ensureDockerRunning(mac.deps, () => {}, () => false), {
    message: "OrbStack did not start. Open it, then try again.",
  });
});

test("a cancelled start stops waiting", async () => {
  const mac = fakeMac({ installed: ["/Applications/OrbStack.app"], answersAfter: Infinity });
  await ensureDockerRunning(mac.deps, () => {}, () => true);
  assert.deepEqual(mac.launched, ["/Applications/OrbStack.app"]);
  assert.equal(mac.pings(), 1);
});

test("nothing is launched off macOS", async () => {
  const mac = fakeMac({ installed: ["/Applications/OrbStack.app"], answersAfter: Infinity, platform: "linux" });
  await assert.rejects(ensureDockerRunning(mac.deps, () => {}, () => false), { message: DOCKER_NOT_INSTALLED_MESSAGE });
  assert.deepEqual(mac.launched, []);
});
