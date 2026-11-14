import { EventRef, FileSystemAdapter, Notice, Platform, SuggestModal, TAbstractFile, TFile, setIcon } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { around } from 'monkey-around';

import EnhancedCanvas from '../main';
import type { CanvasView } from '../Canvas';
import { matchesTextQuery, normalizeText, parseTextQuery, queryTerms } from './utils';

const IMAGE_EXT = /^(png|jpe?g|heic|webp|gif|tiff?|bmp)$/i;
const BATCH = 50; // files per osascript run; keeps argv short and saves progress often
const LIMIT = 50; // results shown in the modal
const COMMAND_ID = 'search-image-text';
const REBUILD_ID = 'rebuild-image-text-index';
const SHARDS = 64; // index files; a save rewrites only the shards that changed
// FNV-1a over UTF-16 code units. Must never change: it decides which file holds a path.
const shardOf = (path: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
    return (h >>> 0) % SHARDS;
};

/** Image: [text, x, y, w, h], box normalized to the image, origin top-left. PDF: [text, page], page 1-based. */
export type OcrLine = [string, number, number, number, number] | [string, number];
type OcrIndex = Record<string, { m: number; l: OcrLine[] }>;

export const isImageFile = (f: TAbstractFile | null): f is TFile => f instanceof TFile && IMAGE_EXT.test(f.extension);
/** Files in the index: images (OCR) and PDFs (their embedded text layer only; scanned pages stay unsearchable). */
const isIndexedFile = (f: TAbstractFile | null): f is TFile => isImageFile(f) || (f instanceof TFile && f.extension.toLowerCase() === 'pdf');

// macOS's built-in JavaScript for Automation calls Vision.framework (runs on the Neural
// Engine). Nothing to ship or install: osascript is on every Mac.
// A PDF is read with PDFKit instead: its embedded text, no OCR, so a scanned PDF indexes as empty.
const OCR_SCRIPT = `ObjC.import('Vision');
ObjC.import('PDFKit');
function pdf(p) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(p));
  if (doc.isNil()) return null; // unreadable
  if (doc.isLocked) return []; // password-protected: no text to read, and retrying won't change that
  var lines = [];
  for (var i = 0; i < doc.pageCount; i++) {
    var s = doc.pageAtIndex(i).string;
    if (s.isNil()) continue;
    s.js.split(/\\r\\n|\\r|\\n/).forEach(function (t) { t = t.trim(); if (t) lines.push([t, i + 1]); });
  }
  return lines;
}
function run(paths) {
  return JSON.stringify(paths.map(function (p) {
    try {
      if (/\\.pdf$/i.test(p)) return pdf(p);
      var req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = 0; // accurate
      req.usesLanguageCorrection = true;
      // macOS 13+; older systems keep Vision's default languages.
      if (req.respondsToSelector('setAutomaticallyDetectsLanguage:')) req.automaticallyDetectsLanguage = true;
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(p), $({}));
      if (!handler.performRequestsError($([req]), null)) return null; // unreadable image, not "no text"
      var res = req.results, lines = [];
      for (var i = 0; i < res.count; i++) {
        var o = res.objectAtIndex(i), c = o.topCandidates(1), b = o.boundingBox;
        if (c.count) lines.push([c.objectAtIndex(0).string.js, b.origin.x, 1 - b.origin.y - b.size.height, b.size.width, b.size.height]);
      }
      return lines;
    } catch (e) { return null; } // script error, not "no text": the caller must not index it as empty
  }));
}`;

/**
 * Optional: on macOS desktop, OCR every vault image into an index kept in the plugin
 * folder (no notes are created); on every device, a vault-wide "Search text in images"
 * modal and image matches for Find in canvas. Other devices only read the synced index.
 */
