# Product investigation: Indicate issues already in Bento

**Feature:** Indicate issues are already in Bento in the "Import issues" section
**Linear:** [DPA-6](https://linear.app/dpang-studios/issue/DPA-6/indicate-issues-are-already-in-bento-in-the-import-issues-section)
**Stage:** Product investigation
**Repo evidence date:** 2026-08-15

## Verdict

Build this. The import path already blocks re-selection correctly; the gap is explanation, not behavior. Cost is small, risk is low, and the current cue (`(imported)` plain text) is easy to miss and uses jargon that does not say "this is already a board card."

## Who has this problem

People who connect Linear and use **Settings → Linear → Import issues** to pull specific open backlog or unstarted issues into a Bento project by hand.

Typical moments:

- They already imported an issue (or a team mapping / `bento` label / webhook / sync did), then return to Import issues to pull more.
- They scan a long team list and cannot tell why some rows will not check.
- They wonder whether "grayed out" means broken, already done, or filtered for another reason.

This is an operator / admin convenience surface, not the board itself. It shows up after Linear is connected; team mappings and automatic sync are adjacent paths that feed the same link table.

## What they do today

In `ImportCard` (`apps/web/src/components/LinearPanel.tsx`):

1. Pick a Linear team and a destination Bento project.
2. See open backlog / unstarted issues from Linear.
3. Check issues and click Import.

For issues that already have a `linear_issue_links` row in the org:

- The checkbox is **disabled** (correct; server import is also a no-op via the unique issue index).
- The label appends plain text **`(imported)`**.
- There is **no** `title` / tooltip, and **no** chip or badge.

So the system already knows the state (`imported: boolean` from `GET /api/linear/issues`). The UI under-communicates it: disabled controls without a clear "why" read as broken; `(imported)` is quiet, easy to skim past, and does not say the issue is already a Bento card.

"Imported" is also org-scoped, not project-scoped: one Linear issue maps to at most one feature in the organization. Someone picking project B still sees the issue as imported if it landed in project A. That is existing product truth; this feature should not invent a second meaning.

## What the change should achieve

When an issue cannot be selected because it is already linked, the person understands **immediately** that it is already in Bento, without leaving the Import issues list or guessing.

Outcomes:

1. **Reason is visible or discoverable** on the disabled row (badge and/or hover text), using language that points at Bento, not only at the import action.
2. **Behavior stays the same:** still not selectable; import still dedupes; available issues unchanged.
3. **No false confidence:** only rows with an existing link show the cue.

## How anybody would know it worked

Manual check in Settings → Linear → Import issues, with at least one already-linked issue and one fresh issue in the same team list:

| Check | Passes when |
| --- | --- |
| Already-linked row | Cannot check the box; cue states it is already in Bento (visible badge and/or hover). |
| Fresh row | Selectable; no "already in Bento" cue. |
| After a successful import | That issue's row becomes disabled and shows the same cue without a full page reload beyond the existing refresh. |
| Copy | No em/en dashes; says Bento clearly (not only "imported"). |

Automated coverage (later stage): assert the disabled imported row exposes the chosen accessible name / title text. Not required to decide whether to build.

## Ideas (not a design lock)

Three lightweight treatments fit the existing console (chips, `title` tooltips elsewhere):

1. **Hover / `title` only** — e.g. "Already in Bento". Lowest visual noise; fails if someone never hovers (touch, quick scan).
2. **Always-visible chip** — e.g. a muted `.chip` reading "In Bento" or "Already in Bento", replacing `(imported)`. Scannable; slightly busier list.
3. **Chip + hover** — chip for scan, longer `title` for detail (optional: "Already linked to a card in this workspace"). Clearest; still small.

Recommendation for the next stage: **chip + short hover**, replace `(imported)`. Match existing `.chip` / muted patterns; do not invent a new status color (status hues are reserved).

A side-by-side concept lives in the feature artifacts folder as `import-already-in-bento-concepts.html` (not committed).

## Deliberately leaving out

- Removing already-linked issues from the list, or a filter toggle.
- Deep link from the row to the existing board card or feature drawer.
- Re-importing the same Linear issue into a second project (org-unique link stays).
- Changing team mapping, label, webhook, or sync import UX.
- Showing which project owns the link (useful later; needs API fields the list does not return today).
- Empty-state or bulk "select all" changes.
- Redesigning the Import issues layout beyond the per-row cue.

## Decision needed

Please choose the indicator treatment before design / implementation:

**A.** Hover text only (`title` / accessible description)  
**B.** Always-visible badge/chip only  
**C.** Badge/chip plus hover text (recommended)

And confirm copy:

**1.** "Already in Bento" (recommended; matches the ticket)  
**2.** "In Bento" (shorter chip)  
**3.** Keep "imported" wording

If you want the chip to name the destination project later, say so; that is a follow-on (API + copy), not this slice.

## Evidence notes

- List endpoint already returns `imported` by joining page issue ids to `linear_issue_links` for the org (`apps/server/src/routes/linear.ts`).
- `importLinearIssue` returns null when a link already exists; unique index makes repeats a no-op.
- Ticket screenshot was not fetchable from this environment (Linear upload auth). Investigation relies on the ticket text plus current UI code, which already disables and appends `(imported)`.
