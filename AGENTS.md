## Commands

- `npm run dev` — esbuild watch, inline-sourcemap `main.js`. **Default.** Reload plugin in Obsidian to pick up changes.
- `npm run build` / `npm run version` exist but aren't part of the maintainer's flow — don't run unless asked.
- No tests/lint/CI. esbuild ignores type errors; run `npx tsc -noEmit` ad hoc.

## Architecture

Obsidian plugin (`isDesktopOnly: false`). Entry `main.ts` → `main.js` via `esbuild.config.mjs`. Obsidian and CodeMirror are externals — do not bundle.

### `main.ts` — `EnhancedCanvas`

Features are `register*` methods called from `onload()` (see `main.ts:445-453`): plugin commands, canvas auto-link, file-manager patches, focus-canvas, exploder, tag import, node auto-height, default node size, drag-temp-node. `onload` walks every `.canvas` to bulk-add properties; `onunload` strips them.

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

- **JSON node** (in `.canvas` file): `node.file` is a **path string**. Used by `addProperty`/`removeProperty`/`renameProperty` and code walking `canvasData.nodes`.
- **Live `CanvasNode`** (in `canvas.nodes`): `node.filePath` is the path string, `node.file` is the `TFile`. Used by `addNodeUpdate`/`removeNodeUpdate`.

Same names, different things. See comments at `main.ts:158-160`.

### Multi-window

Popped-out Canvas views have their own `Document`. DOM listeners bound to `activeDocument` at load time only fire in the main window. `registerFocusCanvas` already attaches per-document via `workspace.on('window-open')` + `iterateAllLeaves` — follow that pattern for any new DOM listener. Workspace events fire globally and are safe.

### Frontmatter sync

When `settings.enableFrontmatter` is on, plugin writes:
1. `canvas: [[<canvas-name>]]` on every referenced note.
2. A property named after each canvas's basename, holding links to edge-connected nodes.

Mutation functions early-return if disabled. **Invariant: cleanup must run *before* flipping the setting off**, else `removeProperty` no-ops. Settings tab handler enforces this — preserve it.

### `src/` modules

- `CanvasExploder.ts` — file/text node → heading-tree of connected nodes. Layout constants at top.
- `CanvasTagImport.ts` + `AdvancedTagSuggestModal.ts` — import tagged notes into a canvas.
- `SendToCanvas.ts` — "Send to Canvas" via `FuzzySuggestModal`. `selectedCanvas` is in-memory only.
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. Settings UI lives in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver) and `randomId` (uses `crypto.getRandomValues` — prefer over `Math.random()`).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — first-run/version-bump modal, gated by `showReleaseNotes`/`previousRelease`.

### CSS

`styles.css` ships with the plugin. Rules live behind body class `enhanced-canvas-enabled`, toggled by `toggleCSSClass` based on `settings.enableCustomCSS`. Hides metadata container in markdown embeds inside Canvas nodes.

## Conventions

`any` and `@ts-ignore` are used heavily against Canvas internals; ESLint allows it. When typing new code, prefer extending `Canvas.d.ts` over `any`.

## Keeping this file current

When a change alters anything documented above — `register*` methods added/removed/renamed, new `src/` modules, new load-bearing patterns or invariants, settings keys, or removed files referenced here — update CLAUDE.md in the same change. Stale guidance is worse than none.
