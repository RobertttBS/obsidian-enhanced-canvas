import { EventRef, FileSystemAdapter, Notice, Platform, SuggestModal, TAbstractFile, TFile } from 'obsidian';
import type { ChildProcess } from 'child_process';

import EnhancedCanvas from '../main';

const IMAGE_EXT = /^(png|jpe?g|heic|webp|gif|tiff?|bmp)$/i;
const BATCH = 50; // images per osascript run; keeps argv short and saves progress often
const COMMAND_ID = 'search-image-text';

/** [text, x, y, w, h]: box normalized to the image, origin top-left. */
export type OcrLine = [string, number, number, number, number];
type OcrIndex = Record<string, { m: number; l: OcrLine[] }>;

/** Case- and width-insensitive form, so "ＡＢＣ（１）" matches "abc(1)". */
export const normalizeText = (s: string) => s.normalize('NFKC').toLowerCase();

export const isImageFile = (f: TAbstractFile | null): f is TFile => f instanceof TFile && IMAGE_EXT.test(f.extension);

// macOS's built-in JavaScript for Automation calls Vision.framework (runs on the Neural
// Engine). Nothing to ship or install: osascript is on every Mac.
const OCR_SCRIPT = `ObjC.import('Vision');
function run(paths) {
  return JSON.stringify(paths.map(function (p) {
    try {
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
 * Optional (macOS desktop only): OCR every vault image into an index kept in the plugin
 * folder (no notes are created), a vault-wide "Search text in images" modal, and
 * image matches for Find in canvas.
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
    private saving: Promise<void> = Promise.resolve();
    private saveQueued = false;

    constructor(readonly plugin: EnhancedCanvas) {}

    static get supported() { return Platform.isMacOS && Platform.isDesktopApp; }

    get isEnabled() { return this.enabled; }

    private get indexPath() { return `${this.plugin.manifest.dir}/ocr-index.json`; }

    register() {
        this.plugin.register(() => this.disable());
        if (this.plugin.settings.enableImageTextSearch) void this.enable();
    }

    async enable() {
        if (this.enabled || !ImageTextSearch.supported) return;
        this.enabled = true;
        const { app } = this.plugin;
        const gen = this.gen;
        let index: OcrIndex = {};
        try { index = JSON.parse(await app.vault.adapter.read(this.indexPath)); } catch { /* no index yet */ }
        // Turned off while reading (and maybe on again: that later call does the setup).
        if (gen !== this.gen) return;
        this.index = index;

        const open = () => new ImageTextModal(this).open();
        this.plugin.addCommand({ id: COMMAND_ID, name: 'Search text in images', callback: open });
        this.ribbon = this.plugin.addRibbonIcon('scan-text', 'Search text in images', open);

        app.workspace.onLayoutReady(() => {
            if (gen !== this.gen) return;
            const changed = (f: TAbstractFile) => { if (isImageFile(f)) void this.scan(); };
            this.refs = [
                app.vault.on('create', changed),
                app.vault.on('modify', changed),
                app.vault.on('delete', (f) => {
                    if (!this.index[f.path]) return;
                    delete this.index[f.path];
                    void this.save();
                }),
                app.vault.on('rename', (f, old) => {
                    if (!this.index[old]) return;
                    this.index[f.path] = this.index[old];
                    delete this.index[old];
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
        this.plugin.removeCommand(COMMAND_ID);
        this.proc?.kill();
        this.proc = null;
    }

    /** Writes never overlap (that can truncate the file); calls made while one waits share it. */
    private save() {
        if (this.saveQueued) return this.saving;
        this.saveQueued = true;
        return this.saving = this.saving.then(() => {
            this.saveQueued = false;
            return this.plugin.app.vault.adapter.write(this.indexPath, JSON.stringify(this.index));
        }).catch((e) => console.error('Enhanced Canvas OCR: saving the index failed', e));
    }

    /** OCR every image whose mtime changed since it was indexed; drop entries whose image is gone. */
    private async scan() {
        if (this.scanning) { this.rescan = true; return; }
        this.scanning = true;
        const { vault } = this.plugin.app;
        try {
            do {
                this.rescan = false;
                const gen = this.gen;
                const gone = Object.keys(this.index).filter((p) => !isImageFile(vault.getAbstractFileByPath(p)));
                gone.forEach((p) => delete this.index[p]);
                if (gone.length) await this.save();

                const todo = vault.getFiles().filter((f) => isImageFile(f)
                    && this.index[f.path]?.m !== f.stat.mtime && this.failed.get(f.path) !== f.stat.mtime);
                const notice = todo.length > BATCH ? new Notice('', 0) : null;
                let warned = false;
                try {
                    for (let i = 0; i < todo.length && gen === this.gen; i += BATCH) {
                        notice?.setMessage(`Enhanced Canvas: reading text in images ${i} / ${todo.length}`);
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
                            }
                        }
                        if (gen !== this.gen) break; // disabled: osascript was killed, not a failure

                        let bad = 0;
                        batch.forEach((f, j) => {
                            const l = lines?.[j];
                            if (!l) { this.failed.set(f.path, mtimes[j]); bad++; console.warn('Enhanced Canvas OCR: could not read', f.path); }
                            // Skip a file deleted while it was being read.
                            else if (vault.getAbstractFileByPath(f.path) === f) this.index[f.path] = { m: mtimes[j], l };
                        });
                        await this.save();
                        if (bad && !warned) {
                            warned = true;
                            new Notice(`Enhanced Canvas: couldn't read text in ${bad === batch.length && batch.length > 1 ? 'some images' : `${bad} image${bad === 1 ? '' : 's'}`}. See console.`);
                        }
                        // ponytail: every image of a batch failing means OCR itself is broken; stop until the next scan.
                        if (bad === batch.length && batch.length > 1) break;
                    }
                } finally {
                    notice?.hide();
                }
            } while (this.rescan && this.enabled);
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
                { timeout: 20_000 + 2_000 * files.length }); // a hung osascript must not stall indexing forever
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

    /** OCR lines of one image that contain `needle`; [] when off or not indexed. */
    linesMatching(path: string, needle: string): OcrLine[] {
        const l = this.index[path]?.l;
        if (!this.enabled || !needle || !l) return [];
        const n = normalizeText(needle), norm = this.norm(l);
        return l.filter((_, i) => norm[i].includes(n));
    }

    /** Images whose text contains every space-separated word of the query. */
    search(query: string) {
        // Longest first, so markWords marks "ab" whole when the query is "a ab".
        const words = normalizeText(query).split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
        const results: { path: string; hits: OcrLine[]; words: string[] }[] = [];
        if (!words.length) return results;
        for (const [path, { l }] of Object.entries(this.index)) {
            const norm = this.norm(l);
            if (!words.every((w) => norm.some((t) => t.includes(w)))) continue;
            results.push({ path, words, hits: l.filter((_, i) => words.some((w) => norm[i].includes(w))) });
            if (results.length >= 50) break; // ponytail: linear scan; fine for a few thousand images
        }
        return results;
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
    for (const [, x, y, w, h] of lines) {
        const box = container.createDiv('ec-ocr-box');
        box.setCssStyles({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    }
}

type ImageTextResult = ReturnType<ImageTextSearch['search']>[number];

class ImageTextModal extends SuggestModal<ImageTextResult> {
    private backlinks: Map<string, string[]>;

    constructor(private search: ImageTextSearch) {
        super(search.plugin.app);
        this.backlinks = search.backlinks();
        this.setPlaceholder('Search text inside images…');
        this.limit = 50;
    }

    getSuggestions(query: string) { return this.search.search(query); }

    renderSuggestion({ path, hits, words }: ImageTextResult, el: HTMLElement) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        const row = el.createDiv('ec-ocr-result');
        const thumb = row.createDiv('ec-ocr-thumb');
        thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), loading: 'lazy' } });
        drawOcrBoxes(thumb, hits);

        const meta = row.createDiv('ec-ocr-meta');
        meta.createDiv({ cls: 'ec-ocr-name', text: file.name });
        for (const [text] of hits.slice(0, 3)) markWords(meta.createDiv('ec-ocr-line'), text, words);
        const notes = this.backlinks.get(path);
        if (notes) meta.createDiv({ cls: 'ec-ocr-notes', text: '↳ ' + notes.map((n) => n.split('/').pop()?.replace(/\.md$/, '')).join(', ') });
    }

    /** Opens the note that embeds the image, at the embed's line; else the image itself. */
    async onChooseSuggestion({ path }: ImageTextResult) {
        const note = this.backlinks.get(path)?.[0];
        const file = this.app.vault.getAbstractFileByPath(note ?? path);
        if (!(file instanceof TFile)) return;
        await this.app.workspace.getLeaf(false).openFile(file, note ? { eState: { line: this.search.refLine(note, path) } } : {});
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
