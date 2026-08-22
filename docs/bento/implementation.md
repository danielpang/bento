# Implementation: pool agent and Poolside models on the board

Added Poolside as a first-class agent throughout core, web, TUI, server, sandbox provisioning, and documentation. Organizations can save `POOLSIDE_API_KEY`, create a `pool` profile with the documented `poolside/laguna-s-2.1` model, and run it through `pool exec` with structured transcript events and actionable authentication or model errors.

The implementation installs `pool` in Docker and Sprite sandboxes with headless EULA acceptance, without bumping the toolchain version. Tests cover catalog pairing, command and environment construction, real CLI event shapes, failures, installer parity and retry behavior, and truthful web and TUI conversation copy.

## Plan changes

Real `pool` 1.0.16 captures changed four assumptions in the engineering plan:

- API-key runs require `POOLSIDE_STANDALONE_BASE_URL`, so Bento supplies the Poolside Platform URL while local runners may override it through their environment. Hosted enterprise endpoint settings remain out of v1.
- JSON output uses `assistantMessage` for reader-facing prose and `thought` for thinking.
- JSON output contains no run ID. Later card messages therefore start a fresh run, and both web and TUI copy say so rather than using unsafe bare `--continue`.
- Only `poolside/laguna-s-2.1` has a verified native ID, so the picker does not guess IDs for other Laguna models. Custom IDs remain typeable.

Because standalone API-key mode ignores the CLI login, `.config/poolside` is not mounted as an authentication alternative.

## Verification

- `corepack pnpm typecheck`: passed, 22 tasks.
- Core, agents, sandbox, TUI, and focused server executor tests: passed.
- `corepack pnpm test`: all non-server packages passed; the server suite could not connect to its required PostgreSQL service on port 5439. This VM has neither PostgreSQL nor Docker available.
- Real Sprite provisioning was not run because `BENTO_SPRITE_E2E` is not configured.
- The sandbox image was not built because Docker is unavailable.
