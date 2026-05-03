# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — esbuild in watch mode, writes inline-sourcemap `main.js`. **This is what the maintainer actually uses** — Obsidian only needs `main.js`, so reload the plugin in Obsidian to pick up changes. Default to this for any local work.
- `npm run build` and `npm run version` exist in `package.json` but are not part of the maintainer's workflow. Don't run them unless explicitly asked.

There is **no test runner, no lint script, and no CI**. esbuild does the actual compile, so type errors won't fail the watch build — sanity-check by reading the file or running `tsc -noEmit` ad hoc if needed.

## Architecture

This is an Obsidian plugin (`isDesktopOnly: false`). Entry is `main.ts`, bundled to `main.js` by `esbuild.config.mjs`. Obsidian and CodeMirror are externals — do not bundle them.

### Core entry: `main.ts` (the `EnhancedCanvas` class)

Almost every feature is a `register*` method called from `onload()`:
- `registerPluginCommands` — command palette commands (only enabled when active view is a Canvas; gated through `ifActiveViewIsCanvas`).
- `registerCanvasAutoLink` — patches the Canvas prototype's `addNode`/`removeNode`/`addEdge`/`removeEdge`/`clear` to keep file frontmatter in sync with canvas structure.
- `registerFileManagerPatches` — patches `FileManager.trashFile`/`renameFile` to clean or migrate plugin-managed properties when files are deleted or renamed.
- `registerFocusCanvas` — when navigating to a canvas via a metadata-panel link click, selects + zooms the matching node.
- `registerCanvasExploder` — wires the "Split by Headings" menu items (file-menu, editor-menu, plus a patched node `showMenu` for text nodes).
- `registerCanvasNodeAutoHeightPatcher` — patches `onResizeDblclick` / `onResizePointerdown` / `blur` on the canvas node prototype to implement auto-resize-to-content.

`onload` also walks every `.canvas` file in the vault to bulk-add properties; `onunload` does the inverse and strips them.

### Prototype patching (the load-bearing pattern)

The plugin extends Obsidian Canvas heavily via `monkey-around`'s `around()`. Canvas internals aren't part of Obsidian's public API — see `Canvas.d.ts` for the reverse-engineered surface this plugin relies on.

Patching can only happen once a Canvas leaf exists in the workspace, so each patcher uses the same idiom:

```ts
const tryToPatch = () => { if (patch()) detachListeners(); };
plugin.app.workspace.on('active-leaf-change', tryToPatch);
plugin.app.workspace.on('layout-change', tryToPatch);
plugin.app.workspace.onLayoutReady(tryToPatch);
tryToPatch();
```

Touching this pattern broke pinned-tab handling on Windows in the past (commit `742eb70`). Detach listeners after a successful patch — leaving them attached causes re-patching and breaks things.

Every `around()` uninstaller is registered with `this.register(uninstaller)` so prototype patches are reverted on plugin unload.

### Two node concepts — do not mix them

- **JSON node**: the plain object stored in the `.canvas` file. `node.file` is a **path string**. Used by `addProperty` / `removeProperty` / `renameProperty` and any code that walks `canvasData.nodes`.
- **Live `CanvasNode`**: the runtime object in `canvas.nodes`. `node.filePath` is the path string, `node.file` is the `TFile`. Used by event handlers like `addNodeUpdate` / `removeNodeUpdate`.

Functions are commented with which they expect (see `main.ts:158-160`). Pay attention — the same property names mean different things on each side.

### Frontmatter synchronization

When `settings.enableFrontmatter` is on, the plugin writes two kinds of frontmatter properties on notes referenced by canvas nodes:
1. `canvas: [[<canvas-name>]]` — every canvas the note appears in.
2. A property named after each canvas's basename, holding markdown links to other nodes that note has edges to.

Every mutation function early-returns if `enableFrontmatter` is false. **Important invariant**: cleanup must run *before* flipping the setting off, otherwise `removeProperty` no-ops and nothing gets cleaned. The settings tab handler in `main.ts` enforces this — preserve it if you refactor.

### Modules under `src/`

- `CanvasExploder.ts` — splits a file or text node into a heading-tree of connected nodes; constants at the top of the file (`HEADING_LIMIT`, `COMPACT_HEIGHT`, etc.) tune layout.
- `SendToCanvas.ts` — "Send to Canvas" / "Send to Selected Canvas" commands; uses `FuzzySuggestModal` for selection and persists `selectedCanvas` only in memory (cleared on unload).
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. The settings tab UI lives in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver compare for release-notes gating) and `randomId` (uses `crypto.getRandomValues`; prefer this over `Math.random()` for IDs).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — modal shown on first run / version bump, gated by `settings.showReleaseNotes` and `settings.previousRelease`.

### CSS

`styles.css` ships with the plugin. Visual rules live behind a body class `enhanced-canvas-enabled`, toggled by `toggleCSSClass` based on `settings.enableCustomCSS`. The class hides the metadata container in markdown embeds inside Canvas nodes.

## Codebase conventions worth knowing

- `any` and `@ts-ignore` are used extensively against Canvas internals. ESLint is configured to allow this (`@typescript-eslint/ban-ts-comment: off`, `no-prototype-builtins: off`). When extending the typed surface, prefer adding to `Canvas.d.ts` over leaving `any` in new code.
- `SECURITY_ROBUSTNESS_PLAN.md` is a *proposal* (Gemini-authored), not the current state — none of phases 1–3 are implemented. Don't treat it as documentation of what exists.
