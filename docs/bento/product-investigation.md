# Product investigation: an "Artifacts" tab between Board and Sessions

## What exists today (verified in code)
- Artifacts are files agents produce for people (write-ups, mockups, screenshots, diagrams), captured per run into `run_artifacts`. `RunArtifact` carries id, runId, stage, path, kind (markdown/mermaid/image/html/file), mime, size, createdAt.
- They are reachable only **per card**: `GET /api/features/:id/artifacts` (newest first, limit 200), surfaced in the card's detail panel and as "View output" links in `ReviewHandoff` (latest 2 of the last run).
- `ArtifactViewer` (modal) and `/artifact/:id` (pop-out tab) already render every kind, with a sandboxed iframe for HTML. Viewing is solved.
- Top bar nav is built in `apps/web/src/App.tsx` (~line 1249): Board, Sessions, Agents, Pipeline, Repositories. Screens are routed by path (`/sessions`, `/spend`).
- **No project-wide artifact listing exists.** Not in the server, api-client, or TUI. Cards have no "has artifacts" field either.

## Who has the problem, and what they do today
Reviewers/PMs/engineers who run cards through agent stages and want to look at the outputs (a mockup, a spec) without remembering which card produced it. Today they open each card, find its artifacts, and open them one at a time; to compare or browse across cards there is no path at all. Pain is inferred from the structure of the product, not measured: the repo holds no usage data, tickets, or feedback on this, so **the evidence is the request itself plus the missing capability, not demonstrated demand.**

## What the change should achieve
A project-level place to browse "what did the agents make?": a grid of cards (one per feature that has artifacts, titled by card name), opening into the existing viewer. Placed between Board and Sessions.

## Proposed shape (smallest version)
1. Server: one new read endpoint, e.g. `GET /api/projects/:id/artifacts` (or a features-with-artifacts summary: card id, name, artifact count, latest createdAt, a preview candidate). Must follow AGENTS.md: resolve via `canAccessProject`/`visibleProjectFilter`, 404 on foreign, **and add it to the tenant matrix in `auth.e2e.test.ts`**. Select metadata only, never the storage key. Swarm artifacts (`type: "swarm"`) are excluded: they use a separate gated access path.
2. api-client method + type.
3. Web: new `/artifacts` screen and nav entry; grid of cards (name, artifact count, kinds, last updated; image/markdown thumbnail optional); click a card -> its artifacts list -> existing `ArtifactViewer`.
4. Docs in `docs/web-app.md`.

Roughly one small PR; no schema change needed (index on `run_artifacts.feature_id` should be checked).

## How we would know it worked
- Adoption: share of weekly active projects that open /artifacts at least once; repeat use.
- Behavior: artifact opens per week from the tab vs. from the card panel; fewer card-detail opens made only to find an artifact.
- Counter-signal: if opens through the tab stay near zero after a few weeks, the card panel was enough.
Analytics exists (`apps/server/src/analytics.ts`) but instrumentation for this tab would need adding.

## Deliberately left out
Searching/filtering, tagging, comparing, deleting or editing artifacts, cross-project views, swarm artifacts, TUI parity, download-all, sharing links, and pagination beyond the existing 200-per-card cap.

## Decisions needed
1. **Grid unit**: one tile per *card* (as requested, with artifacts inside) or one tile per *artifact* labelled with its card name? The request says "list cards by name", so I assumed per card; per-artifact is better for visual browsing of mockups.
2. **Scope**: is Board-adjacent placement also wanted in the TUI, or web only?
3. **Gating**: ship to everyone, or behind the beta flag like Sessions (`beta && screen === "sessions"`)?
4. **Evidence check**: do we have any signal (support asks, interviews) that people struggle to find artifacts? If not, this is a cheap bet but an unproven one; instrumenting opens of the existing card panel first would tell us whether artifact viewing is even frequent.

No code was changed in this stage; bento-cloud was inspected (billing/usage store) and has no artifact concerns.
