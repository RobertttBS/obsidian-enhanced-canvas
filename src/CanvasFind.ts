import { App, ItemView, Menu, Modal, Notice, Setting, TFile } from 'obsidian';
import { around } from 'monkey-around';

import EnhancedCanvas from '../main';
import { Canvas, CanvasNode, CanvasView } from '../Canvas';
import { OcrLine, drawOcrBoxes } from './ImageTextSearch';
import { matchesTextQuery, normalizeText, parseTextQuery, queryTerms } from './utils';

// Classes only; node.color and the .canvas file are never touched.
const HIT_CLASS = 'ec-find-hit';
const ACTIVE_CLASS = 'ec-find-active';
// CSS Custom Highlight API name; styled by ::highlight(ec-find) in styles.css.
const HIGHLIGHT_NAME = 'ec-find';

// TS 4.7's DOM lib predates the CSS Custom Highlight API.
interface HighlightLike { add(range: Range): void; delete(range: Range): boolean }
type HighlightWindow = Window & {
    CSS: { highlights?: Map<string, HighlightLike> };
    Highlight?: new () => HighlightLike;
};

/** Live text highlighting for one canvas's find; repaints as node content (re)renders. */
interface FindSession {
    win: HighlightWindow;
    // Off-screen nodes are detached, so querySelectorAll on the view would miss them.
    hits: CanvasNode[];
    // Image cards matched by their OCR text (Search text in images and PDFs), with the matching lines.
    ocr: Map<CanvasNode, OcrLine[]>;
    observer: MutationObserver;
    ranges: Range[];
    frame: number;
    offClick: () => void;
}

/** Asks for the query or [[link]] to find. */
class FindQueryModal extends Modal {
    constructor(app: App, private onSubmit: (query: string) => void) {
        super(app);
    }

