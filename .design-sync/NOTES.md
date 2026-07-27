# design-sync notes — @bento/web

Repo-specific gotchas for the next sync. Read this before re-running.

## Shape

- `apps/web` is a Vite **application**, not a published library: no `dist`
  entry, no `exports`. The converter runs in synth-entry mode, building
  `.pkg-entry.mjs` from `src/components/**`.
- `srcDir` is `src/components`, not `src`. Rooting at `src` pulls in
  `main.tsx`, which calls `createRoot(document.getElementById("root"))`
  at module scope — inside the bundle IIFE that throws before
  `window.BentoWeb` is ever assigned, and every component then reports
  `[BUNDLE_EXPORT] not a component`.
- The package has to be resolvable from its own `node_modules`:
  `ln -sfn ../.. apps/web/node_modules/@bento/web`. pnpm will not
  self-install a workspace package, and the converter resolves
  `<node-modules>/<pkg>/package.json`. **Recreate this on a fresh clone**
  (it is inside node_modules, so it is never committed).

## Declaration build

- Without a `.d.ts` tree every emitted `<Name>Props` came out as
  `[key: string]: unknown` — the design agent's whole API contract, empty.
  Fixed by adding `apps/web/tsconfig.dts.json` +
  `pnpm --filter @bento/web build:types`, emitting to `apps/web/types/`
  (gitignored), with `"types": "types/components/index.d.ts"` in the
  package so `projectFor` finds the entry.
- `src/components/index.ts` (committed) is the barrel that build emits
  from. A component missing from it is invisible to the sync.
- `build:types` prints one known diagnostic and still emits everything:
  `src/auth-client.ts(4,14): error TS2742` — better-auth's inferred client
  type reaches a `.pnpm`-internal zod path that cannot be named. Adding
  zod as a direct dependency does not fix it (pnpm still resolves through
  `.pnpm`). The script therefore asserts the artifact
  (`test -f types/components/index.d.ts`) rather than tsc's exit code.
  A real fix would be an explicit annotation on `authClient` that keeps
  the plugin methods typed.

## Fonts

- `--mono` is a system stack whose first real family is JetBrains Mono,
  which the repo did not ship. User chose (2026-08-01) to **vendor it**
  rather than accept the fallback: `apps/web/public/fonts/` holds the two
  latin weights the interface uses (400, 600) + `jetbrains-mono.css` +
  the SIL OFL licence, wired via `cfg.extraFonts`.
- Note the asymmetry: the design system now renders JetBrains Mono, while
  the console itself still resolves `--mono` against the viewer's system
  fonts. Importing `public/fonts/jetbrains-mono.css` from
  `apps/web/src/styles.css` would close that gap — a product decision,
  not made here.

## Known render warns

- `[RENDER_THIN] Modal` — Modal is a shell (backdrop + frame + children);
  with only crash-prevention props its mounted text really is just its
  name. Authoring its preview is the fix, not a bug.

## Previews

- `.design-sync/previews/_fixtures.tsx` is not a component preview — it
  holds the fixture rows and a Proxy-based `client` that resolves them.
  Unknown methods resolve to `null` and `stream*` returns an unsubscribe
  function, so a panel that starts calling something new degrades to an
  empty section instead of a blank card.
- Fixture shapes that are easy to get wrong, and what the component does
  when they are: `getConversation` must be `{blocks:[…]}` (a bare array
  throws "blocks is not iterable"); a block needs `queuedAt` or the
  transcript header reads "Invalid Date"; a `result` event needs
  `ok: true` or the run reads as failed; history rows need
  `fromStatus`/`toStatus` unless `kind === "stage_moved"`, else every
  row renders "Status new to unknown".
- Preview cards have no page background, so a component built for the
  dark surface renders on white. `Surface` in `_fixtures.tsx` supplies
  it. The loud case was ProviderMark: the logos ship near-black and are
  inverted by `--logo-filter`, so on white they were white on white.
- BillingCard cannot show its populated state locally: it fetches
  `/api/billing/plan` itself, and patching `fetch` from inside the
  preview broke the preview module's own evaluation (the card went from
  thin to entirely empty). The card explains the absent state instead.

## Known render warns

- `[RENDER_THIN] BillingCard` — it renders nothing without a billing
  service, which is the open source behaviour, not a broken preview.
- Review sheets crop fixed-position dialogs (`Modal`,
  `NewProjectDialog`) below their title. The dialog itself is complete;
  it is the sheet's cell crop, and a taller `viewport` override does not
  move it.

## Re-sync risks

- **The self-link and the declaration build are prerequisites, not
  options.** A fresh clone has neither: recreate
  `apps/web/node_modules/@bento/web -> ../..` and run
  `pnpm --filter @bento/web build:types` before the converter, or the
  run dies on a missing `package.json` and then emits empty props.
- **Fixtures are hand-written and will rot.** They are shaped to what
  the components read today; a component that starts reading a new field
  renders a thinner card without failing any check. If a panel's card
  looks emptier than it should, suspect the fixture first.
- **15 components still ship the converter's own card** (they render
  real UI from the `.d.ts` crash-prevention props, so they are not floor
  cards, but nothing was authored for them): AcceptInvitation,
  AccountSettings, AppearanceSettings, Board, ConfirmDialog, CreateTeam,
  DeviceApproval, NewFeatureDialog, ProjectPicker, PromptDialog,
  ProviderKeysCard, ResetPassword, SessionPage, SignIn, TeamSettings.
  Authoring any of them is a cheap incremental win on a later sync.
- `SessionPage` reads its card id from the URL, so its card shows the
  "could not load" state. Authoring it would need a preview that can
  set the location.
- The vendored JetBrains Mono is pinned at the version fontsource
  shipped on 2026-08-01. Nothing re-checks it.
