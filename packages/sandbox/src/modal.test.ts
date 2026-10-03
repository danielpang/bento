import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { collectExec, execTimeoutMessage } from "./driver.js";
import { BENTO_EXEC_PYTHON, FrameDecoder } from "./modal-exec.js";
import {
  MODAL_SANDBOX_TIMEOUT_MS,
  ModalDriver,
  ModalProvisionLeak,
  modalOutboundAllowlist,
  modalSandboxSize,
  type ModalApi,
  type ModalBox,
  type ModalCreateParams,
  type ModalDirEntry,
  type ModalImageRef,
  type ModalProc,
} from "./modal.js";

const TOOLCHAIN: ModalImageRef = { imageId: "im-toolchain" };

function textProc(exitCode: number, stdout = "", stderr = ""): ModalProc {
  return {
    async *stdout() {},
    stdoutText: async () => stdout,
    stderrText: async () => stderr,
    wait: async () => exitCode,
    writeStdin: async () => {},
    endStdin: async () => {},
  };
}

function frameProc(frames: Uint8Array[], exitCode = 0): ModalProc {
  return {
    async *stdout() {
      for (const frame of frames) yield frame;
    },
    stdoutText: async () => "",
    stderrText: async () => "",
    wait: async () => exitCode,
    writeStdin: async () => {},
    endStdin: async () => {},
  };
}

interface Fake {
  api: ModalApi;
  box: ModalBox;
  creates: ModalCreateParams[];
  /** Image id passed to each create, in order. */
  images: string[];
  execs: string[][];
  deleted: string[];
  toolchainCalls: number;
  toolchainError: Error | null;
}

function fake(options?: { running?: boolean; exitText?: string | null; dirs?: ModalDirEntry[] }): Fake {
  const creates: ModalCreateParams[] = [];
  const images: string[] = [];
  const execs: string[][] = [];
  const deleted: string[] = [];
  let toolchainCalls = 0;
  let toolchainError: Error | null = null;
  const dirs = options?.dirs ?? [];
  const files = new Map<string, string>();
  if (options?.exitText !== undefined && options.exitText !== null) {
    files.set("/var/bento/exec/sh-10/exit", options.exitText);
  }

  const box: ModalBox = {
    sandboxId: "sb-1",
    poll: async () => (options?.running === false ? 1 : null),
    exec: async (argv) => {
      execs.push(argv);
      if (argv[0] === "bento-exec" && argv[1] === "follow") {
        return frameProc([Buffer.from("o 5\nhello"), Buffer.from("e 3\nerr"), Buffer.from("x 0\n")]);
      }
      return textProc(0);
    },
    terminate: async () => {
      options && (options.running = false);
    },
    readText: async (file) => files.get(file) ?? null,
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    listDir: async (dir) => (dir === "/var/bento/exec" ? dirs : []),
    remove: async () => {},
    snapshotDirectory: async () => ({ imageId: "im-dir" }),
    snapshotFilesystem: async () => ({ imageId: "im-fs" }),
    mountImage: async () => {},
    experimentalGetExitSnapshot: async () => {
      throw Object.assign(new Error("no snapshot"), { name: "SnapshotCreationError" });
    },
    getTags: async () => ({ bento_created: String(Date.now()) }),
  };

  const api: ModalApi = {
    fromName: async () => (options?.running === false ? null : box),
    create: async (image, params) => {
      images.push(image.imageId);
      creates.push(params);
      options && (options.running = true);
      return box;
    },
    imageFromId: async (id) => ({ imageId: id }),
    deleteImage: async (id) => {
      deleted.push(id);
    },
    toolchainImage: async () => {
      toolchainCalls += 1;
      if (toolchainError) throw toolchainError;
      return TOOLCHAIN;
    },
    listRunning: async () => [],
  };

  return {
    api,
    box,
    creates,
    images,
    execs,
    deleted,
    get toolchainCalls() {
      return toolchainCalls;
    },
    set toolchainError(err: Error | null) {
      toolchainError = err;
    },
    get toolchainError() {
      return toolchainError;
    },
  };
}

