import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SpriteCommand, type Sprite } from "@fly/sprites";
import { SpriteDriver } from "./sprite.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): void;
  wsCmd?: { resetKeepalive: () => void };
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
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
 * The SDK opens stdin for every exec and holds it open until this side
 * ends the stream, and an agent CLI reads a piped stdin to EOF before
 * it starts. A run whose stdin never closed produced no output at all,
 * forever. See closeStdin.
 */
test("Sprite exec ends the process's stdin once the command is up", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const iterator = driver
    .exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["opencode"])
    [Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));

  // Not before the connection is open: an EOF sent while the socket is
  // still connecting is dropped, and the agent waits forever anyway.
  assert.equal(child.stdin.writableEnded, false);
  child.emit("spawn");
  assert.equal(child.stdin.writableEnded, true);

  child.emit("exit", 0);
  const chunk = await first;
  assert.deepEqual(chunk.value, { kind: "exit", exitCode: 0 });
  await iterator.return?.(undefined);
});

/**
 * The other half of closeStdin's contract lives in the SDK: ending the
 * stdin stream must translate into the end-of-input frame the server
 * waits for. This pins that wiring against the installed package, so
 * an SDK change that drops it fails here instead of silently reviving
 * the hang.
 */
test("the installed SDK still sends stdin end-of-input when the stream ends", async () => {
  const sprite = {
    name: "pin",
    client: { token: "token", baseURL: "https://example.invalid" },
  } as unknown as Sprite;
  const command = new SpriteCommand(sprite, "true");
  const ws = (command as unknown as { wsCmd?: { sendStdinEOF?: unknown } }).wsCmd;
  assert.equal(typeof ws?.sendStdinEOF, "function");
  let sent = 0;
  (ws as { sendStdinEOF: () => void }).sendStdinEOF = () => {
    sent += 1;
  };
  command.stdin.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, 1);
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
