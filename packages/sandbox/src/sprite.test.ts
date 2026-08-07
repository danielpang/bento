import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SpriteCommand, type Sprite } from "@fly/sprites";
import { SpriteDriver } from "./sprite.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): void;
  wsCmd?: { resetKeepalive: () => void };
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

function stubClient(driver: SpriteDriver, sprite: unknown): void {
  (driver as unknown as { client: { getSprite(name: string): Promise<unknown> } }).client = {
    async getSprite() {
      return sprite;
    },
  };
}

test("Sprite provisioning transfers a credential-free repository bundle", async () => {
  const writes: { path: string; data: Buffer }[] = [];
  const scripts: string[] = [];
  const removed: string[] = [];
  const messages: string[] = [];
  const sprite = {
    // Recording argv rather than a bare script is the point of this
    // stub. Provisioning runs shell scripts, and the SDK's exec() is
    // not a shell: it splits on whitespace and execs the first word.
    // A stub that accepted a script string agreed with the old code
    // while every provision failed on `set: not found`.
    spawn(file: string, args: string[]) {
      assert.equal(file, "sh");
      assert.equal(args[0], "-c");
      scripts.push(args[1] ?? "");
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async writeFile(path: string, data: Buffer) {
          writes.push({ path, data });
        },
        async rm(path: string) {
          removed.push(path);
        },
        async readdir() {
          return [
            { name: "api", isDirectory: () => true },
            { name: "removed-repository", isDirectory: () => true },
          ];
        },
        async exists(path: string) {
          return path === "/workspace/removed-repository/.git";
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  stubClient(driver, sprite);

  await driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
    repositories: [{
      name: "api",
      cloneUrl: "https://github.com/acme/api.git",
      branch: "feature/work",
      baseBranch: "main",
      seedBundle: Buffer.from("git bundle"),
    }],
    onProgress: (message) => {
      messages.push(message);
    },
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.data, Buffer.from("git bundle"));
  const commands = scripts.join("\n");
  assert.match(commands, /git clone '\/tmp\/bento-seed-api\.bundle'/);
  assert.doesNotMatch(commands, /sprite-control-token/);
  assert.doesNotMatch(commands, /x-access-token|password=/);
  assert.ok(removed.includes("/workspace/removed-repository"));

  // The transcript's picture of provisioning: sandbox, tools, repos.
  assert.ok(messages.some((m) => m.includes("cloud sandbox")));
  assert.ok(messages.some((m) => m.includes("Installing the agent tools")));
  assert.ok(messages.includes("Repository api is ready on branch feature/work."));
});

test("Sprite provisioning failures carry the script's stderr on the error", async () => {
  const sprite = {
    spawn() {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stderr.write("bento: claude code install failed");
        child.stderr.end();
        child.stdout.end();
        child.emit("exit", 1);
      });
      return child;
    },
    filesystem() {
      return {};
    },
  };
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" }),
    (err: Error & { stderr?: string }) => {
      assert.match(err.message, /exit code 1/);
      assert.match(err.stderr ?? "", /claude code install failed/);
      return true;
    },
  );
});

/**
 * The SDK's WSCommand declares a connection dead after 45 seconds
 * without an incoming message, and a coding agent inside a long tool
 * call is exactly that quiet. The driver resets the clock from outside
 * so only real socket failures end a run. See defuseKeepalive.
 */
test("Sprite exec keeps resetting the SDK inactivity clock while the agent is quiet", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let resets = 0;
  const child = fakeChild();
  child.wsCmd = {
    resetKeepalive() {
      resets += 1;
    },
  };
  const sprite = {
    spawn() {
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const iterator = driver
    .exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["pi"])
    [Symbol.asyncIterator]();
  const first = iterator.next();
  // Let the generator get past its awaits and start its interval.
  await new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.tick(60_000);
  assert.ok(resets >= 5, `expected the clock to be reset through a minute of silence, saw ${resets}`);

  child.emit("exit", 0);
  const chunk = await first;
  assert.deepEqual(chunk.value, { kind: "exit", exitCode: 0 });
  await iterator.return?.(undefined);

  // The guard dies with the stream: no timer may outlive the run.
  const after = resets;
  t.mock.timers.tick(60_000);
  assert.equal(resets, after);
});

/**
 * The clock lives on private SDK internals (SpriteCommand.wsCmd and
 * WSCommand.resetKeepalive), reached by duck type. This pins those
 * names against the installed package, so an SDK upgrade that renames
 * either fails here instead of silently reviving the 45 second
 * timeout.
 */
test("the installed SDK still exposes the inactivity clock the driver resets", () => {
  const sprite = {
    name: "pin",
    client: { token: "token", baseURL: "https://example.invalid" },
  } as unknown as Sprite;
  // Constructing a SpriteCommand builds its WSCommand without opening
  // a connection; nothing here touches the network.
  const command = new SpriteCommand(sprite, "true");
  const ws = (command as unknown as { wsCmd?: { resetKeepalive?: unknown } }).wsCmd;
  assert.equal(typeof ws?.resetKeepalive, "function");
  (ws as { resetKeepalive: () => void }).resetKeepalive();
});

test("Sprite repository export returns committed objects without credentials", async () => {
  const bundle = Buffer.from("bundle bytes");
  const sprite = {
    spawn() {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(`base-sha\nhead-sha\n${bundle.toString("base64")}\n`);
        child.stdout.end();
        child.emit("exit", 0);
      });
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  stubClient(driver, sprite);

  const exported = await driver.exportRepository(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    "api",
    "main",
  );
  assert.equal(exported?.baseSha, "base-sha");
  assert.equal(exported?.headSha, "head-sha");
  assert.deepEqual(exported?.data, bundle);
});