function driver(api: ModalApi, options?: { cpu?: number; memoryMiB?: number }): ModalDriver {
  return new ModalDriver({
    tokenId: "id",
    tokenSecret: "secret",
    api,
    ...(options?.cpu ? { cpu: options.cpu } : {}),
    ...(options?.memoryMiB ? { memoryMiB: options.memoryMiB } : {}),
  });
}

const spec = {
  projectId: "project",
  workspaceKey: "feature-1",
  hostWorkspacePath: "/tmp/unused",
  organizationId: "org-1",
};

test("frames become stdout, stderr, and an exit", () => {
  const decoder = new FrameDecoder();
  const first = decoder.push(Buffer.from("o 5\nhel"));
  assert.deepEqual(first, []);
  const rest = decoder.push(Buffer.from("loe 3\nerrx 7\n"));
  assert.deepEqual(rest, [
    { kind: "stdout", data: "hello" },
    { kind: "stderr", data: "err" },
    { kind: "exit", exitCode: 7 },
  ]);
});

test("provision creates a sandbox with no idle timeout and a 24 hour cap", async () => {
  const state = { running: false };
  const env = fake(state);
  const lines: string[] = [];
  const handle = await driver(env.api).provision({
    ...spec,
    onProgress: (line) => {
      lines.push(line);
    },
  });
  assert.equal(handle.provider, "modal");
  assert.equal(handle.externalId, "bento-feature-1");
  assert.equal(handle.workdir, "/workspace");
  assert.equal(env.creates.length, 1);
  const created = env.creates[0]!;
  assert.equal(created.timeoutMs, MODAL_SANDBOX_TIMEOUT_MS);
  assert.equal(created.timeoutMs, 86_400_000);
  assert.equal(created.idleTimeoutMs, undefined);
  assert.deepEqual(created.experimentalOptions, { enable_exit_snapshot: true });
  assert.equal(created.tags.bento_feature, "feature-1");
  assert.equal(created.tags.bento_org, "org-1");
  assert.equal(created.name, "bento-feature-1");
  assert.ok(lines.includes("Starting a Modal sandbox"));
  assert.equal(driver(env.api).sandboxSize, "modal-standard");
  assert.equal(driver(env.api).supportsStdin, true);
});

test("provision reuses a running sandbox", async () => {
  const env = fake({ running: true });
  const lines: string[] = [];
  await driver(env.api).provision({
    ...spec,
    onProgress: (line) => {
      lines.push(line);
    },
  });
  assert.equal(env.creates.length, 0);
  assert.ok(lines.some((line) => line.startsWith("Reusing the Modal sandbox")));
});

test("a failed toolchain build does not provision", async () => {
  const env = fake({ running: false });
  env.toolchainError = new Error("image build failed");
  await assert.rejects(
    () => driver(env.api).provision(spec),
    /image build failed/,
  );
  assert.equal(env.creates.length, 0);
});

test("provision restores a hibernated image and says when it is gone", async () => {
  const saved = fake({ running: false });
  const lines: string[] = [];
  await driver(saved.api).provision({
    ...spec,
    imageRef: "im-saved",
    onProgress: (line) => {
      lines.push(line);
    },
  });
  assert.equal(saved.creates[0]?.name, "bento-feature-1");
  assert.ok(lines.includes("Restoring the workspace from its last snapshot"));

  const gone = fake({ running: false });
  gone.api.imageFromId = async () => null;
  const goneLines: string[] = [];
  const fresh = await driver(gone.api).provision({
    ...spec,
    imageRef: "im-gone",
    onProgress: (line) => {
      goneLines.push(line);
    },
  });
  assert.ok(goneLines.includes("The saved workspace snapshot is gone, so this sandbox starts from a fresh clone."));
  assert.equal(gone.toolchainCalls, 1);
  assert.equal(fresh.recordedImageRef, null);
  assert.deepEqual(gone.images, [TOOLCHAIN.imageId]);
});

