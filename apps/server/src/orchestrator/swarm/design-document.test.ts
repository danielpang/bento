import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalProcessDriver } from "@bento/sandbox";
import { commitSwarmDesignDocument, SWARM_DESIGN_PATH } from "./design-document.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the design is committed alone and writing the same design is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-swarm-design-"));
  roots.push(root);
  const repo = path.join(root, "app");
  await mkdir(repo);
  await run("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  await run("git", ["-C", repo, "add", "README.md"]);
  await run("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@bento.dev", "commit", "-m", "base"]);
  await run("git", ["-C", repo, "switch", "-c", "swarm/test"]);

  await writeFile(path.join(repo, "unrelated.txt"), "do not commit\n");
  await run("git", ["-C", repo, "add", "unrelated.txt"]);

  const driver = new LocalProcessDriver();
  const handle = { provider: "local-process" as const, externalId: "design-test", workdir: root };
  const content = "# Design\n\nLiteral $HOME, `ticks`, and 'quotes'.\n";
  await commitSwarmDesignDocument({ driver, handle, repositoryName: "app", branch: "swarm/test", content });

  const committed = await run("git", ["-C", repo, "show", `HEAD:${SWARM_DESIGN_PATH}`]);
  assert.equal(committed.stdout, content);
  await assert.rejects(run("git", ["-C", repo, "show", "HEAD:unrelated.txt"]));
  assert.match((await run("git", ["-C", repo, "status", "--short"])).stdout, /A  unrelated\.txt/);

  const firstHead = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  await commitSwarmDesignDocument({ driver, handle, repositoryName: "app", branch: "swarm/test", content });
  assert.equal((await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim(), firstHead);
});

test("the design refuses to commit on an unexpected branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-swarm-design-"));
  roots.push(root);
  const repo = path.join(root, "app");
  await mkdir(repo);
  await run("git", ["-C", repo, "init", "-b", "main"]);

  await assert.rejects(
    commitSwarmDesignDocument({
      driver: new LocalProcessDriver(),
      handle: { provider: "local-process", externalId: "design-test", workdir: root },
      repositoryName: "app",
      branch: "swarm/test",
      content: "# Design\n",
    }),
    /not swarm\/test/,
  );
});