export class ImageTextSearch {
    index: OcrIndex = {};
    private enabled = false;
    private refs: EventRef[] = [];
    private ribbon: HTMLElement | null = null;
    private proc: ChildProcess | null = null;
    private scanning = false;
    private rescan = false;
    private gen = 0; // bumped by disable(), so a scan can tell its osascript was killed on purpose
    private failed = new Map<string, number>(); // path → mtime OCR couldn't read; retried once the file changes
    private broken = false; // OCR itself failed: no scans until Rebuild, so each change doesn't burn a new batch
    private saving: Promise<void> = Promise.resolve();
    private saveQueued = false;
    private loadedAt: number[] = []; // per shard: mtime of the file last read or written
    private dirty = new Set<number>(); // shards changed since the last save

    constructor(readonly plugin: EnhancedCanvas) {}

    /** Only macOS desktop reads images; other devices search the index that sync brings over. */
    static get canIndex() { return Platform.isMacOS && Platform.isDesktopApp; }

    get isEnabled() { return this.enabled; }

    /** True while images are still being read, so a search may miss some. */
    get isIndexing() { return this.scanning; }

    private get indexDir() { return `${this.plugin.manifest.dir}/ocr-index`; }
    private shardPath(s: number) { return `${this.indexDir}/${s.toString(16).padStart(2, '0')}.json`; }

    /** The only way to change one entry: it marks the entry's shard for the next save. */
    private put(path: string, entry?: OcrIndex[string]) {
        if (entry) this.index[path] = entry; else delete this.index[path];
        this.dirty.add(shardOf(path));
    }

    register() {
        this.plugin.register(() => this.disable());
        // Patched always; the hooks do nothing unless the feature and imageTextInCoreSearch are on.
        this.plugin.registerLazyPatcher(() => this.patchCoreSearch());
        if (this.plugin.settings.enableImageTextSearch) void this.enable();
    }

    private get inCoreSearch() { return this.enabled && this.plugin.settings.imageTextInCoreSearch; }

    private open = () => void this.refresh().then(() => { if (this.enabled) new ImageTextModal(this).open(); });

