# Large multi-tasks: implementation

What was built for the decision in [product-investigation.md](./product-investigation.md) and the design in [engineering-requirements.md](./engineering-requirements.md): a card stays a card, and the agent working it may spawn associated child cards when the work is large and worth dividing.

All changes are in the `bento` repository. `bento-cloud` needed none, which the requirements had already verified: the 24 hour ceiling is keyed on `agent_runs.feature_id`, so every part gets its own clock, and the team allowance already sums every run in the organization, so splitting cannot route around the pool.

## The model: one column

`packages/db/src/schema/app.ts`, migration `0023_feature_parent.sql`.

```sql
ALTER TABLE features ADD COLUMN parent_id uuid REFERENCES features(id);
CREATE INDEX features_parent_idx ON features (parent_id);
```

Nullable, self-referential, no cascade. Null is an ordinary card, which is nearly every card. No container type, no join table, and the edge means "that card spawned this one": not a dependency, not a blocker, not an ordering. `features` already carries `organization_id`, its RLS policy and the `bento_inherit_org` trigger, so a column on it inherits all three isolation layers and `rls.test.ts` needs no change.

## The rules a column cannot state: `apps/server/src/feature-tree.ts`

One module, so the HTTP route and the agent-facing tool refuse the same things in the same words.

- **Same project.** Enforced on every write path. A group spanning projects would break the board query, the related view, and the tenant column every card inherits from its project.
- **Bounded depth** (`MAX_PARENT_DEPTH = 3`). A part may itself split, which the investigation allows, but the view shows one level. The ancestor walk that enforces it is also what makes a cycle terminate in a refusal rather than a hung request.
- **A cap of 20 parts per card** (`MAX_CHILDREN_PER_CARD`), checked wherever a part is filed from.
- `relatedGroup` resolves upward from a part first, so a parent and any of its parts answer with the same group, read from the rows rather than from the caller's board.

## The agent's door: a virtual MCP server

`apps/server/src/mcp/bento-tools.ts`, wired into `apps/server/src/routes/mcp-gateway.ts` and `apps/server/src/orchestrator/mcp-run.ts`.

Server id `bento`, answered in process by the gateway instead of proxied. It is not a row in `mcp_servers`: no upstream, no credential, no admin configured it, and it rides the run-scoped grant the gateway already mints, so it dies with the run like everything else. Two tools:

| Tool | Behaviour |
| --- | --- |
| `create_card` | `{title, description}`. Inserts a feature in the run's project with `parent_id` set to the run's own card. Lands in `backlog` with no run started. |
| `list_child_cards` | The parts already filed, so a re-queued run does not file everything twice. |

What holds it in place:

- **Nothing is named by the agent.** The parent, project and organization all come from the grant's run. There is no card id to pass, so there is nothing to forge, and the tool cannot touch any card but the one its run is working.
- **No update and no delete.** A tool that could rewrite a card would make every repository an agent reads a way to rewrite the board.
- **Nothing is started.** The insert never calls `startRunIfIdle`. A part is activated the ordinary way, so `canActivateFeature`, the plan's allowance and the project's auto-start setting all still decide when an agent picks it up.
- **The same side effects as `POST /api/features`**: the analytics event (tagged `source: "agent"` with the parent id), `queueLinearIssueCreate`, and a board bus event so open consoles repaint while the run is still going.
- The gateway's rate bucket, body cap and usage counter apply unchanged. `resolveTarget` refuses the `bento` id explicitly, so the SSE transport's paths answer 404 instead of asking Postgres to read `bento` as a uuid.

**The efficiency gate is prompt level, because code cannot judge scope.** It is stated twice, both times as a test to fail rather than a capability to enjoy: in the tool description, and in a paragraph `buildStagePrompt` adds only when the tools actually reached the sandbox (`canSplitCard`). Both name the two conditions, the file-contention case, and "most cards are one change and should end with no parts at all". The cap, the depth limit and the no-auto-run rule are the mechanical backstops when an agent ignores it.

## API

