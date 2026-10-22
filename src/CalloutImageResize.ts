import { Platform, Plugin } from 'obsidian';
import { EditorView } from '@codemirror/view';

/*
 * Workaround (Obsidian 1.14.4): in Live Preview a callout is one rendered widget, so its
 * images get no resize corner, and any click inside it selects the callout source
 * (RW.hookClickHandler). Clicks under `.interactive-child` are skipped by that handler,
 * so we tag image embeds with it and add our own corner that rewrites `|width`.
 * Remove once core supports resizing images inside callouts.
 */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);
const DIM = /^\s*\d+\s*(x\s*\d+\s*)?$/;
// ponytail: md destination is `<...>` or paren-free; bare `(a (1).png)` misses and commitWidth bails on the count mismatch.
const EMBED = /!\[\[([^\]]+?)\]\]|!\[([^\]]*)\]\((\s*<[^>]*>[^)]*|[^)]+)\)/g;

function isImagePath(path: string): boolean {
	const clean = path.split(/[|#?]/)[0].trim();
	const dot = clean.lastIndexOf('.');
	return dot !== -1 && IMAGE_EXT.has(clean.slice(dot + 1).toLowerCase());
}

/** Same rule as core: replace a trailing dimension segment, else append one. */
function withSize(label: string, width: number): string {
	if (!label || DIM.test(label)) return String(width);
	const i = label.lastIndexOf('|');
	if (i !== -1 && DIM.test(label.slice(i + 1))) return label.slice(0, i) + '|' + width;
	return label + '|' + width;
}

function resizeEmbedText(text: string, width: number): string {
	const wiki = text.match(/^!\[\[(.*?)(\|(.*))?\]\]$/);
	if (wiki) return '![[' + wiki[1] + '|' + withSize(wiki[3] ?? '', width) + ']]';
	const md = text.match(/^!\[(.*?)\](\(.*\))$/);
	return md ? '![' + withSize(md[1], width) + ']' + md[2] : text;
}

/** Image embeds in callout source, in document order, matching what renders as `.internal-embed`. */
function sourceImageEmbeds(text: string): { from: number; text: string }[] {
	const out: { from: number; text: string }[] = [];
	for (const m of text.matchAll(EMBED)) {
		const dest = m[3]?.trim();
		const target = m[1] ?? (dest!.startsWith('<') ? dest!.slice(1, dest!.indexOf('>')) : dest!.split(/\s/)[0]);
		if (m[3] && target.includes('://')) continue; // external URLs render as plain <img>
		if (isImagePath(target)) out.push({ from: m.index!, text: m[0] });
	}
	return out;
}

function domImageEmbeds(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>('.internal-embed')).filter(
		(e) => isImagePath(e.getAttribute('src') ?? '') && !e.parentElement?.closest('.markdown-embed'),
	);
}

/** Line range of the callout whose widget DOM starts at `pos`. */
function calloutRange(view: EditorView, pos: number): { from: number; to: number } {
	const doc = view.state.doc;
	const first = doc.lineAt(pos);
	let last = first;
	while (last.number < doc.lines && /^\s*>/.test(doc.line(last.number + 1).text)) last = doc.line(last.number + 1);
	return { from: first.from, to: last.to };
}

function commitWidth(callout: HTMLElement, root: HTMLElement, embed: HTMLElement, width: number) {
	const editorEl = callout.closest<HTMLElement>('.cm-editor'); // null if the widget re-rendered mid-drag
	const view = editorEl && EditorView.findFromDOM(editorEl);
	if (!view) return;
	const range = calloutRange(view, view.posAtDOM(callout));
	const src = sourceImageEmbeds(view.state.doc.sliceString(range.from, range.to));
	const dom = domImageEmbeds(root);
	const i = dom.indexOf(embed);
	// ponytail: matched by order; bail if source and DOM disagree rather than rewrite the wrong link.
	if (i < 0 || src.length !== dom.length) return console.warn('Enhanced Canvas: callout image not matched to source');
	const target = src[i];
	const insert = resizeEmbedText(target.text, width);
	if (insert === target.text) return;
	const from = range.from + target.from;
	view.dispatch({ changes: { from, to: from + target.text.length, insert }, scrollIntoView: false });
}

function startResize(evt: PointerEvent, corner: HTMLElement, callout: HTMLElement, root: HTMLElement, embed: HTMLElement) {
	const img = embed.querySelector('img');
	if (!img || !evt.isPrimary || evt.button !== 0) return;
	evt.preventDefault();
	evt.stopPropagation();

	const rect = img.getBoundingClientRect();
	const ratio = img.offsetWidth / img.offsetHeight || 1;
	const max = (embed.closest<HTMLElement>('.callout-content') ?? root).clientWidth;
	const scale = rect.width / img.offsetWidth || 1; // canvas zoom: client px → layout px
	const origWidth = img.getAttribute('width');
	let moved = false;
	try { corner.setPointerCapture(evt.pointerId); } catch { /* same as core: capture is best-effort */ }
	embed.addClass('is-resizing');

	// ponytail: LTR only; mirror `rect.left` → `rect.right` if RTL notes need it.
	const onMove = (e: PointerEvent) => {
		moved = true;
		const w = Math.max(Math.abs(e.clientX - rect.left), Math.abs(e.clientY - rect.top) * ratio) / scale;
		img.width = Math.round(Math.min(Math.max(w, 20), max));
	};
	const onUp = (e: PointerEvent) => {
		corner.removeEventListener('pointermove', onMove);
		corner.removeEventListener('pointerup', onUp);
		corner.removeEventListener('pointercancel', onUp);
		embed.removeClass('is-resizing');
		if (!moved) return;
		if (e.type === 'pointerup') commitWidth(callout, root, embed, Math.round(img.clientWidth));
		else if (origWidth === null) img.removeAttribute('width');
		else img.setAttribute('width', origWidth);
	};
	corner.addEventListener('pointermove', onMove);
	corner.addEventListener('pointerup', onUp);
	corner.addEventListener('pointercancel', onUp);
}

export function registerCalloutImageResize(plugin: Plugin) {
	if (Platform.isMobile) return; // core has no resize corner on mobile either

	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const callout = (ctx as unknown as { containerEl?: HTMLElement }).containerEl;
		if (!callout?.classList.contains('cm-callout')) return; // Live Preview callout widget only

		// Runs before core loads the embeds, so tag by `src` and add the corner on hover.
		for (const embed of domImageEmbeds(el)) embed.addClass('interactive-child', 'enhanced-canvas-callout-image');

		el.addEventListener('pointerover', (evt) => {
			const embed = (evt.target as HTMLElement).closest?.<HTMLElement>('.enhanced-canvas-callout-image');
			if (!embed || embed.querySelector(':scope > .image-resize-corner')) return;
			const corner = embed.createDiv('image-resize-corner');
			corner.addEventListener('pointerdown', (e) => startResize(e, corner, callout, el, embed));
		});
	});
}