    onOpen() {
        this.setTitle('Find in canvas');
        let query = '';
        const submit = () => { this.close(); this.onSubmit(query); };
        new Setting(this.contentEl)
            .setDesc('Words (all must match), OR between alternatives, "exact phrase", or a [[link]] to match every card that links to that note.')
            .addText((text) => {
                text.setPlaceholder('words, OR, "phrase" or [[link]]').onChange((v) => (query = v));
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
                });
                window.setTimeout(() => text.inputEl.focus());
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Highlights every canvas node that contains a word or links to a note, dims the
 * rest, and zooms to fit the hits.
 */
export class CanvasFind {
    // ponytail: a canvas closed mid-find stays here until the next find/unload; fine at this size.
    private sessions = new Map<Canvas, FindSession>();

    constructor(private plugin: EnhancedCanvas) {}

    register() {
        const plugin = this.plugin;
        plugin.register(() => this.sessions.forEach((_, canvas) => this.clear(canvas)));

        plugin.addCommand({
            id: 'find-in-canvas',
            name: 'Find in canvas (selected text or link)',
            checkCallback: (checking) => {
                const canvas = this.activeCanvas();
                if (!canvas) return false;
                if (!checking) this.open(canvas);
                return true;
            },
        });

        // Core "Search current file" (Mod+F, Edit → Find) calls the active editor's
        // showSearch(), else the view's. Canvas has none, so give it one: editing a
        // card keeps markdown search, the canvas itself gets find. No hotkey conflict.
        plugin.registerLazyPatcher(() => {
            const view = plugin.app.workspace.getLeavesOfType('canvas')
                .find((l) => (l.view as CanvasView)?.canvas != null)?.view as CanvasView | undefined;
            if (!view) return false;
            const openFind = (canvas: Canvas) => this.open(canvas);
            plugin.register(around(view.constructor.prototype, {
                showSearch: () => function (this: CanvasView) { if (this.canvas) openFind(this.canvas); },
            }));
            return true;
        });

        plugin.addCommand({
            id: 'clear-find-in-canvas',
            name: 'Clear find highlights',
            checkCallback: (checking) => {
                const canvas = this.activeCanvas();
                if (!canvas || !this.sessions.has(canvas)) return false;
                if (!checking) this.clear(canvas);
                return true;
            },
        });

        // Right-click selected text while editing a card.
        plugin.registerEvent(
            plugin.app.workspace.on('editor-menu', (menu: Menu, editor) => {
                const canvas = this.activeCanvas();
                const selection = editor.getSelection().trim();
                if (!canvas || !selection) return;
                menu.addItem((item) => item
                    .setTitle('Find in canvas')
                    .setIcon('search')
                    .onClick(() => void this.find(canvas, selection, true)));
            })
        );
    }

    private open(canvas: Canvas) {
        const selection = this.plugin.app.workspace.activeEditor?.editor?.getSelection().trim();
        if (selection) void this.find(canvas, selection, true);
        else new FindQueryModal(this.plugin.app, (q) => void this.find(canvas, q)).open();
    }

    private activeCanvas(): Canvas | null {
        const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        return view?.getViewType() === 'canvas' ? (view as CanvasView).canvas ?? null : null;
    }

    clear(canvas: Canvas) {
        canvas.view.containerEl.removeClass(ACTIVE_CLASS);
        const session = this.sessions.get(canvas);
        if (!session) return;
        this.sessions.delete(canvas);
        session.hits.forEach((n) => n.nodeEl.removeClass(HIT_CLASS));
        session.ocr.forEach((_, n) => n.nodeEl.querySelectorAll('.ec-ocr-box').forEach((b) => b.remove()));
        session.observer.disconnect();
        session.offClick();
        session.win.cancelAnimationFrame(session.frame);
        const highlight = session.win.CSS.highlights?.get(HIGHLIGHT_NAME);
        session.ranges.forEach((r) => highlight?.delete(r));
    }

    /**
     * Marks each occurrence inside the hit nodes with the CSS Custom Highlight API —
     * no DOM edits, so rendered markdown and editors are untouched. Node content
     * mounts lazily (off-screen, async file render), so repaint on DOM changes.
     * A plain click on the empty canvas ends the find.
     */
    private startSession(canvas: Canvas, hits: CanvasNode[], ocr: Map<CanvasNode, OcrLine[]>, target: TFile | null, terms: string[], sourcePath: string) {
        const win = canvas.view.containerEl.win as HighlightWindow;
        const registry = win.CSS.highlights;
        let hl = registry?.get(HIGHLIGHT_NAME);
        if (!hl && registry && win.Highlight) registry.set(HIGHLIGHT_NAME, hl = new win.Highlight());

        // Same test the canvas uses for "blank": the event targets the wrapper itself.
        // Drag on blank pans or box-selects, so only a click that barely moved counts.
        const wrapper = canvas.wrapperEl;
        let down: { x: number; y: number } | null = null;
        const onDown = (e: PointerEvent) => {
            down = e.target === wrapper && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
        };
        const onClick = (e: MouseEvent) => {
            if (down && e.target === wrapper && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) this.clear(canvas);
        };
        wrapper.addEventListener('pointerdown', onDown);
        wrapper.addEventListener('click', onClick);

        const session: FindSession = {
            win, hits, ocr, ranges: [], frame: 0,
            observer: new MutationObserver(() => {
                if (!session.frame) session.frame = win.requestAnimationFrame(paint);
            }),
            offClick: () => {
                wrapper.removeEventListener('pointerdown', onDown);
                wrapper.removeEventListener('click', onClick);
            },
        };

        const paint = () => {
            session.frame = 0;
            if (!hl) return;
            // Image text has no DOM text to highlight: box it over the image instead.
            // Drawn once per mount, so the mutation it causes doesn't repaint forever.
            session.ocr.forEach((lines, node) => {
                const content = node.nodeEl.querySelector<HTMLElement>('.image-embed');
                if (content && !content.querySelector('.ec-ocr-box')) drawOcrBoxes(content, lines);
            });
            session.ranges.forEach((r) => hl?.delete(r));
            session.ranges = [];
            const doc = win.document;
            for (const node of hits) {
                if (target) {
                    node.nodeEl.querySelectorAll<HTMLElement>('a.internal-link, [data-href]').forEach((a) => {
                        const href = (a.getAttribute('data-href') ?? a.getAttribute('href') ?? '').split('#')[0];
                        if (this.plugin.app.metadataCache.getFirstLinkpathDest(href, node.filePath ?? sourcePath) !== target) return;
                        const range = doc.createRange();
                        range.selectNodeContents(a);
                        session.ranges.push(range);
                    });
                    continue;
                }
                const walker = doc.createTreeWalker(node.nodeEl, NodeFilter.SHOW_TEXT);
                for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
                    // ponytail: assumes normalizing keeps offsets; a few chars (e.g. İ, ligatures) shift the mark.
                    const hay = normalizeText(text.data);
                    for (const term of terms) {
                        for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + term.length)) {
                            const range = doc.createRange();
                            range.setStart(text, i);
                            range.setEnd(text, Math.min(i + term.length, text.length));
                            session.ranges.push(range);
                        }
                    }
                }
            }
            session.ranges.forEach((r) => hl?.add(r));
        };

