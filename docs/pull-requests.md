# Pull requests

Agents commit inside the sandbox. Getting that work onto GitHub is a separate step, and this is how it happens.

## Opening one

**Any stage can create a pull request.** Turn on "Create a pull request" when editing a stage, and a successful run there pushes the feature branch and opens a pull request per repository the agent committed in, or updates the one already open, since every stage of a card works on the same branch.

There is also a **Create PR** button on every card, which publishes whatever is committed right now without waiting for a stage to say so.

Whatever opened them, a card lists the pull requests it has open, one row per repository with its number, so they are still there tomorrow rather than only in the transcript of the run that made them. A card spanning a frontend and a backend gets one in each and is only finished when both are. The `checks_pass` and `pr_comments_resolved` criteria read all of them, and a repository the agent did not touch gets nothing. Stages without the setting keep their work in the worktree, so an investigation stage that commits nothing never opens an empty pull request.

## What does not ride along

Each stage commits a summary under `docs/bento/` so the next one can read it, which is how output flows between stages and between different agent CLIs. None of that is a reason to put six generated markdown files in front of a reviewer, so **the pushed head carries a commit that takes them back out**: the diff is the code, and the write-ups are still in the branch's history for anyone who goes looking.

Turn that off under **Settings, GitHub** to send them along too. On a shared server the setting belongs to the organization and only an owner or admin can change it; a local install keeps it beside the machine's other settings.

## Who pushes, and who is credited

**The server does the pushing, not the agent.** An agent can read anything its sandbox can, so a push credential inside one would be a write credential for every repository in the organization, one prompt injection from leaving. Agents are told to stay on their branch and never merge into `main` or `master`; publishing refuses a protected branch outright, because a prompt is a request and this is not.

Commits are attributed to the identity under **Settings, GitHub**. The server reads this machine's global git config, which a container does not have, so without a name and email the work arrives as `Bento Agent <agent@bento.dev>`. `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` still win when they are set, so an existing `.env` keeps working and CI stays predictable.

## Connecting GitHub

Two kinds of connection, and either is enough.

**A token**, which is the simple path for local and self-hosted installs: save a `GITHUB_TOKEN` under **Settings, GitHub** or in `.env`. Use a fine grained personal access token with Contents and Pull requests write access on the repositories the pipeline works in.

**The GitHub App**, for hosted deployments: configure `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_PRIVATE_KEY`. An organization owner installs it and selects repositories from the console, and Bento keeps each organization's short-lived write token on the server.

Without either, agents still commit and the work waits in the worktree; the run's transcript says exactly what is missing.

App setup, if you are configuring one: the setup URL is `<BENTO_URL>/api/github/callback` and the webhook URL is `<BENTO_URL>/api/webhooks/github`. Grant repository Contents read and write, Pull requests read and write, Checks read, and Metadata read. Subscribe to installation, installation repositories, pull request, check run, check suite, and pull request review events. Users must sign in to Bento with GitHub before connecting an installation, so Bento can verify that the installation is visible to their GitHub account.