test("an exit snapshot wins over an older hibernation image", async () => {
  const env = fake({ running: false });
  env.api.fromName = async () => env.box;
  env.box.poll = async () => 1;
  env.box.experimentalGetExitSnapshot = async () => ({ imageId: "im-exit" });
  const lines: string[] = [];
  const handle = await driver(env.api).provision({
    ...spec,
    imageRef: "im-old",
    onProgress: (line) => {
      lines.push(line);
    },
  });
  assert.deepEqual(env.images, ["im-exit"]);
  assert.equal(handle.recordedImageRef, "im-exit");
  assert.ok(lines.includes("Restoring the workspace from its last snapshot"));
  assert.equal(lines.some((line) => line.includes("fresh clone")), false);
});

test("restore of a stopped sandbox uses the same allowlist as provision", async () => {
  const hosts = ["https://gateway.example", "git@github.com:acme/app.git", "https://api.anthropic.com"];
  const created = fake({ running: false });
  await driver(created.api).provision({
    ...spec,
    network: "restricted",
    allowedHosts: hosts,
  });
  const stopped = fake({ running: false });
  await driver(stopped.api).restore(
    {
      externalId: "bento-feature-1",
      provider: "modal",
      workdir: "/workspace",
      network: "restricted",
      allowedHosts: hosts,
    },
    "im-workspace",
  );
  assert.deepEqual(stopped.creates[0]?.outboundDomainAllowlist, created.creates[0]?.outboundDomainAllowlist);
  assert.deepEqual(stopped.creates[0]?.outboundDomainAllowlist, ["gateway.example", "github.com", "api.anthropic.com"]);
  assert.equal(stopped.creates[0]?.tags.bento_feature, "feature-1");
  assert.ok(stopped.creates[0]?.tags.bento_created);
});

test("a failed clone after create terminates the new sandbox", async () => {
  const env = fake({ running: false });
  let terminated = 0;
  env.box.terminate = async () => {
    terminated += 1;
  };
  env.box.exec = async () => textProc(1, "", "clone failed");
  await assert.rejects(
    () =>
      driver(env.api).provision({
        ...spec,
        repositories: [{ name: "app", cloneUrl: "https://github.com/acme/app.git" }],
      }),
    /could not prepare app/,
  );
  assert.equal(terminated, 1);
  assert.equal(env.creates.length, 1);
});

