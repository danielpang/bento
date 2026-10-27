# Implementation: hide unavailable swarm cost

## Outcome

The current branch already contains the requested implementation (introduced by
`19fcec16`, "Hide swarm cost when nothing was reported and no budget is set").
This stage verified that implementation against the current swarm console
redesign; no additional production-code change was necessary.

## Existing implementation

- `apps/web/src/swarm/money.ts` is the decision point. `hasReportedSpend`
  treats measured or token-priced estimated spend as available, while
  `showSwarmSpend` also treats a configured `budgetUsd` (including a zero-dollar
  budget) as sufficient reason to render the goal's spend statistic.
- `apps/web/src/components/SwarmPage.tsx` omits the complete goal spend statistic
  when neither condition is true.
- `SwarmTree.tsx`, `SwarmOutline.tsx`, and `SwarmNodeDrawer.tsx` omit worker cost
  text, tooltips, and placeholders when that worker has no reported spend.
- `apps/web/src/swarm-console.test.ts` covers the no-cost/no-budget case, a budget
  with no spend, spend with no budget, and worker views with unavailable cost.
  `apps/web/src/swarm-money.test.ts` covers the shared visibility policy.

## Data and API impact

No new state is stored. The UI continues to consume the existing swarm detail
response: `swarm.budgetUsd`, aggregate `swarm.spend`, and each task's `cost`.
No request or response shape changes, server routes, database tables, or
migrations are required. `bento-cloud` does not render swarms and needs no
change.

The visibility rule deliberately uses the existing priced tiers rather than
legacy assumed cost or subscription notional cost, matching the amount displayed
and counted against a swarm budget. This keeps the client aligned with current
server accounting without inventing a dollar value for silent coding agents.

## Risk and reversibility

The change is presentation-only and reversible. The main risk is reintroducing a
`$0.00` placeholder in one of the three worker surfaces or the goal summary;
shared money helpers and render-level regression tests cover those paths. There
are no destructive or irreversible operations.

## Verification

- `pnpm --filter @bento/core build`
- focused web swarm money and console tests: 113 passed
- `pnpm --filter @bento/web... build`

The production build completed successfully. Vite reported only its existing
dynamic-import and large-chunk warnings.
