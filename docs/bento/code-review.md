# Code review: DeepSeek support

> Superseded for Part 2. This review covered the earlier provider-only commit. DeepSeek Harness was subsequently implemented and verified in `339c1f4` and the Part 2 completion commit; see [implementation.md](./implementation.md).

## Verdict

No blocking code findings in the implemented scope. This branch safely delivers Part 1 of the engineering requirements, native DeepSeek models for pi and opencode. It does not add DeepSeek Harness (`dsh`). That omission is intentional and matches the S1/S2 gate in `engineering-requirements.md`; the feature card remains incomplete until those gates can be satisfied.

## Requirements

Sound for Part 1.

- `packages/core/src/model-catalog.manual.ts:35-44` adds the DeepSeek provider, mark, key mapping, and the two current native API model ids.
- `packages/core/src/models.ts:82-83` exposes it only to pi and opencode, while the existing OpenRouter route remains available.
- `packages/agents/src/adapter.ts:173-184`, `opencode.ts:47-55`, and `pi.ts:17-23` require and forward the organization-scoped `DEEPSEEK_API_KEY` selected by the model prefix.
- `apps/server/src/routes/secrets.ts:48-60` derives `canManage` from live membership. `apps/web/src/components/Credentials.tsx:152-203` hides write controls from members while preserving saved status, as required.
- Part 2 was correctly not started without a real DeepSeek key and containment proof. No `dsh` enum, adapter, or toolchain entry was added under an unverified contract.

## Tests

The changed catalog, pairing, credential, adapter, and server role behavior have targeted coverage:

- `packages/core/src/models.test.ts:17-28`
- `packages/core/src/credentials.test.ts:72-78`
- `packages/agents/src/adapters.test.ts:436-444`
- `apps/server/src/auth.e2e.test.ts:918-929`

Review verification passed:

- `pnpm typecheck`: 22 of 22 tasks passed.
- `pnpm --filter @bento/core test`: 48 passed.
- `pnpm --filter @bento/agents test`: 46 passed.
- `pnpm --filter @bento/web test`: 69 passed.
- `pnpm --filter @bento/tui test`: 8 passed.

The remaining acceptance gap is explicit rather than hidden: no live pi or opencode call to DeepSeek was possible because this environment has no `DEEPSEEK_API_KEY`. Part 2 also still needs the real keyed S1 run and S2 network-containment check before implementation.

## Bugs and security

I found no reproducible bug in the implemented scope. Credential values remain write-only and tenant-scoped. Multi mode still resolves agent environment from organization secrets, and the route continues to re-read current membership before returning status or allowing mutation. Existing API consumers were updated for the `{ secrets, canManage }` response shape; the Mac app uses the unchanged `/api/secrets/plain` route.

## Clarity

The changes are clear and follow existing provider patterns. `docs/bento/implementation.md` plainly records both the delivered scope and why Harness itself is absent. `docs/agents.md` also distinguishes native DeepSeek models from DeepSeek Harness, which prevents users from mistaking this work for a `dsh` integration.