test("a clone failure that cannot be stopped is a provision leak", async () => {
  const env = fake({ running: false });
  env.box.terminate = async () => {
    throw new Error("terminate failed");
  };
  env.box.exec = async () => textProc(1, "", "clone failed");
  await assert.rejects(
    () =>
      driver(env.api).provision({
        ...spec,
        repositories: [{ name: "app", cloneUrl: "https://github.com/acme/app.git" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ModalProvisionLeak);
      assert.match(err.message, /could not prepare app/);
      assert.equal(err.externalId, "bento-feature-1");
      return true;
    },
  );
});

test("reusing a running sandbox does not terminate it when clone fails", async () => {
  const env = fake({ running: true });
  let terminated = 0;
  env.box.terminate = async () => {
    terminated += 1;
  };
  env.box.exec = async () => textProc(1, "", "fetch failed");
  await assert.rejects(
    () =>
      driver(env.api).provision({
        ...spec,
        repositories: [{ name: "app", cloneUrl: "https://github.com/acme/app.git" }],
      }),
    /could not prepare app/,
  );
  assert.equal(terminated, 0);
  assert.equal(env.creates.length, 0);
});

test("a missing exit snapshot starts from a fresh clone and says so", async () => {
  const env = fake({ running: false });
  const modal = driver(env.api);
  await modal.provision(spec);
  env.box.poll = async () => 1;
  env.box.getTags = async () => ({ bento_created: String(Date.now() - 23 * 60 * 60 * 1000 - 60_000) });
  env.api.fromName = async () => null;
  const lines: string[] = [];
  await modal.provision({
    ...spec,
    onProgress: (line) => {
      lines.push(line);
    },
  });
  assert.ok(
    lines.includes("This Modal sandbox reached its 24 hour limit, so the next start is a fresh clone."),
  );
});

test("create retries AlreadyExistsError and then keeps the name", async () => {
  const env = fake({ running: false });
  let attempts = 0;
  env.api.create = async (_image, params) => {
    attempts += 1;
    env.creates.push(params);
    if (attempts === 1) {
      throw Object.assign(new Error("name in use"), { name: "AlreadyExistsError" });
    }
    return env.box;
  };
  const handle = await driver(env.api).provision(spec);
  assert.equal(handle.externalId, "bento-feature-1");
  assert.equal(attempts, 2);
});

test("exec parses frames, and a timeout writes execTimeoutMessage", async () => {
  const env = fake({ running: true });
  const modal = driver(env.api);
  const done = await collectExec(modal.exec({ externalId: "bento-feature-1", provider: "modal", workdir: "/workspace" }, ["echo", "hi"]));
  assert.equal(done.stdout, "hello");
  assert.equal(done.stderr, "err");
  assert.equal(done.exitCode, 0);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  env.box.exec = async (argv) => {
    env.execs.push(argv);
    if (argv[1] === "follow") {
      return {
        ...textProc(0),
        async *stdout() {
          await gate;
          yield Buffer.from("x 9\n");
        },
      };
    }
    return textProc(0);
  };
  const timeoutMs = 30;
  const pending = collectExec(
    modal.exec(
      { externalId: "bento-feature-1", provider: "modal", workdir: "/workspace" },
      ["sleep", "100"],
      { timeoutMs },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const timed = await pending;
  assert.match(timed.stderr, new RegExp(execTimeoutMessage(timeoutMs).replace(/[.]/g, "\\.")));
  assert.equal(timed.exitCode, 9);
  assert.ok(env.execs.some((argv) => argv[0] === "bento-exec" && argv[1] === "kill"));
});

test("abort kills the process group", async () => {
  const env = fake({ running: true });
  let followStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    followStarted = resolve;
  });
  env.box.exec = async (argv) => {
    env.execs.push(argv);
    if (argv[1] === "follow") {
      followStarted();
      return {
        ...textProc(0),
        async *stdout() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield Buffer.from("x 1\n");
        },
      };
    }
    return textProc(0);
  };
  const controller = new AbortController();
  const pending = collectExec(
    driver(env.api).exec(
      { externalId: "bento-feature-1", provider: "modal", workdir: "/workspace" },
      ["sleep", "100"],
      { signal: controller.signal },
    ),
  );
  await started;
  controller.abort();
  await pending;
  assert.ok(env.execs.some((argv) => argv[1] === "kill"));
});

test("attach returns null when the exit file is already there", async () => {
  const env = fake({
    running: true,
    dirs: [{ name: "sh-10", type: "directory" }, { name: "sh-2", type: "directory" }],
    exitText: "0",
  });
  const attached = await driver(env.api).attach(
    { externalId: "bento-feature-1", provider: "modal", workdir: "/workspace" },
    ["sh", "-c", "true"],
  );
  assert.equal(attached, null);
  assert.equal(env.execs.some((argv) => argv[1] === "follow"), false);
});

test("restore mounts a directory snapshot onto a running sandbox", async () => {
  const env = fake({ running: true });
  let mounted: string | null = null;
  env.box.mountImage = async (_path, image) => {
    mounted = image.imageId;
  };
  await driver(env.api).restore(
    { externalId: "bento-feature-1", provider: "modal", workdir: "/workspace" },
    "im-workspace",
  );
  assert.equal(mounted, "im-workspace");
  assert.equal(env.creates.length, 0);
});

test("a restricted run names hosts and refuses when it cannot", () => {
  assert.deepEqual(
    modalOutboundAllowlist({
      network: "restricted",
      allowedHosts: ["https://gateway.example", "git@github.com:acme/app.git", "https://api.openai.com/v1"],
    }),
    ["gateway.example", "github.com", "api.openai.com"],
  );
  assert.equal(modalOutboundAllowlist({ network: "open", allowedHosts: [] }), undefined);
  assert.throws(
    () => modalOutboundAllowlist({ network: "restricted", allowedHosts: [] }),
    /could not name the hosts/,
  );
  assert.throws(
    () => modalOutboundAllowlist({ network: "restricted", allowedHosts: ["not a host"] }),
    /could not be named/,
  );
});

test("sandbox size follows the sprite names with a modal prefix", () => {
  assert.equal(modalSandboxSize(1, 2048), "modal-small");
  assert.equal(modalSandboxSize(2, 4096), "modal-standard");
  assert.equal(modalSandboxSize(4, 8192), "modal-large");
  assert.equal(modalSandboxSize(8, 16384), "modal-xl");
  assert.equal(modalSandboxSize(3, 4096), "modal-custom-3c-4g");
});

test("destroy terminates the sandbox and deletes the hibernation image", async () => {
  const env = fake({ running: true });
  let terminated = false;
  env.box.terminate = async () => {
    terminated = true;
  };
  await driver(env.api).destroy({
    externalId: "bento-feature-1",
    provider: "modal",
    workdir: "/workspace",
    imageRef: "im-hibernated",
  });
  assert.equal(terminated, true);
  assert.deepEqual(env.deleted, ["im-hibernated"]);
});

test("bento-exec records frames from byte 0 and writes exit last", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-exec-"));
  const script = path.join(dir, "bento-exec");
  await writeFile(script, BENTO_EXEC_PYTHON, { mode: 0o755 });
  const work = path.join(dir, "run");
  const started = await run(script, ["start", work, "--", "python3", "-c", "import sys; sys.stdout.write('hi\\n'); sys.stderr.write('no\\n')"]);
  assert.equal(started.code, 0, started.stderr);
  const followed = await run(script, ["follow", work, "0"]);
  assert.equal(followed.code, 0, followed.stderr);
  const decoder = new FrameDecoder();
  const frames = decoder.push(Buffer.from(followed.stdout));
  assert.deepEqual(
    frames.map((frame) => frame.kind),
    ["stdout", "stderr", "exit"],
  );
  assert.equal(frames[0]?.kind === "stdout" ? frames[0].data : "", "hi\n");
  assert.equal(frames[1]?.kind === "stderr" ? frames[1].data : "", "no\n");
  assert.equal(frames[2]?.kind === "exit" ? frames[2].exitCode : -1, 0);
  const exitAt = followed.stdout.lastIndexOf("x 0\n");
  assert.ok(exitAt > followed.stdout.indexOf("o "));
  assert.ok(exitAt > followed.stdout.indexOf("e "));
});

