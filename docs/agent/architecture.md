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
patches, focus-canvas, exploder, tag import, find in canvas (`new CanvasFind(this).register()`), image text search (`this.imageText.register()`, a no-op unless `enableImageTextSearch`), node auto-height, default node size, callout image resize (`registerCalloutImageResize(this)`). `onload` then runs `syncAllCanvasProperties`; `onunload` strips the
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
- `CanvasFind.ts` — "Find in canvas" command + editor-menu item + a `showSearch()` patched
  onto the CanvasView prototype, so core "Search current file" (Mod+F) opens find on a
  canvas (editing a card still gets markdown search). No own hotkey, no conflict. Highlights nodes
  matching a query (`parseTextQuery` in `utils.ts`; selected text is one literal phrase) or linking to a `[[note]]` (links resolved via
  `getFirstLinkpathDest`), dims the rest, `zoomToBbox` to fit. Uses only
  `ec-find-hit` / `ec-find-active` classes — never `node.color`, never writes the file.
  Matched text is marked via the CSS Custom Highlight API (`::highlight(ec-find)`, no
  DOM edits); a `MutationObserver` on hit nodes repaints as content lazily mounts.
  A click (not a drag) on empty canvas (`e.target === canvas.wrapperEl`) clears the find.
  A file node's name, note text and OCR text (`plugin.imageText.textOf`, null when that
  feature is off) are matched as one text; image matches are the one DOM edit: `.ec-ocr-box` divs appended to the
  node's `.image-embed`, drawn once per mount (so the observer doesn't loop), removed on clear.
