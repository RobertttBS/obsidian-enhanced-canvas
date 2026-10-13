# Obsidian source audit — optimization backlog

Checked against the Obsidian `app.js` of **1.12.7** and **1.14.4** (unpacked from the
app's asar and pretty-printed). Findings were identical in both versions. Line numbers below are from the audit and have since drifted.

## Status

**Done** (`npx tsc --noEmit` green; not yet verified by reloading in Obsidian):
- A1: removed the `dragTempNode` patch.
- A2: text-card menu now uses the `canvas:node-menu` event (one `@ts-ignore`, the event
  isn't in Obsidian's public typings).
- B2: `renameProperty` early-returns when basenames match or the cache lacks the old key.
- B3: `deleteFile` only processes sources whose cached `frontmatterLinks` resolve to the deleted file (frontmatter embeds `![[x]]` are not cached, so they are no longer stripped).
- C: `cachedRead` in the three read-only spots, `isClearing` reset via `try/finally`,
  default node size listens to `layout-change` only.

**Not done** (decided to skip for now, revisit only if the symptom shows up):
- B1 edge flush: only matters on canvases with hundreds of edges at open time; touches
  the debounce / real-frontmatter invariants, so risk > payoff.
- B4 stacked-tabs polling: only affects Stacked Tabs users; needs per-document `scroll`
  listeners and hasn't been tested against real Stacked Tabs.
- `SendToCanvas` closed-canvas write (`JSON.stringify(…, 2)` format, non-atomic
  read+modify): needs a read/write restructure into `vault.process`.
- `CanvasExploder` fixed 250 ms wait.

**Manual check before commit:** text-card right-click shows "Split by headings"; moving a
canvas to another folder; deleting a note referenced by a canvas.

Obsidian line refs (`app.js` pretty-printed) are given as `1.12.7 / 1.14.4`.

## A. Delete or simplify

### A1. `dragTempNode` patch is redundant and buggy — `main.ts:1394-1423`
- Every Obsidian call site (`178913/178933/178959` / `192771/192792/192818`) passes
  `config.defaultTextNodeDimensions` or `config.defaultFileNodeDimensions`, which
  `applyDefaultNodeSizeToCanvas` already overwrites. The patch adds nothing.
- Bug: the patch replaces the size with the *file* size even for the "add card" (text)
  button, so its drag preview is file-sized while the created card is text-sized.
- Fix: delete `patchCanvasDragTempNode`, `registerCanvasDragTempNodePatcher`,
  `dragTempNodeUninstaller`, and the call in `onload`.

### A2. `patchCanvasNodeMenu` can use an official event — `main.ts:1197-1228`
- `Node.showMenu` ends with `workspace.trigger("canvas:node-menu", menu, node)`
  (`182425` / `196285`).
- Fix: `registerEvent(workspace.on('canvas:node-menu', (menu, node) => …))` keeping the
  `node.text !== undefined && !node.file` check. Removes a lazy patcher, the
  `plugin = this` alias, and the prototype-depth assumption.

## B. Performance / write amplification

### B1. Edge flush is O(E × (N log N + E)) — `main.ts:991-997`, `919`
- Opening a canvas queues every edge; the flush calls `processNodeUpdate` per edge, and
  each call runs `canvas.getData()` (sorts + serializes all nodes/edges,
  `179216` / `193074`) and rebuilds the maps.
- Fix: call `getData()` and build the maps once per flush; group pending edges by
  `fromNode.filePath` so each source note is processed once. Keep the debounce and the
  "decisions read real frontmatter in the callback" invariants.

### B2. `renameProperty` rewrites every node's note — `main.ts:277-306`
- No cache gate (unlike `removeProperty`). `processFrontMatter` always re-serializes
  YAML (`vI` `94760` / `vB`), and `vault.process` only skips the write when output ===
  input, so non-canonical YAML gets reformatted and comments are lost.
- Moving a canvas to another folder keeps the basename, yet still touches every note.
- Fix: early-return when `oldBaseName === newBaseName` or the cached frontmatter has no
  `oldBaseName` key.

### B3. `deleteFile` rewrites every backlinking note — `main.ts:659-686`
- Runs `processFrontMatter` on every backlink source, whether or not its frontmatter
  links to the deleted file. Deleting a heavily-linked note rewrites (and reformats) all
  of them, sequentially.
- Fix: gate on `metadataCache.getFileCache(source)?.frontmatterLinks` — only process
  sources whose frontmatter actually links to the file.

### B4. Stacked-tabs 200 ms polling — `main.ts:559-605`
- Polling is needed (`canvasRect` is cached, `Canvas.onResize` `179775` / `193635`;
  sliding tabs change `left`, not width, so ResizeObserver doesn't fire), but it forces
  layout every 200 ms until the leaf changes, and the stacked check is a global
  `querySelector`.
- Fix: listen for `scroll` on the leaf's `.workspace-tab-container` (Obsidian does the
  same, `onContainerScroll` `80318` / `89868`), throttle with `requestAnimationFrame`,
  call `view.onResize()`, and use `leaf.parent.isStacked` instead of the global query.

## C. Small items

- **`cachedRead`**: `syncAllCanvasProperties` (`main.ts:352`), `deleteCanvasFile`
  (`692`), `renameCanvasFile` (`707`) only read; use `vault.cachedRead`. Biggest win is
  the startup sweep over every canvas.
- **`isClearing`** (`main.ts:1156-1164`): `Canvas.clear` is synchronous
  (`179376` / `193234`), so `try { old() } finally { isClearing = false }` is exact;
  the `queueMicrotask` reset can swallow a real removal in the same tick.
- **Default node size** (`main.ts:1383`): listens to both `active-leaf-change` and
  `layout-change`; `config` is created with the view, so `layout-change` suffices.
- **`SendToCanvas` write to a closed canvas** (`src/SendToCanvas.ts:130`):
  `JSON.stringify(data, null, 2)` differs from Obsidian's own format (tab-indented,
  all-primitive objects collapsed to one line — `dc` `33224` / `Yb`), so the first write
  diffs the whole file. `read`+`modify` is also non-atomic; prefer `vault.process`.
- **`CanvasExploder` fixed 250 ms wait** (`src/CanvasExploder.ts:328`): already marked
  `ponytail:`; file nodes may under-measure. Upgrade: wait for `node.child` to load,
  then `renderer.onRendered`.

## Suggested order
1. A1, A2 (pure deletion, lowest risk).
2. B2, B3 (add early-returns / cache gates; no behavior change).
3. C small items.
4. B1, B4 (larger changes; do if big canvases / Stacked Tabs matter).

Any change touching frontmatter sync must keep the 5 invariants in `CLAUDE.md`, and the
docs (`CLAUDE.md` ↔ `AGENTS.md`, `docs/agent/architecture.md`) must be updated in the
same change.
