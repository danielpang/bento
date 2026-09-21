import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkReleaseState, releaseFiles, resolveReleaseTag } from "./release-target.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./release-target.mjs", import.meta.url));
let temporary, origin, checkout, releaseCommit, newerCommit, server, graphqlUrl;
let responseStatus = 200;
let responseBody = { data: { repository: { release: null } } };
let requests = [];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "bento-release-test-"));
  origin = path.join(temporary, "origin");
  checkout = path.join(temporary, "checkout");
  await mkdir(origin);
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.name", "Release test");
  git(origin, "config", "user.email", "release-test@example.invalid");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "config", "tag.gpgsign", "false");
  await writeFile(path.join(origin, "README.md"), "Before desktop packaging\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "Before desktop");
  git(origin, "tag", "v0.1.0");
  for (const file of releaseFiles) {
    await mkdir(path.dirname(path.join(origin, file)), { recursive: true });
    await writeFile(path.join(origin, file), "Release tooling\n");
  }
  git(origin, "add", ".");
  git(origin, "commit", "-m", "Release source");
  releaseCommit = git(origin, "rev-parse", "HEAD");
  git(origin, "tag", "v1.2.3");
  git(origin, "tag", "-a", "v1.2.4-rc.1", "-m", "Annotated version");
  await writeFile(path.join(origin, "README.md"), "Newer branch source\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "Newer branch");
  newerCommit = git(origin, "rev-parse", "HEAD");
  git(origin, "branch", "v1.2.3");
  git(temporary, "clone", "--no-tags", "--depth=1", `file://${origin}`, checkout);

  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(responseStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  graphqlUrl = `http://127.0.0.1:${server.address().port}/graphql`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("resolves the remote tag commit instead of the selected branch or a same-named branch", () => {
  assert.equal(git(checkout, "rev-parse", "HEAD"), newerCommit);
  assert.equal(resolveReleaseTag("v1.2.3", { cwd: checkout }), releaseCommit);
  assert.equal(git(checkout, "rev-parse", "HEAD"), newerCommit);
});

test("peels annotated tags to the application commit", () => {
  assert.notEqual(git(origin, "rev-parse", "refs/tags/v1.2.4-rc.1"), releaseCommit);
  assert.equal(resolveReleaseTag("v1.2.4-rc.1", { cwd: checkout, expectedCommit: releaseCommit }), releaseCommit);
});

test("ignores stale local tags", () => {
  git(checkout, "tag", "v1.2.3", newerCommit);
  assert.equal(resolveReleaseTag("v1.2.3", { cwd: checkout }), releaseCommit);
  assert.equal(git(checkout, "rev-parse", "refs/tags/v1.2.3"), newerCommit);
});

test("refuses a tag moved after a run resolved its commit", () => {
  git(origin, "tag", "v1.2.5", releaseCommit);
  const commit = resolveReleaseTag("v1.2.5", { cwd: checkout });
  git(origin, "tag", "-f", "v1.2.5", newerCommit);
  assert.throws(() => resolveReleaseTag("v1.2.5", { cwd: checkout, expectedCommit: commit }), /tag v1.2.5 moved/);
});

test("refuses missing tags, branch-only versions, old tooling, and invalid tag input", () => {
  git(origin, "branch", "v2.0.0");
  for (const tag of ["v9.9.9", "v2.0.0"]) {
    assert.throws(() => resolveReleaseTag(tag, { cwd: checkout }), /does not exist or could not be fetched/);
  }
  assert.throws(() => resolveReleaseTag("v0.1.0", { cwd: checkout }), /does not contain scripts\/release-version.mjs/);
  for (const tag of [undefined, "", "main", "refs/tags/v1.2.3", "v1.2.3\ncommit=bad", "v1.2.3;touch bad", "--upload-pack=bad"]) {
    assert.throws(() => resolveReleaseTag(tag, { cwd: checkout }), /Use a version tag/);
  }
});

const check = (tag = "v1.2.3") => checkReleaseState(tag, { repository: "owner/bento", token: "test-token", graphqlUrl });

test("checks missing and draft releases through real HTTP, and blocks published releases", async () => {
  requests = [];
  responseStatus = 200;
  responseBody = { data: { repository: { release: null } } };
  assert.equal(await check(), "missing");
  assert.deepEqual(requests[0].body.variables, { owner: "owner", name: "bento", tag: "v1.2.3" });
  assert.equal(requests[0].authorization, "Bearer test-token");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/graphql");
  responseBody = { data: { repository: { release: { isDraft: true } } } };
  assert.equal(await check(), "draft");
  responseBody = { data: { repository: { release: { isDraft: false } } } };
  await assert.rejects(check(), /already published/);
});

test("API, authentication, permission, and malformed-response failures never mean missing", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    responseStatus = status;
    await assert.rejects(check(), new RegExp(`HTTP ${status}`));
  }
  responseStatus = 200;
  for (const body of [
    { data: { repository: { release: null } }, errors: [{ message: "Forbidden" }] },
    { data: { repository: null } },
    { data: { repository: {} } },
    { data: { repository: { release: {} } } },
  ]) {
    responseBody = body;
    await assert.rejects(check(), /Cannot check release/);
  }
  await assert.rejects(checkReleaseState("v1.2.3", { token: "", repository: "owner/bento", graphqlUrl }), /token/);
});

test("workflow entry point writes the exact tag and commit only after successful checks", async () => {
  const output = path.join(temporary, "github-output");
  const env = {
    ...process.env,
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/bento",
    GITHUB_GRAPHQL_URL: graphqlUrl,
    GITHUB_OUTPUT: output,
    EXPECTED_COMMIT: releaseCommit,
  };
  responseBody = { data: { repository: { release: { isDraft: true } } } };
  const result = await run(process.execPath, [script, "v1.2.3"], { cwd: checkout, env });
  assert.equal(result.stdout, "draft\n");
  const expected = `tag=v1.2.3\ncommit=${releaseCommit}\nstate=draft\n`;
  assert.equal(await readFile(output, "utf8"), expected);
  responseStatus = 503;
  await assert.rejects(run(process.execPath, [script, "v1.2.3"], { cwd: checkout, env }), /HTTP 503/);
  assert.equal(await readFile(output, "utf8"), expected);
});
