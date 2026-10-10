# Hide swarm cost when nothing was reported

Earlier stage write-ups (`product-investigation.md`, `design.md`, `engineering-requirements.md`) were not in the tree. This implements the card as stated: hide cost in the swarm goal and on agent workers when the coding agent reports none and the swarm has no budget.

## Rule

Show a spend figure only when at least one of these is true:

- A tool reported a priced cost (`measuredUsd` or `estimatedUsd` above zero).
- The swarm has a budget (`budgetUsd` is set), even if spend is still zero.

Otherwise hide the figure. Do not print `$0.00` as a stand-in for unknown cost. Legacy assumed charges and notional list prices do not count as reported spend, matching `cappedUsd`.

## Surfaces

- **Goal brief** (`SwarmPage`): the spend summary hides; the worker stepper stays.
- **Worker cards** (`SwarmTree`, `SwarmOutline`) and the **node drawer**: hide the cost chip or line when that node's rolled-up priced spend is zero.
- **TUI** headline and `bento swarm list`: same rule. Worker lines already omitted a zero.

Helpers live in `apps/web/src/swarm/money.ts` (`hasReportedSpend`, `showSwarmSpend`) and `apps/tui/src/swarm/tree.ts` (`showSwarmMoney`).

`bento-cloud` was not changed.

## Verify

```bash
pnpm --filter @bento/web test
pnpm --filter @bento/tui test
```

Covered cases: hidden when no report and no budget; `$0.00` still shown against a set budget; reported spend still shown without a budget; worker cards and the drawer hide an unreported zero.
