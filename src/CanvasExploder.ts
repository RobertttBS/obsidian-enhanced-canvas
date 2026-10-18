import {
    App,
    CachedMetadata,
    Menu,
    ItemView,
    Notice,
    SuggestModal
} from 'obsidian';
import { AllCanvasNodeData, CanvasEdgeData, CanvasNodeData } from "obsidian/canvas";

import EnhancedCanvas from '../main';
import { Canvas, CanvasNode, CanvasView } from '../Canvas';
import { randomId } from './utils';

const HEADING_LIMIT = 10;
const COMPACT_HEIGHT = 50;
const LEAF_HEIGHT = 170;
const DEFAULT_WIDTH = 400;
const MAX_HEIGHT = 600;
const GAP_Y = 20;
const GAP_X = 20;

/** Picks the deepest heading level to split down to (Infinity = all levels). */
class HeadingLevelModal extends SuggestModal<number> {
    constructor(app: App, private levels: number[], private onPick: (maxLevel: number) => void) {
        super(app);
        this.setPlaceholder("Split down to heading level…");
    }

    getSuggestions(query: string): number[] {
        // The deepest level present equals "all levels", so it's offered only as that.
        const options = [Infinity, ...this.levels.slice(0, -1)];
        return options.filter((l) => this.label(l).toLowerCase().includes(query.toLowerCase()));
    }

    label(level: number): string {
        return level === Infinity ? `All levels (H${this.levels[this.levels.length - 1]})` : `H${level}`;
    }

    renderSuggestion(level: number, el: HTMLElement) {
        el.setText(this.label(level));
    }

    onChooseSuggestion(level: number) {
        this.onPick(level);
    }
}

/**
 * Manages the interactive decomposition of file nodes, enabling the visualization of 
 * a document's internal outline as a connected, hierarchical tree structure directly
 * on the canvas.
 */
export class CanvasExploder {
    private plugin: EnhancedCanvas;

    constructor(plugin: EnhancedCanvas) {
        this.plugin = plugin;
    }

    checkAndAddMenu(menu: Menu, title: string) {
        const activeView = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        if (activeView && activeView.getViewType() === "canvas") {
            const canvas = (activeView as CanvasView).canvas;

            if (canvas) {
                const selection = canvas.selection;

                if (selection.size === 1) {
                    const node = selection.values().next().value as CanvasNode | undefined;

                    // File Node
                    if (node && node.file) {
                        menu.addItem((item) => {
                            item
                                .setTitle(title)
                                .onClick(() => this.split(canvas, node));
                        });
                    }
                    // Text Node (for editor-menu when editing)
                    else if (node && node.text !== undefined) {
                        menu.addItem((item) => {
                            item
                                .setTitle(title)
                                .onClick(() => this.split(canvas, node));
                        });
                    }
                }
            }
        }
    }

    /**
     * Adds "Split by headings" to a node's context menu (canvas:node-menu).
     * File nodes that already target a subpath are skipped, as before (Obsidian's
     * own file-menu only fires for whole-file nodes).
     */
    addNodeMenu(menu: Menu, node: CanvasNode) {
        const canvas = node.canvas;
        if (!canvas || canvas.readonly) return;

        // Only markdown files have headings; images/PDFs are file nodes too.
        if (node.file ? node.file.extension !== 'md' || node.subpath : node.text === undefined) return;

        menu.addItem((item) => {
            item
                .setTitle("Split by headings")
                .onClick(() => this.split(canvas, node));
        });
    }

    /** Splits a file/text node, first asking for the heading level when the setting is on. */
    split(canvas: Canvas, node: CanvasNode) {
        const explode = (max: number) => node.file
            ? this.explodeFileNode(canvas, node, max)
            : this.explodeTextNode(canvas, node, max);
        if (!this.plugin.settings.chooseHeadingLevelOnSplit) return explode(Infinity);

        const cache = node.file ? this.plugin.app.metadataCache.getFileCache(node.file) : null;
        const sectionsAt = (max: number) => cache
            ? this.fileSections(cache, max)
            : this.parseMarkdownHeadings(node.text ?? '', max);
        const distinct = [...new Set(sectionsAt(Infinity).map((s) => s.level))].sort((a, b) => a - b);
        // Only offer levels that yield 2+ cards; with <2 such levels there's nothing
        // to choose, and explode handles the no-headings notice.
        const levels = distinct.filter((l) => sectionsAt(l).length >= 2);
        if (levels.length < 2) return explode(Infinity);
        new HeadingLevelModal(this.plugin.app, levels, explode).open();
    }

