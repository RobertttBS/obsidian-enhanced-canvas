# Architecture Reference — obsidian-enhanced-canvas

The deep detail behind the one-line traps in `CLAUDE.md`. Read the section you're
about to touch; you do not need the whole file in context to change one feature.

## Build & entry

Obsidian plugin, `isDesktopOnly: false`. Entry `main.ts` → `main.js` via
`esbuild.config.mjs`. **Obsidian and CodeMirror are externals — never bundle them.**
Canvas internals are reverse-engineered in `Canvas.d.ts`; prefer extending that
over `any` when typing new Canvas code (though `any`/`@ts-ignore` are accepted
against Canvas internals — ESLint allows it).

## `main.ts` — `EnhancedCanvas`

Features register from `onload()`: the `register*` methods plus
`canvasTagImport.register()` — plugin commands, canvas auto-link, file-manager
patches, focus-canvas, exploder, tag import, node auto-height, default node size,
drag-temp-node. `onload` then runs `syncAllCanvasProperties`; `onunload` strips the
properties. Get the live method line numbers with:

```
grep -nE "register[A-Z]\w*\(|syncAllCanvasProperties|ensureCanvasKeyOrder|writeLinkSet" main.ts
```

## Prototype patching (load-bearing)

Uses `monkey-around`'s `around()`. Patching needs a Canvas leaf, so **every patcher
goes through `EnhancedCanvas.registerLazyPatcher(patch)`** — it retries `patch()`
(which returns a success boolean) on `active-leaf-change` / `layout-change` /
`onLayoutReady`, and **detaches the retry listeners after the first success**.
Leaving them attached re-patches and breaks Windows pinned tabs (shipped once,
commit `742eb70`). Do not hand-roll the retry. Register every uninstaller with
`this.register(...)`.

## Two node concepts — do not mix

Same names, different things (see comments at `main.ts:158-160`):

| | Lives in | `.file` is | `.filePath` | Used by |
|---|---|---|---|---|
| **JSON node** | `.canvas` file / `canvasData.nodes` | a path **string** | — | `addProperty`/`removeProperty`/`renameProperty`, any code walking `canvasData.nodes` |
| **Live `CanvasNode`** | `canvas.nodes` | the **`TFile`** | the path string | `addNodeUpdate`/`removeNodeUpdate` |

Before editing anything named `node`, confirm which kind you hold.

## Frontmatter sync (when `settings.enableFrontmatter` is on)

The plugin writes two things to every referenced note:
1. `canvas: [[<canvas-name>]]`.
2. A property named after each canvas's basename, holding links to edge-connected
   nodes.

Load-bearing rules — all four cause silent user-data loss if broken:

- **Order:** `canvas` must precede the per-canvas properties. Every write path calls
  `ensureCanvasKeyOrder` **inside** its `processFrontMatter` callback (writes race,
  so insertion order alone isn't enough).
- **Debounce:** all edge syncs — including `addEdge` — go through the debounced
  queue, never immediately. Opening a canvas re-adds every edge; an immediate sync
  mid-import sees partial data and strips valid links. The auto-link edge patch only
  queues a sync when an edge's **endpoints** change (geometry-only `edge.update()`
  calls are ignored).
- **Cache is a gate, not a source:** the metadata cache only decides *whether* a
  sync runs (to skip no-op `processFrontMatter` calls). The actual add/remove
  decisions happen inside the callback against the **real** frontmatter, because the
  cache lags right after a write.
- **Cleanup before flip:** turning `enableFrontmatter` off must run cleanup
  *before* the setting flips, else `removeProperty` no-ops and orphans the
  properties. The settings-tab handler enforces this ordering — preserve it.

`onload`'s `syncAllCanvasProperties` aggregates desired frontmatter across all
`.canvas` files, diffs against the metadata cache, and does **at most one**
`processFrontMatter` write per out-of-date note (zero when nothing changed — keep
it that way). Mutation functions early-return when the setting is off.

## Multi-window

Popped-out Canvas views have their own `Document`. DOM listeners bound to
`activeDocument` at load time only fire in the main window. `registerFocusCanvas`
attaches per-document via `workspace.on('window-open')` + `iterateAllLeaves` —
follow that pattern for any new DOM listener. Workspace events fire globally and are
safe.

## `src/` modules

- `CanvasExploder.ts` — file/text node → heading-tree of connected nodes. Layout
  constants at top.
- `CanvasTagImport.ts` + `AdvancedTagSuggestModal.ts` — import tagged notes into a
  canvas. Tag completion uses Obsidian's `AbstractInputSuggest`, completing the word
  under the cursor.
- `SendToCanvas.ts` — "Send to Canvas" via `FuzzySuggestModal`; `selectedCanvas` is
  in-memory only.
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. Settings UI lives
  in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver), `randomId` (uses `crypto.getRandomValues`
  — prefer over `Math.random()`).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — first-run / version-bump modal,
  gated by `showReleaseNotes` / `previousRelease`.

## CSS

`styles.css` ships with the plugin. Rules live behind body class
`enhanced-canvas-enabled`, toggled by `toggleCSSClass` from `settings.enableCustomCSS`.
Hides the metadata container in markdown embeds inside Canvas nodes.

## Release process

1. Bump `version` in `manifest.json`.
2. In `src/releaseNotesData.ts`: prepend a callout to the current notes string, and
   map the new version to it in `releaseNotesContent`. Keep each callout to one or
   two short lines — Refactor: `> [!success] Refactor in <v>`; Feature:
   `> [!note]`/`> [!tip]`; Bug fix: `> [!bug] Fixed in <v>`.
3. Commit as `update manifest.json to <version>`.
