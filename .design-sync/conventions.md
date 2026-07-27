# Building with Bento's console components

Bento is a board for coordinating AI coding agents. Its interface is a
dark, instrument-panel look: a quiet slate ground, one accent hue for
whatever the primary action is, and reserved colours that only ever mean
a status.

## No wrapper, no theme provider

Import a component and render it. There is no provider, no theme object,
and no context to set up — the whole visual system is CSS custom
properties on `:root`, which `styles.css` defines. Load that stylesheet
and everything below works.

```jsx
import { SecretField, Modal } from "@bento/web";

<Modal
  title="New agent"
  description="Pair a coding tool with a model."
  onClose={close}
  actions={
    <>
      <button className="btn btn-ghost" onClick={close}>Cancel</button>
      <button className="btn btn-primary" onClick={save}>Add agent</button>
    </>
  }
>
  <label className="field">
    <span className="label">Name</span>
    <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
  </label>
</Modal>
```

Two things follow from that:

- **Actions are passed as elements, not configured.** `Modal` takes an
  `actions` node; you compose the buttons yourself with `btn` classes.
  The same is true of every dialog here.
- **Panels take a client.** `FeatureDrawer`, `AgentsPanel`,
  `StageConfig`, `RepositoriesPanel`, `SettingsPage`, `AgentSession`,
  `GitHubTokenCard` and `NewProjectDialog` fetch their own data through a
  `client` prop and render empty without one. For a design, either pass
  an object whose methods resolve fixtures, or build the screen from the
  smaller parts instead.

## Styling: classes, not props

There are no style props. Components carry their own look, and your own
layout glue is written with the same class vocabulary they use. These
are real class names from the shipped stylesheet — prefer them to
inventing new ones.

| Family | Names |
| --- | --- |
| Actions | `btn`, `btn-primary`, `btn-ghost`, `btn-danger` |
| Form | `field`, `label`, `input`, `input-lg`, `select`, `textarea-grow` |
| Surfaces | `section`, `card`, `card-panel`, `settings-card`, `stage-card`, `repo-card`, `drawer`, `drawer-head`, `drawer-body`, `modal`, `modal-backdrop` |
| Board | `board`, `lane`, `lane-head`, `lane-name`, `lane-count`, `lane-cards`, `lane-ord`, `card-title`, `card-meta` |
| Status and labels | `chip`, `chip-clip`, `chip-empty`, `chip-soft`, `status`, `dot`, `muted`, `error`, `warn` |
| Tabs and pickers | `tab-row`, `tab`, `tab-on`, `tab-dot`, `picker`, `picker-trigger`, `picker-menu` |
| Layout | `actions`, `action-grid`, `center`, `divider`, `empty-state` |

`label` and `lane-ord` are the instrumentation voice: uppercase mono,
letter-spaced, `--text-faint`. Use them for field labels and ordinals,
never for prose.

## Colour is meaning

The tokens are on `:root`; reference them as `var(--name)` and never
hard-code a hex.

- Ground and surfaces: `--bg`, `--panel`, `--panel-raised`, `--line`,
  `--line-bright`
- Text: `--text`, `--text-dim`, `--text-faint`
- The accent: `--brand`, with `--on-brand` for text sitting on it
- **Reserved status hues, which mean only what they say**: `--running`
  (blue), `--succeeded` (green), `--failed` (coral), `--gated` (gold),
  `--idle`. Never use one of these for a control, and never use
  `--brand` to signal a state — the accent is deliberately outside the
  status set so an interactive element never reads as a status.
- Shape and type: `--radius`, `--sans`, `--mono`, `--shadow-1`,
  `--shadow-2`

Both themes are defined: dark is the default on `:root`, light comes
from `:root[data-theme="light"]`, and three accents are available via
`:root[data-accent="magenta"|"teal"]`. Every component is built for
both, so read colour from tokens and both themes keep working.

## Writing the words

Copy is part of this design system. Sentences, not fragments; say what
happened and what to do about it. A control names its own outcome
("Create PR", "Approve and advance", "Save commands"). **No em dashes,
no en dashes, and no hyphen-as-pause** anywhere in the interface — use
separate sentences, commas, colons, or parentheses.

## Where the truth is

- `styles.css` and its imports: every token and class, with the reasons
  in comments.
- `components/<group>/<Name>/<Name>.d.ts`: the props, carrying their own
  documentation.
- `components/<group>/<Name>/<Name>.prompt.md`: how each component is
  meant to be used.

Read the stylesheet before inventing a class. Almost everything you need
is already named.