        for (const node of hits) session.observer.observe(node.nodeEl, { childList: true, subtree: true, characterData: true });
        this.sessions.set(canvas, session);
        paint();
    }

    /** `literal`: the whole query is one phrase (selected text), not parseTextQuery syntax. */
    async find(canvas: Canvas, query: string, literal = false) {
        this.clear(canvas);
        query = query.trim();
        if (!query) return;

        const { metadataCache, vault } = this.plugin.app;
        const sourcePath = canvas.view.file?.path ?? '';
        const target = this.resolveLink(query, sourcePath);
        const parsed = literal ? [[normalizeText(query)]] : parseTextQuery(query);
        const terms = queryTerms(parsed);
        if (!target && !terms.length) return;
        const matches = (...texts: string[]) => {
            const hay = normalizeText(texts.join('\n'));
            return matchesTextQuery(parsed, (t) => hay.includes(t));
        };

        // Walk the JSON nodes: here node.file is a path string, not a TFile.
        const hitIds: string[] = [];
        const ocrLines = new Map<string, OcrLine[]>();
        if (!target) await this.plugin.imageText.refresh(); // link search never reads image text
        for (const data of canvas.getData().nodes) {
            let hit = false;
            if (data.type === 'text') {
                hit = target
                    ? this.textLinks(data.text).some((l) => this.resolveLink(l, sourcePath) === target)
                    : matches(data.text);
            } else if (data.type === 'file') {
                const file = vault.getAbstractFileByPath(data.file);
                if (!(file instanceof TFile)) continue;
                if (target) {
                    const cache = metadataCache.getFileCache(file);
                    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])];
                    hit = file === target || refs.some((r) => metadataCache.getFirstLinkpathDest(r.link.split('#')[0], file.path) === target);
                } else {
                    // Name, note text and image text count as one text, so terms may match in any of them.
                    const ocr = this.plugin.imageText.textOf(file.path);
                    hit = matches(file.basename, file.extension === 'md' ? await vault.cachedRead(file) : '', ocr?.norm.join('\n') ?? '');
                    const lines = hit && ocr ? ocr.lines.filter((_, i) => terms.some((t) => ocr.norm[i].includes(t))) : [];
                    if (lines.length) ocrLines.set(data.id, lines);
                }
            } else if (data.type === 'group') {
                hit = !target && matches(data.label ?? '');
            } else if (data.type === 'link') {
                hit = !target && matches(data.url);
            }
            if (hit) hitIds.push(data.id);
        }

        // Clear again after the awaits: an overlapping find may have started a session meanwhile.
        this.clear(canvas);
        const hits = hitIds.map((id) => canvas.nodes.get(id)).filter((n): n is CanvasNode => n !== undefined);
        if (hits.length === 0) {
            new Notice(`No cards match "${query}".`);
            return;
        }

        canvas.view.containerEl.addClass(ACTIVE_CLASS);
        for (const node of hits) node.nodeEl.addClass(HIT_CLASS);
        const ocr = new Map(hits.filter((n) => ocrLines.has(n.id)).map((n) => [n, ocrLines.get(n.id) as OcrLine[]]));
        this.startSession(canvas, hits, ocr, target, terms, sourcePath);

        const boxes = hits.map((n) => n.getBBox());
        canvas.zoomToBbox({
            minX: Math.min(...boxes.map((b) => b.minX)),
            minY: Math.min(...boxes.map((b) => b.minY)),
            maxX: Math.max(...boxes.map((b) => b.maxX)),
            maxY: Math.max(...boxes.map((b) => b.maxY)),
        });
        new Notice(`Found "${query}" in ${hits.length} card${hits.length === 1 ? '' : 's'}. Click an empty spot on the Canvas to clear.`);
    }

    /** "[[Note#h|alias]]", "![[Note]]" or "[x](Note.md)" → the TFile it points to; null otherwise. */
    private resolveLink(query: string, sourcePath: string): TFile | null {
        // Whole query must be one link; bare words and "[[Note]] more text" stay words.
        const linkpath = query.match(/^!?\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]$/)?.[1]
            ?? query.match(/^!?\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)$/)?.[1];
        if (!linkpath) return null;
        let decoded = linkpath;
        try { decoded = decodeURI(linkpath); } catch { /* keep raw */ }
        return this.plugin.app.metadataCache.getFirstLinkpathDest(decoded.trim(), sourcePath);
    }

    /** Text nodes aren't in the metadata cache, so pull their links by hand. */
    private textLinks(text: string): string[] {
        // ponytail: regex, misses links inside code blocks; fine for highlighting.
        return Array.from(text.matchAll(/\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\)/g), (m) => m[0]);
    }
}
