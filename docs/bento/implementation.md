# Reclaim a card's local workspace when it is marked done

## Summary

- When a card is marked done (or cancelled), local mode now deletes that card's host workspace: git worktrees are deregistered, then the workspace directory is removed, including leftover `node_modules` and other agent debris.
- Captured artifacts are left alone. `run_artifacts` rows and artifact-store bytes live outside the sandbox, so destroying a Docker container or a Fly sprite cannot take them with it. Tests lock that in.
- The boot sweep also reclaims leftover workspaces for cards that finished before this change, and for deleted cards whose directory husk was left behind.

The shared sandbox image (`bento-sandbox:dev`) is not deleted. It is one image for every card; the per-card disk is the container's writable layer (already reclaimed) plus the workspace (the actual leak).

## What changed

`WorktreeManager.removeWorkspace` deregisters each repository worktree, then deletes `<BENTO_DATA_DIR>/worktrees/<featureId>`. `reapSandbox` still destroys the machine first, then calls that method. It no longer returns early when there is no sandbox row, so a card whose provisioning failed still loses its workspace. An active run still throws so the job retries.

Feature delete uses the same path, so it no longer leaves an empty workspace directory behind.

The boot sweep still reaps machines of done and cancelled cards, then lists `worktrees/` and:

- cleans via `reapSandbox` when the feature is done or cancelled
- removes the directory when the feature is gone
- leaves active cards and names that are not feature ids alone

Multi mode is unchanged: sprites never create host worktrees, so the new step is a no-op. Artifacts were already stored in Postgres and the bucket before a sprite is destroyed.

## Test plan

- [ ] Mark a local-mode card done and confirm `<BENTO_DATA_DIR>/worktrees/<featureId>` is gone, while the origin still has the feature branch.
- [ ] Confirm the card's artifacts (stage write-up, images) are still readable on the card after the workspace is gone.
- [ ] Reopen or run the same card again and confirm the worktree comes back from the branch with committed history.
- [ ] Restart the server and confirm leftover workspaces of previously finished cards are swept.

`pnpm exec turbo run build && pnpm exec turbo run test` passed (Postgres on localhost:5432).
