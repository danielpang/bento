---
name: preventing-prod-slop
description: Use when a pull request, migration, or deploy diff is up for merge and the open question is whether production would get worse. Covers green CI, a closing launch window, index or column locks, a removed endpoint, a new secret or binding, and reviews sliding into style or test nits.
---

# Preventing slop from hitting prod

## Overview

Answer one question: once this change is merged and deployed, does production get worse?

Style, naming, and coverage are out of scope. Publish `go` or `no-go` and a ledger of failure trajectories. A trajectory is one chain from a trigger, through this diff, to a worse value of one production metric. A link without a citation is a guess.

## When to use

Use this on a pull request, a migration, or any diff that can ship. If the diff cannot affect production (docs, local tooling, tests only), say so in one line and stop.

## Procedure

1. Say whether the diff touches runtime code, a migration, infra, or shipped config.
2. Name affected resources by reading manifests (Terraform, CloudFormation, Wrangler, `fly.toml`, Kubernetes) and connecting them to changed files. Drop the rest.
3. Run the heuristics before any other reasoning. Each hit is a trajectory.
4. For each trajectory, try to confirm it and try to refute it with a log template and its count, a metric, or a config value. Forecast before a magnitude status.
5. Derive the verdict. Post the comment shape below.

A new commit cancels the previous assessment. Review that delta. Keep trajectories it does not touch. Re-open the ones it changes. Do not continue the old thread.

Cap the work at 30 tool calls. Record the count. Do not re-read a file you already cited.

## Heuristics

A hit is not a verdict.

- A migration someone must apply by hand, or in a fixed order around the deploy.
- `CREATE INDEX` without `CONCURRENTLY`.
- `ADD COLUMN ... NOT NULL` with no default.
- An endpoint removed while deployed clients still call it.
- A new read of an environment variable, secret, or binding this diff does not provision.

## Status and verdict

| Status | Meaning |
| --- | --- |
| `confirmed` | Every link has a production citation, and a real attempt to refute it failed. |
| `plausible` | The chain is concrete and at least one link has no telemetry. Missing data is not a refutation. |
| `refuted` | Telemetry shows the chain does not happen. Cite the count, metric, or config value. |

No citation, no `confirmed` and no `refuted`.

Magnitude (the lock matters, the queue overflows, latency doubles) needs history, not the last hour. A flat line and a climbing line differ. Read the low-to-high band, not the center. No series: say the forecast was not run and leave that link `plausible`.

```ts
function verdict(trajectories: { status: string }[]): "go" | "no-go" {
  return trajectories.some((entry) => entry.status === "confirmed") ? "no-go" : "go";
}
```

`plausible` does not flip the verdict. It still leads the comment, names this diff, and says what would make it safe.

## Comment

1. First line: `no-go` or `go`.
2. One sentence: mechanism, resource, and metric. If every trajectory is `refuted`, say that.
3. Citations (file and line, log count, metric, config key, or manifest edge).
4. What would make this change safe, or "none".
5. Ledger: each trajectory, its status, and the tool-call count.

## Rationalizations

| Excuse | Write this instead |
| --- | --- |
| "CI is green" | CI did not see production. Run the heuristics. |
| "Not sure, so approve" | Unread telemetry is `plausible`, not `refuted`. Lead with it. |
| "Mention it next time" | Name this diff and the safe form. |
| "Review style and tests" | Those findings do not go in this comment. |
| "Someone senior said block" | A `refuted` trajectory stays `go`. |
| "The table is probably small" | A size guess is `plausible`. |
| "The test covers the missing secret" | An unset-secret test does not show the secret exists in production. |

## Red flags

Rewrite if the approval reason is green CI, a lock or missing secret sits in a footnote, `confirmed` or `refuted` lacks a production citation, style or coverage is the main finding, the old thread continued after a new commit, or one recent number stands in for a forecast.

## Example

`migrations/0114_order_search_trgm.sql:1` is `CREATE INDEX ... USING gin` with no `CONCURRENTLY`. Checkout writes `orders` at about 38/s, flat across 48h. The build holds a write lock, so those writes queue. Status: `confirmed`. Verdict: `no-go`. Safe form: `CREATE INDEX CONCURRENTLY` outside the transactional migration.
