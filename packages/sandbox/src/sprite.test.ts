import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SpriteCommand, type Sprite } from "@fly/sprites";
import { LineChannel, collectExec } from "./driver.js";
import { SpriteDriver, spriteName } from "./sprite.js";

/**
 * A sprite lives until something deletes it, and the e2e test's own
 * cleanup cannot run when its job is cancelled or times out. The
 * workflow deletes the machine afterwards for those cases, which means
 * it has to name it, which means two places now derive one name.
 *
 * Pinned here rather than discovered by a bill: this test runs in
 * ordinary CI, and the e2e it guards runs nightly.
 */
test("the sandbox e2e workflow deletes the sprite that test creates", async () => {
  const workflow = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/sandbox-e2e.yml"),
    "utf8",
  );
  const e2e = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "sprite.e2e.test.ts"),
    "utf8",
  );

  // The name the workflow's cleanup step deletes, built the one way
  // the driver builds names.
  const cleaned = spriteName("e2e-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.ok(
    workflow.includes(cleaned),
    `the workflow does not delete ${cleaned}, so a cancelled run would leak its sprite`,
  );
  // And the same two halves on the test's side.
  for (const variable of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    assert.match(e2e, new RegExp(variable), `the e2e test no longer names its sprite after ${variable}`);
  }

  // The cleanup step has to point at a script that is really there.
  // It runs on a schedule, so a path that stopped resolving would go
  // unnoticed until a sprite was left running.
  const invoked = workflow.match(/scripts\/[\w.-]+\.ts/)?.[0];
  assert.ok(invoked, "the workflow no longer runs a cleanup script");
  await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", invoked), "utf8");
});

/** Lets pending microtasks and immediates run, twice over for chains. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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

/**
 * A CLI whose installer was unreachable used to be silent: the sandbox
 * was handed back as ready, and the run that needed it died at spawn
 * with the runtime's own "executable file `opencode` not found in
 * $PATH". Provisioning writes into the run's transcript, so the missing
 * tool is said there instead, while the sandbox stays usable for the
 * agents that did install.
 */
test("Sprite provisioning says which agent CLI could not be installed", async () => {
  const messages: string[] = [];
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        // The probe answers first; the toolchain script reports what it
        // could not put on the PATH.
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-absent\n");
        else child.stdout.write("bento-toolchain-missing: opencode \n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          return [];
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const handle = await driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
    onProgress: (message) => {
      messages.push(message);
    },
  });

  assert.equal(handle.provider, "sprite");
  const said = messages.find((message) => message.includes("Could not install"));
  assert.ok(said, `no message named the missing CLI: ${messages.join(" | ")}`);
  assert.match(said, /opencode/);
  // No dashes in user-facing copy.
  assert.doesNotMatch(said, /[—–]|\s-\s/);
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
 * forever. See feedStdin.
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
 * Sprites run commands as root, and Claude Code refuses
 * --dangerously-skip-permissions as root unless IS_SANDBOX says the
 * sandbox is the security boundary. The Docker driver learned this
 * when every claude-code run died at exit 1 with no output; this pins
 * the same guarantee here.
 */
test("Sprite exec marks the sandbox as the security boundary for agent CLIs", async () => {
  let seenEnv: Record<string, string> | undefined;
  const child = fakeChild();
  const sprite = {
    spawn(_file: string, _args: string[], options?: { env?: Record<string, string> }) {
      seenEnv = options?.env;
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"], {
      env: { ANTHROPIC_API_KEY: "key" },
    }),
  );
  assert.equal(seenEnv?.IS_SANDBOX, "1");
  assert.equal(seenEnv?.ANTHROPIC_API_KEY, "key");
});

/**
 * The live session: lines written while the agent runs flow to its
 * stdin as user messages, and the channel ending is how the agent
 * learns the conversation is over. Same contract as the Docker driver,
 * which is what makes mid-run messages reach a sprite agent instead of
 * parking until the run ends.
 */
