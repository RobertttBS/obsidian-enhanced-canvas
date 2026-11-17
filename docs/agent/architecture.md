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
commits `742646a`, `282fcd3`). Do not hand-roll the retry. Register every uninstaller with
`this.register(...)`.

## Two node concepts — do not mix

Same names, different things (`JsonNodeRef` and the comments in `addProperty`/`removeProperty`, `main.ts`):

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

Known, deliberately unfixed: opening a canvas queues every edge, and the flush runs
`processNodeUpdate` per edge, each calling `canvas.getData()` (O(E × (N log N + E))).
Only hurts canvases with hundreds of edges; batching it per flush touches the debounce
and real-frontmatter invariants, so it waits until the symptom shows up.

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
- `ImageTextSearch.ts` — optional, setting `enableImageTextSearch` (default on). Indexing is
  desktop only (`ImageTextSearch.canIndex`, Linux included); mobile is search-only: it
  reads the synced index, never writes it, registers no Rebuild command, vault events or scan,
  and `refresh()` (run before the modal opens and before Find in canvas matches) re-reads the
  shard files whose mtime changed. OCRs every
  vault image by spawning the system `osascript -l JavaScript` with an inline JXA script
  that calls Vision.framework (macOS), or `powershell.exe -Command -` (Windows PowerShell 5.1;
  PowerShell 7 can't load WinRT) with `WIN_OCR_SCRIPT` calling `Windows.Media.Ocr`: the script goes in
  on stdin (not `-EncodedCommand`, which antivirus/EDR flags) as one `try` statement plus a blank line, with the paths
  embedded as ASCII-escaped JSON (`winOcrScript`); the same JSON shape comes out, and `CJK_GAP` removes the space
  Windows puts between CJK characters. Windows uses the user's first zh/ja/ko language (Settings order,
  `GlobalizationPreferences.Languages`) that has OCR, else the first installed zh/ja/ko OCR language, else
  the first user-profile one (one engine reads one language; an English engine drops CJK silently).
  PowerShell is spawned by full path (`%SystemRoot%\System32\WindowsPowerShell\v1.0`). Known blocks
  set `broken` + `blockedBy` (even for one image) and the notice names the cause (`BLOCK_HINT`):
  exit 2 = no OCR language, exit 3 = Constrained Language Mode (checked on the script's first line),
  spawn ENOENT = missing, other spawn errors / AMSI text on stderr = blocked; the one-by-one retries that pause OCR all exiting nonzero with empty stderr and no signal (an EDR kill), or 3 such runs in a row across scans (`silentRuns`, for one image per run) = stopped. Image paths of 260+ chars go in as `\\?\` / `\\?\UNC\` (`longPath`): PS 5.1 can't open them otherwise without LongPathsEnabled. No binary ships. `child_process` is `require`d inside
  `ocrImagesNative()` only, so mobile never loads it (keep it that way: a top-level import breaks
  mobile). **Built-in OCR** (`docs/design-builtin-ocr.md`): `engine` picks the image OCR per batch — macOS
  `'system'`, Linux `'builtin'`, Windows whatever the device-local key `ENGINE_KEY`
  (`enhanced-canvas-ocr-engine`, `app.saveLocalStorage`, never `data.json`) says — empty (`storedEngine` null) = the default,
  `'builtin'`, also for devices updated from a build that only had Windows OCR (no migration to `'system'`): PowerShell
  starts only once the user picks Windows OCR. `removeBuiltin()` leaves the key alone: the built-in OCR offers the download again, a Windows OCR user stays on
  Windows OCR. An empty key with `'system'` in `readBy` (an update from a build that only had Windows OCR) becomes
  `'builtin'` through `setEngine()` in `scan()`, just before the built-in OCR's first batch. The key is set by the "OCR engine"
  setting (Windows only, `canChooseEngine`) or the paused notice's "Use built-in OCR" button (`setEngine()`, which
  bumps `gen`, so a running batch is dropped, not failed, and the scan restarts). `setEngine()` also drops the
  images from `failed` (the other engine may read them; PDF failures stay, no OCR) and, if another engine read images on this device
  (`readBy`, the engines that have read an image here, in `DEVICE_KEY`; builds before it kept one `readImage` flag,
  which `loadDevice()` reads as the stored engine, or Windows OCR with none stored) and images are indexed,
  `offerReread()` shows one notice (replacing a previous one) whose button runs `rereadImages()`: every indexed
  image goes in the device-local `reread` set (`DEVICE_KEY`; never `m` in the synced index, or every other device
  would re-read too), which `stale()` treats as stale; a read removes it (success replaces the text, failure keeps
  the old text and goes in `failed`). Rebuild clears `reread`. Built-in without its files
  (`OcrAssets.ready()`): the scan leaves images out (not failed; PDFs go on) and `offerDownload()` shows a Download
  notice once per run; never falls back to the system OCR. `BuiltinOcr.ts` runs PaddleOCR (PP-OCRv6 small,
  onnxruntime-web, single thread) in a classic Worker started from a Blob URL; the worker source is
  `src/ocr-worker.js`, bundled to a string against `onnxruntime-web/webgpu` by the `ocr-worker-source` virtual module
  (`esbuild.config.mjs`). It is `.js` because tsc (`moduleResolution: "node"`, TS 4.7) can't resolve
  `ppu-paddle-ocr/web`; don't make it `.ts`. The asyncify `.wasm` is **not** in `main.js` (only its JS glue is,
  inside the worker source): it is downloaded with the models (`docs/design-builtin-ocr.md`, decision 4), and
  `esbuild.config.mjs` fails the build unless `node_modules`' `.wasm` has the SHA-256 listed in `OcrAssets.ts` (glue
  and `.wasm` must be the same onnxruntime-web version). `OcrAssets.ts` fetches `det.onnx`,
  `rec.onnx`, `dict.txt`, `ort-wasm-simd-threaded.asyncify.wasm` from this repo's GitHub release `ocr-assets-1` with `requestUrl` (fetch hits CORS), checks
  the SHA-256 constants before storing, and keeps them in IndexedDB `enhanced-canvas-ocr-assets` (key
  `<tag>/<name>`, no vault id; outside the vault so sync doesn't carry 60 MB; `load()` returns fresh buffers, which the worker takes by transfer). Resumes per file
  (so a device that has the models fetches only a file added later), verifies only on
  write, one `download()` at a time; `clear()` (command "Remove downloaded built-in OCR files") deletes the database (the engine key stays).
  `missingBytes` (as of the last `ready()`) lets `offerDownload()` say how much is left when an update added a file. A new model or onnxruntime version needs a new tag (and `scripts/fetch-ocr-assets.mjs`
  prepares the files; the maintainer uploads them). The worker tries WebGPU (`['webgpu', 'wasm']`) unless
  `navigator.gpu` is missing (then `['wasm']`); the log line ends with `ep=...`; after two GPU worker failures in a
  row (init, or the timeout/"restarting the worker" path) it uses WASM until Obsidian restarts; a GPU init failure
  is retried at once, so one failing start falls through to WASM within the same `read()`. Batches are
  `builtin.batchSize`: 50 on WebGPU, 10 on WASM (~7 s per image). Traps in the worker: clear
  `ort.env.wasm.wasmPaths` before `initialize()` (else onnxruntime imports its glue from jsDelivr); use
  `strategy: 'per-box'` (per-line drops vertical margin text); `.ort` models fail on WebGPU (no NHWC Conv kernel)
  and the library falls back to WASM silently, so only `.onnx`; the library creates both sessions in parallel and
  WebGPU refuses the second, so the worker serializes `InferenceSession.create`; `powerPreference` is ignored on
  Windows. `BuiltinOcr` and `OcrAssets` use no Node modules and may only `import type` from `ImageTextSearch.ts`,
  so `CJK_GAP` is applied in `ocrImages()`. PDFs are indexed too, in-process by `readPdf()` with Obsidian's pdf.js
  (`loadPdfJs()`): only their embedded text layer (no OCR, so scanned pages stay empty), one line per text line (`hasEOL`) as `[text, page]`
  (1-based) instead of a box, control characters stripped. `getDocument` must get
  `cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true` (Obsidian's own PDF view uses it): without
  it CJK text in CID fonts comes out nearly empty. pdf.js replaced macOS PDFKit after a
  302-PDF comparison (`docs/design-ocr-index-per-device.md` §4). A PDF with a user password
  (`PasswordException`; owner-only passwords open fine) is indexed as `{l: [], pw: 'locked'}`; the scan never
  prompts, it ends with one notice linking to `PdfUnlockModal` (also the "Unlock password-protected PDFs"
  command, indexing devices only). There each PDF gets its own password; one that opens a PDF is tried on
  the rest. `unlockPdf()` reads it with the password and stores `pw: 'unlocked'`; the password is never
  stored (decided: type it once; text stays). `rebuild()` keeps `unlocked` entries (it couldn't re-read them);
  a PDF changed since is re-read by the scan and so locked again. The text is plaintext in the synced index —
  accepted, the modal warns. Earlier builds indexed locked PDFs as plain `[]`: the first scan re-reads empty
  PDF entries once (`pdfLockChecked`, device-local). Index
  `{path: {m: mtime, l: [[text,x,y,w,h] | [text,page]], pw?}}` lives in
  `<plugin dir>/ocr-index/00.json`…`3f.json`, never in `data.json` (it's ~100 MB): 64 shards, a path's
  shard is `shardOf(path)` (FNV-1a mod 64 — never change it), each file is that shard's part of the
  index; a missing file is an empty shard. In memory `this.index` stays one merged object. `put()`
  marks the entry's shard in `dirty`; `save()` rewrites only dirty shards (an empty one as `{}`,
  never deleted) and puts them back in `dirty` if a write fails. `load()` reads only shards whose
  mtime changed and are not dirty (unsaved local entries win), and applies them in one step. On the
  indexing computer, `migrateLegacy` runs after the shards load, adds only paths the shards lack from an
  earlier build's single `ocr-index.json`, and deletes it only after every dirty shard is written. Rescans images whose
  mtime changed, 50 per OCR process run (10 on built-in WASM; at most `PDF_BATCH` = 5 PDFs per batch, so progress is saved often); vault events keep it current. Each scan first
  prunes entries whose image is gone. A failed OCR process run is retried one image at a time;
  files that still fail (images, or PDFs `readPdf()` can't open) go in the `failed`
  map with their mtime (skipped until the file changes, never indexed as empty). `failed`, `reread` and `readBy`
  are per device, in `app.saveLocalStorage(DEVICE_KEY)`, not the synced index: they survive restarts, so a bad file
  isn't retried (and re-notified) on every launch. If every
  `ALWAYS_DECODABLE` image (png/jpg/gif/tiff/bmp — not HEIC/WebP, which need Windows Store codecs) of a
  batch fails and the current engine has never read an image on this device (`readBy`; the index can't tell, it may be synced
  from another device), or the first 3 single-retry runs fail as whole runs, OCR itself is broken (`pause()`):
  `broken` for the system OCR, `builtinBroken` (this run only) for the built-in one; `paused` is the current
  engine's. It skips images (PDFs keep indexing) until the "Rebuild image and PDF text index" command, which
  also clears the index (except unlocked PDFs) and `failed`. `broken` + `blockedBy` are saved in `DEVICE_KEY`
  as soon as they change, so a restart doesn't start PowerShell again (an EDR alert each time); only Rebuild clears
  them, and switching to the built-in OCR doesn't (they describe the system OCR). The paused notice
  (`noticePaused()`) shows at most once per run, also for a state read back at startup (an engine change or
  removing the built-in files resets that, and the download offer); on Windows it offers the
  built-in OCR. **Crash guard** (`docs/design-ocr-consent-and-crash-guard.md` B): EDR may kill all of Obsidian
  when PowerShell/osascript starts, so nothing after the spawn runs. `ocrImagesNative()` writes a per-vault marker
  (`os.tmpdir()`, named by `app.appId`) with sync fs before every spawn and removes it `MARKER_LINGER` (10 s) after
  the process ends; `disable()` and the workspace `quit` event and the main window's `beforeunload` (a reload fires no `quit`) remove it at once. A marker found by `enable()`
  (`checkMarker()`; skipped if the engine is now `'builtin'`, and an empty engine is restored to `'system'`, since
  the kill can beat Chromium's localStorage flush of the choice) is recorded in the device-wide `ocr-killed.json` (`%LOCALAPPDATA%` /
  Application Support), which every vault reads before each spawn and `applyKill()` mirrors into `broken` +
  `blockedBy: 'killed'` — so Rebuild re-applies it instead of clearing it. `noticeKilled()` asks (built-in, or keep
  using → `allowSystemAgain()`, which also sets the engine to `'system'` when it's empty or built-in); after a second kill only the built-in OCR is offered, and the settings button
  ("Try … OCR again", shown while `systemKilled`) is the only way back. Keep fs sync there: localStorage
  and async writes may not reach disk before the kill. PDF failures never pause. Images
  matched by Obsidian's *Excluded files* (`metadataCache.isUserIgnored`) are skipped and pruned. Index changes must go through `put()` and writes through `save()`, which serializes and
  coalesces them — never call `adapter.write` on the index directly, and never from a search-only device. `disable()` removes
  the command, ribbon and listeners and kills the process but keeps the index. Also owns
  the vault-wide "Search text in images and PDFs" `SuggestModal`: same query syntax, scans the whole
  index for the total, sorts by matching lines, numbers them all. The modal caches that list per
  query + kind (rescanned on every redraw while `isIndexing`; rows tolerate a file deleted since) and shows `PAGE` = 50; a last "Show more" row (overridden `selectSuggestion`, so it
  doesn't close) adds 50 by redrawing the list, then restores the scroll and selects the first new
  row via the private `chooser.setSelectedItem`. An All / Images / PDFs
  filter (reset to All on every open) is applied inside `search()` before paging, and each
  button shows that kind's match count; the row (filter + toggle) is hidden while the query is empty. A compact toggle (not remembered) is CSS only: the
  `ec-ocr-compact` class on the modal hides thumbnails and backlinks and keeps one match line,
  with a file-type icon before the name; a canvas backlink
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
   **Both are a how-to for users, not a changelog**: each bullet tells the user what to
   click, run or set to use the feature. Leave out engine/library names, internals,
   "X now does Y" comparisons, and "nothing changes for Z" lines.
   Updates show `whatsNew` + `featureGuide`; first install shows `featureGuide`;
   the "Show feature guide" command reopens the update view.
3. Commit as `update manifest.json to <version>`.
4. Push `master` (ask first).
5. Publish (ask first; it ships to every user): `npm run build` (production
   `main.js`, no sourcemap — the dev build must not ship), then
   `gh release create <version> main.js manifest.json styles.css --title <version> --notes "<what's new>"`.
   The tag is the bare version (no `v`) and must equal `manifest.json`'s `version`.