    /** Reruns open core searches, so image results follow imageTextInCoreSearch. */
    setCoreSearch() {
        for (const leaf of this.plugin.app.workspace.getLeavesOfType('search')) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const view = leaf.view as any;
            if (!view.getQuery?.()) continue;
            view.searchQuery = null; // else the same query only rechecks files the last run matched
            view.startSearch?.();
        }
    }

    /**
     * Core Search reads only .md/.canvas content, so images match by filename alone. Undocumented
     * internals (checked on 1.15.1): the query's match(file, content) gets an image's OCR text as
     * if it were a note, and the result list's addResult gets it too, to render the matched lines.
     * Missing methods → no patch, Search works as before.
     */
    private patchCoreSearch() {
        // A deferred (not yet shown) leaf has no startSearch; take the first loaded one.
        const view = this.plugin.app.workspace.getLeavesOfType('search')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((l) => l.view as any)
            .find((v) => typeof v?.startSearch === 'function' && typeof v.dom?.addResult === 'function');
        if (!view) return false;
        const ocr = (f: TFile) => {
            const t = this.inCoreSearch && isIndexedFile(f) ? this.textOf(f.path) : null;
            return t ? t.lines.map((l) => l[0]).join('\n') : null;
        };
        const { plugin } = this;
        const active = () => this.inCoreSearch;
        const refresh = () => { if (active()) void this.refresh(); };
        plugin.register(around(Object.getPrototypeOf(view.dom), {
            addResult: (next) => function (this: unknown, file: TFile, result: unknown, content: string, ...rest: unknown[]) {
                const t = ocr(file);
                const item = next.call(this, file, result, t ?? content, ...rest);
                // Core shows no image preview; add one between the title and the matched lines.
                if (t !== null && isImageFile(file) && item?.selfEl instanceof HTMLElement && !item.selfEl.nextElementSibling?.matches('.ec-search-thumb')) {
                    item.selfEl.after(createEl('img', {
                        cls: 'ec-search-thumb', attr: { src: plugin.app.vault.getResourcePath(file), loading: 'lazy' },
                    }));
                }
                return item;
            },
        }));
        let queryPatched = false;
        plugin.register(around(view.constructor.prototype, {
            startSearch: (next) => function (this: typeof view, ...args: unknown[]) {
                refresh(); // search-only devices: pick up a synced index for the next search
                const r = next.apply(this, args);
                // The query class is reachable only through a query, which the first search creates.
                const proto = this.searchQuery && Object.getPrototypeOf(this.searchQuery);
                if (queryPatched || typeof proto?.match !== 'function') return r;
                queryPatched = true;
                plugin.register(around(proto, {
                    match: (m) => function (this: unknown, file: TFile, content: string) {
                        const t = ocr(file);
                        return t === null ? m.call(this, file, content)
                            : m.call(this, Object.create(file, { extension: { value: 'md' } }), t);
                    },
                }));
                if (!active()) return r;
                this.searchQuery = null; // a repeated query only rechecks the last run's matches
                return next.apply(this, args); // rerun the first search with the patch
            },
        }));
        // A search that ran before this patch (a deferred tab shown, or startup) has no image results yet.
        if (active()) this.setCoreSearch();
        return true;
    }

    async enable() {
        if (this.enabled) return;
        this.enabled = true;
        const { app } = this.plugin;
        const gen = this.gen;
        await this.load();
        // Turned off while reading (and maybe on again: that later call does the setup).
        if (gen !== this.gen) return;

        this.plugin.addCommand({ id: COMMAND_ID, name: 'Search text in images', callback: this.open });
        this.ribbon = this.plugin.addRibbonIcon('scan-text', 'Search text in images', this.open);
        this.setCoreSearch();
        // Search-only devices never write the index: the indexing Mac owns the file.
        if (!ImageTextSearch.canIndex) return;
        this.plugin.addCommand({ id: REBUILD_ID, name: 'Rebuild image text index', callback: () => void this.rebuild() });

        app.workspace.onLayoutReady(() => {
            if (gen !== this.gen) return;
            const changed = (f: TAbstractFile) => { if (isIndexedFile(f)) void this.scan(); };
            this.refs = [
                app.vault.on('create', changed),
                app.vault.on('modify', changed),
                app.vault.on('delete', (f) => {
                    if (!this.index[f.path]) return;
                    this.put(f.path);
                    void this.save();
                }),
                app.vault.on('rename', (f, old) => {
                    if (!this.index[old]) return;
                    this.put(f.path, this.index[old]);
                    this.put(old);
                    void this.save();
                }),
            ];
            void this.scan();
        });
    }

    /** Stops indexing and removes the UI. The index file stays, so re-enabling is instant. */
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.gen++;
        this.refs.forEach((r) => this.plugin.app.vault.offref(r));
        this.refs = [];
        this.ribbon?.remove();
        this.ribbon = null;
        this.setCoreSearch(); // removes image results from open searches
        this.plugin.removeCommand(COMMAND_ID);
        this.plugin.removeCommand(REBUILD_ID);
        this.proc?.kill();
        this.proc = null;
    }

    /** Reads the shards whose file changed since they were last read. */
    private async load() {
        const { adapter } = this.plugin.app.vault;
        const gen = this.gen;
        await this.saving; // else a disable/enable mid-save reads the old files over newer entries
        const changed: { s: number; m: number; entries: OcrIndex }[] = [];
        // ponytail: 64 stats per call, one at a time (lower peak memory on phones). Add a manifest file if that is slow.
        for (let s = 0; s < SHARDS; s++) {
            try {
                const m = (await adapter.stat(this.shardPath(s)))?.mtime;
                // A dirty shard has entries a failed save didn't write; the next save writes them over the file.
                if (m === undefined || m === this.loadedAt[s] || this.dirty.has(s)) continue; // no file yet, or already read
                changed.push({ s, m, entries: JSON.parse(await adapter.read(this.shardPath(s))) });
            } catch { /* unreadable or mid-sync: keep what we have for this shard */ }
        }
        if (gen !== this.gen) return;
        const stale = new Set(changed.map((c) => c.s));
        if (stale.size) for (const p of Object.keys(this.index)) if (stale.has(shardOf(p))) delete this.index[p];
        for (const c of changed) { Object.assign(this.index, c.entries); this.loadedAt[c.s] = c.m; }
        // After the shards: a retry (an earlier migration's save failed) must not overwrite newer entries.
        if (ImageTextSearch.canIndex) await this.migrateLegacy(gen);
    }

    /** One-time: moves the single-file index of earlier builds into shards. */
    private async migrateLegacy(gen: number) {
        const { adapter } = this.plugin.app.vault;
        const legacy = `${this.plugin.manifest.dir}/ocr-index.json`;
        try {
            if (!(await adapter.exists(legacy))) return;
            const index: OcrIndex = JSON.parse(await adapter.read(legacy));
            if (gen !== this.gen) return;
            // Adds only paths the shards lack. A path a scan dropped can come back; the next scan drops it again.
            for (const [p, e] of Object.entries(index)) if (!(p in this.index)) this.put(p, e);
            await this.save();
            if (!this.dirty.size) await adapter.remove(legacy); // only once every shard is on disk
        } catch (e) { console.error('Enhanced Canvas OCR: migrating the old index failed', e); }
    }

    /** On search-only devices, picks up an index file that sync replaced. */
    async refresh() {
        if (this.enabled && !ImageTextSearch.canIndex) await this.load();
    }

    /** Writes never overlap (that can truncate the file); calls made while one waits share it. */
    private save() {
        if (this.saveQueued) return this.saving;
        this.saveQueued = true;
        return this.saving = this.saving.then(async () => {
            this.saveQueued = false;
            const { adapter } = this.plugin.app.vault;
            const shards = [...this.dirty];
            this.dirty.clear();
            // Snapshot now (no await before this), so entries changed during the writes go to the next save.
            const out = new Map<number, OcrIndex>(shards.map((s) => [s, {}]));
            for (const [p, e] of Object.entries(this.index)) {
                const o = out.get(shardOf(p));
                if (o) o[p] = e;
            }
            try {
                if (!(await adapter.exists(this.indexDir))) await adapter.mkdir(this.indexDir);
                for (const s of shards) {
                    await adapter.write(this.shardPath(s), JSON.stringify(out.get(s)));
                    this.loadedAt[s] = (await adapter.stat(this.shardPath(s)))?.mtime ?? -1;
                }
            } catch (e) {
                shards.forEach((s) => this.dirty.add(s)); // rewriting a shard is harmless; losing one is not
                console.error('Enhanced Canvas OCR: saving the index failed', e);
            }
        });
    }

    /** Forgets every reading, failures included, and reads all images again. */
    private async rebuild() {
        // Abort a running scan: its todo list was built from the old index.
        this.gen++;
        this.proc?.kill();
        this.proc = null;
        this.index = {};
        for (let s = 0; s < SHARDS; s++) this.dirty.add(s);
        this.failed.clear();
        this.broken = false;
        await this.save();
        new Notice('Enhanced Canvas: rebuilding the image text index…');
        void this.scan();
    }

    /** OCR every image whose mtime changed since it was indexed; drop entries whose image is gone or excluded. */
    private async scan() {
        if (this.broken) return;
        if (this.scanning) { this.rescan = true; return; }
        this.scanning = true;
        const { vault, metadataCache } = this.plugin.app;
        // Settings → Files and links → Excluded files.
        const excluded = (p: string) => metadataCache.isUserIgnored?.(p) ?? false;
        try {
            do {
                this.rescan = false;
                const gen = this.gen;
                const gone = Object.keys(this.index).filter((p) => !isIndexedFile(vault.getAbstractFileByPath(p)) || excluded(p));
                gone.forEach((p) => this.put(p));
                if (gone.length) await this.save();

                const todo = vault.getFiles().filter((f) => isIndexedFile(f) && !excluded(f.path)
                    && this.index[f.path]?.m !== f.stat.mtime && this.failed.get(f.path) !== f.stat.mtime);
                const notice = todo.length > BATCH ? new Notice('', 0) : null;
                let warned = false;
                try {
                    for (let i = 0; i < todo.length && gen === this.gen; i += BATCH) {
                        notice?.setMessage(`Enhanced Canvas: reading text in images and PDFs ${i} / ${todo.length}`);
                        const batch = todo.slice(i, i + BATCH);
                        // Taken before OCR: an image changed mid-run must still look stale afterwards.
                        const mtimes = batch.map((f) => f.stat.mtime);
                        let lines: (OcrLine[] | null)[] | null = await this.ocr(batch);
                        // One bad image fails the whole run: retry one by one so it can't block the rest.
                        if (!lines && batch.length > 1) {
                            lines = [];
                            for (const f of batch) {
                                if (gen !== this.gen) break;
                                lines.push((await this.ocr([f]))?.[0] ?? null);
                                // ponytail: the first 3 all failing alone = OCR is broken, not the images; saves up to ~18 min of retries.
                                // Later failures in a row are not checked: each is retried and marked failed on its own.
                                if (lines.length === 3 && lines.every((l) => !l)) break;
                            }
                        }
                        if (gen !== this.gen) break; // disabled: osascript was killed, not a failure

                        // Every image failing means OCR itself is broken: pause instead of marking them all failed.
                        if (batch.length > 1 && batch.every((_, j) => !lines?.[j])) {
                            this.broken = true;
                            new Notice('Enhanced Canvas: macOS text recognition isn\'t working, so reading images is paused. Run "Rebuild image text index" to try again.', 0);
                            break;
                        }
                        let bad = 0;
                        batch.forEach((f, j) => {
                            const l = lines?.[j];
                            if (!l) { this.failed.set(f.path, mtimes[j]); bad++; console.warn('Enhanced Canvas OCR: could not read', f.path); }
                            // Skip a file deleted while it was being read.
                            else if (vault.getAbstractFileByPath(f.path) === f) this.put(f.path, { m: mtimes[j], l });
                        });
                        await this.save();
                        if (bad && !warned) {
                            warned = true;
                            new Notice(`Enhanced Canvas: couldn't read text in ${bad} file${bad === 1 ? '' : 's'}. They're retried when changed, or run "Rebuild image text index".`);
                        }
                    }
                } finally {
                    notice?.hide();
                }
            } while (this.rescan && this.enabled && !this.broken);
        } finally {
            this.scanning = false;
        }
    }

    private ocr(files: TFile[]): Promise<(OcrLine[] | null)[] | null> {
        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return Promise.resolve(null);
        // Required lazily: child_process doesn't exist on mobile, where this never runs.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spawn } = require('child_process') as typeof import('child_process');
        const gen = this.gen;
        return new Promise((resolve) => {
            const proc = this.proc = spawn('osascript', ['-l', 'JavaScript', '-e', OCR_SCRIPT, ...files.map((f) => adapter.getFullPath(f.path))],
                // A hung osascript must not stall indexing forever. Must be an integer: spawn throws on a fraction. Size term: a 19 MB, 2,720-page PDF reads in ~11 s on an M4.
                { timeout: 20_000 + 2_000 * files.length + Math.round(files.reduce((t, f) => t + f.stat.size, 0) / 500) });
            let out = '', err = '';
            // Decode as one stream: a CJK character split across two chunks would otherwise be garbled.
            proc.stdout?.setEncoding('utf8');
            proc.stderr?.setEncoding('utf8');
            proc.stdout?.on('data', (d) => (out += d));
            proc.stderr?.on('data', (d) => (err += d));
            proc.on('error', (e) => { console.error('Enhanced Canvas OCR:', e); resolve(null); });
            proc.on('close', (code) => {
                if (this.proc === proc) this.proc = null;
                try {
                    if (code !== 0) throw new Error(err || `osascript exited with ${code}`);
                    resolve(JSON.parse(out));
                } catch (e) {
                    if (gen === this.gen) console.error('Enhanced Canvas OCR:', e); // else killed by disable()
                    resolve(null);
                }
            });
        });
    }

    /** Normalized text of each line, cached per index entry (a re-read image gets a new array). */
    private normCache = new WeakMap<OcrLine[], string[]>();
    private norm(l: OcrLine[]) {
        let n = this.normCache.get(l);
        if (!n) this.normCache.set(l, n = l.map((x) => normalizeText(x[0])));
        return n;
    }

    /** OCR lines of one image with their normalized text; null when off or not indexed. */
    textOf(path: string) {
        const l = this.index[path]?.l;
        return this.enabled && l ? { lines: l, norm: this.norm(l) } : null;
    }

    /** Images matching the query (parseTextQuery syntax), most matching lines first. */
    search(input: string) {
        const query = parseTextQuery(input), terms = queryTerms(query);
        const { vault } = this.plugin.app;
        const results: { path: string; hits: OcrLine[]; terms: string[]; n: number }[] = [];
        if (!terms.length) return { results, total: 0 };
        // ponytail: linear scan of the whole index for the total; fine for a few thousand images.
        for (const [path, { l }] of Object.entries(this.index)) {
            const norm = this.norm(l);
            // Per line, so a phrase can't span OCR lines: every match then has a line to box.
            if (!matchesTextQuery(query, (t) => norm.some((n) => n.includes(t)))) continue;
            if (!isIndexedFile(vault.getAbstractFileByPath(path))) continue; // deleted, entry not pruned yet
            results.push({ path, terms, n: 0, hits: l.filter((_, i) => terms.some((t) => norm[i].includes(t))) });
        }
        results.sort((a, b) => b.hits.length - a.hits.length);
        const shown = results.slice(0, LIMIT);
        shown.forEach((r, i) => (r.n = i + 1));
        return { results: shown, total: results.length };
    }

    /** Indexed image path → notes that embed or link it. Walks every link once: build per modal, not per result. */
    backlinks() {
        const map = new Map<string, string[]>();
        for (const [source, links] of Object.entries(this.plugin.app.metadataCache.resolvedLinks)) {
            for (const dest in links) {
                if (!this.index[dest]) continue;
                const sources = map.get(dest);
                if (sources) sources.push(source); else map.set(dest, [source]);
            }
        }
        return map;
    }

    /** Line in `source` of its first embed of or link to the image. */
    refLine(source: string, imagePath: string) {
        const { metadataCache } = this.plugin.app;
        const cache = metadataCache.getCache(source);
        return [...(cache?.embeds ?? []), ...(cache?.links ?? [])]
            .find((r) => metadataCache.getFirstLinkpathDest(r.link.split('#')[0], source)?.path === imagePath)
            ?.position.start.line ?? 0;
    }
}

