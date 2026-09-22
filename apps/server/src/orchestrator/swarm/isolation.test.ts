import assert from "node:assert/strict";
import { test } from "node:test";
import { exportSwarmBranch, isolationRefusal } from "./sandbox.js";

/**
 * The one promise a swarm's template makes that a deployment can fail
 * to keep.
 *
 * It is asymmetric on purpose, and the asymmetry is the whole design:
 * "worktree" says where the code is, and a driver whose sandboxes
 * clone the repository inside themselves cannot put it there.
 * "sandbox" says nothing at all, so every driver satisfies it,
 * including the ones that hand an agent a worktree because that is all
 * they have.
 */

test("a template that asserts nothing runs anywhere", () => {
  for (const provider of ["docker", "local-process", "sprite"]) {
    assert.equal(isolationRefusal("sandbox", provider), null, `sandbox isolation on ${provider}`);
  }
});

test("a template built around checkouts on the server runs where they are", () => {
  assert.equal(isolationRefusal("worktree", "docker"), null);
  assert.equal(isolationRefusal("worktree", "local-process"), null);
});

test("and is refused, in words, where the sandbox holds its own clone", () => {
  const refusal = isolationRefusal("worktree", "sprite");
  assert.ok(refusal, "a shape that cannot be kept is refused rather than quietly changed");
  assert.match(refusal!, /worktrees of the repository on the server/);
  assert.match(refusal!, /machines that hold their own clones/);
  assert.match(refusal!, /Set the template's isolation/, "and says what to do about it");
});

/* ---------------------------------------------------------------- */

/**
 * Taking the swarm's branch out of the machine that holds it.
 *
 * A driver whose sandboxes clone the repository inside themselves has
 * the swarm's branch in exactly one place, and it has never been
 * pushed anywhere. This is what carries it to a worker's machine.
 */
const handle = { externalId: "sprite-1", provider: "sprite" as const, workdir: "/workspace" };

test("one bundle per repository the swarm actually committed in", async () => {
  const asked: string[] = [];
  const bundles = await exportSwarmBranch(
    {
      async exportRepository(_handle, name, base) {
        asked.push(`${name}@${base}`);
        // The second repository has nothing beyond its base branch,
        // which is the ordinary case in a project spanning several.
        return name === "web" ? null : { baseSha: "b", headSha: "h", data: Buffer.from(name) };
      },
    },
    handle,
    [
      { name: "api", defaultBranch: "main" },
      { name: "web", defaultBranch: "trunk" },
    ],
    "swarm/checkout",
  );

  assert.deepEqual(asked, ["api@main", "web@trunk"], "each against its own base branch");
  assert.deepEqual([...bundles.keys()], ["api"]);
  assert.deepEqual(bundles.get("api"), { branch: "swarm/checkout", data: Buffer.from("api") });
});

test("a branch that could not be read fails the run rather than starting from the default", async () => {
  await assert.rejects(
    exportSwarmBranch(
      {
        async exportRepository() {
          throw new Error("the sandbox is asleep");
        },
      },
      handle,
      [{ name: "api", defaultBranch: "main" }],
      "swarm/checkout",
    ),
    /would have started from main instead of from the swarm's branch/,
  );
});

test("a driver that cannot export answers with nothing, and the seed decides", async () => {
  const bundles = await exportSwarmBranch({}, handle, [{ name: "api", defaultBranch: "main" }], "swarm/checkout");
  assert.equal(bundles.size, 0);
});
