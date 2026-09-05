# Pull requests

Agents commit in the sandbox. GitHub publication is a separate server-side step.

## Opening a pull request

If you want an agent to create a PR for their changes you can Enable **Create a pull request** on a stage. After a successful run, the server pushes the feature branch and opens or updates one pull request per repository with commits. All stages on a card share one branch.

**You can also click the Create PR** button in the card drawer publishes current commits without waiting for stage completion.

The card lists open pull requests by repository. Multi-repo cards require a PR in each repo for completion gates (`checks_pass`, `pr_comments_resolved`). Untouched repositories are skipped. Stages without the flag keep work in the worktree only.

## Stage artifacts in pull requests

Stages write summaries under `docs/bento/` for downstream stages. Before publication, Bento removes these files from the branch tip. The PR diff contains code changes only. Files remain in git history.

You can keep the artifacts under **Settings, GitHub**. On shared servers, the setting is organization-scoped (owner or admin). Local installs store it with machine settings.

## Push and attribution

The server pushes the changes; agents do not receive push credentials. Publishing rejects protected branches (`main`, `master`).

Commit author is configured under **Settings, GitHub**. Defaults to `Bento Agent <no-reply@usebento.ai>` if no values are set.

## GitHub connection

You can connect to Github with the following options:

**Personal access token** (local and self-hosted): set `GITHUB_TOKEN` under **Settings, GitHub** or in `.env`. Requires Contents and Pull requests write on target repositories.

**GitHub App** (only on hosted solutions like [usebento.ai](https://usebento.ai)): An organization owner installs the App and selects repositories. Bento stores short-lived installation tokens per organization.

Without either, agents commit locally. The transcript will report Github is not configured.

**Create a Github application with the following values:**


| Setting     | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Setup URL   | `<server URL>/api/github/callback`                                                                 |
| Webhook URL | `<server URL>/api/webhooks/github`                                                                 |
| Permissions | Contents R/W, Pull requests R/W, Checks read, Metadata read                                        |
| Events      | installation, installation repositories, pull request, check run, check suite, pull request review |


Then set the following values as environment variables: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.