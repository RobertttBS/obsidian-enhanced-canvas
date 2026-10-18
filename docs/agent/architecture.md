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
patches, focus-canvas, exploder, tag import, find in canvas (`new CanvasFind(this).register()`), node auto-height, default node size. `onload` then runs `syncAllCanvasProperties`; `onunload` strips the
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

Load-bearing rules — all five cause silent user-data loss if broken:

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
- **Match links by basename:** Obsidian rewrites frontmatter links on rename — a
  path prefix to disambiguate same-basename canvases, an alias — so `[[X.canvas]]`
  can become `[[folder/X.canvas|X.canvas]]`. Every comparison goes through
  `canvasLinkBasename`, never string equality, or removal silently leaves the link
  behind and the sweep appends a duplicate. Basename is the identity here anyway:
  the per-canvas property key *is* the canvas basename.
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

- `CanvasExploder.ts` — file/text node → heading-tree of connected nodes. Supports
  optional auto-resizing leaf cards and realigning tree vertically, and (setting
  `chooseHeadingLevelOnSplit`) a `SuggestModal` to cap the split depth. Layout constants at top.
- `CanvasTagImport.ts` + `AdvancedTagSuggestModal.ts` — import tagged notes into a
  canvas. Tag completion uses Obsidian's `AbstractInputSuggest`, completing the word
  under the cursor.
- `CanvasFind.ts` — "Find in canvas" command (default hotkey Mod+F, shared with core
  "Search current file") + editor-menu item: highlights nodes
  containing a word or linking to a `[[note]]` (links resolved via
  `getFirstLinkpathDest`), dims the rest, `zoomToBbox` to fit. Uses only
  `ec-find-hit` / `ec-find-active` classes — never `node.color`, never writes the file.
  Matched text is marked via the CSS Custom Highlight API (`::highlight(ec-find)`, no
  DOM edits); a `MutationObserver` on hit nodes repaints as content lazily mounts.
  A click (not a drag) on empty canvas (`e.target === canvas.wrapperEl`) clears the find.
- `SendToCanvas.ts` — "Send to Canvas" via `FuzzySuggestModal`; `selectedCanvas` is
  in-memory only.
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. Settings UI lives
  in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver), `randomId` (uses `crypto.getRandomValues`
  — prefer over `Math.random()`).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — first-run / version-bump modal
  (what's new + feature guide, also opened by the "Show feature guide" command),
  gated by `showReleaseNotes` / `previousRelease`.

## CSS

`styles.css` ships with the plugin. Rules live behind body class
`enhanced-canvas-enabled`, toggled by `toggleCSSClass` from `settings.enableCustomCSS`.
Hides the metadata container in markdown embeds inside Canvas nodes. The
`ec-find-*` rules (find in canvas) are unscoped — only `CanvasFind` adds those classes.

## Release process

1. Bump `version` in `manifest.json`.
2. In `src/releaseNotesData.ts`: replace `whatsNew` with this release's user-facing
   features (skip fixes and refactors). When a feature ships, add an entry to
   `featureGuide`: what it does, where to find it (menu/command), related settings.
   Updates show `whatsNew` + `featureGuide`; first install shows `featureGuide`;
   the "Show feature guide" command reopens the update view.
3. Commit as `update manifest.json to <version>`.
4. Push `master` (ask first).
5. Publish (ask first; it ships to every user): `npm run build` (production
   `main.js`, no sourcemap — the dev build must not ship), then
   `gh release create <version> main.js manifest.json styles.css --title <version> --notes "<what's new>"`.
   The tag is the bare version (no `v`) and must equal `manifest.json`'s `version`.