- `ImageTextSearch.ts` — optional, setting `enableImageTextSearch` (default off). Indexing is
  macOS and Windows desktop only (`ImageTextSearch.canIndex`); every other device is search-only: it
  reads the synced index, never writes it, registers no Rebuild command, vault events or scan,
  and `refresh()` (run before the modal opens and before Find in canvas matches) re-reads the
  shard files whose mtime changed. OCRs every
  vault image by spawning the system `osascript -l JavaScript` with an inline JXA script
  that calls Vision.framework (macOS), or `powershell.exe -EncodedCommand` (Windows PowerShell 5.1;
  PowerShell 7 can't load WinRT) with `WIN_OCR_SCRIPT` calling `Windows.Media.Ocr`: paths go in
  as ASCII-escaped JSON on stdin, the same JSON shape comes out, and `CJK_GAP` removes the space
  Windows puts between CJK characters. Windows uses the first user-profile language with an OCR
  pack; none → exit 2 → `ocrImages()` sets `broken` (even for one image). No binary ships. `child_process` is `require`d inside
  `ocrImages()` only, so mobile never loads it (keep it that way: a top-level import breaks
  mobile). PDFs are indexed too, in-process by `readPdf()` with Obsidian's pdf.js
  (`loadPdfJs()`): only their embedded text layer (no OCR, so scanned pages stay empty; a
  password-protected PDF indexes as `[]`), one line per text line (`hasEOL`) as `[text, page]`
  (1-based) instead of a box, control characters stripped. `getDocument` must get
  `cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true` (Obsidian's own PDF view uses it): without
  it CJK text in CID fonts comes out nearly empty. pdf.js replaced macOS PDFKit after a
  302-PDF comparison (`docs/design-ocr-index-per-device.md` §4). Index
  `{path: {m: mtime, l: [[text,x,y,w,h] | [text,page]]}}` lives in
  `<plugin dir>/ocr-index/00.json`…`3f.json`, never in `data.json` (it's ~100 MB): 64 shards, a path's
  shard is `shardOf(path)` (FNV-1a mod 64 — never change it), each file is that shard's part of the
  index; a missing file is an empty shard. In memory `this.index` stays one merged object. `put()`
  marks the entry's shard in `dirty`; `save()` rewrites only dirty shards (an empty one as `{}`,
  never deleted) and puts them back in `dirty` if a write fails. `load()` reads only shards whose
  mtime changed and are not dirty (unsaved local entries win), and applies them in one step. On the
  indexing computer, `migrateLegacy` runs after the shards load, adds only paths the shards lack from an
  earlier build's single `ocr-index.json`, and deletes it only after every dirty shard is written. Rescans images whose
  mtime changed, 50 per OCR process run; vault events keep it current. Each scan first
  prunes entries whose image is gone. A failed OCR process run is retried one image at a time;
  files that still fail (images, or PDFs `readPdf()` can't open) go in the in-memory `failed`
  map with their mtime (skipped until the file changes, never indexed as empty). If every
  image of a batch fails (or the first 3 single retries), OCR itself is broken: `broken`
  skips images (PDFs keep indexing) until the "Rebuild image and PDF text index" command, which
  also clears the index and `failed`. PDF failures never set `broken`. Images
  matched by Obsidian's *Excluded files* (`metadataCache.isUserIgnored`) are skipped and pruned. Index changes must go through `put()` and writes through `save()`, which serializes and
  coalesces them — never call `adapter.write` on the index directly, and never from a search-only device. `disable()` removes
  the command, ribbon and listeners and kills the process but keeps the index. Also owns
  the vault-wide "Search text in images and PDFs" `SuggestModal`: same query syntax, scans the whole
  index for the total, sorts by matching lines, shows 50 numbered results; a canvas backlink
  opens zoomed to the image card, a PDF opens at its first matching page (`#page=N`).
  `drawOcrBoxes` skips PDF lines; PDFs get a file icon instead of a thumbnail.
  Ceiling: one entry is never split, so a single PDF whose entry exceeds 100 MiB (about 45,000
  pages) still puts its shard over GitHub's file limit. Setting `imageTextInCoreSearch` (`setCoreSearch()` reruns
  open searches for it; the patcher reruns them once patched, since a search may run first): core Search reads only `.md`/`.canvas` content, so a lazy
  patcher wraps undocumented internals (checked on 1.15.1) — the search view's `startSearch`,
  its result list's `addResult`, and, from the first query instance, the query prototype's
  `match` — handing an image's OCR text in as if it were a note (`Object.create(file)` with
  `extension: 'md'`); the `addResult` wrapper also inserts an `.ec-search-thumb` `<img>` after the result's `selfEl` (core has no image preview). Patches are always on; the hooks no-op unless the feature and setting are.
- `CalloutImageResize.ts` — workaround for core (1.14.4): images inside a Live Preview
  callout widget (`.cm-callout`) get no resize corner, and any click selects the callout
  source. A markdown post-processor tags image `.internal-embed`s with `interactive-child`
  (core's click handler skips those) and adds a `.image-resize-corner` on hover; on drag end
  it rewrites `|width` in the source, matching DOM image ↔ source embed by order (bails if
  counts differ). Applies to all markdown editors, not just canvas; desktop only. Remove
  when core supports it.
- `SendToCanvas.ts` — "Send to Canvas" via `FuzzySuggestModal`; `selectedCanvas` is
  in-memory only.
- `settings.ts` — `EnhancedCanvasSettings` + `DEFAULT_SETTINGS`. Settings UI lives
  in `main.ts`.
- `utils.ts` — `isVersionNewer` (semver), `randomId` (uses `crypto.getRandomValues`
  — prefer over `Math.random()`), tag query parsing, and the text query shared by Find in
  canvas and image search: `parseTextQuery` (Obsidian syntax: words AND, uppercase `OR`,
  `"phrase"`), `matchesTextQuery`, `queryTerms`, `normalizeText` (NFKC + lowercase).
- `ReleaseNotesModal.ts` + `releaseNotesData.ts` — first-run / version-bump modal
  (what's new + feature guide, also opened by the "Show feature guide" command),
  gated by `showReleaseNotes` / `previousRelease`.

## CSS

`styles.css` ships with the plugin. Rules live behind body class
`enhanced-canvas-enabled`, toggled by `toggleCSSClass` from `settings.enableCustomCSS`.
Hides the metadata container in markdown embeds inside Canvas nodes. The
`ec-find-*` rules (find in canvas) and `ec-ocr-*` rules (image text search) are unscoped — only `CanvasFind` / `ImageTextSearch` add those classes. `.enhanced-canvas-callout-image` (unscoped) positions
the callout image resize corner.

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
