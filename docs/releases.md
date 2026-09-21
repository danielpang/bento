# Releasing Bento

The **Release** GitHub Actions workflow builds the CLI and both Mac installers
from one existing version tag, such as `v0.1.3`. Pushing a `v*` tag starts it
automatically. Tags must contain the shared CLI and Electron packaging tooling;
older tags from before the Electron app cannot use this pipeline.

To start or retry a release manually, open **Actions > Release > Run workflow**,
select **main**, enter the existing tag, and run it. The equivalent GitHub CLI
command is:

```sh
gh workflow run release.yml --ref main -f tag=v0.1.3
```

The selected branch supplies the workflow and its validation helpers. The tag
supplies the application source: the workflow resolves it to one commit and uses
that exact commit for every CLI and Mac build. Manual dispatch neither creates a
tag nor releases the selected branch's current application code. GitHub shows the
manual trigger after this workflow has landed on the default branch. See
[GitHub's manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Automatic and manual runs for the same tag share a concurrency group. One run
finishes before another can build that tag. A failed build publishes nothing;
a failed upload can leave a draft. Dispatch the same tag to rebuild and replace
its draft assets. The workflow checks the remote tag again before uploading and
publishing, and refuses if it has moved or the release is already published.
Authentication failures and GitHub API errors stop the run instead of being
treated as a missing release. Published assets are never intentionally replaced;
use a new version tag for changes. Avoid editing the tag or publishing its draft
by hand while the workflow runs.

The standalone **Desktop** workflow builds Mac artifacts for inspection without
publishing a GitHub release. Use **Release** when both applications should be
published. Signing setup and Mac update behavior are documented in the
[Mac application guide](../apps/desktop/README.md).

Validate changes to the release helper locally with:

```sh
node --test scripts/release-target.test.mjs
actionlint .github/workflows/release.yml .github/workflows/desktop.yml .github/workflows/ci.yml
```

The tests use real temporary Git repositories and HTTP requests to exercise
existing lightweight and annotated tags, stale local refs, moved or missing tags,
draft retries, published releases, and API failures. They do not publish releases.
