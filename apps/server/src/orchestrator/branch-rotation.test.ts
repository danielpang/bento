import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubPublisher } from "@bento/github";
import { branchForRun, nextBranchName } from "./branch-rotation.js";

interface PrRow {
  number: number;
  url: string;
  repoUrl: string;
}

/**
 * The calls branchForRun makes, and what it did with them. A stub
 * rather than a database, because what is under test is the decision,
 * and the decision is made before anything is written. Deletes are
 * counted because there must never be one: the card's pull requests
 * are its record of what it shipped.
 */
function fakeDb(rows: PrRow[]) {
  const wrote: Record<string, unknown>[] = [];
  let deleted = 0;
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          wrote.push(values);
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        deleted += 1;
      },
    }),
  };
  return { db: db as never, wrote, deletedRows: () => deleted };
}

function publisherSaying(merged: Record<number, boolean>): GitHubPublisher {
  return {
    async getPullRequest(ref) {
      const state = merged[ref.prNumber];
      if (state === undefined) throw new Error(`no such pull request ${ref.prNumber}`);
      return { title: "t", body: null, state: state ? "closed" : "open", merged: state };
    },
    async ensurePullRequest() {
      throw new Error("not used");
    },
    async updatePullRequest() {},
    async pullRequestHasRunComment() {
      return false;
    },
    async createPullRequestComment() {},
    async pushToken() {
      return "unused";
    },
  };
}

const ONE_PR: PrRow[] = [{ number: 7, url: "https://github.com/acme/app/pull/7", repoUrl: "https://github.com/acme/app" }];

test("a merged pull request sends the next run to a new branch", async () => {
  const { db, wrote, deletedRows } = fakeDb(ONE_PR);
  const result = await branchForRun(db, publisherSaying({ 7: true }), {
    featureId: "card-1",
    branch: "feature/checkout-flow-a1b2c3d4",
  });

  assert.equal(result.branch, "feature/checkout-flow-a1b2c3d4-2");
  assert.deepEqual(result.replaced, [
    { number: 7, url: "https://github.com/acme/app/pull/7", repoUrl: "https://github.com/acme/app" },
  ]);
  assert.deepEqual(wrote, [{ branchName: "feature/checkout-flow-a1b2c3d4-2", prNumber: null }]);
  assert.equal(deletedRows(), 0, "the card keeps the record of what it shipped");
});

test("an open pull request keeps the card on its branch", async () => {
  const { db, wrote, deletedRows } = fakeDb(ONE_PR);
  const result = await branchForRun(db, publisherSaying({ 7: false }), {
    featureId: "card-1",
    branch: "feature/checkout-flow-a1b2c3d4",
  });

  assert.equal(result.branch, "feature/checkout-flow-a1b2c3d4");
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(wrote, []);
  assert.equal(deletedRows(), 0);
});

/**
 * A card spanning a frontend and a backend is finished when both have
 * landed. Rotating on the first would abandon the branch the second
 * pull request is still open on.
 */
test("one merged repository of two is not enough", async () => {
  const rows: PrRow[] = [
    ...ONE_PR,
    { number: 9, url: "https://github.com/acme/web/pull/9", repoUrl: "https://github.com/acme/web" },
  ];
  const { db, wrote } = fakeDb(rows);
  const result = await branchForRun(db, publisherSaying({ 7: true, 9: false }), {
    featureId: "card-1",
    branch: "feature/checkout-flow-a1b2c3d4",
  });

  assert.equal(result.branch, "feature/checkout-flow-a1b2c3d4");
  assert.deepEqual(wrote, []);
});

/** Unreadable is not merged: a card must never lose a branch to a 500. */
test("a pull request GitHub will not talk about keeps the branch", async () => {
  const { db, wrote } = fakeDb(ONE_PR);
  const result = await branchForRun(db, publisherSaying({}), {
    featureId: "card-1",
    branch: "feature/checkout-flow-a1b2c3d4",
  });

  assert.equal(result.branch, "feature/checkout-flow-a1b2c3d4");
  assert.deepEqual(wrote, []);
});

test("a slow GitHub does not hold up the run", async () => {
  const { db, wrote } = fakeDb(ONE_PR);
  const slow: GitHubPublisher = {
    ...publisherSaying({ 7: true }),
    async getPullRequest() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { title: "t", body: null, state: "closed", merged: true };
    },
  };
  const result = await branchForRun(db, slow, { featureId: "card-1", branch: "feature/x-a1b2c3d4" }, { timeoutMs: 20 });

  assert.equal(result.branch, "feature/x-a1b2c3d4");
  assert.deepEqual(wrote, []);
});

test("a card with no pull request and a card with no GitHub keep their branch", async () => {
  const none = fakeDb([]);
  assert.equal(
    (await branchForRun(none.db, publisherSaying({}), { featureId: "card-1", branch: "feature/x-a1b2c3d4" })).branch,
    "feature/x-a1b2c3d4",
  );

  const disconnected = fakeDb(ONE_PR);
  assert.equal(
    (await branchForRun(disconnected.db, undefined, { featureId: "card-1", branch: "feature/x-a1b2c3d4" })).branch,
    "feature/x-a1b2c3d4",
  );
});

test("nextBranchName counts up, and leaves the card's name alone", () => {
  assert.equal(nextBranchName("feature/checkout-flow-a1b2c3d4"), "feature/checkout-flow-a1b2c3d4-2");
  assert.equal(nextBranchName("feature/checkout-flow-a1b2c3d4-2"), "feature/checkout-flow-a1b2c3d4-3");
  assert.equal(nextBranchName("feature/checkout-flow-a1b2c3d4-9"), "feature/checkout-flow-a1b2c3d4-10");
  // The eight hex characters that end a Bento branch name are an id,
  // not a count, even on the cards whose id happens to be all digits.
  assert.equal(nextBranchName("feature/checkout-flow-12345678"), "feature/checkout-flow-12345678-2");
});

/**
 * The repository each merged pull request was in, because only those
 * repositories start their next branch from the base branch. One whose
 * publish failed still holds unlanded commits, and re-cutting it would
 * leave them on a branch the card has walked away from.
 */
test("the replaced pull requests name their repositories", async () => {
  const rows: PrRow[] = [
    ...ONE_PR,
    { number: 9, url: "https://github.com/acme/web/pull/9", repoUrl: "https://github.com/acme/web" },
  ];
  const { db } = fakeDb(rows);
  const result = await branchForRun(db, publisherSaying({ 7: true, 9: true }), {
    featureId: "card-1",
    branch: "feature/x-a1b2c3d4",
  });

  assert.deepEqual(result.replaced.map((pr) => pr.repoUrl), [
    "https://github.com/acme/app",
    "https://github.com/acme/web",
  ]);
});