test("bento-exec stdin accepts a write after start has exited", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-exec-stdin-"));
  const script = path.join(dir, "bento-exec");
  await writeFile(script, BENTO_EXEC_PYTHON, { mode: 0o755 });
  const work = path.join(dir, "run");
  const payload = "from-a-later-process";
  let pid = 0;
  try {
    const started = await run(script, [
      "start",
      work,
      "--",
      "python3",
      "-c",
      "import sys; sys.stdout.write(sys.stdin.read())",
    ]);
    assert.equal(started.code, 0, started.stderr);
    const pidPath = path.join(work, "pid");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        pid = Number((await readFile(pidPath, "utf8")).trim());
        if (pid > 0) break;
      } catch {
        pid = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pid > 0, "daemon did not write a pid");
    await stat(path.join(work, "stdin"));
    const wrote = await runPython([
      "-c",
      "import sys; open(sys.argv[1], 'wb', buffering=0).write(sys.argv[2].encode())",
      path.join(work, "stdin"),
      payload,
    ]);
    assert.equal(wrote.code, 0, wrote.stderr);
    const closed = await run(script, ["eof", work]);
    assert.equal(closed.code, 0, closed.stderr);
    const followed = await run(script, ["follow", work, "0"]);
    assert.equal(followed.code, 0, followed.stderr);
    const frames = new FrameDecoder().push(Buffer.from(followed.stdout));
    assert.equal(frames[0]?.kind === "stdout" ? frames[0].data : "", payload);
    assert.equal(frames.at(-1)?.kind === "exit" ? frames.at(-1)?.exitCode : -1, 0);
  } finally {
    if (pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The command already exited.
        }
      }
    }
  }
});

function run(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runPython([script, ...args]);
}

function runPython(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bento-exec timed out: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