    sanitizeHeading(rawHeading: string): string {
        let text = rawHeading.replace(/\[\[|\]\]/g, "");

        text = text.replace(/[[\](){}<>|#:]/g, " ");
        text = text.replace(/\s+/g, " ");
        return text.trim();
    }

    /**
     * Parses raw markdown text into structured sections based on headings.
     */
    parseMarkdownHeadings(rawText: string, maxLevel = Infinity): { level: number, content: string }[] {
        // Split by newlines to process line by line
        const lines = rawText.split(/\r?\n/);
        const sections: { level: number, content: string }[] = [];
        const preamble: string[] = [];

        let currentSection: { level: number, lines: string[] } | null = null;

        // Regex to detect headings (e.g., "## My Title")
        const headingRegex = /^(#{1,6})\s+(.*)/;

        for (const line of lines) {
            const match = line.match(headingRegex);

            // Headings deeper than maxLevel stay as content of the current section.
            if (match && match[1].length <= maxLevel) {
                // If we have an existing section, push it to results
                if (currentSection) {
                    sections.push({
                        level: currentSection.level,
                        content: currentSection.lines.join('\n')
                    });
                }

                // Start a new section
                currentSection = {
                    level: match[1].length, // Number of hashes
                    lines: [line] // Keep the heading in the content
                };
            } else if (currentSection) {
                currentSection.lines.push(line);
            } else {
                preamble.push(line);
            }
        }

        // Push the final section
        if (currentSection) {
            sections.push({
                level: currentSection.level,
                content: currentSection.lines.join('\n')
            });
        }

        // Text before the first heading becomes its own card, a sibling of the
        // first heading placed above it (so it is always a leaf, never compacted).
        const preambleText = preamble.join('\n').trim();
        if (preambleText && sections.length > 0) {
            sections.unshift({ level: sections[0].level, content: preambleText });
        }

        return sections;
    }

	/**
	 * Deconstructs a single file node into a hierarchical tree of connected nodes representing its internal headings,
	 * replacing the original node to visualize the document's structure directly on the canvas.
	 */
	explodeFileNode(canvas: Canvas, originalNode: CanvasNode, maxLevel = Infinity) {
		const targetFile = originalNode.file;
		if (!targetFile) return;

		const cache = this.plugin.app.metadataCache.getFileCache(targetFile);
		if (!cache || !cache.headings || cache.headings.length === 0) {
			new Notice(`File "${targetFile.basename}" does not contain any headings to explode.`);
			return;
		}

		const sections = this.fileSections(cache, maxLevel);
		if (sections.length < 2 && maxLevel !== Infinity) {
			new Notice("Only one card at this heading level, nothing to split.");
			return;
		}

		const createdCount = this.buildSectionTree(
			canvas,
			originalNode,
			sections,
			(section) => ({
				type: 'file',
				file: targetFile.path,
				// ponytail: no subpath can target "before the first heading", so the
				// preamble node embeds the whole note (preamble renders at the top).
				// Explicit undefined overrides any subpath inherited from originalData.
				subpath: section.heading === undefined ? undefined : `#${this.sanitizeHeading(section.heading)}`,
			}),
			COMPACT_HEIGHT,
		);

		new Notice(`Explosion complete, created ${createdCount} nodes.`);
	}

	/** File-node sections: headings <= maxLevel, plus a preamble entry (no heading) if content precedes them. */
	private fileSections(cache: CachedMetadata, maxLevel: number): { level: number, heading?: string }[] {
		// A heading subpath embeds its deeper subheadings too, so dropping them loses nothing.
		const sections: { level: number, heading?: string }[] = (cache.headings ?? [])
			.filter((h) => h.level <= maxLevel)
			.map((h) => ({ level: h.level, heading: h.heading }));
		if (sections.length === 0) return sections;

		// Content (or deeper headings) before the first kept heading, frontmatter
		// excluded, gets its own node, mirroring parseMarkdownHeadings.
		const firstHeadingLine = cache.headings!.find((h) => h.level <= maxLevel)!.position.start.line;
		if (cache.sections?.some((s) => s.type !== 'yaml' && s.position.start.line < firstHeadingLine)) {
			sections.unshift({ level: sections[0].level });
		}
		return sections;
	}

	/**
	 * Shared explode core: lays out one node per section (indented by heading
	 * level), connects each section to its nearest shallower parent, then swaps
	 * the original node for the new tree and selects it.
	 *
	 * @param nodePayload - Per-section node fields (e.g. file+subpath, or text).
	 * @param fallbackLeafHeight - Leaf height when the original node has no usable height.
	 * @returns The number of nodes created.
	 */
	private buildSectionTree<S extends { level: number }>(
		canvas: Canvas,
		originalNode: CanvasNode,
		sections: S[],
		nodePayload: (section: S) => Partial<AllCanvasNodeData>,
		fallbackLeafHeight: number,
	): number {
		const isCompactMode = sections.length > HEADING_LIMIT;

		const baseX = originalNode.x;
		let currentY = originalNode.y;
		const originalHeight = originalNode.height;

		const width = Math.max(originalNode.width ?? 0, DEFAULT_WIDTH);
		const minLevel = Math.min(...sections.map((s) => s.level));

		const currentData = canvas.getData();
		const originalData = currentData.nodes.find((n: CanvasNodeData) => n.id === originalNode.id) ?? ({} as Partial<CanvasNodeData>);

		const nodeStack: { level: number, nodeId: string }[] = [];
		const newNodesData: AllCanvasNodeData[] = [];
		const newEdgesData: CanvasEdgeData[] = [];
		const createdNodeMeta: { id: string; isParent: boolean }[] = [];

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];

			const nextSection = sections[i + 1];
			const isParent = Boolean(nextSection && nextSection.level > section.level);

			let nodeHeight: number;
			if (isParent) {
				nodeHeight = COMPACT_HEIGHT;
			} else if (isCompactMode) {
				nodeHeight = LEAF_HEIGHT;
			} else {
				nodeHeight = (typeof originalHeight === 'number' && originalHeight > COMPACT_HEIGHT)
					? Math.min(MAX_HEIGHT, originalHeight)
					: fallbackLeafHeight;
			}

			const levelOffset = section.level - minLevel;
			const currentX = baseX + (levelOffset * (width + GAP_X));

			const newNodeId = randomId();
			createdNodeMeta.push({ id: newNodeId, isParent });
			newNodesData.push({
				...originalData,
				...nodePayload(section),
				id: newNodeId,
				x: currentX,
				y: currentY,
				width: width,
				height: nodeHeight
			} as AllCanvasNodeData);

			while (nodeStack.length > 0) {
				const lastEntry = nodeStack[nodeStack.length - 1];
				if (lastEntry.level >= section.level) {
					nodeStack.pop();
				} else {
					break;
				}
			}

			if (nodeStack.length > 0) {
				const parentEntry = nodeStack[nodeStack.length - 1];
				newEdgesData.push({
					id: randomId(),
					fromNode: parentEntry.nodeId,
					fromSide: 'bottom',
					toNode: newNodeId,
					toSide: 'left'
				});
			}

			nodeStack.push({
				level: section.level,
				nodeId: newNodeId
			});

			currentY += nodeHeight + GAP_Y;
		}

		currentData.nodes = currentData.nodes.filter((n: CanvasNodeData) => n.id !== originalNode.id);
		currentData.edges = currentData.edges.filter((e: CanvasEdgeData) =>
			e.fromNode !== originalNode.id && e.toNode !== originalNode.id
		);

		currentData.nodes.push(...newNodesData);
		currentData.edges.push(...newEdgesData);

		canvas.setData(currentData);
		canvas.requestSave(false);

		const newNodeIds = new Set(newNodesData.map(n => n.id));
		canvas.deselectAll();
		for (const [id, node] of canvas.nodes) {
			if (newNodeIds.has(id)) {
				canvas.select(node);
			}
		}
		canvas.zoomToSelection();

		if (this.plugin.settings.autoResizeOnSplit) {
			this.realignTreeAfterAutoResize(canvas, originalNode.y, createdNodeMeta, newNodesData).catch(console.error);
		}

		return newNodesData.length;
	}

	/**
	 * Mounts a node's content regardless of viewport/zoom and resolves once it has rendered.
	 * Sets alwaysKeepLoaded so the canvas doesn't cull it before we measure; caller resets it.
	 */
	private async mountAndWaitForRender(node: CanvasNode): Promise<void> {
		node.alwaysKeepLoaded = true;
		node.attach?.();
		node.render?.();
		node.mountContent?.();

		const child = node.child;
		// File nodes: render() kicked off an async loadFile(); the preview is shown but empty
		// until it lands. Re-awaiting it is a cached read and no-ops if contents already loaded.
		if (node.file) await child?.loadFile?.();
		const renderer = child?.previewMode?.renderer;
		if (!renderer) return;
		// Content was just set, which queued a render, so onRendered waits for it.
		// Timeout guards against a render that never completes (e.g. element not laid out).
		await new Promise<void>((resolve) => {
			const timer = window.setTimeout(resolve, 2000);
			renderer.onRendered(() => {
				window.clearTimeout(timer);
				resolve();
			});
		});
	}

	/**
	 * Fits leaf nodes to their content via auto-resize and restacks the tree vertically
	 * based on each node's resulting height (clamped by maxAutoResizeHeight; capped leaves get no auto-fit).
	 */
	private async realignTreeAfterAutoResize(
		canvas: Canvas,
		baseY: number,
		createdNodes: { id: string; isParent: boolean }[],
		createdData: AllCanvasNodeData[],
	): Promise<void> {
		if (!canvas || !canvas.nodes) return;
		const view = canvas.view;
		const file = view?.file;

		const mockEvent = {
			preventDefault: () => {},
			stopPropagation: () => {},
		};

		const leaves = createdNodes
			.filter((meta) => !meta.isParent)
			.map((meta) => canvas.nodes.get(meta.id))
			.filter((node): node is CanvasNode => !!node);

		// 1. Force-mount every leaf (even off-screen / below the zoom breakpoint) and wait
		// until its markdown has rendered, so the native auto-resize has something to measure.
		try {
			await Promise.all(leaves.map((node) => this.mountAndWaitForRender(node)));

			// Bail if the view closed/switched file, or the user touched any new node meanwhile.
			if (canvas.view !== view || view?.file !== file || !view?.containerEl.isConnected) return;
			const untouched = createdData.every((d) => {
				const live = canvas.nodes.get(d.id);
				return live && live.x === d.x && live.y === d.y && live.width === d.width && live.height === d.height;
			});
			if (!untouched) return;

			for (const node of leaves) {
				if (node.isContentMounted && typeof node.onResizeDblclick === 'function') {
					node.onResizeDblclick(mockEvent, "bottom");
				}
				node.autoHeightEnabled = true;
			}
		} finally {
			// Hand culling back to the canvas.
			for (const node of leaves) node.alwaysKeepLoaded = false;
		}

		// 2. Measure heights and recalculate stacked Y positions
		const maxHeight = this.plugin.settings.maxAutoResizeHeight || 1000;
		let currentY = baseY;
		const nodeYMap = new Map<string, number>();
		const nodeHeightMap = new Map<string, number>();
		// Leaves capped at maxHeight: no auto-fit afterwards, or the next blur would grow them past the cap.
		const clampedIds = new Set<string>();

		for (const meta of createdNodes) {
			const liveNode = canvas.nodes.get(meta.id);
			let nodeHeight: number;
			if (meta.isParent) {
				nodeHeight = COMPACT_HEIGHT;
			} else {
				const rawHeight = (liveNode && liveNode.height > 0)
					? liveNode.height
					: (liveNode?.nodeEl?.offsetHeight || LEAF_HEIGHT);
				nodeHeight = Math.min(rawHeight, maxHeight);
				if (rawHeight > maxHeight) clampedIds.add(meta.id);
			}

			nodeHeightMap.set(meta.id, nodeHeight);
			nodeYMap.set(meta.id, currentY);
			currentY += nodeHeight + GAP_Y;
		}

		// 3. Apply new coordinates and heights to canvas data
		const currentData = canvas.getData();
		let modified = false;
		for (const nodeData of currentData.nodes) {
			const newY = nodeYMap.get(nodeData.id);
			const newHeight = nodeHeightMap.get(nodeData.id);
			if (newY !== undefined && newHeight !== undefined) {
				nodeData.y = newY;
				nodeData.height = newHeight;
				modified = true;
			}
		}

		if (modified) {
			// The native fits above queued a debounced history push of the pre-restack layout;
			// drop it so it can't land on top of the snapshot setData pushes.
			canvas.requestPushHistory?.cancel();
			canvas.setData(currentData);
			canvas.requestSave(false);
		}

		// 4. Set autoHeightEnabled on live leaf nodes after setData (off for capped ones)
		for (const meta of createdNodes) {
			if (!meta.isParent) {
				const liveNode = canvas.nodes.get(meta.id);
				if (liveNode) {
					liveNode.autoHeightEnabled = !clampedIds.has(meta.id);
				}
			}
		}

		// 5. Re-select and zoom to the updated selection bounds
		const newNodeIds = new Set(createdNodes.map(n => n.id));
		canvas.deselectAll();
		for (const [id, node] of canvas.nodes) {
			if (newNodeIds.has(id)) {
				canvas.select(node);
			}
		}
		canvas.zoomToSelection();
	}

	/**
	 * Deconstructs a single text node into a hierarchical tree of connected nodes representing its internal headings,
	 * replacing the original node to visualize the card's structure directly on the canvas.
	 */
	explodeTextNode(canvas: Canvas, originalNode: CanvasNode, maxLevel = Infinity) {
		const sections = this.parseMarkdownHeadings(originalNode.text ?? '', maxLevel);

		if (sections.length === 0) {
			new Notice("No headings found to split.");
			return;
		}
		if (sections.length < 2 && maxLevel !== Infinity) {
			new Notice("Only one card at this heading level, nothing to split.");
			return;
		}

		const createdCount = this.buildSectionTree(
			canvas,
			originalNode,
			sections,
			(section) => ({
				type: 'text',
				text: section.content,
			}),
			LEAF_HEIGHT,
		);

		new Notice(`Split complete, created ${createdCount} cards.`);
	}
}
