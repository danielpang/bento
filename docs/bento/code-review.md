# Large multi-tasks — code review

Review of `98fbb71` (and the review-stage fixes on top of it) against [product-investigation.md](./product-investigation.md) and [engineering-requirements.md](./engineering-requirements.md). All product code is in `bento`. `bento-cloud` has no changes, which matches the billing design: the 24-hour ceiling is per `agent_runs.feature_id`, and the team allowance already sums every run.

## Verdict

**Ready to merge after the review fixes, once `pnpm typecheck` and `pnpm test` have been run on a machine with the toolchain.** The model, the agent door, and the console shape match the investigation. Two bugs would have shipped: the related-cards client never named the card, so the drawer and overlay could not load a group, and a child that itself split was treated only as a child, so its parts vanished from the related view, the highlight, and the delete guard.

This environment has Node 24 but no `pnpm`, no installed workspace, and no Postgres, so the full suite was not run here. The pure `cards.ts` tests were executed (9/9 pass). The server e2e and gateway tests still need a database.

## Requirements

| Check | Status |
| --- | --- |
| A card stays a card; association is `features.parent_id` | Met. Nullable, self-referential, no cascade. |
| Agent may spawn only children of the card it is working | Met. Parent, project, and org come from the grant's run. No update or delete tool. |
| Efficiency gate is prompt-level; cap and no-auto-run are mechanical | Met. Tool description, initialize instructions, and `buildStagePrompt` (only when `canSplitCard`). Cap 20, depth 3, insert never calls `startRunIfIdle`. |
| Same project, cycles bounded, delete refuses while parts exist | Met. Shared `parentRefusal`. Insert-only write path cannot form a cycle; the ancestor walk is bounded so a cycle that arrived some other way is a refusal, not a hang. Delete is 409 with the shared sentence, now inside the row lock. |
| Parent keeps going; finishing it leaves parts alone | Met. No pipeline change. E2e pins the finish half. |
| Badge on the parent, none on an ordinary card | Met. Client-derived `childStats`, beta-only. |
| Related view from either end, orthogonal arrows, done and cross-lane parts included | Met after the client URL fix. Paths are `M H V H`; rows come from `/related`, not the board snapshot. |
| Badge opens the related view | Departed, justified. The card is already a `<button>`; a nested button is invalid HTML. The view opens from the drawer. |
| `childStats` on board payloads | Departed, justified. Same project means the board already holds every part; deriving keeps the badge on the board stream. |
| New routes behind `beta-testers`; `/related` in the foreign-tenant matrix | Met. Card tools also gated via `isBetaRun`. |
| Billing: no bento-cloud change | Met. Group spend is per-card in the related view, not a new meter. |
| Tests: route, gateway, badge, related, delete, finish | Written. Not all executed here. No live “file a card, let an agent spawn two, read the rows” check yet — the implementation already called that out. |

## Strengths

- One module (`feature-tree.ts`) owns the refusals both doors use, so the HTTP route and the MCP tool cannot drift.
- The virtual `bento` server is the right shape: no row, no credential, grant-scoped, SSE paths refuse the id instead of handing `"bento"` to Postgres as a uuid.
- Server-side parentage is actually server-side. The agent cannot name a parent or a project.
- The efficiency gate is written as a test to fail, twice, and is omitted when the tools never reached the sandbox.
- Console changes stay off the happy path for teams that never split: no badge, no dim, no drawer section, all behind `<BetaOnly>` / `useBetaTesters`.
- Arrow orthogonality is a property of the layout, and the tests assert on path data rather than pixels.
- Delete copy is shared (`parentDeleteRefusal`) between the disabled button and the 409.

## Issues found in review

### Critical (fixed)

1. **`relatedFeatures` dropped the card id.**
   - Was: `` `/api/features//related` ``
   - The drawer loads the group through this client, and the overlay does too. A 404/400 would be swallowed (`catch (() => {})`), so Parts, Part of, Show related cards, and the delete disable never appeared, even though the server and the board badge were fine. Server e2e talks to Hono directly, so it could not have caught this.
   - Fix: `` `/api/features/${featureId}/related` ``, with a client test that asserts the path.

### Important (fixed)

2. **A mid-level parent was treated only as a child.**
   - `relatedGroup` and the board highlight always walked up (`parentId ?? id`). Depth 3 is allowed, and a child may itself split. Opening related from that middle card showed its *parent’s* group and hid its own parts. The drawer then showed “Part of” instead of “Parts”, so Delete was not disabled even though the server would 409.
   - Fix: a card that has children is the root of its own one-level group (`relatedRootId` in `@bento/core`, same rule on the server). The ancestor is returned as `partOf` so the drawer can show both sections. Board highlight uses the same root. Tests cover the helper, the board ring, and the `/related` payload.

3. **Delete counted children outside the row lock.**
   - A part filed between the count and the `DELETE` would surface as a foreign-key 500 instead of the named 409.
   - Fix: count after `FOR UPDATE` on the parent row.

### Minor (not changed)

4. **`GET /related` in the foreign-tenant matrix is weaker than it looks.** In `auth.e2e.test.ts` the app is multi-mode without PostHog, so `getBetaTester` is always false and the handler 404s before `getAccessibleFeature`. The matrix still gets 404 for a stranger, but it does not prove the access helper runs. The helper is in the handler; the gap is the test.
5. **Child cap is check-then-insert.** Two concurrent HTTP creates on the same parent can theoretically pass 20. One agent per card makes the MCP path sequential; the HTTP race is narrow. A unique partial index or a locked count would close it.
6. **Group spend is per card, not a printed total.** Billing policy is already correct (hours stay on the card that ran them). The requirements mentioned a sum in the related view; each mini-card shows its own figure instead. Fine for v1.
7. **Handwritten migration snapshot.** `0023_feature_parent.sql` and `0023_snapshot.json` were written by hand. `pnpm --filter @bento/db db:generate` should report nothing to add before the next migration is generated.
8. **No cycle-specific HTTP test.** v1 never updates `parent_id` on an existing row, so a cycle cannot be created through either door. The depth walk is the backstop. Worth a test the day a PATCH exists.

## What this review changed

- `packages/api-client/src/client.ts` — interpolate the feature id; `client.test.ts` pins the URL.
- `packages/core/src/cards.ts` — `relatedRootId`; tests for mid-level vs leaf.
- `apps/server/src/feature-tree.ts` — root is the card that has children; `partOf` for the ancestor.
- `apps/server/src/routes/features.ts` — delete refusal inside the lock.
- `apps/web` — board highlight and drawer follow the same root rule; both “Parts” and “Part of” when a card is both.
- Tests in `board-card.test.ts` and `e2e.test.ts` for the mid-level group.

## Still required before calling it done

On a machine with the repo’s toolchain and Postgres:

```bash
pnpm install
pnpm typecheck
DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
pnpm --filter @bento/db db:generate   # confirm it adds nothing
```

Then the check no suite replaces: file a card, let an agent split it through a live gateway, and read the rows back.
