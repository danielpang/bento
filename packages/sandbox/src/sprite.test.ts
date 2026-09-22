import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APIError, FilesystemError, Sprite as SpriteClass, SpriteCommand, type Sprite } from "@fly/sprites";
import { LineChannel, collectExec } from "./driver.js";
import {
  FILESYSTEM_RETRY_DELAYS_MS,
  SpriteDriver,
  EXEC_HANDSHAKE_RETRY_DELAYS_MS,
  SPRITE_ACQUIRE_RATE_LIMIT_WAITS,
  SPRITE_ACQUIRE_RETRY_DELAYS_MS,
  SPRITE_DESTROY_RETRY_DELAYS_MS,
  SPRITE_LOOKUP_RETRY_DELAYS_MS,
  spriteExistsWithRetry,
  spriteName,
} from "./sprite.js";

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

/**
 * Runs a provision whose filesystem calls may sleep between retries.
 * The clock is fake, so a held outage still finishes in this test
 * instead of waiting out the real backoff. Each delay is armed only
 * after the previous attempt rejects, so the clock advances one wait
 * at a time.
 */
async function provisionWithFilesystemRetries(
  t: { mock: { timers: { enable(opts: { apis: Array<"setTimeout" | "setInterval"> }): void; tick(ms: number): void } } },
  driver: SpriteDriver,
  spec: Parameters<SpriteDriver["provision"]>[0] = {
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
  },
): Promise<unknown> {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const outcome = driver.provision(spec).then(
    (value) => value,
    (err: unknown) => err,
  );
  await settle();
  await settle();
  for (const delay of FILESYSTEM_RETRY_DELAYS_MS) {
    t.mock.timers.tick(delay);
    await settle();
    await settle();
  }
  return outcome;
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

/**
 * Points the driver at a stub sprite, and gives that stub the one method
 * every command now calls.
 *
 * The driver holds the machine awake through the Tasks API for the
 * length of any command, which every stub below would otherwise have to
 * know about. Supplying the default here keeps each stub about the thing
 * its own test is checking, and the returned array lets a test that
 * cares read the calls back. A stub that brings its own execFileHTTP
 * keeps it.
 */
function stubClient(driver: SpriteDriver, sprite: unknown): { taskCalls: string[] } {
  const target = sprite as {
    execFileHTTP?: (file: string, args: string[]) => Promise<unknown>;
  };
  const taskCalls: string[] = [];
  if (!target.execFileHTTP) {
    target.execFileHTTP = async (_file: string, args: string[]) => {
      taskCalls.push(args[1] ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    };
  }
  (driver as unknown as { client: { getSprite(name: string): Promise<unknown> } }).client = {
    async getSprite() {
      return sprite;
    },
  };
  return { taskCalls };
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
 * The workspace sweep between runs must leave Bento's own artifacts
 * directory alone, and it once could not: the SDK's exists() only maps
 * a structured ENOENT to false, and the sprites API answers a missing
 * path with the OS's own words ("open ...: no such file or directory")
 * and no code, so probing artifacts/.git threw instead of answering.
 * The first card whose agent wrote an artifact failed every later
 * provision of its reused sandbox with exactly that error.
 */
test("Sprite provisioning leaves the artifacts directory and unreadable directories alone", async () => {
  const probed: string[] = [];
  const removed: string[] = [];
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          return [
            { name: "api", isDirectory: () => true },
            { name: "artifacts", isDirectory: () => true },
            { name: "half-deleted", isDirectory: () => true },
            { name: "mid-clone", isDirectory: () => true },
            { name: "removed-repository", isDirectory: () => true },
          ];
        },
        async exists(path: string) {
          probed.push(path);
          if (path === "/workspace/removed-repository/.git") return true;
          // The SDK's other missing-path shape: /list answering with
          // entries null makes stat() dereference it unguarded.
          if (path === "/workspace/mid-clone/.git") {
            throw new TypeError("Cannot read properties of null (reading 'length')");
          }
          // What the live API really does with a missing path; the
          // SDK wraps it with code UNKNOWN, not ENOENT.
          throw new FilesystemError(`open ${path}: no such file or directory`, "UNKNOWN", path, "stat");
        },
        async rm(path: string) {
          removed.push(path);
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
    repositories: [{ name: "api", cloneUrl: "https://github.com/acme/api.git", branch: "main" }],
  });

  // The artifacts directory is known, not probed: a name check must
  // not depend on the filesystem API's error shape.
  assert.ok(!probed.includes("/workspace/artifacts/.git"));
  // A directory whose probe failed is left standing; the one that
  // answered "checkout" is reaped.
  assert.deepEqual(removed, ["/workspace/removed-repository"]);
});

/**
 * The forgiveness above is only for the shapes that name a missing
 * path. The SDK wraps every failed response in a FilesystemError, an
 * expired token and a 503 included, so the class alone must not be
 * enough: swallowing those would hand back a sandbox whose sweep
 * silently never ran, and a dropped repository's checkout would stay.
 */
test("Sprite provisioning still fails when the checkout probe fails for other reasons", async (t) => {
  const failures: { fail: () => never; retriable: boolean; pattern: RegExp }[] = [
    // A real 503 through the SDK: FilesystemError, but not a missing path.
    // Retried, then still a failure, so a held outage cannot skip the sweep.
    {
      retriable: true,
      pattern: /503/,
      fail: () => {
        throw new FilesystemError("stat failed with status 503", "UNKNOWN", "/workspace/leftover/.git", "stat");
      },
    },
    // undici's transport failure: a TypeError, but it carries a cause.
    // Not the sprites "please retry" shape, so it fails on the first try.
    {
      retriable: false,
      pattern: /fetch failed/,
      fail: () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      },
    },
    // A missing status that is not an outage. Retrying it would only
    // delay the failure, and it must not read as "no checkout".
    {
      retriable: false,
      pattern: /status 404/,
      fail: () => {
        throw new FilesystemError("stat failed with status 404", "UNKNOWN", "/workspace/leftover/.git", "stat");
      },
    },
  ];
  for (const { fail, retriable, pattern } of failures) {
    let probes = 0;
    const sprite = {
      spawn(_file: string, args: string[]) {
        const child = fakeChild();
        queueMicrotask(() => {
          if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0);
        });
        return child;
      },
      filesystem() {
        return {
          async readdir() {
            return [{ name: "leftover", isDirectory: () => true }];
          },
          async exists() {
            probes += 1;
            fail();
          },
        };
      },
    };
    const driver = new SpriteDriver({ token: "token" });
    stubClient(driver, sprite);

    const result = retriable
      ? await provisionWithFilesystemRetries(t, driver)
      : await driver
          .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
          .then(
            () => "resolved",
            (err: unknown) => err,
          );
    if (retriable) t.mock.timers.reset();
    assert.ok(result instanceof Error, "the checkout probe must still fail the provision");
    assert.match(result.message, pattern);
    assert.equal(probes, retriable ? FILESYSTEM_RETRY_DELAYS_MS.length + 1 : 1);
  }
});

/**
 * The same distinction on the workspace listing: the SDK's own null
 * dereference means an empty workspace, but undici reports a transport
 * failure as a TypeError too, and an outage must not read as a
 * workspace with nothing to sweep.
 */
