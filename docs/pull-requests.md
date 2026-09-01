# Pull requests

Agents commit inside the sandbox. Getting that work onto GitHub is a separate step.

## Opening one

**Any stage can create a pull request.** Turn on "Create a pull request" when editing a stage. A successful run there pushes the feature branch and opens one pull request per repository the agent committed in, or updates the one already open. Every stage of a card works on the same branch.

There is also a **Create PR** button on every card, which publishes whatever is committed right now without waiting for a stage to say so.

A card lists the pull requests it has open, one row per repository with its number, however they were opened. A card spanning a frontend and a backend gets one in each, and is finished only when both are. The `checks_pass` and `pr_comments_resolved` criteria read all of them. A repository the agent did not touch gets nothing. Stages without the setting keep their work in the worktree, so an investigation stage that commits nothing never opens an empty pull request.

## What does not ride along

Each stage commits a summary under `docs/bento/` for the next one to read. That is how output moves between stages and between different agent CLIs. Reviewers do not need six generated markdown files, so **the pushed head carries a commit that removes them again**. The diff is the code. The write-ups remain in the branch's history.

Turn that off under **Settings, GitHub** to send them along too. On a shared server the setting belongs to the organization, and only an owner or admin can change it. A local install keeps it with the machine's other settings.

## Who pushes, and who is credited

**The server does the pushing, not the agent.** An agent can read anything its sandbox can. A push credential inside one would be a write credential for every repository in the organization, one prompt injection away from leaving. Agents are told to stay on their branch and never merge into `main` or `master`, and publishing refuses a protected branch outright. An instruction in a prompt can be ignored; the refusal cannot.

Commits are attributed to the identity under **Settings, GitHub**, which is the only place that sets it. Left blank, the server falls back to the machine's global git config. A container has none, so the work arrives as `Bento Agent <no-reply@usebento.ai>`.

## Connecting GitHub

Two kinds of connection, and either is enough.

**A token** is the simple path for local and self-hosted installs. Save a `GITHUB_TOKEN` under **Settings, GitHub** or in `.env`. Use a fine grained personal access token with Contents and Pull requests write access on the repositories the pipeline works in.

**The GitHub App** is for hosted deployments. Configure `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_PRIVATE_KEY`. An organization owner installs it and selects repositories from the console. Bento keeps each organization's short-lived write token on the server.

Without either, agents still commit and the work waits in the worktree. The run's transcript says what is missing.

### Connecting your own GitHub account

Bento binds an installation to an organization only for someone GitHub already shows that installation to. That is how it knows the installation is yours to connect. Signing in with GitHub answers this on its own. Signing up with an email and password does not, so those accounts connect a GitHub account first, from **Settings, GitHub** or from beside the install button. It sends you to GitHub and back, and then the install is one click away.

The two addresses need not match. The connection is yours rather than the organization's: nothing is pushed with it, and it is only read to check what you can see on GitHub.

Reconnect from the same card if GitHub stops accepting it, which is what the "no longer connected" message means, or to move the connection to a different GitHub account.

App setup, if you are configuring one. The setup URL is `<your server URL>/api/github/callback` and the webhook URL is `<your server URL>/api/webhooks/github`. Grant repository Contents read and write, Pull requests read and write, Checks read, and Metadata read. Subscribe to installation, installation repositories, pull request, check run, check suite, and pull request review events.

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the same App. They are what let people connect a GitHub account. Without them nobody on the deployment can install anything, however they signed in.
