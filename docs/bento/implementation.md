# Implementation: DeepSeek Harness

Implemented DeepSeek Harness (`dsh`) as a preview coding agent, in addition to the native DeepSeek provider support already delivered for pi and opencode.

## What changed

- Registered `dsh` across the core enum, profile schema, model catalog, API validation, adapter registry, web console, and TUI.
- Added a one-shot text adapter for `dsh --profile headless`. It selects the model through `DSH_MODEL`, forwards the organization-scoped DeepSeek key and optional base URL, and turns final stdout into one assistant message.
- Added bounded plain-text stdout support to the shared agent executor. Existing JSON event adapters keep their prior behavior.
- Pinned `@deepseek-ai/dsh@0.1.1-rc.2` in Docker and Sprite provisioning, upgraded the private agent-only Node runtime to 22.22.2, and added a version-aware warm-sandbox upgrade path.
- Added the headless profile overlay, native local tools, automatic permissions inside Bento's outer sandbox, and disabled Harness web search.
- Added preview and capability copy, a quiet running state with elapsed time, a long-run warning, cold follow-up messaging, and actionable Harness failure messages.
- Added core, adapter, provisioning, server, web, TUI, and route-level coverage.

## Plan changes

The previous implementation stopped after provider support because the written S1/S2 gates asked for a real DeepSeek credential. The follow-up requirement made Harness itself mandatory. Upstream and package inspection established the missing model and containment contracts, and a mock endpoint verified the request, tools, stdout, and exit behavior. No production DeepSeek key was available, so this implementation does not claim a real service acceptance run.

Harness cannot simultaneously disable its nested sandbox and enforce workspace-only access itself. The implementation therefore uses Bento's existing Docker or Sprite sandbox as the sole security boundary, matching the repository's other permission-disabled agents. This is the material change from the earlier plan.

## Verification

- `pnpm typecheck`: all 22 tasks passed.
- Focused core, agents, sandbox, server orchestrator, web, and TUI suites passed. The sandbox suite ran 64 tests and skipped the credentialed real-Sprite E2E as designed.
- The full `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test` run passed 22 of 23 package tasks. One unrelated Linear inbound timing test failed under full parallel load; rerunning that exact test alone passed in 10 seconds.
- A published-package smoke test completed `dsh --profile headless --dump-config` with the pinned package and shipped profile.
- A real DeepSeek API run was not possible because this environment has no `DEEPSEEK_API_KEY`.
