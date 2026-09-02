# Large multi-tasks: engineering requirements

Technical design for the decision in [product-investigation.md](./product-investigation.md): a card stays a card, and the agent working it may spawn associated child cards when the work is large and worth dividing. This document defines the data model, the agent-facing capability, the API, the console UI, and the guardrails. It resolves the investigation's open question about the parent's pipeline.

## Data model

One new column, no new table.

```sql
ALTER TABLE features ADD COLUMN parent_id uuid REFERENCES features(id);
CREATE INDEX features_parent_idx ON features(parent_id);
```

- **Self-referential, nullable.** Null means what it means today: an ordinary card. No container type, no join table; the relationship is "this card spawned that one" and nothing else.
- **Same project required.** The server validates that parent and child share a `project_id`. A cross-project parent would break the board query, the related view, and the RLS assumption that a group lives in one tenant.
- **No new RLS work.** `features` already carries `organization_id`, its policy, and the inherit trigger. A column on an existing tenant table inherits all three layers.
- **Delete rule: refuse.** The FK has no cascade, matching the existing "no action" group (`features.current_stage_id`, `agent_runs.agent_profile_id`): deleting a parent with children is refused, and the console's delete confirmation says so and names the count. Detaching children first is the escape hatch (a follow-up PATCH; v1 can require deleting children first). This satisfies acceptance check 6: the effect is defined and visible before it happens.
- **Cycles forbidden.** The write path walks the ancestor chain (bounded, the chain is short in practice) and refuses a parent that is the card itself or any descendant. A child may itself become a parent; the investigation allows that, only the v1 UI stays one level deep.
- **Finishing or cancelling a parent leaves children untouched.** They are independent cards with their own branches and pipelines.

## How an agent creates cards: a built-in Bento MCP server

The sandbox has no channel to the board today, but the MCP gateway is exactly the right one: agents already receive per-harness MCP config pointing at `/api/mcp-gateway/<serverId>` with a run-scoped bearer token (`mintRunGrant`), the token dies when the run settles, and no real credential ever enters the sandbox.

Design: a **virtual server id `bento`**, handled in-process by the gateway instead of proxied upstream. `prepareRunMcp` adds it to every run's config alongside the organization's real servers. The grant row already identifies the run; the run identifies the feature, project, and organization, so the tool needs no new credential and no new token format.

Tools exposed, deliberately minimal:

| Tool | Behaviour |
| --- | --- |
| `create_card` | `{title, description}`. Inserts a feature in the run's project with `parent_id` set to the run's feature. Returns the new card's id and title. Lands in `backlog` with no run started. |
| `list_child_cards` | Children of the run's feature: id, title, status, stage. Exists so a resumed or re-queued run can see what it already created instead of duplicating. |

Rules the implementation must hold:

- **Server-side truth for parentage.** The tool derives project and parent from the grant's run. The agent cannot name a parent, a project, or any other card. It can create children of the card it is working, nothing else. No update or delete tools in v1.
- **Children do not auto-run from the tool.** They enter the board the way a human-filed or Linear-filed card does and go through the existing activation path, including `canActivateFeature` entitlements and the project's existing auto-start setting. The spawn tool never calls `startRunIfIdle`.
- **Per-run child cap** (20) enforced at the tool, on top of the gateway's existing per-grant rate bucket. A chatty or injected agent gets a refusal string, not twenty-first card.
- **Injection posture.** Card titles and descriptions are agent output and therefore untrusted; they are inert rows rendered as text (react-markdown, raw HTML off), same as today. The tool grants no read access beyond the run's own children.
- **Mirrors existing create semantics.** The insert goes through the same code path effects as `POST /api/features`: analytics event, `queueLinearIssueCreate`, and a board bus event so open consoles refresh while the run is still going.
- **Availability matches MCP availability.** Harnesses without MCP support, restricted-network organizations, and the local-process driver run without the tool, with the existing transcript note. That is an accepted v1 limitation, not a blocker.

**The efficiency gate is prompt-level, not code-level.** The tool description and a paragraph appended by `prompt.ts` (only when the tool is attached) state both conditions from the investigation: split only when the task is large and dividing it is more efficient than one agent on one branch, and parts that would fight over the same files must not split. Code cannot judge scope; the cap and the no-auto-run rule are the mechanical backstops.

## API

All routes follow the access-helper and 404 conventions and join the matrix test in `auth.e2e.test.ts`.