test("Sprite provisioning still fails when listing the workspace hits a transport failure", async () => {
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" }),
    /fetch failed/,
  );
});

/**
 * A project with no repositories provisions a sprite whose workspace is
 * empty, and the SDK cannot describe one: the API answers an empty
 * directory by setting entries to null and readdir maps it unchecked,
 * so it throws `Cannot read properties of null (reading 'map')` instead
 * of returning nothing.
 *
 * Every run of such a project died in provisioning because of it, with
 * a TypeError from inside a vendor's SDK and nothing pointing at the
 * missing repository. Found by the first real run of sprite.e2e.test.ts,
 * which provisions without repositories and had never been run against
 * a live machine before.
 */
test("Sprite provisioning survives an empty workspace", async () => {
  const messages: string[] = [];
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          throw new TypeError("Cannot read properties of null (reading 'map')");
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
    repositories: [],
    onProgress: (message) => {
      messages.push(message);
    },
  });
  assert.equal(handle.workdir, "/workspace");
});

/**
 * The narrowness matters: swallowing every readdir failure would turn
 * an unreachable API, or a token that has expired, into a sandbox
 * handed back as ready. Only the SDK's own null dereference is
 * forgiven.
 */
test("Sprite provisioning still fails when the filesystem API does", async () => {
  let listings = 0;
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          listings += 1;
          // A plain Error, not the SDK's FilesystemError. The retry is
          // only for the shape the sprites API actually returns.
          throw new Error("503 Service Unavailable");
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" }),
    /503/,
  );
  assert.equal(listings, 1);
});

/**
 * The sprites filesystem API answers a blip with FilesystemError
 * "service temporarily unavailable, please retry" and no status: the
 * SDK keeps the sentence and drops the HTTP code. Provisioning lists
 * the workspace on every run, so one blip used to fail the run. The
 * listing has to be repeated, and the sweep has to use the listing
 * that finally arrived, not treat the failure as an empty workspace.
 */
test("Sprite provisioning retries a temporarily unavailable filesystem and still sweeps", async (t) => {
  const messages: string[] = [];
  const removed: string[] = [];
  let listings = 0;
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          listings += 1;
          if (listings < 3) {
            throw new FilesystemError(
              "service temporarily unavailable, please retry",
              "UNKNOWN",
              "/workspace",
              "readdir",
            );
          }
          return [{ name: "removed-repository", isDirectory: () => true }];
        },
        async exists(path: string) {
          return path === "/workspace/removed-repository/.git";
        },
        async rm(path: string) {
          removed.push(path);
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await provisionWithFilesystemRetries(t, driver, {
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
    onProgress: (message) => {
      messages.push(message);
    },
  });
  assert.ok(!(result instanceof Error), `provision should recover: ${result}`);
  assert.equal(listings, 3);
  assert.deepEqual(removed, ["/workspace/removed-repository"]);
  assert.equal(
    messages.filter((message) => message.includes("temporarily unavailable")).length,
    1,
  );
});

/**
 * A retry that never gets an answer still fails the provision with the
 * API's own sentence. Stopping after the schedule is what keeps a real
 * outage from parking the run in "starting".
 */
test("Sprite provisioning stops retrying when the filesystem stays unavailable", async (t) => {
  let listings = 0;
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          listings += 1;
          throw new FilesystemError(
            "service temporarily unavailable, please retry",
            "UNKNOWN",
            "/workspace",
            "readdir",
          );
        },
      };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await provisionWithFilesystemRetries(t, driver);
  assert.ok(result instanceof Error);
  assert.match(result.message, /service temporarily unavailable, please retry/);
  assert.equal(listings, FILESYSTEM_RETRY_DELAYS_MS.length + 1);
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
 *
 * The same error is a refused upgrade, which is retried: a single
 * ETIMEDOUT used to fail the run, and the credential-bearing URL was
 * the only copy of the failure. Both have to stay true together.
 */
test("Sprite exec keeps the credential-bearing exec URL out of error output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let spawned = 0;
  const sprite = {
    spawn() {
      spawned += 1;
      const child = fakeChild();
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

  const pending = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  for (const delay of EXEC_HANDSHAKE_RETRY_DELAYS_MS) {
    await settle();
    t.mock.timers.tick(delay);
  }
  await settle();
  const result = await pending;
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /ETIMEDOUT/);
  assert.match(result.stderr, /\[sandbox exec url\]/);
  assert.match(result.stderr, /did not accept the exec connection, and it stayed that way through the retries/);
  assert.doesNotMatch(result.stderr, /sk-secret|wss:/);
  // The first upgrade plus one retry per delay. Stopping earlier would
  // turn one blip back into a failed run; continuing would not stop.
  assert.equal(spawned, 1 + EXEC_HANDSHAKE_RETRY_DELAYS_MS.length);
});

/**
 * A refused upgrade is not proof the command is gone. When the server
 * did start it and only the 101 was lost, the retry joins that session
 * instead of launching a second copy.
 */
test("Sprite exec joins a command the refused upgrade had already started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const started = fakeChild();
  const attached = fakeChild();
  const spawns: { args: string[]; sessionId?: string }[] = [];
  const sprite = {
    spawn(_file: string, args: string[] = [], options?: { sessionId?: string }) {
      spawns.push({ args, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) });
      if (spawns.length === 1) {
        queueMicrotask(() => {
          started.emit(
            "error",
            new Error(
              "WebSocket error: Received network error or non-101 status code. (url: wss://api.sprites.dev/v1/sprites/x/exec?cmd=claude)",
            ),
          );
        });
        return started;
      }
      queueMicrotask(() => attached.emit("spawn"));
      return attached;
    },
    async listSessions() {
      return [
        {
          id: "sess-started",
          command: "claude -p do the task",
          workdir: "/workspace",
          created: new Date(),
          bytesPerSecond: 0,
          isActive: true,
          tty: false,
        },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const pending = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude", "-p", "do the task"]),
  );
  await settle();
  t.mock.timers.tick(EXEC_HANDSHAKE_RETRY_DELAYS_MS[0]!);
  await settle();
  attached.stdout.write('{"type":"result"}\n');
  attached.emit("exit", 0);
  const result = await pending;

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /result/);
  assert.match(result.stderr, /reattached to the running command/);
  assert.doesNotMatch(result.stderr, /wss:/);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1]?.sessionId, "sess-started");
  assert.deepEqual(spawns[1]?.args, []);
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
 * The other half of surviving a quiet agent, and the one no amount of
 * connection handling could have fixed.
 *
 * A sandbox pauses when it looks idle, and what it counts as activity
 * is output: a process started through exec keeps the machine up only
 * while it is writing. An agent waiting on a model turn writes nothing,
 * so the machine pauses, and a pause ends the process. The reattach
 * above then works exactly as designed and finds nothing, because there
 * is nothing left to find. A task registered for the length of the
 * command is what stops the pause.
 */
