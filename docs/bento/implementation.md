# Implementation: create a project from Settings, then Projects

Earlier-stage files (`docs/bento/product-investigation.md`, `design.md`, `engineering-requirements.md`) were not present. This change follows the existing console: Settings already listed, renamed, and removed projects, and the board already created them through `NewProjectDialog` and `POST /api/projects`.

## What changed

Settings, then Projects, now has a **New project** button. It opens the same create dialog as the board (local checkout paths, or GitHub repos on a hosted install). After a successful create:

- The list reloads.
- That project's settings open (`/settings?tab=projects&project=<id>`).
- The new project is remembered as the selected one, so Back to board does not drop the person on the previous project.

The empty state no longer says to create from the board. Config's pipeline export empty copy now says to create a project first, rather than naming only the board.

No new server route, migration, or `bento-cloud` change. The TUI already had Create project on its Projects list.

## How to verify

1. Open Settings, then Projects.
2. Click New project, give it a name (and a checkout path in local mode).
3. Confirm the new project's settings open, it appears in the list after Back, and the board picker selects it.

`DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test` passed (25 turbo tasks, including the new `@bento/web` cases in `apps/web/src/projects-settings.test.ts`). `pnpm --filter @bento/web typecheck` passed.