- `POST /api/features` takes an optional `parentId`: resolved through `getAccessibleFeature` (404, so naming another tenant's card teaches nothing), then through the shared refusals (400).
- `GET /api/features/:id/related` returns `{parent, children}` or `null`, behind the `getBetaTester` 404 convention. Added to the foreign-tenant matrix in `auth.e2e.test.ts`.
- `DELETE /api/features/:id` refuses a card that has parts, with 409 and a sentence naming the count. Before the transaction, so the answer names the count rather than surfacing a foreign key violation as a 500.
- `parentId` reaches every client for free: the board list and the card detail both `select()` the whole row.

## Console

- **Badge.** One chip in the card's existing `.card-meta-end` row, beside the spend and the pull request: the number of parts, toned by the group's worst news first (a failure, then one still moving, then all done). A card that was never split renders nothing new, which is acceptance check 8.
- **Group highlight.** Selecting a card in a group rings the card it came from and the other parts, wherever they sit, and dims the rest. No arrow is ever drawn on the board itself.
- **Related-cards view.** A `Modal` opened from the drawer, from either end. Layout is computed from the number of parts alone and the arrows are drawn from the same numbers, so the two cannot disagree. Every path is `M … H … V … H …`; arrowheads are `<polygon>`, so there is no command anywhere in the view's path data that could draw a diagonal.
- **Drawer.** "Parts" on the card a split came from, with a row per part; "Part of" on a part, which is the way back. Delete is disabled on a parent with the same sentence the server answers with.
- All of it is behind the beta flag, and the parts are read from `/related` rather than from the board snapshot, so a finished part or one dragged into another lane is always in the picture.

## Two deliberate departures from the engineering requirements

1. **The badge's counts are derived on the client, not shipped as a `childStats` field on board payloads.** Every part of a card is a card in the same project, so a console showing the board already holds all of them and their run statuses. Deriving costs no query, and it makes the badge live off the same board stream everything else repaints from. `childStatsFrom` lives in `@bento/core` with its own tests. The server-side grouped query would have been a second source of truth that goes stale between refreshes.

2. **The badge is a chip, not a button.** The requirements had the related view open from the badge. The board card *is* a `<button>`; a second button inside it is invalid HTML and steals the click a keyboard user aimed at the card. The badge stays the at-a-glance fact the investigation asks for, and the view opens from the drawer, which is one click away and is also where a part finds its way back to the parent.

One thing the requirements did not settle, decided here: **the card tools are behind the beta flag too**, via a new `isBetaRun` (the acting member, or the project's owner for an auto-started run). An agent that can split a card for a team whose board cannot show the group has made work nobody can see the shape of. Noted in AGENTS.md beside the other two beta conventions.

## The parent after it splits

**Keep going**, as the requirements resolved it. Spawning has no effect on the parent's pipeline; it finishes its stage and carries whatever scope the agent kept for itself. An e2e test pins the other half: finishing the parent leaves its parts alone.

## Tests

- `packages/core/src/cards.test.ts`: the badge's counts and tone, including that a finished part counts as done whatever its last run said.
- `apps/web/src/related-cards.test.ts`: the arrows carry no diagonal command, a part level with the parent still gets one straight line, and a finished part and a backlog part are both drawn.
- `apps/web/src/board-card.test.ts`: the badge and its tone, the group ring and dim, and that a card with no parts and a viewer off the flag both see no change at all.
- `apps/server/src/orchestrator/prompt.test.ts`: both conditions are in the prompt when the tool is attached, and nothing about splitting is said when it is not.
- `apps/server/src/mcp/gateway.e2e.test.ts`: the tool list, a card parented to the run's own feature with no run started, the cap, an unknown tool, a grant that never pinned `bento`, revocation, and the SSE paths refusing.
- `apps/server/src/e2e.test.ts`: the group reads the same from either end, a finished part is still in it, cross-project and unknown parents are refused, the depth limit, the cap, the delete refusal with the parts intact, and finishing the parent leaving them alone.
- `apps/server/src/auth.e2e.test.ts`: `/related` in the foreign-tenant matrix.

## Not verified here, and it should be before merge

This sandbox has no Node toolchain and no installed dependencies, so **`pnpm typecheck` and `pnpm test` were not run**, and nothing was driven in a browser or against Postgres. Against this repository's own rule ("verify against something real before calling it done") that is the outstanding gap in this stage, not a formality. The first thing to do on a machine that can run them:

```bash
pnpm install
pnpm typecheck
DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
pnpm --filter @bento/db db:migrate
```

`0023_feature_parent.sql`, its journal entry and its drizzle snapshot were written by hand rather than generated. Run `pnpm --filter @bento/db db:generate` once and confirm it reports nothing to add: a snapshot that does not match the schema would make the next migration re-emit this column.

Then the real check, which no test replaces: file a card, let an agent split it through a live gateway, and read the rows back out of Postgres.

## Out of scope, unchanged

Dependency edges and scheduling, combined pull request merging, worktree sharing, deep-tree UI (the data model supports depth, the view shows one level), the Linear parent round trip, re-parenting, and any billing policy change.
