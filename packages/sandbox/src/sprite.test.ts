import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Sprite as SpriteClass, SpriteCommand, type Sprite } from "@fly/sprites";
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
    // Nothing to reattach to: the command never started.
    async listSessions() {
      return [];
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
 * always means the socket closed without one. When the sandbox answers
 * and the session is not there, the process is genuinely gone, and the
 * run must fail with the explanation rather than hang or retry.
 */
test("Sprite exec explains a connection that closed without an exit", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      queueMicrotask(() => child.emit("exit", -1));
      return child;
    },
    async listSessions() {
      return [];
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
 * The failure this section exists for: a WebSocket blip half an hour
 * into an agent run used to end it with "stopped before reporting a
 * result (exit code -1)" while the agent inside the sprite worked on,
 * mid task. The socket is not the process. A close without an exit now
 * finds the surviving session and picks the stream back up, and the
 * run's consumer never sees a failure.
 */
test("Sprite exec reattaches to the running command when the connection drops", async () => {
  const child1 = fakeChild();
  const child2 = fakeChild();
  const spawns: { file: string; args: string[]; options?: Record<string, unknown> }[] = [];
  const sprite = {
    spawn(file: string, args: string[], options?: Record<string, unknown>) {
      spawns.push({ file, args, ...(options ? { options } : {}) });
      return spawns.length === 1 ? child1 : child2;
    },
    async listSessions() {
      return [
        {
          id: "sess-1",
          // The full command line, prompt included, as the server
          // reports it.
          command: "claude -p do the task",
          workdir: "/workspace",
          created: new Date(0),
          bytesPerSecond: 0,
          isActive: false,
          tty: false,
        },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const collected = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude", "-p", "do the task"]),
  );
  await settle();
  child1.emit("spawn");
  child1.stdout.write('{"type":"assistant"}\n');
  await settle();
  child1.emit("exit", -1); // the socket dropped, no exit frame arrived

  for (let i = 0; i < 50 && spawns.length < 2; i++) await settle();
  assert.equal(spawns.length, 2, "the driver should have attached to the surviving session");
  child2.emit("spawn");
  await settle();
  child2.stdout.write('{"type":"result"}\n');
  child2.emit("exit", 0);

  const result = await collected;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /assistant/);
  assert.match(result.stdout, /result/);
  assert.match(result.stderr, /reattached to the running command/);
  assert.doesNotMatch(result.stderr, /closed before the command reported an exit/);
  // The first spawn asks the server to keep the process alive across a
  // disconnect; the second names the session instead of a command.
  assert.equal(spawns[0]?.options?.maxRunAfterDisconnect, "10m");
  assert.equal(spawns[1]?.options?.sessionId, "sess-1");
});

/**
 * A stop is the one disconnect that must not reattach: the user asked
 * for the process to end, and following it back would resurrect the
 * run they cancelled. The stop itself is also delivered over HTTP,
 * because the WebSocket kill dies with the socket it rides on.
 */
test("Sprite exec does not reattach when the run was told to stop, and stops it over HTTP", async () => {
  const child = fakeChild();
  let spawned = 0;
  const kills: { id: string; signal?: string; timeout?: string }[] = [];
  const sprite = {
    spawn() {
      spawned += 1;
      return child;
    },
    async listSessions() {
      return [
        {
          id: "sess-3",
          command: "claude",
          workdir: "/workspace",
          created: new Date(0),
          bytesPerSecond: 0,
          isActive: true,
          tty: false,
        },
      ];
    },
    async killSession(id: string, signal?: string, timeout?: string) {
      kills.push({ id, ...(signal ? { signal } : {}), ...(timeout ? { timeout } : {}) });
      return { async processAll() {} };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const controller = new AbortController();
  const collected = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"], {
      signal: controller.signal,
    }),
  );
  await settle();
  child.emit("spawn");
  await settle();
  controller.abort();
  // The kill went over a socket that then closed without an exit frame.
  child.emit("exit", -1);

  const result = await collected;
  await settle();
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /closed before the command reported an exit/);
  assert.equal(spawned, 1, "a cancelled run must not be reattached");
  assert.deepEqual(kills, [{ id: "sess-3", signal: "SIGTERM", timeout: "10s" }]);
});

/**
 * The SDK's connect has no bound: a connection that blackholes emits
 * neither open nor error, and before this the run sat silent until its
 * own limit, holding a worker slot the whole time.
 */
test("Sprite exec gives up on a connection the sandbox never accepts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const child = fakeChild(); // never emits anything at all
  const sprite = {
    spawn() {
      return child;
    },
    async listSessions() {
      return [];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const collected = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  await settle();
  t.mock.timers.tick(2 * 60_000);
  await settle();
  await settle();

  const result = await collected;
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /did not accept the connection in time/);
});

/**
 * The conversation belongs to the run, not to a connection: a line sent
 * after a reattach must reach the process through the new socket, and
 * the conversation ending must still close its stdin.
 */
test("Sprite exec keeps the live conversation flowing across a reattach", async () => {
  const child1 = fakeChild();
  const child2 = fakeChild();
  const spawns: string[] = [];
  const sprite = {
    spawn(file: string) {
      spawns.push(file);
      return spawns.length === 1 ? child1 : child2;
    },
    async listSessions() {
      return [
        {
          id: "sess-2",
          command: "claude",
          workdir: "/workspace",
          created: new Date(0),
          bytesPerSecond: 0,
          isActive: false,
          tty: false,
        },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const channel = new LineChannel();
  channel.write("first");
  const collected = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"], {
      stdin: channel,
    }),
  );
  await settle();
  const written1: string[] = [];
  child1.stdin.on("data", (d: Buffer | string) => written1.push(d.toString()));
  child1.emit("spawn");
  await settle();
  assert.deepEqual(written1, ["first\n"]);

  child1.emit("exit", -1); // the socket dropped mid conversation
  for (let i = 0; i < 50 && spawns.length < 2; i++) await settle();
  assert.equal(spawns.length, 2);
  const written2: string[] = [];
  child2.stdin.on("data", (d: Buffer | string) => written2.push(d.toString()));
  child2.emit("spawn");
  await settle();

  channel.write("second");
  await settle();
  assert.deepEqual(written2, ["second\n"]);
  // The conversation is still open, so the reattached stdin is too.
  assert.equal(child2.stdin.writableEnded, false);

  channel.end();
  await settle();
  assert.equal(child2.stdin.writableEnded, true);

  child2.emit("exit", 0);
  const result = await collected;
  assert.equal(result.exitCode, 0);
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

/**
 * Reattaching rests on three SDK behaviors: max_run_after_disconnect
 * riding the exec URL (the server-side grace that keeps the process
 * alive), sessionId routing to /exec/{id} in attach mode, and a close
 * on the private WSCommand that does not signal the process. This pins
 * all three against the installed package, so an SDK change fails here
 * instead of silently turning every dropped socket back into a dead
 * run.
 */
test("the installed SDK still supports surviving a disconnect and reattaching", () => {
  const sprite = {
    name: "pin",
    client: { token: "token", baseURL: "https://example.invalid" },
  } as unknown as Sprite;
  const kept = new SpriteCommand(sprite, "claude", [], { maxRunAfterDisconnect: "10m" });
  const keptWs = (kept as unknown as { wsCmd?: { url?: string } }).wsCmd;
  assert.match(keptWs?.url ?? "", /max_run_after_disconnect=10m/);

  const attach = new SpriteCommand(sprite, "claude", [], { sessionId: "sess-9" });
  const attachWs = (attach as unknown as { wsCmd?: { url?: string; isAttach?: boolean; close?: unknown } }).wsCmd;
  assert.match(attachWs?.url ?? "", /\/exec\/sess-9\?/);
  assert.equal(attachWs?.isAttach, true);
  assert.equal(typeof attachWs?.close, "function");

  // Sessions are found again through listSessions on the Sprite class,
  // and a stop reaches the process over HTTP through killSession.
  assert.equal(typeof SpriteClass.prototype.listSessions, "function");
  assert.equal(typeof SpriteClass.prototype.killSession, "function");
});

/**
 * The checkpoint stream reports failure as an error message, not a
 * rejection. Drained blind, a failed checkpoint looked exactly like a
 * finished one, and the newest listed checkpoint was then the previous
 * snapshot: a later rollback would restore the wrong filesystem.
 */
test("Sprite snapshot surfaces a checkpoint the sandbox failed to take", async () => {
  const sprite = {
    async createCheckpoint() {
      return {
        async processAll(handler: (message: { type: string; error?: string; data?: string }) => void) {
          handler({ type: "info", data: "creating checkpoint" });
          handler({ type: "error", error: "disk full" });
        },
        close() {},
      };
    },
    async listCheckpoints() {
      return [{ id: "v1", createTime: new Date(0) }];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.snapshot({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, "before stage"),
    /disk full/,
  );
});

/**
 * The checkpoint fetch carries no timeout at any layer, so a stalled
 * stream used to park the run in "starting" holding its worker slot
 * until a server restart.
 */
test("Sprite snapshot gives up on a checkpoint stream that stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let closed = false;
  const sprite = {
    async createCheckpoint() {
      return {
        processAll() {
          return new Promise(() => {});
        },
        close() {
          closed = true;
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const outcome = driver
    .snapshot({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, "before stage")
    .then(
      () => "resolved",
      (err: Error) => err,
    );
  await settle();
  t.mock.timers.tick(6 * 60_000);
  const result = await outcome;
  assert.ok(result instanceof Error, "the stalled checkpoint must fail rather than hang");
  assert.match(result.message, /did not finish within/);
  assert.ok(closed, "the stalled stream was closed");
});

/**
 * Filesystem calls have no SDK timeout either; a stalled one hung
 * provisioning with the run parked in "starting". The bound turns that
 * into a failure the run record can explain.
 */
test("Sprite provisioning fails rather than hangs when a filesystem call stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sprite = {
    spawn() {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        readdir() {
          return new Promise(() => {});
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const outcome = driver
    .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
    .then(
      () => "resolved",
      (err: Error) => err,
    );
  await settle();
  await settle();
  t.mock.timers.tick(6 * 60_000);
  const result = await outcome;
  assert.ok(result instanceof Error, "the stalled provision must fail rather than hang");
  assert.match(result.message, /listing the workspace did not finish/);
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
