import {
    Menu,
    ItemView,
    Notice
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
                                .onClick(() => {
                                    void this.explodeFileNode(canvas, node);
                                });
                        });
                    }
                    // Text Node (for editor-menu when editing)
                    else if (node && node.text !== undefined) {
                        menu.addItem((item) => {
                            item
                                .setTitle(title)
                                .onClick(() => {
                                    void this.explodeTextNode(canvas, node);
                                });
                        });
                    }
                }
            }
        }
    }

    /**
     * Adds the "Split Card by Headings" menu item for text nodes.
     * Called from main.ts when a text node context menu is shown.
     */
    addTextNodeMenu(menu: Menu, node: CanvasNode) {
        const activeView = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        if (!activeView || activeView.getViewType() !== "canvas") return;

        const canvas = (activeView as CanvasView).canvas;
        if (!canvas) return;

        menu.addItem((item) => {
            item
                .setTitle("Split by headings")
                .onClick(() => {
                    void this.explodeTextNode(canvas, node);
                });
        });
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
    parseMarkdownHeadings(rawText: string): { level: number, content: string }[] {
        // Split by newlines to process line by line
        const lines = rawText.split(/\r?\n/);
        const sections: { level: number, content: string }[] = [];
        const preamble: string[] = [];

        let currentSection: { level: number, lines: string[] } | null = null;

        // Regex to detect headings (e.g., "## My Title")
        const headingRegex = /^(#{1,6})\s+(.*)/;

        for (const line of lines) {
            const match = line.match(headingRegex);

            if (match) {
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
	explodeFileNode(canvas: Canvas, originalNode: CanvasNode) {
		const targetFile = originalNode.file;
		if (!targetFile) return;

		const cache = this.plugin.app.metadataCache.getFileCache(targetFile);
		if (!cache || !cache.headings || cache.headings.length === 0) {
			new Notice(`File "${targetFile.basename}" does not contain any headings to explode.`);
			return;
		}

		const sections: { level: number, heading?: string }[] =
			cache.headings.map((h) => ({ level: h.level, heading: h.heading }));

		// Content before the first heading (frontmatter excluded) gets its own node,
		// mirroring parseMarkdownHeadings.
		const firstHeadingLine = cache.headings[0].position.start.line;
		if (cache.sections?.some((s) => s.type !== 'yaml' && s.position.start.line < firstHeadingLine)) {
			sections.unshift({ level: sections[0].level });
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
			void this.realignTreeAfterAutoResize(canvas, originalNode.y, createdNodeMeta, newNodesData);
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
	 * based on each node's resulting height (clamped by maxAutoResizeHeight).
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

		// 4. Ensure autoHeightEnabled persists on live leaf nodes after setData
		for (const meta of createdNodes) {
			if (!meta.isParent) {
				const liveNode = canvas.nodes.get(meta.id);
				if (liveNode) {
					liveNode.autoHeightEnabled = true;
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
	explodeTextNode(canvas: Canvas, originalNode: CanvasNode) {
		const sections = this.parseMarkdownHeadings(originalNode.text ?? '');

		if (sections.length === 0) {
			new Notice("No headings found to split.");
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
