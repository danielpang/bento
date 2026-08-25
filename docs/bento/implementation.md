# Implementation: DeepSeek support

Implemented the independently shippable first part of the engineering plan: native DeepSeek models are now available to pi and opencode.

## What changed

- Added `DEEPSEEK_API_KEY` to the encrypted organization credential catalog, local environment example, Compose pass-through, hosted deployment docs, web provider tabs, and TUI setup.
- Added a native DeepSeek provider with its mark and the current documented text model ids, `deepseek-v4-pro` and `deepseek-v4-flash`.
- Added DeepSeek to the pi and opencode provider matrix, credential requirements, and sandbox environment forwarding. Existing OpenRouter DeepSeek models remain available.
- Changed `GET /api/secrets` to return `{ secrets, canManage }`. Web and TUI credential surfaces now show saved status to members without offering writes that their live organization role cannot perform.
- Added catalog, pairing, credential, adapter, API role, and local secret response coverage.

## Plan changes and gate outcome

Part 2, registering DeepSeek Harness as the `dsh` tool, was not started. The engineering requirements explicitly gate it on S1 and S2, including a real keyed model run. No `DEEPSEEK_API_KEY` is available in this environment.

The spike did verify `@deepseek-ai/dsh@0.1.1-rc.2` against a local OpenAI-compatible mock. A profile overlay can read the per-run model from `DSH_MODEL`, disable the Harness sandbox plugins, and use local bash and filesystem plugins. This is useful evidence, but it does not satisfy the written real-run gate or prove network containment against DeepSeek's service.

Upstream verification also changed two planned details:

- `deepseek-v3.2` and `deepseek-r1` are model version names, not current native API ids, so they were not added to the picker.
- pi and opencode read `DEEPSEEK_API_KEY` but not `DEEPSEEK_BASE_URL`, so the unused base URL credential remains part of the gated Harness work.

## Verification

- `pnpm typecheck`: passed all 22 tasks across 13 packages.
- Focused core, agents, web, and TUI suites: 171 tests passed.
- Full `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test`: 22 package tasks passed. The database-backed server task failed because this Sprite has no Postgres installation or Docker and `localhost:5439` refused connections.
- A live DeepSeek run was not possible without a credential.