/** Draws a highlight box over each OCR line on an element laid over the image. */
export function drawOcrBoxes(container: HTMLElement, lines: OcrLine[]) {
    for (const l of lines) {
        if (l.length !== 5) continue; // PDF text has no box
        const [, x, y, w, h] = l;
        const box = container.createDiv('ec-ocr-box');
        box.setCssStyles({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    }
}

type ImageTextResult = ReturnType<ImageTextSearch['search']>['results'][number];

class ImageTextModal extends SuggestModal<ImageTextResult> {
    private backlinks: Map<string, string[]>;
    private countEl: HTMLElement;

    constructor(private search: ImageTextSearch) {
        super(search.plugin.app);
        this.backlinks = search.backlinks();
        this.setPlaceholder('Search text inside images and PDFs: words, OR, "exact phrase"');
        this.limit = LIMIT;
        this.countEl = this.modalEl.createDiv('ec-ocr-count'); // modal's own document (pop-out windows)
        this.resultContainerEl.before(this.countEl);
    }

    getSuggestions(query: string) {
        const { results, total } = this.search.search(query);
        const count = !query.trim() ? ''
            : total > results.length ? `Showing ${results.length} of ${total} results` : `${total} result${total === 1 ? '' : 's'}`;
        // Before the index is complete, "no results" may just mean "not read yet".
        const indexing = this.search.isIndexing ? 'Still reading images and PDFs; results may be incomplete.' : '';
        this.countEl.setText([count, indexing].filter(Boolean).join(' · '));
        return results;
    }

    renderSuggestion({ path, hits, terms, n }: ImageTextResult, el: HTMLElement) {
        const file = this.app.vault.getAbstractFileByPath(path) as TFile; // search() keeps only existing images
        const row = el.createDiv('ec-ocr-result');
        const thumb = row.createDiv('ec-ocr-thumb');
        if (isImageFile(file)) {
            thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), loading: 'lazy' } });
            drawOcrBoxes(thumb, hits);
        } else setIcon(thumb, 'file-text');

        const meta = row.createDiv('ec-ocr-meta');
        meta.createDiv({ cls: 'ec-ocr-name', text: `${n}. ${file.name}` });
        for (const l of hits.slice(0, 3)) {
            const line = meta.createDiv('ec-ocr-line');
            if (l.length === 2) line.createSpan({ cls: 'ec-ocr-page', text: `p. ${l[1]} ` });
            markWords(line, l[0], terms);
        }
        const notes = this.backlinks.get(path);
        if (notes) meta.createDiv({ cls: 'ec-ocr-notes', text: '↳ ' + notes.map((n) => n.split('/').pop()?.replace(/\.md$/, '')).join(', ') });
    }

    /**
     * A PDF opens at the page of its first match. An image opens the note that embeds it, at
     * the embed's line (a canvas zooms to the image card); else the image itself.
     */
    async onChooseSuggestion({ path, hits }: ImageTextResult) {
        const first = hits[0];
        if (first?.length === 2) {
            // Not openLinkText: it splits the path at the first '#', which a file name may contain.
            const pdf = this.app.vault.getAbstractFileByPath(path);
            if (pdf instanceof TFile) await this.app.workspace.getLeaf(false).openFile(pdf, { eState: { subpath: `#page=${first[1]}` } });
            return;
        }
        const note = this.backlinks.get(path)?.[0];
        const file = this.app.vault.getAbstractFileByPath(note ?? path);
        if (!(file instanceof TFile)) return;
        const leaf = this.app.workspace.getLeaf(false);
        const isCanvas = file.extension === 'canvas';
        await leaf.openFile(file, note && !isCanvas ? { eState: { line: this.search.refLine(note, path) } } : {});
        if (!isCanvas) return;
        const canvas = (leaf.view as CanvasView).canvas;
        // ponytail: first card showing the image; an image embedded inside a text card isn't found.
        const node = canvas && [...canvas.nodes.values()].find((n) => n.filePath === path);
        if (node) canvas.zoomToBbox(node.getBBox());
    }
}

function markWords(el: HTMLElement, text: string, words: string[]) {
    const n = normalizeText(text);
    // ponytail: assumes NFKC keeps string length; a rare ligature shifts the mark by a char.
    for (let i = 0; i < text.length;) {
        const w = words.find((w) => n.startsWith(w, i));
        if (w) { el.createEl('mark', { text: text.slice(i, i + w.length) }); i += w.length; }
        else { el.appendText(text[i]); i++; }
    }
}
