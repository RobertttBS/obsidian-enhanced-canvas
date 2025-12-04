import {
    Plugin,
    Menu,
    ItemView,
    FileView,
    TFile,
    TAbstractFile,
    Editor,
    MarkdownView,
    Notice
} from 'obsidian';

import EnhancedCanvas from '../main'; 

declare module "obsidian" {
    interface Workspace {
        on(name: "canvas-menu", callback: (menu: Menu, canvas: any) => any, ctx?: any): EventRef;
    }
}

export class CanvasExploder {
    private plugin: EnhancedCanvas;

    constructor(plugin: EnhancedCanvas) {
        this.plugin = plugin;
    }

    checkAndAddMenu(menu: Menu, title: string) {
        const activeView = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        if (activeView && activeView.getViewType() === "canvas") {
            // @ts-ignore
            const canvas = (activeView as any).canvas;
            
            if (canvas) {
                const selection = canvas.selection;
                if (selection.size === 1) {
                    const node = selection.values().next().value;
                    // 確保選中的是 File Node 且有檔案
                    if (node && node.file) { 
                        menu.addItem((item) => {
                            item
                                .setTitle(title)
                                .setIcon("expand")
                                .onClick(() => {
                                    this.explodeFileNode(canvas, node);
                                });
                        });
                    }
                }
            }
        }
    }

	randomId(length: number = 16): string {
		const byteLength = Math.ceil(length / 2);
		const array = new Uint8Array(byteLength);
		
		window.crypto.getRandomValues(array);
		
		return Array.from(array, (byte) => 
			byte.toString(16).padStart(2, '0')
		).join('').substring(0, length);
	}

    sanitizeHeading(rawHeading: string): string {
        let text = rawHeading.replace(/\[\[|\]\]/g, "");

        text = text.replace(/[|#:]/g, " ");
        text = text.replace(/\s+/g, " ");
        return text.trim();
    }

    async explodeFileNode(canvas: any, originalNode: any) {
		const targetFile: TFile = originalNode.file;

		const cache = this.plugin.app.metadataCache.getFileCache(targetFile);
		if (!cache || !cache.headings || cache.headings.length === 0) {
			new Notice(`File "${targetFile.basename}" does not contain any headings to explode.`);
			return;
		}

		const headings = cache.headings;

		const GAP_Y = 20;
		const GAP_X = 20;
		
		const baseX = originalNode.x; 
		let currentY = originalNode.y;
		const width = originalNode.width || 400;
		const defaultHeight = (typeof originalNode.height === 'number' && originalNode.height > 50) ? originalNode.height : 400;

		const minLevel = Math.min(...headings.map((h: any) => h.level));

		const nodeStack: { level: number, nodeId: string }[] = [];
		const edgesToAdd: any[] = []; 
		const newNodesSet = new Set<any>(); 

		let createdCount = 0;

		for (const heading of headings) {
			const levelOffset = heading.level - minLevel;
			
			const currentX = baseX + (levelOffset * (width + GAP_X));
			
            const cleanText = this.sanitizeHeading(heading.heading);
			const subpath = `#${cleanText}`;
			
			let newNode;
			try {
				newNode = canvas.createFileNode({
					file: targetFile,
					subpath: subpath,
					pos: { x: currentX, y: currentY }, // 使用新的 currentX
					size: { width: width, height: defaultHeight },
					save: false, 
					focus: false 
				});
			} catch (e) {
				console.error(`Failed to create node for heading: ${subpath}`, e);
				continue;
			}

			if (!newNode) continue;
			createdCount++;
			
			newNodesSet.add(newNode);

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
				edgesToAdd.push({
					id: this.randomId(),
					fromNode: parentEntry.nodeId,
					fromSide: 'bottom',
					toNode: newNode.id,
					toSide: 'left'
				});
			}

			nodeStack.push({
				level: heading.level,
				nodeId: newNode.id
			});

			currentY += defaultHeight + GAP_Y;
		}

		if (edgesToAdd.length > 0) {
			const currentData = canvas.getData();
			currentData.edges.push(...edgesToAdd);
			canvas.setData(currentData);
		}

		if (createdCount > 0) {
			canvas.removeNode(originalNode);
		}

		if (newNodesSet.size > 0) {
			canvas.deselectAll();
			for (const node of newNodesSet) {
				canvas.select(node);
			}
			canvas.zoomToSelection();
		}

		canvas.requestSave();
		new Notice(`Explosion complete, created ${createdCount} nodes.`);
	}
}