test("Sprite exec feeds live stdin lines and closes stdin when the conversation ends", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);
  assert.equal(driver.supportsStdin, true);

  const channel = new LineChannel();
  channel.write('{"type":"user"}');
  const iterator = driver
    .exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"], { stdin: channel })
    [Symbol.asyncIterator]();
  const first = iterator.next();
  await settle();

  const written: string[] = [];
  child.stdin.on("data", (d: Buffer | string) => written.push(d.toString()));
  child.emit("spawn");
  await settle();
  assert.deepEqual(written, ['{"type":"user"}\n']);
  // The conversation is still open, so stdin must be too.
  assert.equal(child.stdin.writableEnded, false);

  channel.write("follow-up");
  await settle();
  assert.deepEqual(written, ['{"type":"user"}\n', "follow-up\n"]);

  channel.end();
  await settle();
  assert.equal(child.stdin.writableEnded, true);

  child.emit("exit", 0);
  const chunk = await first;
  assert.deepEqual(chunk.value, { kind: "exit", exitCode: 0 });
  await iterator.return?.(undefined);
});

/**
 * The SDK appends the exec URL to its connection errors, and that URL
 * carries the whole environment as query parameters, credentials
 * included. Error text ends up in run transcripts, so the URL must
 * not survive into the stream.
 */
test("Sprite exec keeps the credential-bearing exec URL out of error output", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      queueMicrotask(() => {
        child.emit(
          "error",
          new Error(
            "WebSocket error: connect ETIMEDOUT (url: wss://api.sprites.dev/v1/sprites/x/exec?env=ANTHROPIC_API_KEY%3Dsk-secret&cmd=claude)",
          ),
        );
      });
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /ETIMEDOUT/);
  assert.match(result.stderr, /\[sandbox exec url\]/);
  assert.doesNotMatch(result.stderr, /sk-secret|wss:/);
});

/**
 * A real process exit arrives as an unsigned byte, so a negative code
 * always means the socket closed without one. Without the explanation
 * the run reads as the agent failing with "exit code -1" when the
 * agent was never heard from at all.
 */
test("Sprite exec explains a connection that closed without an exit", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      queueMicrotask(() => child.emit("exit", -1));
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /connection to the sandbox closed before the command reported an exit/);
});

/**
 * The other half of feedStdin's contract lives in the SDK: ending the
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

/** Same pin for the live half: written lines must reach writeStdin. */
test("the installed SDK still forwards stdin writes to the socket", async () => {
  const sprite = {
    name: "pin",
    client: { token: "token", baseURL: "https://example.invalid" },
  } as unknown as Sprite;
  const command = new SpriteCommand(sprite, "true");
  const ws = (command as unknown as { wsCmd?: { writeStdin?: unknown } }).wsCmd;
  assert.equal(typeof ws?.writeStdin, "function");
  const written: string[] = [];
  (ws as { writeStdin: (data: Buffer) => void }).writeStdin = (data) => {
    written.push(data.toString());
  };
  command.stdin.write("a user message\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["a user message\n"]);
});

/**
 * defuseKeepalive removes the SDK's only detector of a half open
 * socket, so runScript must carry its own deadline: without one, a
 * provisioning script whose connection died silently never settled,
 * and the run held its worker slot until a server restart.
 */
test("Sprite provisioning gives up on a script whose connection went silent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
  };
  const sprite = {
    spawn() {
      return child;
    },
    filesystem() {
      return {};
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const provisioning = driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
  });
  const outcome = provisioning.then(
    () => "resolved",
    (err: Error) => err,
  );
  // Past the deadline with no exit, no error, and no data.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(21 * 60_000);
  const result = await outcome;
  assert.ok(result instanceof Error, "provisioning must fail rather than hang");
  assert.match(result.message, /did not finish within/);
  assert.ok(killed, "the stuck process was told to stop");
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
