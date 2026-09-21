import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { releaseVersion } from "./release-version.mjs";

export const releaseFiles = [
  "scripts/release-version.mjs",
  "scripts/package-cli.mjs",
  "apps/desktop/package.json",
  "apps/desktop/scripts/package.mjs",
  "apps/desktop/scripts/verify-update-artifacts.mjs",
];

export function resolveReleaseTag(tag, { cwd = process.cwd(), expectedCommit } = {}) {
  releaseVersion(tag);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    // Fetch the remote tag explicitly, ignoring stale local tags and branch names.
    git("fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${tag}`);
  } catch {
    throw new Error(`Release tag ${tag} does not exist or could not be fetched.`);
  }
  const commit = git("rev-parse", "--verify", "FETCH_HEAD^{commit}");
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error(`Release tag ${tag} moved: expected ${expectedCommit}, found ${commit}. Use a new version tag for changes.`);
  }
  for (const file of releaseFiles) {
    try {
      git("cat-file", "-e", `${commit}:${file}`);
    } catch {
      throw new Error(`${tag} does not contain ${file}. Choose a tag with the shared CLI and desktop release tooling.`);
    }
  }
  return commit;
}

export async function checkReleaseState(tag, {
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql",
} = {}) {
  releaseVersion(tag);
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
    throw new Error("A GitHub token and owner/repository are required to check the release.");
  }
  const [owner, name] = repository.split("/");
  // GraphQL finds drafts by their pending tag too. REST's release-by-tag route
  // only finds published releases, which would break retries of failed uploads.
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft } } }",
      variables: { owner, name, tag },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot check release ${tag}: GitHub returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.errors?.length || !result.data?.repository) {
    throw new Error(`Cannot check release ${tag}: GitHub did not return release access.`);
  }
  const release = result.data.repository.release;
  if (release === null) return "missing";
  if (release?.isDraft === true) return "draft";
  if (release?.isDraft === false) {
    throw new Error(`${tag} is already published. Its assets cannot be replaced. Use a new version tag for changes.`);
  }
  throw new Error(`Cannot check release ${tag}: GitHub returned an unexpected release response.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  const commit = resolveReleaseTag(tag, { expectedCommit: process.env.EXPECTED_COMMIT });
  const state = await checkReleaseState(tag);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${commit}\nstate=${state}\n`);
  }
  console.log(state);
}
