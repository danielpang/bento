import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SpriteDriver } from "./sprite.js";

test("Sprite provisioning transfers a credential-free repository bundle", async () => {
  const writes: { path: string; data: Buffer }[] = [];
  const scripts: string[] = [];
  const removed: string[] = [];
  const sprite = {
    async exec(script: string) {
      scripts.push(script);
      return { stdout: "", stderr: "", exitCode: 0 };
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
  (driver as unknown as { client: { getSprite(name: string): Promise<typeof sprite> } }).client = {
    async getSprite() {
      return sprite;
    },
  };

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
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.data, Buffer.from("git bundle"));
  const commands = scripts.join("\n");
  assert.match(commands, /git clone '\/tmp\/bento-seed-api\.bundle'/);
  assert.doesNotMatch(commands, /sprite-control-token/);
  assert.doesNotMatch(commands, /x-access-token|password=/);
  assert.ok(removed.includes("/workspace/removed-repository"));
});

test("Sprite repository export returns committed objects without credentials", async () => {
  const bundle = Buffer.from("bundle bytes");
  const sprite = {
    spawn() {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill(): void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.write(`base-sha\nhead-sha\n${bundle.toString("base64")}\n`);
        child.stdout.end();
        child.emit("exit", 0);
      });
      return child;
    },
  };
  const driver = new SpriteDriver({ token: "sprite-control-token" });
  (driver as unknown as { client: { getSprite(name: string): Promise<typeof sprite> } }).client = {
    async getSprite() {
      return sprite;
    },
  };

  const exported = await driver.exportRepository(
    { externalId: "sprite", provider: "sprite", workdir: "/workspace" },
    "api",
    "main",
  );
  assert.equal(exported?.baseSha, "base-sha");
  assert.equal(exported?.headSha, "head-sha");
  assert.deepEqual(exported?.data, bundle);
});
