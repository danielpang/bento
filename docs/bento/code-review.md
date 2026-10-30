# Code review: don't show cost in bento swarms if not available

Reviewed against the feature request and `docs/bento/implementation.md`. The earlier-stage files (`product-investigation.md`, `design.md`, `engineering-requirements.md`) are not on this branch.

The hide-cost behavior is already in the tree (merged as `19fcec16`, #255). This branch’s unique commit is the implementation note. The swarm console redesign (`bc12ed60`, #310) moved the goal figure into the stats strip; the visibility rule survived that move. `bento-cloud` does not render swarms and has no change.

**Verdict: ready to merge.**

## 1. The change does what the requirements said

Yes.

Requirements: if a coding agent does not report cost **and** the swarm has no budget, hide the dollar in the goal section and on agent workers. Do not print a placeholder.

The decision lives in `apps/web/src/swarm/money.ts`:

- `hasReportedSpend` (line 82–84) is true only when measured or token-priced estimated spend is greater than zero. Legacy assumed cost and subscription notional cost do not count.
- `showSwarmSpend` (line 93–95) is true when there is a budget (`budgetUsd !== null`, including `$0`) **or** `hasReportedSpend`.

Surfaces:

| Surface | File | What happens when there is nothing to show |
|---|---|---|
| Goal figures | `SwarmPage.tsx:706–711` | The whole `swarm-spend-summary` stat is omitted. Adjacent stats stay. |
| Tree card | `SwarmTree.tsx:339`, `399–403` | No `swarm-node-cost` span, and the tooltip does not mention spend. |
| Outline row | `SwarmOutline.tsx:67`, `126–128` | The cost cell is empty; no `$0.00` and no title. |
| Worker drawer | `SwarmNodeDrawer.tsx:462–468` | The “Spend estimate” line is not rendered. |

A budget with no spend still shows `$0.00` against the cap (`SwarmPage.tsx:706–709`). That matches the written policy: a cap is itself a figure. Reported spend with no cap still shows, with “No budget cap”.

Parent nodes roll up child spend in `layout.ts:409–426`. A plan card therefore shows a dollar when a descendant reported one, not when the parent row is silent. Silent leaves stay blank. That is the right reading of “agent workers”.

TUI swarm output from #255 is gone because the terminal no longer offers swarms (`apps/tui/src/cli.tsx:75–76`). No gap.

## 2. It is covered by tests

Yes, at both the policy and the render.

`apps/web/src/swarm-money.test.ts:86–96` covers silent+uncapped (hide), budget with no spend (show), reported spend with no budget (show), and assumed-only (not reported).

`apps/web/src/swarm-console.test.ts`:

- `1264–1271` — goal markup has no `swarm-spend-summary` and no `$0.00` when spend and budget are both absent; workers remain.
- `1273–1278` — `$0.00` still prints against a `$40` budget.
- `1281–1288` — `$2.50` prints with “No budget cap”.
- `1291–1312` — tree and outline print `$0.70` on the worker that reported it and never `$0.00`; the silent worker’s drawer has no spend line.

Re-ran on this checkout:

```
pnpm --filter @bento/web exec node --test --import tsx src/swarm-money.test.ts src/swarm-console.test.ts
```

113 passed, 0 failed.

## 3. Bugs

None found that would show a cost the requirements said to hide, or hide a cost they said to keep.

Checked: goal extra-stats path after the redesign, tree tooltip, outline empty cell vs placeholder, drawer conditional, assumed/notional tiers, parent rollup, and origin/main’s two extra commits (they do not touch these files).

The outline still reserves a cost column (`SwarmOutline.tsx:126–128`) so rows stay aligned. It does not put a value in it. That is not a shown cost.

## 4. Clarity for the next person

Clear enough.

`money.ts` states the rule next to the functions that enforce it. The console tests name the cases in the test titles. `implementation.md` records why assumed/notional stay out of the displayed figure.

`nodeSpendChip` in `money.ts:140–151` is unused after the redesign (tree uses `hasReportedSpend` + `formatUsd(cappedUsd)`). Harmless leftover, not a regression of this feature.

## Visual

Rendered markup from the same components the tests use is at `artifacts/swarm-cost-visibility.html` (goal hidden / shown / zero-against-budget / spend-without-cap, plus tree, outline, and drawer).
