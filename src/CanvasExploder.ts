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
            } else {
                // Append line to current section (or handle preamble text if needed)
                if (currentSection) {
                    currentSection.lines.push(line);
                }
            }
        }

        // Push the final section
        if (currentSection) {
            sections.push({
                level: currentSection.level,
                content: currentSection.lines.join('\n')
            });
        }

        return sections;
    }

	/**
	 * Deconstructs a single file node into a hierarchical tree of connected nodes representing its internal headings,
	 * replacing the original node to visualize the document's structure directly on the canvas.
	 */
	async explodeFileNode(canvas: Canvas, originalNode: CanvasNode) {
		const targetFile = originalNode.file;
		if (!targetFile) return;

		const cache = this.plugin.app.metadataCache.getFileCache(targetFile);
		if (!cache || !cache.headings || cache.headings.length === 0) {
			new Notice(`File "${targetFile.basename}" does not contain any headings to explode.`);
			return;
		}

		const headings = cache.headings;
		const isCompactMode = headings.length > HEADING_LIMIT;

		const baseX = originalNode.x;
		let currentY = originalNode.y;

		const width = Math.max(originalNode.width ?? 0, DEFAULT_WIDTH);

		const minLevel = Math.min(...headings.map((h) => h.level));

		const nodeStack: { level: number, nodeId: string }[] = [];
		const newNodesData: AllCanvasNodeData[] = [];
		const newEdgesData: CanvasEdgeData[] = [];

		let createdCount = 0;
		const originalData = canvas.getData().nodes.find((n: CanvasNodeData) => n.id === originalNode.id) ?? ({} as Partial<CanvasNodeData>);

		for (let i = 0; i < headings.length; i++) {
			const heading = headings[i];
			
			const nextHeading = headings[i + 1];
			const isParent = nextHeading && nextHeading.level > heading.level;

			let nodeHeight: number;
			if (isParent) {
				nodeHeight = COMPACT_HEIGHT;
			}
			else if (isCompactMode) {
				nodeHeight = LEAF_HEIGHT;
			}
			else {
				nodeHeight = (typeof originalNode.height === 'number' && originalNode.height > COMPACT_HEIGHT)
					? Math.min(MAX_HEIGHT, originalNode.height)
					: COMPACT_HEIGHT;
			}

			const levelOffset = heading.level - minLevel;
			const currentX = baseX + (levelOffset * (width + GAP_X));

			const cleanText = this.sanitizeHeading(heading.heading);
			const subpath = `#${cleanText}`;

			const newNodeId = randomId();
			newNodesData.push({
				...originalData,
				id: newNodeId,
				type: 'file',
				file: targetFile.path,
				subpath: subpath,
				x: currentX,
				y: currentY,
				width: width,
				height: nodeHeight
			});

			createdCount++;

			while (nodeStack.length > 0) {
				const lastEntry = nodeStack[nodeStack.length - 1];
				if (lastEntry.level >= heading.level) {
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
				level: heading.level,
				nodeId: newNodeId
			});

			currentY += nodeHeight + GAP_Y;
		}

		if (createdCount > 0) {
			const currentData = canvas.getData();
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
		}

		new Notice(`Explosion complete, created ${createdCount} nodes.`);
	}

	/**
	 * Deconstructs a single text node into a hierarchical tree of connected nodes representing its internal headings,
	 * replacing the original node to visualize the card's structure directly on the canvas.
	 */
	async explodeTextNode(canvas: Canvas, originalNode: CanvasNode) {
		const rawText = originalNode.text ?? '';
		const sections = this.parseMarkdownHeadings(rawText);

		if (sections.length === 0) {
			new Notice("No headings found to split.");
			return;
		}

		// --- 1. Cache original node properties ---
		const baseX = originalNode.x;
		const baseY = originalNode.y;
		const originalWidth = originalNode.width ?? 0;
		const originalHeight = originalNode.height;
		const originalNodeId = originalNode.id;

		const width = Math.max(originalWidth, DEFAULT_WIDTH);
		const minLevel = Math.min(...sections.map(s => s.level));

		const originalData = canvas.getData().nodes.find((n: CanvasNodeData) => n.id === originalNodeId) ?? ({} as Partial<CanvasNodeData>);

		// --- 2. Build new nodes and edges data ---
		let currentY = baseY;
		const nodeStack: { level: number, nodeId: string }[] = [];
		const newNodesData: AllCanvasNodeData[] = [];
		const newEdgesData: CanvasEdgeData[] = [];

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			
			// Check if this is a parent node
			const nextSection = sections[i + 1];
			const isParent = nextSection && nextSection.level > section.level;
			
			// Determine if we're in compact mode (many sections)
			const isCompactMode = sections.length > HEADING_LIMIT;
			
			// Calculate height
			let nodeHeight: number;
			if (isParent) {
				nodeHeight = COMPACT_HEIGHT;
			} else if (isCompactMode) {
				nodeHeight = LEAF_HEIGHT;
			} else {
				nodeHeight = (typeof originalHeight === 'number' && originalHeight > COMPACT_HEIGHT)
					? Math.min(MAX_HEIGHT, originalHeight)
					: LEAF_HEIGHT;
			}
			
			// Calculate position
			const levelOffset = section.level - minLevel;
			const currentX = baseX + (levelOffset * (width + GAP_X));

			// Create node data (not the actual node yet)
			const newNodeId = randomId();
			newNodesData.push({
				...originalData,
				id: newNodeId,
				type: 'text',
				text: section.content,
				x: currentX,
				y: currentY,
				width: width,
				height: nodeHeight
			});

			// Manage Hierarchy
			while (nodeStack.length > 0) {
				const lastEntry = nodeStack[nodeStack.length - 1];
				if (lastEntry.level >= section.level) {
					nodeStack.pop();
				} else {
					break;
				}
			}

			// Add Edge if parent exists
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

			// Push current node to stack
			nodeStack.push({
				level: section.level,
				nodeId: newNodeId
			});

			// Update Y position
			currentY += nodeHeight + GAP_Y;
		}

		// --- 3. Apply all changes ---
		const currentData = canvas.getData();
		
		// Remove original node from data
		currentData.nodes = currentData.nodes.filter((n: CanvasNodeData) => n.id !== originalNodeId);

		// Remove any edges connected to original node
		currentData.edges = currentData.edges.filter((e: CanvasEdgeData) =>
			e.fromNode !== originalNodeId && e.toNode !== originalNodeId
		);
		
		// Add new nodes and edges
		currentData.nodes.push(...newNodesData);
		currentData.edges.push(...newEdgesData);
		
		canvas.setData(currentData);
		canvas.requestSave(false);

		// --- 4. Select new nodes ---
		const newNodeIds = new Set(newNodesData.map(n => n.id));
		canvas.deselectAll();
		for (const [id, node] of canvas.nodes) {
			if (newNodeIds.has(id)) {
				canvas.select(node);
			}
		}
		canvas.zoomToSelection();

		new Notice(`Split complete, created ${sections.length} cards.`);
	}
}