test("Sprite exec holds the sandbox awake for the length of the command", async () => {
  const child = fakeChild();
  const calls: string[] = [];
  const sprite = {
    name: "sprite",
    spawn() {
      return child;
    },
    async execFileHTTP(file: string, args: string[]) {
      // A script, through a shell: the Tasks API lives on the machine's
      // own management socket, so the only way to reach it is from
      // inside the sandbox.
      assert.equal(file, "sh");
      assert.equal(args[0], "-c");
      calls.push(args[1] ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async listSessions() {
      return [];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const collected = collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude", "-p", "task"]),
  );
  await settle();
  child.emit("spawn");
  await settle();

  // Registered before the command is left to be quiet, not after the
  // first pause has already taken it.
  assert.equal(calls.length, 1, `expected one registration, got ${calls.length}`);
  assert.match(calls[0]!, /-X POST/);
  assert.match(calls[0]!, /\/v1\/tasks/);
  const taskName = calls[0]!.match(/"name":"(bento-claude-[0-9a-f]{8})"/)?.[1];
  assert.ok(taskName, `the registration did not name a task: ${calls[0]}`);
  // An expiry, so a server that dies mid run cannot pin a machine awake
  // and billed forever.
  assert.match(calls[0]!, /"expire":"\d+[smh]"/);

  child.emit("exit", 0);
  assert.equal((await collected).exitCode, 0);
  await settle();

  // And let go the moment the command is over, because a held machine
  // is a billed one.
  const last = calls.at(-1) ?? "";
  assert.match(last, /-X DELETE/);
  assert.match(last, new RegExp(`/v1/tasks/${taskName}`));
});

/**
 * A hold has to outlive the run, and the platform caps a single task
 * well below how long an agent can work, so the hold is renewed while
 * the command runs. The renewal falls back to registering again, for
 * the case renewals were failing long enough for the task to expire
 * underneath them.
 */
test("Sprite exec keeps renewing its hold while the command runs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const child = fakeChild();
  const calls: string[] = [];
  const sprite = {
    name: "sprite",
    spawn() {
      return child;
    },
    async execFileHTTP(_file: string, args: string[]) {
      calls.push(args[1] ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
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
  child.emit("spawn");
  await settle();
  assert.equal(calls.length, 1);

  // Two quiet minutes: exactly the stretch that used to lose a run.
  t.mock.timers.tick(60_000);
  await settle();
  t.mock.timers.tick(60_000);
  await settle();

  const renewals = calls.slice(1);
  assert.equal(renewals.length, 2, `expected two renewals, got ${renewals.length}`);
  for (const renewal of renewals) {
    assert.match(renewal, /-X PUT/);
    // The re-registration behind it, for a task that already expired.
    assert.match(renewal, /\|\|.*-X POST/);
  }

  child.emit("exit", 0);
  await collected;
  await settle();
  // The renewals stop with the command rather than running on.
  const after = calls.length;
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(calls.length, after, "the hold went on renewing after the command ended");
});

/**
 * Keeping the machine awake is best effort, and it runs alongside real
 * work: a sandbox whose Tasks API refuses, or whose image predates it,
 * must still run the command. This is the old behavior, which is worse
 * but is not nothing, rather than a run that fails outright over a hold
 * it could not take.
 */
test("Sprite exec still runs the command when the sandbox refuses the hold", async () => {
  const child = fakeChild();
  const sprite = {
    name: "sprite",
    spawn() {
      return child;
    },
    async execFileHTTP() {
      throw new Error("404 page not found");
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
  child.emit("spawn");
  child.stdout.write("working\n");
  await settle();
  child.emit("exit", 0);

  const result = await collected;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /working/);
  // The operator's problem, not the user's: a failed hold must not turn
  // up in the transcript the agent's output becomes.
  assert.doesNotMatch(result.stderr, /task|awake|404/i);
});

/**
 * The message that cost an afternoon. "The process was gone" is true
 * and says nothing about why, and the why is the one thing an operator
 * can act on: a sandbox that paused mid command means the hold above
 * never took, so every long quiet run on that machine is dying the same
 * way. The sandbox knows when it last went to sleep, so it is asked.
 */
test("Sprite exec names the pause when the sandbox slept through the command", async () => {
  const child = fakeChild();
  const sprite = {
    name: "sprite",
    spawn() {
      queueMicrotask(() => child.emit("exit", -1));
      return child;
    },
    async listSessions() {
      return [];
    },
    // Asleep since a moment ago, which is after this command began.
    lastWarmingAt: new Date(Date.now() + 1_000),
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /went to sleep/);
  assert.match(result.stderr, /gone when the driver tried to reattach/);
  // This lands in the run's transcript and in the failure the card
  // shows, so it is copy, and the copy rule holds: no dashes.
  assert.doesNotMatch(result.stderr, /[—–]|\s-\s/);
});

/**
 * And not blamed on a pause that did not happen. A sandbox last asleep
 * before this command started is one that stayed up, so whatever killed
 * the process was something else and the message must not send anybody
 * after the wrong thing.
 */
test("Sprite exec does not blame a pause that predates the command", async () => {
  const child = fakeChild();
  const sprite = {
    name: "sprite",
    spawn() {
      queueMicrotask(() => child.emit("exit", -1));
      return child;
    },
    async listSessions() {
      return [];
    },
    lastWarmingAt: new Date(Date.now() - 60 * 60_000),
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const result = await collectExec(
    driver.exec({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
  );
  assert.equal(result.exitCode, -1);
  assert.doesNotMatch(result.stderr, /went to sleep/);
  assert.match(result.stderr, /the process was gone when the driver tried to reattach/);
});

/**
 * Provisioning goes quiet too: an installer downloading for minutes, a
 * clone of a large repository. A pause there ends the script the same
 * way it ended agent runs, and would surface as a half installed
 * toolchain rather than as a lost run.
 */
test("Sprite provisioning holds the sandbox awake while its scripts run", async () => {
  const calls: string[] = [];
  const sprite = {
    name: "sprite",
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
    async execFileHTTP(_file: string, args: string[]) {
      calls.push(args[1] ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
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

  await driver.provision({ projectId: "p", featureId: "f", hostWorkspacePath: "/unused" });

  const registered = calls.filter((call) => /-X POST/.test(call));
  const released = calls.filter((call) => /-X DELETE/.test(call));
  assert.ok(registered.length > 0, "provisioning never held the sandbox awake");
  assert.ok(registered.every((call) => /"name":"bento-provision-[0-9a-f]{8}"/.test(call)));
  // Every script lets go of its own hold, so a provision cannot leave
  // the machine pinned awake behind it.
  assert.equal(released.length, registered.length, `${registered.length} holds taken, ${released.length} released`);
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
 * attach is how a freshly booted server picks up a run the previous
 * process left working in the sandbox: find the session, connect to it,
 * and stream as if the socket had never gone away. Only the command's
 * first word matters for the match, and tty sessions are never ours.
 */
test("Sprite attach streams the surviving session to completion", async () => {
  const child = fakeChild();
  const spawns: { file: string; args: string[]; options?: Record<string, unknown> }[] = [];
  const sprite = {
    spawn(file: string, args: string[], options?: Record<string, unknown>) {
      spawns.push({ file, args, ...(options ? { options } : {}) });
      return child;
    },
    async listSessions() {
      return [
        { id: "tty-1", command: "claude", workdir: "/w", created: new Date(3), bytesPerSecond: 0, isActive: true, tty: true },
        { id: "old-1", command: "claude -p earlier task", workdir: "/w", created: new Date(1), bytesPerSecond: 0, isActive: false, tty: false },
        { id: "sess-7", command: "claude -p do the task", workdir: "/w", created: new Date(2), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const attaching = driver.attach(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    ["claude", "-p", "do the task"],
  );
  await settle();
  child.emit("spawn");
  const stream = await attaching;
  assert.ok(stream, "a listed session must be attachable");

  const collected = collectExec(stream!);
  child.stdout.write('{"type":"result"}\n');
  child.emit("exit", 0);
  const result = await collected;

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /result/);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0]?.args, []);
  assert.equal(spawns[0]?.options?.sessionId, "sess-7");
});

/**
 * A sandbox that answers without the session is conclusive: the process
 * ended while nobody was attached. Null, not an error, so the caller
 * can close the run honestly instead of retrying forever.
 */
test("Sprite attach answers null when the process is gone", async () => {
  let spawned = 0;
  const sprite = {
    spawn() {
      spawned += 1;
      return fakeChild();
    },
    async listSessions() {
      return [
        { id: "tty-1", command: "claude", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: true, tty: true },
        { id: "sh-1", command: "sh -lc export", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const stream = await driver.attach(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    ["claude"],
  );
  assert.equal(stream, null);
  assert.equal(spawned, 0);
});

/**
 * A connection that will not open is a transport failure, not proof the
 * session is gone, so attach must reject rather than answer null: null
 * makes the caller close the run for good.
 */
test("Sprite attach rejects rather than answering null when the connection will not open", async () => {
  const child = fakeChild();
  let signalled = false;
  child.kill = () => {
    signalled = true;
  };
  const sprite = {
    spawn() {
      queueMicrotask(() => child.emit("error", new Error("WebSocket error: connect refused")));
      return child;
    },
    async listSessions() {
      return [
        { id: "sess-8", command: "claude", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.attach({ externalId: "sprite", provider: "sprite", workdir: "/workspace" }, ["claude"]),
    /connect refused/,
  );
  // The process must not be signalled for a failure that is ours.
  assert.equal(signalled, false);
});

/**
 * After a successful attach the stream is a full citizen: a later
 * socket drop walks the same reattach ladder an exec-born stream does.
 */
test("Sprite attach inherits the drop-recovery ladder", async () => {
  const child1 = fakeChild();
  const child2 = fakeChild();
  const spawns: { options?: Record<string, unknown> }[] = [];
  const sprite = {
    spawn(_file: string, _args: string[], options?: Record<string, unknown>) {
      spawns.push({ ...(options ? { options } : {}) });
      return spawns.length === 1 ? child1 : child2;
    },
    async listSessions() {
      return [
        { id: "sess-9", command: "claude", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const attaching = driver.attach(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    ["claude"],
  );
  await settle();
  child1.emit("spawn");
  const stream = await attaching;
  assert.ok(stream);
  const collected = collectExec(stream!);

  child1.emit("exit", -1); // the reattached socket dropped again
  for (let i = 0; i < 50 && spawns.length < 2; i++) await settle();
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1]?.options?.sessionId, "sess-9");
  child2.emit("spawn");
  await settle();
  child2.stdout.write('{"type":"result"}\n');
  child2.emit("exit", 0);

  const result = await collected;
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /reattached to the running command/);
});

/**
 * The conversation belongs to the run: an attached stream accepts live
 * stdin exactly as an exec-born one, and the conversation ending still
 * closes the process's stdin.
 */
test("Sprite attach carries the live conversation and closes stdin when it ends", async () => {
  const child = fakeChild();
  const sprite = {
    spawn() {
      return child;
    },
    async listSessions() {
      return [
        { id: "sess-10", command: "claude", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const channel = new LineChannel();
  const attaching = driver.attach(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    ["claude"],
    { stdin: channel },
  );
  await settle();
  child.emit("spawn");
  const stream = await attaching;
  assert.ok(stream);
  const collected = collectExec(stream!);

  const written: string[] = [];
  child.stdin.on("data", (d: Buffer | string) => written.push(d.toString()));
  channel.write("a follow-up");
  await settle();
  assert.deepEqual(written, ["a follow-up\n"]);
  assert.equal(child.stdin.writableEnded, false);

  channel.end();
  await settle();
  assert.equal(child.stdin.writableEnded, true);

  child.emit("exit", 0);
  const result = await collected;
  assert.equal(result.exitCode, 0);
});

/**
 * A cancel on a resumed run must actually stop the agent: over the
 * socket, and over HTTP for when the socket is past helping, and it
 * must never trigger another reattach.
 */
test("Sprite attach does not resurrect a cancelled run", async () => {
  const child = fakeChild();
  let spawned = 0;
  const kills: { id: string; signal?: string }[] = [];
  const sprite = {
    spawn() {
      spawned += 1;
      return child;
    },
    async listSessions() {
      return [
        { id: "sess-11", command: "claude", workdir: "/w", created: new Date(0), bytesPerSecond: 0, isActive: false, tty: false },
      ];
    },
    async killSession(id: string, signal?: string) {
      kills.push({ id, ...(signal ? { signal } : {}) });
      return { async processAll() {} };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const controller = new AbortController();
  const attaching = driver.attach(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    ["claude"],
    { signal: controller.signal },
  );
  await settle();
  child.emit("spawn");
  const stream = await attaching;
  assert.ok(stream);
  const collected = collectExec(stream!);

  controller.abort();
  child.emit("exit", -1); // the socket closed without a real exit
  const result = await collected;
  await settle();

  assert.equal(result.exitCode, -1);
  assert.equal(spawned, 1, "a cancelled run must not be reattached");
  assert.deepEqual(kills, [{ id: "sess-11", signal: "SIGTERM" }]);
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
 * A provisioning exec that dies in the WebSocket upgrade.
 *
 * The failure captured from production was undici's handshake error
 * while the toolchain script was the command, and runScript used to
 * reject that on the first try with the URL (the whole script) still
 * attached. The upgrade is retried. The URL does not leave the driver.
 */
test("Sprite provisioning retries a refused exec upgrade and then installs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let toolchainSpawns = 0;
  const sprite = {
    spawn(file: string, args: string[]) {
      assert.equal(file, "sh");
      const child = fakeChild();
      const body = args[1] ?? "";
      queueMicrotask(() => {
        if (body.includes("\nMARKER=")) {
          toolchainSpawns += 1;
          if (toolchainSpawns === 1) {
            child.emit(
              "error",
              new Error(
                "WebSocket error: Received network error or non-101 status code. (url: wss://api.sprites.dev/v1/sprites/bento/exec?cmd=sh&cmd=-c&cmd=MARKER%3Dsecret-script)",
              ),
            );
            return;
          }
        }
        if (body.includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    async listSessions() {
      return [];
    },
    filesystem() {
      return { async readdir() { return []; } };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const pending = driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
  });
  await settle();
  t.mock.timers.tick(EXEC_HANDSHAKE_RETRY_DELAYS_MS[0]!);
  await settle();
  const handle = await pending;
  assert.equal(handle.externalId, "bento-feature");
  assert.equal(toolchainSpawns, 2);
});

/**
 * When the retries are spent, the error the executor captures must not
 * carry the exec URL. That URL is the script, and it is what PostHog
 * stored for the handshake failure.
 */
test("Sprite provisioning reports a refused exec upgrade without the exec URL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let toolchainSpawns = 0;
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      const body = args[1] ?? "";
      queueMicrotask(() => {
        if (body.includes("\nMARKER=")) {
          toolchainSpawns += 1;
          child.emit(
            "error",
            new Error(
              "WebSocket error: Received network error or non-101 status code. (url: wss://api.sprites.dev/v1/sprites/bento/exec?cmd=sh&cmd=-c&cmd=MARKER%3Dsecret-script)",
            ),
          );
          return;
        }
        if (body.includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    async listSessions() {
      return [];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const pending = driver
    .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
    .then(
      () => "resolved",
      (err: Error) => err,
    );
  for (const delay of EXEC_HANDSHAKE_RETRY_DELAYS_MS) {
    await settle();
    t.mock.timers.tick(delay);
  }
  await settle();
  const result = await pending;
  assert.ok(result instanceof Error);
  assert.match(result.message, /failed before the command started/);
  assert.match(result.message, /non-101 status code/);
  assert.match(result.message, new RegExp(`after ${1 + EXEC_HANDSHAKE_RETRY_DELAYS_MS.length} attempts`));
  assert.doesNotMatch(result.message, /wss:|secret-script|sandbox exec url/);
  assert.equal(toolchainSpawns, 1 + EXEC_HANDSHAKE_RETRY_DELAYS_MS.length);
});

/**
 * The server can start the script and still fail the client's upgrade.
 * The retry has to collect that process, not start a second installer.
 */
test("Sprite provisioning attaches to a script the refused upgrade already started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const spawns: { args: string[]; sessionId?: string }[] = [];
  const sprite = {
    spawn(file: string, args: string[] = [], options?: { sessionId?: string }) {
      assert.equal(file, "sh");
      spawns.push({ args, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) });
      const child = fakeChild();
      const body = args[1] ?? "";
      queueMicrotask(() => {
        if (options?.sessionId) {
          child.stdout.write("tools-present\nbento-toolchain-missing: \n");
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0);
          return;
        }
        if (body.includes("\nMARKER=")) {
          child.emit(
            "error",
            new Error("WebSocket error: Received network error or non-101 status code. (url: wss://api.sprites.dev/x)"),
          );
          return;
        }
        if (body.includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    async listSessions() {
      const toolchain = spawns.find((spawn) => (spawn.args[1] ?? "").includes("\nMARKER="));
      if (!toolchain) return [];
      return [
        {
          id: "install-1",
          command: `sh -c ${toolchain.args[1]}`,
          workdir: "/",
          created: new Date(),
          bytesPerSecond: 0,
          isActive: true,
          tty: false,
        },
      ];
    },
    filesystem() {
      return { async readdir() { return []; } };
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  const pending = driver.provision({
    projectId: "project",
    featureId: "feature",
    hostWorkspacePath: "/unused",
  });
  await settle();
  t.mock.timers.tick(EXEC_HANDSHAKE_RETRY_DELAYS_MS[0]!);
  await settle();
  await pending;

  const installs = spawns.filter((spawn) => (spawn.args[1] ?? "").includes("\nMARKER=") || spawn.sessionId);
  assert.equal(installs.length, 2);
  assert.equal(installs[0]?.sessionId, undefined);
  assert.equal(installs[1]?.sessionId, "install-1");
  assert.deepEqual(installs[1]?.args, []);
});

/**
 * A script that ran and failed is the script's answer, not a transport
 * failure. Retrying it would hide a real installer error behind another
 * attempt.
 */
test("Sprite provisioning does not retry a script that exited", async () => {
  let toolchainSpawns = 0;
  const sprite = {
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      const body = args[1] ?? "";
      queueMicrotask(() => {
        if (body.includes("\nMARKER=")) {
          toolchainSpawns += 1;
          child.stderr.write("installer exploded\n");
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 1);
          return;
        }
        if (body.includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    async listSessions() {
      return [];
    },
  };
  const driver = new SpriteDriver({ token: "token" });
  stubClient(driver, sprite);

  await assert.rejects(
    driver.provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /exit code 1/);
      assert.equal((err as { stderr?: string }).stderr?.includes("installer exploded"), true);
      return true;
    },
  );
  assert.equal(toolchainSpawns, 1);
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

  /**
   * The keep-awake hold rides execFileHTTP rather than a WebSocket, so
   * a renewal is one request that cannot be lost with the socket the
   * command is on. Pinned because losing it silently would give every
   * quiet run its pause back.
   */
  assert.equal(typeof SpriteClass.prototype.execFileHTTP, "function");
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

/**
 * A sprite is a billed machine, so destroy used to be the most
 * dangerous kind of quiet: it swallowed every error, and a refused
 * delete read as a machine gone while it kept running.
 */
test("destroying a sprite tolerates one that is already gone and reports everything else", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attempted: string[] = [];
  let failure: unknown = null;
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  (driver as unknown as { client: { deleteSprite(name: string): Promise<void> } }).client = {
    async deleteSprite(name: string) {
      attempted.push(name);
      if (failure) throw failure;
    },
  };
  const handle = { externalId: "bento-feature", provider: "sprite" as const, workdir: "/workspace" };

  await driver.destroy(handle);
  assert.deepEqual(attempted, ["bento-feature"]);

  // Already gone is the one outcome that means the same thing as a
  // successful delete.
  failure = new APIError("sprite not found", { statusCode: 404 });
  await driver.destroy(handle);
  failure = new Error("Failed to delete sprite (status 404): no such sprite");
  await driver.destroy(handle);

  // A refusal has to reach the caller at once: the delete route
  // answers 502 and keeps the card, rather than losing the only
  // pointer to a machine that is still billing.
  attempted.length = 0;
  failure = new APIError("forbidden", { statusCode: 403 });
  await assert.rejects(driver.destroy(handle), /forbidden/);
  assert.equal(attempted.length, 1);
  failure = new Error("fetch failed");
  await assert.rejects(driver.destroy(handle), /fetch failed/);
  assert.equal(attempted.length, 2);

  // A control plane that is unwell gets asked again, and still
  // reaches the caller once the waits are spent.
  attempted.length = 0;
  failure = new APIError("upstream is unwell", { statusCode: 500 });
  const pending = driver.destroy(handle).then(
    () => "ok" as const,
    (err: Error) => err,
  );
  await settle();
  assert.equal(attempted.length, 1);
  for (const delay of SPRITE_DESTROY_RETRY_DELAYS_MS) {
    t.mock.timers.tick(delay);
    await settle();
  }
  const result = await pending;
  assert.ok(result instanceof Error);
  assert.match(result.message, /upstream is unwell/);
  assert.equal(attempted.length, SPRITE_DESTROY_RETRY_DELAYS_MS.length + 1);
});

/**
 * The e2e teardown threw "service temporarily unavailable, please
 * retry" out of deleteSprite during a Sprites incident, which failed
 * the hook and left the machine for the workflow's cleanup step. The
 * API said to retry. Now it is.
 */
test("destroying a sprite retries a transient control-plane failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  (driver as unknown as { client: { deleteSprite(name: string): Promise<void> } }).client = {
    async deleteSprite() {
      calls += 1;
      if (calls === 1) throw new APIError("service temporarily unavailable, please retry", { statusCode: 503 });
      if (calls === 2) throw new Error("Network error: fetch failed");
    },
  };
  const handle = { externalId: "bento-feature", provider: "sprite" as const, workdir: "/workspace" };

  let settled = false;
  const pending = driver.destroy(handle).then(() => {
    settled = true;
  });
  await settle();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  t.mock.timers.tick(SPRITE_DESTROY_RETRY_DELAYS_MS[0]!);
  await settle();
  assert.equal(calls, 2);
  assert.equal(settled, false);
  t.mock.timers.tick(SPRITE_DESTROY_RETRY_DELAYS_MS[1]!);
  await pending;
  assert.equal(calls, 3);
});

/**
 * The sandbox e2e asks "does this sprite already exist" before it
 * creates one. Fly aborted that getSprite at the client's one minute
 * timeout, and the suite ended before a machine existed. A retry
 * covers the abort. A timeout is still not "gone", and a status the
 * API actually returned is still answered once.
 */
test("a sprite lookup retries a control-plane timeout and still reports a real failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: string[] = [];
  let calls = 0;
  const client = {
    async getSprite() {
      calls += 1;
      throw new Error("Network error: The operation was aborted due to timeout");
    },
  };
  const pending = spriteExistsWithRetry(client as never, "bento-e2e", (err) => {
    notices.push(err instanceof Error ? err.message : String(err));
    throw new Error("progress must not replace the lookup error");
  }).then(
    (found) => found as boolean | Error,
    (err: Error) => err,
  );

  await settle();
  assert.equal(calls, 1);
  for (const delay of SPRITE_LOOKUP_RETRY_DELAYS_MS) {
    t.mock.timers.tick(delay);
    await settle();
  }
  const result = await pending;
  assert.ok(result instanceof Error);
  assert.match(result.message, /aborted due to timeout/);
  assert.equal(calls, SPRITE_LOOKUP_RETRY_DELAYS_MS.length + 1);
  assert.equal(notices.length, SPRITE_LOOKUP_RETRY_DELAYS_MS.length);

  // The third answer is the one that counts: two aborts, then the sprite.
  calls = 0;
  const flaky = {
    async getSprite() {
      calls += 1;
      if (calls < 3) throw new Error("Network error: fetch failed");
      return { name: "bento-e2e" };
    },
  };
  const found = spriteExistsWithRetry(flaky as never, "bento-e2e");
  await settle();
  t.mock.timers.tick(SPRITE_LOOKUP_RETRY_DELAYS_MS[0]!);
  await settle();
  t.mock.timers.tick(SPRITE_LOOKUP_RETRY_DELAYS_MS[1]!);
  await settle();
  assert.equal(await found, true);
  assert.equal(calls, 3);

  // A 404 on the last try is "gone", which is what the e2e wants before
  // it creates a machine.
  calls = 0;
  const absent = {
    async getSprite() {
      calls += 1;
      if (calls < 3) throw new Error("Network error: The operation was aborted due to timeout");
      throw new APIError("sprite not found", { statusCode: 404 });
    },
  };
  const gone = spriteExistsWithRetry(absent as never, "bento-e2e");
  await settle();
  t.mock.timers.tick(SPRITE_LOOKUP_RETRY_DELAYS_MS[0]!);
  await settle();
  t.mock.timers.tick(SPRITE_LOOKUP_RETRY_DELAYS_MS[1]!);
  await settle();
  assert.equal(await gone, false);
  assert.equal(calls, 3);

  // A response with a status is answered once. Waiting here would turn
  // a refused token into a long pause.
  calls = 0;
  notices.length = 0;
  const refused = {
    async getSprite() {
      calls += 1;
      throw new APIError("upstream is unwell", { statusCode: 500 });
    },
  };
  await assert.rejects(
    spriteExistsWithRetry(refused as never, "bento-e2e", (err) => {
      notices.push(String(err));
    }),
    /upstream is unwell/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(notices, []);
});

/**
 * delete-sprite.ts is a short process whose only pending work during a
 * lookup retry is this timer. An unref'd timer let Node exit with
 * "unsettled top-level await" before the retry ran, so a sprite the
 * test had created was left for the next attempt.
 */
test("a sprite lookup retry keeps its backoff on the event loop", async () => {
  // A separate process: the check replaces setTimeout, which the rest
  // of this file is also using. The script clears the real timer and
  // runs the callback itself, so it does not wait out the backoff.
  const source = `
    import { APIError } from "@fly/sprites";
    import { spriteExistsWithRetry } from "./src/sprite.ts";
    const real = global.setTimeout;
    let referenced = false;
    let release = () => {};
    global.setTimeout = (fn, ms, ...args) => {
      const timer = real(fn, ms, ...args);
      referenced = timer.hasRef();
      release = () => {
        clearTimeout(timer);
        fn(...args);
      };
      return timer;
    };
    let calls = 0;
    const pending = spriteExistsWithRetry({
      async getSprite() {
        calls += 1;
        if (calls === 1) throw new Error("Network error: The operation was aborted due to timeout");
        throw new APIError("upstream is unwell", { statusCode: 500 });
      },
    }, "bento-e2e");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    if (!referenced) {
      console.error("retry backoff was not keeping the event loop alive");
      process.exit(1);
    }
    global.setTimeout = real;
    release();
    await pending.then(
      () => process.exit(1),
      (err) => {
        if (!String(err).includes("upstream is unwell")) {
          console.error(err);
          process.exit(1);
        }
      },
    );
  `;
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${stderr}\n${stdout}\n${err.message}`));
        else resolve({ stdout, stderr });
      },
    );
  });
  assert.equal(stderr, "", stderr);
  assert.equal(stdout, "");
});

/**
 * The sprite a cold provision talks to once acquireSprite has a machine.
 * The rest of provision has to finish for the retry to count as success.
 */
function acquiredSprite() {
  return {
    name: "bento-feature",
    async execFileHTTP() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    spawn(_file: string, args: string[]) {
      const child = fakeChild();
      queueMicrotask(() => {
        if ((args[1] ?? "").includes("tools-absent")) child.stdout.write("tools-present\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
      });
      return child;
    },
    filesystem() {
      return {
        async readdir() {
          throw new TypeError("Cannot read properties of null (reading 'map')");
        },
      };
    },
  };
}

/**
 * Cold provision's createSprite threw Fly's HTML 500 page, and the
 * cleanup step then found the sprite and deleted it. The response was
 * the failure. The machine was not. A retry has to look the name up
 * before it spends another create.
 */
test("Sprite provisioning retries a control-plane 500 and reuses the sprite a failed create made", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const html500 = () =>
    new APIError("<title>500 Internal Server Error · Sprites · Fly.io</title>", { statusCode: 500 });

  // The 500 created the machine. The next lookup finds it, so create
  // runs once.
  {
    const messages: string[] = [];
    let lookups = 0;
    let creates = 0;
    const sprite = acquiredSprite();
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        lookups += 1;
        if (lookups === 1) throw new APIError("sprite not found", { statusCode: 404 });
        return sprite;
      },
      async createSprite() {
        creates += 1;
        throw html500();
      },
    };
    const pending = driver.provision({
      projectId: "project",
      featureId: "feature",
      hostWorkspacePath: "/unused",
      repositories: [],
      onProgress: (message) => {
        messages.push(message);
      },
    });
    await settle();
    assert.equal(creates, 1);
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[0]!);
    const handle = await pending;
    assert.equal(handle.externalId, "bento-feature");
    assert.equal(creates, 1);
    assert.ok(messages.some((message) => message.includes("Creating the sandbox failed on the control plane")));
    assert.ok(messages.some((message) => message.startsWith("Created cloud sandbox")));
  }

  // Still missing after the failed create: one confirming lookup, then
  // a second create. When that 500s too, the original error comes back
  // and no third machine is asked for.
  {
    let lookups = 0;
    let creates = 0;
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        lookups += 1;
        throw new APIError("sprite not found", { statusCode: 404 });
      },
      async createSprite() {
        creates += 1;
        throw html500();
      },
    };
    let settled = false;
    const pending = driver
      .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
      .then(
        () => {
          settled = true;
          return "ok" as const;
        },
        (err: Error) => {
          settled = true;
          return err;
        },
      );
    await settle();
    assert.equal(creates, 1);
    // The wait the 500 itself asked for. The sprite is still absent,
    // and that single 404 must not spend another create.
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[0]!);
    await settle();
    assert.equal(creates, 1);
    // A second look, then one more create. That 500 ends the budget.
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[1]!);
    await settle();
    assert.equal(creates, 2);
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[2]!);
    await settle();
    const result = await pending;
    assert.equal(settled, true);
    assert.ok(result instanceof Error);
    assert.match(result.message, /500 Internal Server Error/);
    assert.equal(creates, 2);
    assert.ok(lookups > 1);
  }

  // A lookup that 500s has not said the sprite is missing, so it must
  // not spend a create.
  {
    let creates = 0;
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        throw html500();
      },
      async createSprite() {
        creates += 1;
        throw new Error("create should not run");
      },
    };
    const pending = driver
      .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
      .then(
        () => "ok" as const,
        (err: Error) => err,
      );
    await settle();
    for (const delay of SPRITE_ACQUIRE_RETRY_DELAYS_MS) {
      t.mock.timers.tick(delay);
      await settle();
    }
    const result = await pending;
    assert.ok(result instanceof Error);
    assert.match(result.message, /500 Internal Server Error/);
    assert.equal(creates, 0);
  }

  // A refused create is answered once.
  {
    let creates = 0;
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        throw new APIError("sprite not found", { statusCode: 404 });
      },
      async createSprite() {
        creates += 1;
        throw new APIError("bad request", { statusCode: 400 });
      },
    };
    let settled = false;
    const pending = driver
      .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
      .then(
        () => {
          settled = true;
          return "ok" as const;
        },
        (err: Error) => {
          settled = true;
          return err;
        },
      );
    await settle();
    assert.equal(settled, true);
    assert.equal(creates, 1);
    const result = await pending;
    assert.ok(result instanceof Error);
    assert.match(result.message, /bad request/);
  }

  // The account allows ten creates a minute. A 429 names its own wait,
  // and the sprite a previous attempt already made is reused instead
  // of creating another.
  {
    const messages: string[] = [];
    let lookups = 0;
    let creates = 0;
    const sprite = acquiredSprite();
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        lookups += 1;
        if (lookups === 1) throw new APIError("sprite not found", { statusCode: 404 });
        return sprite;
      },
      async createSprite() {
        creates += 1;
        throw new APIError("Sprite creation rate limit exceeded", {
          statusCode: 429,
          retryAfterSeconds: 60,
        });
      },
    };
    const pending = driver.provision({
      projectId: "project",
      featureId: "feature",
      hostWorkspacePath: "/unused",
      repositories: [],
      onProgress: (message) => {
        messages.push(message);
      },
    });
    await settle();
    assert.equal(creates, 1);
    t.mock.timers.tick(59_000);
    await settle();
    assert.equal(lookups, 1, "the rate limit wait should elapse before another lookup");
    t.mock.timers.tick(1_000);
    const handle = await pending;
    assert.equal(handle.externalId, "bento-feature");
    assert.equal(creates, 1);
    assert.ok(messages.some((message) => message.includes("Sprite creation is rate limited")));
  }
});

/**
 * The sequence sandbox-e2e run 35762235632 went through during a
 * Sprites incident: a create that 500s, a lookup that 404s, a lookup
 * that does not answer, a lookup that 404s, and then a 429 with a
 * minute's retry-after. The three short waits were spent by then, and
 * the provision died on the one error whose retry was sure to be
 * answered. The account had made two creates in that minute, not ten.
 */
test("Sprite provisioning waits out a rate limit even after the short retries are spent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const html500 = () =>
    new APIError("<title>500 Internal Server Error · Sprites · Fly.io</title>", { statusCode: 500 });
  const rateLimited = () =>
    new APIError("Sprite creation rate limit exceeded. You can create 10 sprites per minute.", {
      statusCode: 429,
      retryAfterSeconds: 60,
    });
  const notFound = () => new APIError("sprite not found", { statusCode: 404 });

  // The run as it happened, with the machine arriving on the create
  // after the rate limit wait.
  {
    const messages: string[] = [];
    let lookups = 0;
    let creates = 0;
    const sprite = acquiredSprite();
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        lookups += 1;
        if (lookups === 3) throw new Error("Network error: The operation was aborted due to timeout");
        throw notFound();
      },
      async createSprite() {
        creates += 1;
        if (creates === 1) throw html500();
        if (creates === 2) throw rateLimited();
        return sprite;
      },
    };
    const pending = driver.provision({
      projectId: "project",
      featureId: "feature",
      hostWorkspacePath: "/unused",
      repositories: [],
      onProgress: (message) => {
        messages.push(message);
      },
    });
    await settle();
    assert.equal(creates, 1);
    // The 500's wait, then the lookup that confirms the machine is
    // absent, which spends the second short wait.
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[0]!);
    await settle();
    assert.equal(lookups, 2);
    // A lookup the control plane never answered spends the third.
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[1]!);
    await settle();
    assert.equal(lookups, 3);
    t.mock.timers.tick(SPRITE_ACQUIRE_RETRY_DELAYS_MS[2]!);
    await settle();
    // Absent, so a second create, which meets the rate limit. Nothing
    // is left in the short budget, and that must not matter.
    assert.equal(lookups, 4);
    assert.equal(creates, 2);
    assert.ok(messages.some((message) => message.includes("Sprite creation is rate limited")));
    t.mock.timers.tick(59_000);
    await settle();
    assert.equal(creates, 2, "the create has to wait for the retry-after the API asked for");
    t.mock.timers.tick(1_000);
    const handle = await pending;
    assert.equal(handle.externalId, "bento-feature");
    assert.equal(creates, 3);
    assert.ok(messages.some((message) => message.startsWith("Created cloud sandbox")));
  }

  // A limit that never clears still ends the provision, after exactly
  // the waits it is allowed, and with the 429 as the reason.
  {
    let creates = 0;
    const driver = new SpriteDriver({ token: "token" });
    (driver as unknown as { client: unknown }).client = {
      async getSprite() {
        throw notFound();
      },
      async createSprite() {
        creates += 1;
        throw rateLimited();
      },
    };
    const pending = driver
      .provision({ projectId: "project", featureId: "feature", hostWorkspacePath: "/unused" })
      .then(
        () => "ok" as const,
        (err: Error) => err,
      );
    await settle();
    assert.equal(creates, 1);
    for (let wait = 0; wait < SPRITE_ACQUIRE_RATE_LIMIT_WAITS; wait++) {
      t.mock.timers.tick(60_000);
      await settle();
      assert.equal(creates, wait + 2);
    }
    const result = await pending;
    assert.ok(result instanceof Error);
    assert.match(result.message, /rate limit exceeded/);
    assert.equal(creates, SPRITE_ACQUIRE_RATE_LIMIT_WAITS + 1);
  }
});

const spriteHandle = { externalId: "bento-feature", provider: "sprite" as const, workdir: "/workspace" };

/**
 * exec's first act used to be one getSprite, and that call is the MCP
 * config write. A single "sprite not found" threw out of executeRun
 * before the agent started. The lookup is retried, and a sprite the
 * info endpoint never admits is addressed by the name provision stored.
 */
test("Sprite exec retries a sprite the info endpoint has not caught up to", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  let calls = 0;
  const noted: Array<{ retries: number; outcome: string; reason: string; name: string }> = [];
  const driver = new SpriteDriver({
    token: "token",
    onLookupRetry(info) {
      noted.push(info);
      throw new Error("metrics must not fail the command");
    },
  });
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      calls += 1;
      if (calls < 3) throw new APIError("sprite not found", { statusCode: 404 });
      return {
        spawn() {
          return child;
        },
        async execFileHTTP() {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };
    },
    sprite() {
      throw new Error("a sprite that appears on retry must not be addressed by name");
    },
  };

  const pending = collectExec(driver.exec(spriteHandle, ["claude"])).then(
    (result) => result,
    (err: Error) => err,
  );
  await settle();
  t.mock.timers.tick(200);
  await settle();
  t.mock.timers.tick(500);
  await settle();
  await settle();
  child.emit("spawn");
  child.emit("exit", 0);
  const result = await pending;
  assert.ok(!(result instanceof Error), result instanceof Error ? result.message : "");
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 3);
  assert.deepEqual(noted, [{ name: "bento-feature", retries: 2, outcome: "recovered", reason: "not_found" }]);
});

test("Sprite exec addresses a sprite by name when the info endpoint keeps saying it is missing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  let lookups = 0;
  let handled: string | null = null;
  const noted: Array<{ name: string; retries: number; outcome: string; reason: string }> = [];
  const driver = new SpriteDriver({
    token: "token",
    onLookupRetry(info) {
      noted.push(info);
    },
  });
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      lookups += 1;
      throw new APIError("sprite not found", { statusCode: 404 });
    },
    sprite(name: string) {
      handled = name;
      return {
        spawn() {
          return child;
        },
        async execFileHTTP() {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };
    },
  };

  const pending = collectExec(driver.exec(spriteHandle, ["claude"])).then(
    (result) => result,
    (err: Error) => err,
  );
  for (const delay of [200, 500, 1_000, 2_000]) {
    await settle();
    t.mock.timers.tick(delay);
  }
  await settle();
  await settle();
  assert.equal(handled, "bento-feature");
  assert.equal(lookups, 5);
  assert.deepEqual(noted, [
    { name: "bento-feature", retries: 5, outcome: "addressed_by_name", reason: "not_found" },
  ]);
  child.emit("spawn");
  child.stdout.write("ok\n");
  child.emit("exit", 0);
  const result = await pending;
  assert.ok(!(result instanceof Error), result instanceof Error ? result.message : "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ok/);
});

test("Sprite exec stops when the command itself reports the sandbox is missing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  let spawns = 0;
  const driver = new SpriteDriver({ token: "token" });
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      throw new APIError("sprite not found", { statusCode: 404 });
    },
    sprite() {
      return {
        spawn() {
          spawns += 1;
          queueMicrotask(() => child.emit("error", new Error('HTTP 404: {"error":"sprite not found"}')));
          return child;
        },
        async execFileHTTP() {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async listSessions() {
          throw new Error("should not reattach when the sprite is gone");
        },
      };
    },
  };

  const pending = collectExec(driver.exec(spriteHandle, ["claude"])).then(
    (result) => result,
    (err: Error) => err,
  );
  for (const delay of [200, 500, 1_000, 2_000]) {
    await settle();
    t.mock.timers.tick(delay);
  }
  await settle();
  await settle();
  const result = await pending;
  assert.ok(!(result instanceof Error), result instanceof Error ? result.message : "");
  assert.equal(spawns, 1);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /was not found, so the command was not started/);
  assert.match(result.stderr, /Start the run again to provision a new sandbox/);
  assert.doesNotMatch(result.stderr, /[—–]/);
});

test("Sprite exec does not paper over a lookup that failed for another reason", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let handled = false;
  const noted: Array<{ name: string; retries: number; outcome: string; reason: string }> = [];
  const driver = new SpriteDriver({
    token: "token",
    onLookupRetry(info) {
      noted.push(info);
    },
  });
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      calls += 1;
      throw new APIError("upstream is unwell", { statusCode: 500 });
    },
    sprite() {
      handled = true;
      return {};
    },
  };

  const pending = collectExec(driver.exec(spriteHandle, ["claude"])).then(
    () => "resolved" as const,
    (err: Error) => err,
  );
  for (let i = 0; i < 6; i++) {
    await settle();
    t.mock.timers.tick(2_000);
  }
  const result = await pending;
  assert.ok(result instanceof Error);
  assert.match(result.message, /upstream is unwell/);
  assert.equal(handled, false);
  assert.equal(calls, 5);
  assert.deepEqual(noted, [{ name: "bento-feature", retries: 5, outcome: "failed", reason: "transient" }]);

  let unauthorized = 0;
  noted.length = 0;
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      unauthorized += 1;
      throw new APIError("unauthorized", { statusCode: 401 });
    },
    sprite() {
      throw new Error("an unauthorized lookup must not fall through to a handle");
    },
  };
  await assert.rejects(collectExec(driver.exec(spriteHandle, ["claude"])), /unauthorized/);
  assert.equal(unauthorized, 1);
  assert.deepEqual(noted, []);
});

test("Sprite exec reports a lookup that mixed a missing sprite with a blinking API", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const noted: Array<{ name: string; retries: number; outcome: string; reason: string }> = [];
  const driver = new SpriteDriver({
    token: "token",
    onLookupRetry(info) {
      noted.push(info);
    },
  });
  (driver as unknown as { client: Record<string, unknown> }).client = {
    async getSprite() {
      calls += 1;
      if (calls === 1) throw new APIError("sprite not found", { statusCode: 404 });
      throw new APIError("upstream is unwell", { statusCode: 500 });
    },
    sprite() {
      throw new Error("a failed lookup must not be addressed by name");
    },
  };

  const pending = collectExec(driver.exec(spriteHandle, ["claude"])).then(
    () => "resolved" as const,
    (err: Error) => err,
  );
  for (let i = 0; i < 6; i++) {
    await settle();
    t.mock.timers.tick(2_000);
  }
  const result = await pending;
  assert.ok(result instanceof Error);
  assert.match(result.message, /upstream is unwell/);
  assert.equal(calls, 5);
  assert.deepEqual(noted, [{ name: "bento-feature", retries: 5, outcome: "failed", reason: "mixed" }]);
});