- `POST /api/features` accepts an optional `parentId` (validated: accessible, same project, no cycle), so people and the TUI can file children by hand.
- `GET /api/features/:id/related`: the group for the related-cards view. Resolves the card, walks to its parent if it is a child, and returns `{parent, children: [...]}` with id, title, status, stage name, spend, and `prNumber` per card. One endpoint, one query with a grouped join, so the view cannot miss a done or cross-lane child (acceptance check 2).
- Board payloads (`GET /api/features?projectId=`, board snapshot) grow `parentId` and a computed `childStats` (`{total, running, failed, done}`) via one grouped query over `parent_id`, the same pattern as `withPullRequestUrls`. `childStats` is what lets the badge say "moving or failed" without opening the card.
- New server endpoints ship behind the `beta-testers` flag with the `getBetaTester` 404 convention.

## Console UI

All new UI wraps in `<BetaOnly>`.

- **Parent badge.** A chip in the card's existing `.card-meta-end` row, next to the PR chip: child count, colored by `childStats` (coral if any child failed, blue if any running, green when all done, neutral otherwise). Cards with no children render nothing new, which is acceptance check 8: no ceremony for teams that never split.
- **Board highlight on select.** Selecting a card that belongs to a group sets a `data-related` attribute on its parent and siblings; CSS rings the related cards and slightly dims the rest. The board holds every feature in memory, so this is a set computation per selection, no fetch. This is the lightweight cross-lane affordance; no arrows are ever drawn on the board itself.
- **Related-cards overlay.** Opened from the badge, or from a "part of" link in a child's drawer. An overlay in the `FeatureDrawer` pattern (the console has no router), fed by `GET /:id/related`. Layout is deterministic: parent mini-card in a left column, children stacked in a right column in creation order. Under the cards, one absolutely positioned SVG layer draws one path per child using only `H` and `V` commands: out of the parent's right edge, along a shared vertical trunk, into the child's left edge, arrowhead at the end. Orthogonality is guaranteed by construction; there is no diagonal-producing command in the path data. Each mini-card shows status dot, stage, spend, and navigates via the existing `?feature=<id>` selection. Children render from the database rows, never the board snapshot, so done and cross-lane children always appear.
- **Drawer.** A child's drawer shows "Part of <parent title>" linking to the parent; a parent's drawer shows its children with statuses. The delete action on a parent with children is disabled with the refusal reason.
- **Live updates.** Child creation and child status changes arrive over the existing board stream; the 250ms coalesced refresh already covers repaint of badge and highlight.

A mockup of the badge, the highlight, and the overlay is attached to this card as an artifact (`related-cards-mockup.html`), with the spawn flow as a Mermaid sequence diagram.

## Billing and entitlements: no bento-cloud changes

Verified against the bento-cloud source; v1 needs zero changes there, which keeps the contract seam untouched.

- The 24-hour card ceiling is keyed on `agent_runs.feature_id` (`featureAgentHours`), so each child gets its own clock automatically, which is exactly what the investigation specifies (check 7).
- The team allowance already sums every run in the organization and counts in-flight hours, so splitting cannot route around the pool: twenty children spend from the same allowance the parent does.
- Group spend is presentation, not policy: the related view and parent drawer sum child `cost_usd` client-side or in the `/related` query. No new metering.

## The parent after it splits: keep going

Resolving the investigation's open question. v1 ships **keep going**: spawning has no effect on the parent's pipeline. The parent finishes its current stage, and whatever scope the agent kept for itself (possibly only the write-up) is what its later stages work on. This is the only option compatible with "the parent remains a working card" and it requires no new machinery.

**Hold** has a natural home later: a `children_done` gate criterion in `stages.gate_criteria`, re-evaluated by the existing gate evaluator on run finish and on the five-minute fallback. It is designed for but explicitly out of v1. "Stop implementing" is rejected: a parent that cannot work is option C from the investigation.

## Testing requirements

- New routes in the `auth.e2e.test.ts` foreign-tenant matrix.
- Cycle and cross-project refusals on both the route and the MCP tool.
- Gateway test: the `bento` virtual server creates a correctly parented card from a grant, refuses after revocation, and refuses past the child cap.
- Board test (`board-card.test.ts` pattern): badge renders from `childStats`, absent without children.
- Related endpoint: returns done and cross-lane children; a child resolves to the same group as its parent.
- Delete refusal: parent with children answers with the refusal, children intact.
- Per CLAUDE.md, verify against something real: file a card, let an agent spawn two children through a live gateway, and read the rows back.

## Out of scope for v1 (unchanged from the investigation)

Dependency edges and scheduling, combined PR merging, worktree sharing, deep-tree UI (data model supports depth, UI shows one level), Linear parent round-trip, re-parenting UI, and any billing policy change.
