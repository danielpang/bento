# Design: Artifacts tab

Nav order: **Board · Artifacts · Sessions · Agents · Pipeline · Repositories**. Route `/artifacts`. Hidden on the swarm board (like Board/Sessions). Mockup: `/workspace/artifacts/artifacts-tab.html`.

## Decisions taken (investigation's open questions)
1. **Grid unit: one tile per card** (as requested). Each tile shows a preview of its newest previewable artifact, so visual browsing still works. Clicking opens a card detail view listing that card's artifacts.
2. **Web only**; no TUI.
3. **Ship to everyone** (not beta-gated). It is read-only and reuses the existing viewer.
4. Instrument opens (`artifacts_tab_opened`, `artifact_opened` with `source: tab|card_panel`) so the success metrics in the investigation can be measured.

## Screens
### 1. Grid (`/artifacts`)
- Heading "Artifacts", subtext "Everything your agents produced, by card." Sort: newest activity first; no filters in v1.
- Responsive grid, `repeat(auto-fill, minmax(240px, 1fr))`. Each tile (a link, keyboard focusable):
  - Thumbnail (16:10): image artifact → the image; markdown → first ~6 lines rendered as text; HTML/mermaid/file → kind icon on a neutral surface.
  - Card name (2-line clamp), e.g. "Create a new tab for Artifacts".
  - Meta: "4 artifacts" (singular "1 artifact"), kind chips (Markdown, Image…), "Updated 2h ago".
- Project picker in the top bar scopes the grid, as on Board.

### 2. Card artifacts (`/artifacts/:cardId`)
- Back link "← All artifacts", card name as title, button "Open card" (opens the card's detail panel).
- List/grid of that card's artifacts newest first: name (file path basename), kind chip, stage ("UI/UX design"), size, time. Click → existing `ArtifactViewer` modal. Secondary action "Open in new tab" → `/artifact/:id`.
- If the list hit the 200 cap: footnote "Showing the 200 most recent artifacts."

### 3. Viewer
Existing `ArtifactViewer` unchanged; closing returns focus to the tile/row.

## States
| State | What they see |
|---|---|
| Loading | Heading plus 8 skeleton tiles (`aria-busy`). Skeleton rows on the detail view. |
| Empty (no artifacts in project) | Icon, "No artifacts yet", "When an agent produces a write-up, mockup, or screenshot on a card, it will show up here." Button "Go to Board". |
| No projects | Same no-project prompt as Board; no grid. |
| Error | Inline alert: "Couldn't load artifacts." Button "Try again". Keeps nav usable. |
| Error on one artifact | In the viewer: "Couldn't open this artifact." with "Try again" and "Open in new tab". |
| Permission denied / foreign project (server 404) | "This project isn't available. It may have been removed, or you may not have access." Button "Choose another project". Never reveals whether it exists. |
| Card deleted while viewing | "This card no longer exists." Button "Back to all artifacts". |
| Thumbnail fails | Falls back to the kind icon silently. |
| Swarm artifacts | Excluded; never shown. |

## Accessibility
Tiles are real links with the card name as accessible name plus "4 artifacts, updated 2 hours ago". Nav item uses `aria-current="page"`. Thumbnails have empty alt (the name is already in the label). Skeleton respects reduced motion. Focus returns to the opener when the viewer closes.

## Handoff to implementation
- Endpoint `GET /api/projects/:id/artifacts` returns per card: id, name, artifactCount, kinds[], latestCreatedAt, preview {artifactId, kind} | null. Access via `canAccessProject`, 404 on foreign, added to the tenant matrix in `auth.e2e.test.ts`, no storage keys.
- Detail view reuses `GET /api/features/:id/artifacts`.
- Add nav entry in `apps/web/src/App.tsx` (~line 1249) between Board and Sessions; document in `docs/web-app.md`.

No code changed in this stage; bento-cloud untouched.
