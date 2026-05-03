# CLAUDE.md

Guidance for Claude Code working in this repo.

## Commands

- `npm run dev` — esbuild watch mode, writes inline-sourcemap `main.js`. **Default to this.** Reload the plugin in Obsidian to pick up changes.
- `npm run build` / `npm run version` exist but aren't part of the maintainer's workflow — don't run unless asked.
- No tests, lint, or CI. esbuild won't fail on type errors; run `tsc -noEmit` ad hoc if needed.

## Architecture

Obsidian plugin (`isDesktopOnly: false`). Entry `main.ts` → `main.js` via `esbuild.config.mjs`. Obsidian and CodeMirror are externals — do not bundle.

### `main.ts` — the `EnhancedCanvas` class

Features are `register*` methods called from `onload()`:
- `registerPluginCommands` — palette commands, gated by `ifActiveViewIsCanvas`.
- `registerCanvasAutoLink` — patches Canvas `addNode`/`removeNode`/`addEdge`/`removeEdge`/`clear` to sync frontmatter.
- `registerFileManagerPatches` — patches `FileManager.trashFile`/`renameFile` to clean/migrate plugin properties.
- `registerFocusCanvas` — selects+zooms a node when navigating via metadata-panel link.
- `registerCanvasExploder` — "Split by Headings" menu wiring (file-menu, editor-menu, patched node `showMenu`).
- `registerCanvasNodeAutoHeightPatcher` — patches `onResizeDblclick`/`onResizePointerdown`/`blur` for auto-resize-to-content.

`onload` walks every `.canvas` to bulk-add properties; `onunload` strips them.

### Prototype patching (load-bearing)

Uses `monkey-around`'s `around()`. Canvas internals are reverse-engineered in `Canvas.d.ts`. Patching needs a Canvas leaf, so every patcher uses:

```ts
const tryToPatch = () => { if (patch()) detachListeners(); };
plugin.app.workspace.on('active-leaf-change', tryToPatch);
plugin.app.workspace.on('layout-change', tryToPatch);
plugin.app.workspace.onLayoutReady(tryToPatch);
tryToPatch();
```

Touching this broke Windows pinned tabs before (commit `742eb70`). **Detach listeners after a successful patch** — leaving them attached re-patches and breaks things. Register every uninstaller with `this.register(...)`.

### Two node concepts — don't mix

- **JSON node** (in `.canvas` file): `node.file` is a **path string**. Used by `addProperty`/`removeProperty`/`renameProperty` and anything walking `canvasData.nodes`.
- **Live `CanvasNode`** (in `canvas.nodes`): `node.filePath` is the path string, `node.file` is the `TFile`. Used by `addNodeUpdate`/`removeNodeUpdate`.

Same names mean different things. Functions are commented with which they expect (see `main.ts:158-160`).

### Frontmatter sync

When `settings.enableFrontmatter` is on, plugin writes:
1. `canvas: [[<canvas-name>]]` on every referenced note.
2. A property named after each canvas's basename, holding links to edge-connected nodes.

Mutation functions early-return if disabled. **Invariant: cleanup must run *before* flipping the setting off**, else `removeProperty` no-ops. Settings tab handler enforces this — preserve it.

### `src/` modules

- `CanvasExploder.ts` — file/text node → heading-tree of connected nodes. Layout constants at top (`HEADING_LIMIT`, `COMPACT_HEIGHT`, …).
- `SendToCanvas.ts` — "Send to Canvas" commands via `FuzzySuggestModal`. `selectedCanvas` is in-memory only.
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. Settings UI lives in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver) and `randomId` (uses `crypto.getRandomValues` — prefer over `Math.random()`).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — first-run/version-bump modal, gated by `showReleaseNotes`/`previousRelease`.

### CSS

`styles.css` ships with the plugin. Rules live behind body class `enhanced-canvas-enabled`, toggled by `toggleCSSClass` based on `settings.enableCustomCSS`. Hides metadata container in markdown embeds inside Canvas nodes.

## Conventions

- `any` and `@ts-ignore` used heavily against Canvas internals; ESLint allows it. When typing, prefer extending `Canvas.d.ts` over `any` in new code.
- `SECURITY_ROBUSTNESS_PLAN.md` is a Gemini-authored *proposal*, not current state. Don't treat as docs.
