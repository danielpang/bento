# Implementation: DeepSeek Harness

Completed Part 2 of the engineering plan: DeepSeek Harness (`dsh`) is a preview coding agent in Bento, in addition to the native DeepSeek provider support already delivered for pi and opencode.

## What changed

- Registered `dsh` across the core enum, profile schema, model catalog, API validation, adapter registry, web console, and TUI.
- Added a one-shot text adapter for `dsh --profile headless`. It selects the model through `DSH_MODEL`, forwards the organization-scoped DeepSeek key and optional base URL, and turns final stdout into one assistant message.
- Added bounded plain-text stdout support to the shared agent executor. Existing JSON event adapters keep their prior behavior.
- Pinned `@deepseek-ai/dsh@0.1.1-rc.2` in Docker and Sprite provisioning, upgraded the private agent-only Node runtime to 22.22.2, and added a version-aware warm-sandbox upgrade path.
- Added the headless profile overlay, native local tools, automatic permissions inside Bento's outer sandbox, and disabled Harness web search.
- Added preview and capability copy, a quiet running state with elapsed time, a long-run warning, cold follow-up messaging, and actionable Harness failure messages.
- Added core, adapter, provisioning, server, web, TUI, and route-level coverage.
- Added a real-Sprite behavioral check that runs the installed Harness with Bento's exact profile against an in-sandbox mock endpoint, exercises local bash, and verifies the selected model, credential, final output, and exit status.

## Plan changes

The previous implementation stopped after provider support because the written S1/S2 gates asked for a real DeepSeek credential. The follow-up requirement made Harness itself mandatory. Upstream and package inspection established the missing model and containment contracts. The pinned published package was then run with the exact shipped `DSH_HOME` profile and runtime environment against a controlled endpoint: it selected `deepseek-v4-pro`, sent the DeepSeek credential, executed local bash, wrote the requested workspace file, printed one final message, and exited zero.

Harness cannot simultaneously disable its nested sandbox and enforce workspace-only access itself. The implementation therefore uses Bento's existing Docker or Sprite sandbox as the sole security boundary, matching the repository's other permission-disabled agents. This is the material change from the earlier plan.

## Verification

- `pnpm typecheck`: all 22 tasks passed.
- Focused core, agents, sandbox, server orchestrator, web, and TUI suites passed.
- Full `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test`: all 23 tasks passed, including 280 server tests.
- The real published `@deepseek-ai/dsh@0.1.1-rc.2` passed the exact headless profile and local-tool behavioral run described above.
- The credentialed real-Sprite test could not run locally because `SPRITES_TOKEN` is absent. It is wired into `.github/workflows/sandbox-e2e.yml`, now including the full dsh behavioral probe rather than only `--version`.
- A production DeepSeek API request could not run locally because `DEEPSEEK_API_KEY` is absent. Provider request shape and execution behavior were verified against the controlled compatible endpoint instead.
