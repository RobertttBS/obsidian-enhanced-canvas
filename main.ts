import {
	Menu,
	debounce,
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile
} from 'obsidian';
import { CanvasEdgeData, NodeSide, CanvasData } from "obsidian/canvas";
import { around } from "monkey-around";
import { CanvasNode } from 'Canvas';
import { CanvasExploder } from './src/CanvasExploder';
import { SendToCanvas } from './src/SendToCanvas';
import { EnhancedCanvasSettings, DEFAULT_SETTINGS } from "./src/settings";
import { isVersionNewer } from "./src/utils";
import { ReleaseNotesModal } from "./src/ReleaseNotesModal";

interface CanvasNodeWithFlag extends CanvasNode {
    _autoHeightTimer?: number | null;
    _delayedResizeTimer?: number | null;
    [key: string]: any; 
}

export default class EnhancedCanvas extends Plugin {
	public exploder: CanvasExploder;
	public sendToCanvas: SendToCanvas;
	public patchedEdge: boolean;
	private isMetadataClicked: boolean = false;
	settings: EnhancedCanvasSettings;

	private autoHeightCheckReference: (() => void) | null = null;
	private autoLinkCheckReference: (() => void) | null = null;

	/**
	 * Scans the selected nodes to identify underlying file references and automatically
	 * generates visual connections where valid links exist between files but edges are
	 * currently missing on the canvas.
	 */
	createMissingEdgesFromLinks(canvas: any) {
		const selectedNodes = Array.from(canvas.selection);
		const fileNodes = selectedNodes.filter(node => node?.filePath);
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const currentData = canvas.getData();

		const existingEdgesMap = new Map();
		currentData.edges.forEach(edge => {
			existingEdgesMap.set(`${edge.fromNode}->${edge.toNode}`, edge);
		});

		const filePathToNodeMap = new Map();
		fileNodes.forEach(node => {
			if (node.filePath) {
				filePathToNodeMap.set(node.filePath, node);
			}
		});

		const newEdges = [];

		fileNodes.forEach(sourceNode => {
			const links = resolvedLinks[sourceNode.filePath];
			if (!links) return;
	
			Object.keys(links).forEach(targetPath => {
				const targetNode = filePathToNodeMap.get(targetPath);
				if (targetNode && targetNode !== sourceNode) {
					const edgeKey = `${sourceNode.id}->${targetNode.id}`;
					if (!existingEdgesMap.has(edgeKey)) {
						const newEdge = this.createEdge(sourceNode, targetNode);
						newEdges.push(newEdge);
						existingEdgesMap.set(edgeKey, newEdge);
					}
				}
			});
		});
	
		if (newEdges.length > 0) {
			currentData.edges.push(...newEdges);
			canvas.setData(currentData);
			canvas.requestSave(false);
		}
	}
	
	/**
	 * Recomputes the connection anchor points for all edges contained within the
	 * current selection to ensure optimal visual alignment and routing.
	 */
	optimizeEdgesBetweenSelectedNodes(canvas: any) {
		const selectedNodes = Array.from(canvas.selection);
		if (selectedNodes.length < 2) return;

		const currentData = canvas.getData();

		const selectedNodeIds = new Set(selectedNodes.map(node => node.id));

		let didUpdateEdges = false;
		currentData.edges.forEach(edge => {
			if (selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode)) {
				const fromNode = currentData.nodes.find(node => node.id === edge.fromNode);
				const toNode = currentData.nodes.find(node => node.id === edge.toNode);
				if (fromNode && toNode) {
					const updatedEdge = this.createEdge(fromNode, toNode);
					if (edge.fromSide !== updatedEdge.fromSide || edge.toSide !== updatedEdge.toSide) {
						edge.fromSide = updatedEdge.fromSide;
						edge.toSide = updatedEdge.toSide;
						didUpdateEdges = true;
					}
				}
			}
		});

		if (didUpdateEdges) {
			canvas.setData(currentData);
			canvas.requestSave(false);
		}
	}

	deleteEdges(canvas: any) {
		const selectedNodes = Array.from(canvas.selection);
		const selectedNodeIds = new Set(selectedNodes.map(node => node.id));
		const currentData = canvas.getData();

		currentData.edges = currentData.edges.filter(edge => {
			return !(selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode));
		});
	
		canvas.setData(currentData);
		canvas.requestSave(false);
	}
	
	/**
	 * add 'canvas' and canvas basename properties to the node frontmatter.
	 */
	addProperty(node: any, propertyName: string, basename: string) {
		if (!this.settings.enableFrontmatter) return;
		const file = this.app.vault.getFileByPath(node.file); // node is JSON node, not canvas node
		if (!file) return;

		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;

			if (!frontmatter.canvas) {
				frontmatter.canvas = [];
			}
			const canvasLink = `[[${propertyName}]]`;
			if (!frontmatter.canvas.includes(canvasLink)) {
				frontmatter.canvas.push(canvasLink);
			}
	
			if (!frontmatter[basename]) {
				frontmatter[basename] = [];
			}
		});
	}

	/**
	 * For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	 */
	removeProperty(node: any, propertyName: string, basename: string) {
		if (!this.settings.enableFrontmatter) return;
		const file = this.app.vault.getFileByPath(node.file); // node is JSON node, not canvas node
		if (!file) return;

		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;
	
			// remove the property
			if (frontmatter[basename]) {
				delete frontmatter[basename];
			}
	
			// remove the link from the canvas property
			if (frontmatter.canvas) {
				const canvasLink = `[[${propertyName}]]`;
				frontmatter.canvas = frontmatter.canvas.filter((link: string) => link !== canvasLink);

				if (frontmatter.canvas.length === 0) {
					delete frontmatter.canvas;
				}
			}
		});
	}

	/**
	 * For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	 */
	renameProperty(node: any, oldName: string, newName: string) {
		if (!this.settings.enableFrontmatter) return;
		const file = this.app.vault.getFileByPath(node.file);
		if (!file) return;
	
		const getBaseName = (name: string) => name.substring(name.lastIndexOf('/') + 1);

		newName = getBaseName(newName);
		const oldBaseName = oldName.replace('.canvas', '');
		const newBaseName = newName.replace('.canvas', '');
	
		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;
	
			// rebuild the frontmatter with the new property name
			const newFrontmatter = Object.fromEntries(
				Object.entries(frontmatter).map(([key, value]) => [
					key === oldBaseName ? newBaseName : key,
					value
				])
			);
	
			// remove all properties and assign the new frontmatter
			Object.keys(frontmatter).forEach(key => {
				delete frontmatter[key];
			});
			Object.assign(frontmatter, newFrontmatter);
		});
	}

	removeAllProperty(canvas: any, canvasData: CanvasData) {
		const nodes = canvasData.nodes;
		nodes.forEach(node => {
			if (!node?.file) return;

			this.removeProperty(node, canvas.view.file.name,canvas.view.file.basename);
		});
		canvas.setData(canvasData);
		canvas.requestSave(false);
	}

	async processEdgeUpdate(e: any) {
		if (!this.settings.enableFrontmatter) return;
        const fromNode = e?.from?.node;
        const toNode = e?.to?.node;

        if (!fromNode || !toNode) return;
        if (!fromNode?.filePath && !fromNode?.file) return;

        const fromFilePath = fromNode.filePath || fromNode.file;
        const toFilePath = toNode.filePath || toNode.file;

        const fromFile = this.app.vault.getFileByPath(fromFilePath);
        const toFile = this.app.vault.getFileByPath(toFilePath);

		if (fromFilePath === toFilePath) return;
        if (!fromFile || !toFile) return;

        const canvasName = e.canvas.view.file.basename;

        let link = this.app.fileManager.generateMarkdownLink(toFile, fromFilePath).replace(/^!(\[\[.*\]\])$/, '$1');
        await this.updateFrontmatter(fromFile, link, 'add', canvasName);
    }

	/**
	 * Orchestrates a batch update for all connections within the provided canvas data
	 * to ensure every edge is validated and processed according to the plugin's
	 * current update logic.
	 */
	async processEdgesInCanvas(canvasData: CanvasData, canvasFile: TFile) {
		if (!canvasData) return;
	
		const tempCanvas = {
			view: {
				file: canvasFile
			},
			getData: () => canvasData,
		};
	
		const nodeIdToNodeMap = new Map<string, any>();

		if (canvasData.nodes && Array.isArray(canvasData.nodes)) {
			for (const node of canvasData.nodes) {
				nodeIdToNodeMap.set(node.id, node);
			}
		}
	
		if (canvasData.edges && Array.isArray(canvasData.edges)) {
			for (const edgeData of canvasData.edges) {
				const fromNode = nodeIdToNodeMap.get(edgeData.fromNode);
				const toNode = nodeIdToNodeMap.get(edgeData.toNode);
	
				if (!fromNode || !toNode) continue;
	
				const e = {
					from: { node: fromNode },
					to: { node: toNode },
					canvas: tempCanvas
				};
	
				await this.processEdgeUpdate(e);
			}
		}
	}

	/**
	 * Modifies a file's frontmatter property to ensure a specific value is either 
	 * included or excluded while maintaining list integrity.
	 */
    updateFrontmatter = async (file: TFile, link: string, action: 'add' | 'remove', propertyName: string) => {
		if (!this.settings.enableFrontmatter) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const existingValue = Reflect.get(fm, propertyName);
            let currentSet = new Set<string>();

            if (Array.isArray(existingValue)) {
                existingValue.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
                             .forEach(item => currentSet.add(item));
            } else if (typeof existingValue === 'string' && existingValue.trim() !== '') {
                currentSet.add(existingValue);
            }
            
            if (action === 'add') {
                currentSet.add(link);
            } else if (action === 'remove') {
                currentSet.delete(link);
            }

            const finalArray = Array.from(currentSet);

            if (finalArray.length > 0) {
                Reflect.set(fm, propertyName, finalArray);
            } else {
                Reflect.deleteProperty(fm, propertyName);
            }
        }); 
    };

	private ifActiveViewIsCanvas = (commandFn: (canvas: any, canvasData: CanvasData) => void) => (checking: boolean) => {
		const activeView = this.app.workspace.getActiveViewOfType(ItemView);
		if (activeView?.getViewType() !== 'canvas') {
			return checking ? false : undefined;
		}
		
		if (checking) return true;
		
		// @ts-ignore
		const canvas = activeView.canvas;
		const canvasData = canvas?.getData();
		
		if (!canvas || !canvasData) return;
		return commandFn(canvas, canvasData);
	}

	/** Applies or removes the body CSS class that gates the optional visual styles. */
	toggleCSSClass(enabled: boolean) {
		if (enabled) {
			document.body.classList.add('enhanced-canvas-enabled');
		} else {
			document.body.classList.remove('enhanced-canvas-enabled');
		}
	}

	/**
	 * Registers all core plugin features and performs an initial scan
	 * of the vault to process and initialize data from all
	 * existing canvas files upon loading.
	 */
	async onload() {
		await this.loadSettings();
		this.checkReleaseNotes();

		this.exploder = new CanvasExploder(this);
		this.sendToCanvas = new SendToCanvas(this);

		this.addSettingTab(new EnhancedCanvasSettingTab(this.app, this));
		this.toggleCSSClass(this.settings.enableCustomCSS);

		this.registerPluginCommands();
		this.registerCanvasAutoLink();
		this.registerFileManagerPatches();
		this.registerFocusCanvas();
		this.registerCanvasExploder();
		this.registerCanvasNodeAutoHeightPatcher();

		try {
			const canvasFiles = this.app.vault.getFiles().filter(file => file.extension === 'canvas');
			
			await Promise.all(canvasFiles.map(async (canvasFile) => {
				try {
					const content = await this.app.vault.read(canvasFile);
					if (!content || content.trim() === '') return;
					
					try {
						const canvasData = JSON.parse(content) as CanvasData;
						if (!canvasData) return;
						
						if (canvasData.nodes && Array.isArray(canvasData.nodes)) {
							for (const node of canvasData.nodes) {
								if (!node?.file) continue;
								
								this.addProperty(node, canvasFile.name, canvasFile.basename);
							}
						}
												
						await this.processEdgesInCanvas(canvasData, canvasFile);
					} catch (parseError) {
						return;
					}
				} catch (fileError) {
					return;
				}
			}));
		} catch (error) {
			return;
		}

		/**
		 * Configures a monitoring routine to force Canvas views to recalculate their layout
		 * during "Stacked Tabs" sliding transitions, ensuring proper rendering when
		 * standard resize triggers are insufficient.
		 */
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (this.canvasStackInterval) {
					clearInterval(this.canvasStackInterval);
					this.canvasStackInterval = null;
				}

				if (!leaf) return;

				const isStacked = !!document.querySelector('.workspace-tabs.mod-stacked');
				if (!isStacked) return;

				const view = leaf.view;
				if (view.getViewType() !== 'canvas') return;

				if (typeof view.onResize === 'function') {
					view.onResize();
				}
				
				setTimeout(() => {
					if (typeof view.onResize === 'function') view.onResize();
				}, 200);

				let lastLeft = view.containerEl.getBoundingClientRect().left;

				this.canvasStackInterval = setInterval(() => {
					if (!view || !view.containerEl) {
						clearInterval(this.canvasStackInterval);
						return;
					}

					const rect = view.containerEl.getBoundingClientRect();
					
					if (Math.abs(rect.left - lastLeft) > 2) {
						if (typeof view.onResize === 'function') {
							view.onResize();
						}

						lastLeft = rect.left;
					}
				}, 200);
			})
		);
	}

    checkReleaseNotes() {
        try {
            const currentVersion = this.manifest.version;
            const previousVersion = this.settings.previousRelease;

            const isNewInstall = previousVersion === "0.0.0" || !previousVersion;

            if (this.settings.showReleaseNotes) {
                if (isNewInstall || isVersionNewer(currentVersion, previousVersion)) {
                    new ReleaseNotesModal(
                        this.app,
                        this,
                        currentVersion,
                        isNewInstall
                    ).open();
                }
            }
        } catch (e) {
            console.error("Failed to show release notes:", e);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

	/**
	 * Registers patches for the application's FileManager to intercept file deletion
	 * and rename operations. This function ensures data integrity by automatically
	 * cleaning up references to the modified files throughout the vault before the
	 * original operation proceeds.
	 */
	registerFileManagerPatches() {
		const plugin = this;

		const deleteFile = async (file: any) => {
			if (file.deleted === true) return;
			
			const backLinks = plugin.app.metadataCache.getBacklinksForFile(file);
			if (!backLinks || !backLinks.data) return;
		
			const linkRegexBasename = new RegExp(`\\[\\[${file.basename}(\\|.*)?\\]\\]`);
			const linkRegexFullName = new RegExp(`\\[\\[${file.name}(\\|.*)?\\]\\]`);
			
			for (const [sourcePath, references] of backLinks.data.entries()) {
				const sourceFile = plugin.app.vault.getFileByPath(sourcePath);
				if (!sourceFile || sourceFile.extension !== 'md') continue;

				await plugin.app.fileManager.processFrontMatter(sourceFile, (frontmatter) => {
					if (!frontmatter) return;
					
					Object.keys(frontmatter).forEach(key => {
						if (Array.isArray(frontmatter[key])) {
							frontmatter[key] = frontmatter[key].filter(item => {
								if (typeof item !== 'string') return true;

								return !(linkRegexBasename.test(item) || linkRegexFullName.test(item));
							});
						}
					});
				});
			}
		}
		
		const deleteCanvasFile = async (file: any) => {
			if (file.extension !== 'canvas') return;
			if (file.deleted === true) return;
			
			const content = await plugin.app.vault.read(file);
			if (!content) return;
			const canvasData = JSON.parse(content);
			if (!canvasData) return;
			
			canvasData.nodes.forEach((node: any) => {
				if (node.type !== 'file') return;
				plugin.removeProperty(node, file.name, file.basename);
			});
		}
	
		const renameCanvasFile = async (file: any, newPath: string) => {
			if (file.extension !== 'canvas') return;
			if (file.deleted === true) return;
			
			const content = await plugin.app.vault.read(file);
			if (!content) return;
			const canvasData = JSON.parse(content);
			if (!canvasData) return;
			
			canvasData.nodes.forEach((node: any) => {
				if (node.type !== 'file') return;
				plugin.renameProperty(node, file.name, newPath);
			});
		}
	
		const uninstaller = around(this.app.fileManager.constructor.prototype, {
			trashFile(old: Function) {
				return function(file: any) {
					deleteCanvasFile(file);
					deleteFile(file);
					return old.call(this, file);
				};
			},
			renameFile(old: Function) {
				return function(file: any, newPath: string) {
					renameCanvasFile(file, newPath);
					return old.call(this, file, newPath);
				};
			}
		});

		this.register(uninstaller);
	}

	/**
	 * Registers all plugin commands, making them available in the
	 * Obsidian command palette.
	 *
	 * All commands registered here are context-aware and will only be enabled
	 * when the active view is a Canvas.
	 */
	registerPluginCommands() {
		this.addCommand({
			id: 'optimize-edges',
			name: 'Adjust edges with shortest path',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.optimizeEdgesBetweenSelectedNodes(canvas);
			})
		});

		this.addCommand({
			id: 'delete-edges',
			name: 'Delete edges between selected nodes',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.deleteEdges(canvas);
			})
		});

		this.addCommand({
			id: 'add-link-and-optimize-edge',
			name: 'Add edges according the links in notes',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.createMissingEdgesFromLinks(canvas);
				this.optimizeEdgesBetweenSelectedNodes(canvas);
			})
		});

		this.addCommand({
			id: 'remove-canvas-property',
			name: 'Remove the property of all nodes in current Canvas',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.removeAllProperty(canvas, canvasData);
			})
		});

        this.addCommand({
            id: "send-to-canvas",
            name: "Send to Canvas",
            callback: () => {
                this.sendToCanvas.handleSendToCanvas(); 
            },
        });

		this.addCommand({
			id: "send-to-selected-canvas",
            name: "Send to Selected Canvas",
            callback: () => {
                this.sendToCanvas.handleSendToSelectedCanvas();
            },
        });

        this.addCommand({
            id: "clear-selected-canvas-file",
            name: "Clear selected Canvas file",
            callback: () => {
                this.sendToCanvas.clearSelectedCanvas();
            },
        });
	}

	/**
	 * Registers event listeners to implement a "zoom to node" feature.
	 *
	 * This function's goal is to automatically focus the canvas on the relevant
	 * node when a user navigates to the canvas by clicking a link from another
	 * file's metadata/properties panel (e.g., a backlink).
	 */
	registerFocusCanvas() {
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target.closest('.metadata-container') || target.closest('.search-result-container')) {
				this.isMetadataClicked = true;
			
				setTimeout(() => {
					this.isMetadataClicked = false;
				}, 500);
			}
		}, true);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				Promise.resolve().then(async () => {
					if (this.isMetadataClicked == false) return;
					// get current active leaf
					const activeLeaf = this.app.workspace.getActiveViewOfType(ItemView) as any;
					if (!activeLeaf || activeLeaf.getViewType() !== 'canvas') return;
		
					const prevFile = this.app.workspace.getLastOpenFiles()[0];
					if (!prevFile) return;
					
					// @ts-ignore
					const canvas = await activeLeaf.canvas;
					if (!canvas) return;

					for (const [key, value] of canvas.nodes) {
						if (value?.filePath === prevFile) {
							canvas.select(value);
						}
					}
					setTimeout(() => {
						canvas.zoomToSelection();
					}, 100);
				});
			})
		);
	}

	/**
	 * Establishes real-time synchronization to manage frontmatter properties
	 * in source files based on their connections within a canvas.
	 * This ensures file metadata automatically reflects the
	 * visual graph structure as nodes and edges are added, removed, or updated.
	 */
	registerCanvasAutoLink() {
		const plugin = this;

		const processNodeUpdate = async (e: any) => {
			const fromNode = e?.from?.node;
			const toNode = e?.to?.node;

			if (!fromNode || !toNode) return;
			if (!fromNode?.filePath) return;
		
			const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
			if (!fromFile) return;

			const canvasName = await e.canvas.view.file.basename;
			const resolvedLinks = this.app.metadataCache.resolvedLinks[fromNode.filePath] || {};
			const fromNodeLinks = Object.keys(resolvedLinks);
		
			const { edges, nodes } = await e.canvas.getData();

			const sameFileNodes = nodes.filter(node => node.file === fromNode.filePath);
			const allRelevantEdges = edges.filter(edge => 
				sameFileNodes.some(node => edge.fromNode === node.id)
			);

			const edgeToNodesFilePathSet = new Set(
				allRelevantEdges
					.map(edge => nodes.find(node => node.id === edge.toNode))
					.filter(node => node && node.file)
					.map(node => node.file)
			);

			const updatePromises: Promise<void>[] = [];
			const getFilePath = (path: string) => this.app.vault.getFileByPath(path);
		
			fromNodeLinks.forEach(filePath => {
				if (!edgeToNodesFilePathSet.has(filePath)) {
					if (filePath === e.canvas.view.file.path) return;
					const targetFile = getFilePath(filePath);
					if (!targetFile) return;
		
					let link = this.app.fileManager.generateMarkdownLink(targetFile, filePath).replace(/^!(\[\[.*\]\])$/, '$1');
					updatePromises.push(this.updateFrontmatter(fromFile, link, 'remove', canvasName));
				}
			});
		
			if (toNode?.filePath) {
				if (fromNode.filePath !== toNode.filePath) {
					const targetFile = getFilePath(toNode.filePath);
					
					if (targetFile) {
						let link = this.app.fileManager.generateMarkdownLink(targetFile, toNode.filePath).replace(/^!(\[\[.*\]\])$/, '$1');
						// 將此操作加入 Promise 佇列
						updatePromises.push(this.updateFrontmatter(fromFile, link, 'add', canvasName));
					}
				}
			}

			await Promise.all(updatePromises);
		};

		const updateTargetNode = debounce(async (e: any) => {
			await processNodeUpdate(e);
		}, 500, true);

		const updateTargetNodeImmediate = async (e: any) => {
			await processNodeUpdate(e);
		};

		/**
		 * Synchronizes file metadata with the canvas state by removing the frontmatter reference in the source file
		 * when the corresponding visual connection to the target file is no longer present.
		 */
		const updateOriginalNode = async (edge: any) => {
			if (!edge.to.node?.filePath || !edge.from.node?.filePath) return;

			const canvasName = edge.canvas.view.file.basename;
			const toNode = edge.to.node;
			const fromNode = edge.from.node;

			const file = this.app.vault.getFileByPath(toNode.filePath);
			if (!file) return;

			let link = this.app.fileManager.generateMarkdownLink(file, toNode.filePath);
			link = link.replace(/^!(\[\[.*\]\])$/, '$1'); // for image links

			if (fromNode?.filePath) {
				const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
				if (!fromFile) return;

				const { edges, nodes } = await edge.canvas.getData();
				const sameFileNodes = nodes.filter(node => node.file === fromNode.filePath);

				const stillHasConnection = edges.some(e => 
					sameFileNodes.some(node => e.fromNode === node.id) && 
					e.toNode === toNode.id &&
					!(e.fromNode === fromNode.id && e.toNode === toNode.id)
				);

				if (!stillHasConnection) {
					this.updateFrontmatter(fromFile, link, 'remove', canvasName);
				}
			}
		};

		// remove the node frontmatter when the node is removed
		const removeNodeUpdate = async (node: any) => {
            const resolvedNode = await node;
            if (resolvedNode?.file?.extension !== 'md') return;

            const canvasFile = resolvedNode?.canvas?.view?.file;
            if (!canvasFile || !canvasFile.name) return;

            if (resolvedNode?.filePath) {
                // Check if other nodes in the canvas are using the same source file
                const canvasData = await resolvedNode.canvas.getData();
                const otherNodes = canvasData.nodes.filter(
                    (n: any) => {
						return n.file === resolvedNode.filePath
					}
                );

                // Only remove the property if no other nodes are using the same source file
                if (otherNodes.length === 0) {
                    // use the method for JSON node to remove the property named after the canvas file name.
                    let tmpNode: { file?: string } = {};
                    tmpNode.file = resolvedNode.filePath;
                    this.removeProperty(tmpNode, canvasFile.name, canvasFile.basename);
                }
            }
        };

		// aims to add the canvas file link to the property named after the canvas file name.
		const addNodeUpdate = async (node: any) => {
			const resolvedNode = await node;
			if (resolvedNode?.file?.extension !== 'md') return;

			const canvasFile = resolvedNode.canvas.view.file;
			if (!canvasFile || !canvasFile.name) return;

			if (resolvedNode.filePath) {
				// use the method for JSON node to add the property named after the canvas file name.
				let tmpNode: { file?: string } = {};
				tmpNode.file = resolvedNode.filePath;
				this.addProperty(tmpNode, canvasFile.name, canvasFile.basename);
			}
		};

		const selfPatched = (edge: any) => {
			this.patchedEdge = true;

			const uninstaller = around(edge.constructor.prototype, {
				update: (next: any) => {
					return function (...args: any[]) {
						const result = next.call(this, ...args);
						updateTargetNode(this);
						return result;
					};
				}
			});

			plugin.register(uninstaller);
		};

		const patchCanvas = () => {
			const canvasView = plugin.app.workspace.getLeavesOfType('canvas')[0]?.view;
			if (!canvasView?.canvas) return false;

			const uninstaller = around(canvasView.canvas.constructor.prototype, {
				removeNode(old: Function) {
					return function(node: any) {
						const result = old.call(this, node);
						if (this.isClearing !== true) {
							removeNodeUpdate(node);
						}
						return result;
					};
				},
				addNode(old: Function) {
					return function(node: any) {
						const result = old.call(this, node);
						addNodeUpdate(node);
						return result;
					};
				},
				removeEdge(old: Function) {
					return function(edge: any) {
						const result = old.call(this, edge);
						if (this.isClearing !== true) {
							updateOriginalNode(edge);
						}
						return result;
					};
				},
				addEdge(old: Function) {
					return function(edge: any) {
						const result = old.call(this, edge);
						if (!plugin.patchedEdge) {
							plugin.patchedEdge = true;
							selfPatched(edge);
						}
						updateTargetNodeImmediate(edge);
						return result;
					};
				},
				clear(old: Function) {
					return function() {
						this.isClearing = true;
						const result = old.call(this);
						this.isClearing = false;
						return result;
					};
				}
			});

			plugin.register(uninstaller);
			
			return true;	
		};
		
		const tryToPatch = () => {
			if (patchCanvas()) {
				plugin.detachAutoLinkListeners();
			}
		};
		plugin.autoLinkCheckReference = tryToPatch;

		plugin.app.workspace.on('active-leaf-change', tryToPatch);
		plugin.app.workspace.on('layout-change', tryToPatch);

		tryToPatch();
	}

	registerCanvasExploder() {
        // For File Nodes - use file-menu event
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu: Menu) => {
                this.exploder.checkAndAddMenu(menu, "Split by Headings");
            })
        );

        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu: Menu) => {
                this.exploder.checkAndAddMenu(menu, "Split by Headings");
            })
        );

        // For Text Nodes - patch canvas node menu
        this.patchCanvasNodeMenu();
	}

    /**
     * Patches Canvas to add context menu for text nodes (which don't trigger file-menu).
     */
    patchCanvasNodeMenu() {
        const plugin = this;
        let patched = false;
        
        const tryPatch = () => {
            if (patched) return;
            
            const canvasView = this.app.workspace.getLeavesOfType("canvas")?.[0]?.view as any;
            const anyNode = canvasView?.canvas?.nodes?.values()?.next()?.value;
            if (!anyNode) return;

            const basePrototype = Object.getPrototypeOf(Object.getPrototypeOf(anyNode));
            if (!basePrototype?.showMenu) return;

            const uninstall = around(basePrototype, {
                showMenu: (next) => {
                    return function(menu: Menu, ...args: any[]) {
                        const result = next.call(this, menu, ...args);
                        
                        // Add menu for text nodes
                        if (this.text !== undefined && !this.file) {
                            plugin.exploder.addTextNodeMenu(menu, this);
                        }
                        
                        return result;
                    };
                }
            });

            this.register(uninstall);
            patched = true;
            plugin.app.workspace.offref(leafEvent);
        };

        this.app.workspace.onLayoutReady(tryPatch);
        const leafEvent = this.app.workspace.on('active-leaf-change', tryPatch);
        this.registerEvent(leafEvent);
    }
	
	/**
	 * Installs hooks into the native Canvas prototype to enable automatic height adjustment behavior,
	 * allowing nodes to dynamically resize to fit their content in response to specific user gestures
	 * on resize handles.
	 */
	patchCanvasNodeAutoHeight(): boolean {
        const canvasView = this.app.workspace.getLeavesOfType("canvas")?.first()?.view;
        if (!canvasView) return false;

        const canvas = (canvasView as any).canvas;
        if (!canvas) return false;

        const anyNode = canvas.nodes.values().next().value;
        if (!anyNode) return false;

        const anyNodeConstructor = anyNode.constructor;
        const baseNodePrototype = Object.getPrototypeOf(anyNodeConstructor.prototype);
        
        const methodsToPatch: Record<string, (originalMethod: Function) => Function> = {};

        if (baseNodePrototype.onResizeDblclick) {
            methodsToPatch.onResizeDblclick = (originalMethod) => {
                return function(this: CanvasNodeWithFlag, ...args: any[]) {
                    const [, direction] = args;
                    
                    if (direction === "bottom") {
                        if (this._autoHeightTimer) {
                            window.clearTimeout(this._autoHeightTimer);
                            this._autoHeightTimer = null;
                        }
                        this.autoHeightEnabled = true;
                    }
                    return originalMethod.apply(this, args);
                };
            };
        }
        
        if (baseNodePrototype.onResizePointerdown) {
            methodsToPatch.onResizePointerdown = (originalMethod) => {
                return function(this: CanvasNodeWithFlag, ...args: any[]) {
                    const [event, direction] = args;
                    
                    const result = originalMethod.apply(this, args);

                    if (direction === "bottom") {
                        if (this._autoHeightTimer) {
                            window.clearTimeout(this._autoHeightTimer);
                            this._autoHeightTimer = null;
                        } else {
                            this._autoHeightTimer = window.setTimeout(() => {
                                this.autoHeightEnabled = false; 
                                this._autoHeightTimer = null;
                            }, 250);
                        }
                    } 
                    else if (direction === "right" || direction === "left") {
                        if (this.autoHeightEnabled === true) {
                            const handlePointerUp = () => {
                                window.setTimeout(() => {
                                    if (!this.canvas || !this.canvas.nodes.has(this.id)) return;
                                    
                                    if (this.nodeEl && this.nodeEl.classList.contains('is-resizing')) {
                                        return;
                                    }

                                    this.onResizeDblclick(event, "bottom");

                                }, 0); 
                            };

                            window.addEventListener("pointerup", handlePointerUp, { once: true });
                        }
                    }

                    return result;
                };
            };
        }

		if (baseNodePrototype.blur) {
			methodsToPatch.blur = (originalMethod: Function) => {
				return function(this: CanvasNodeWithFlag, ...args: any[]) {
					const result = originalMethod.apply(this, args);

					if (this.autoHeightEnabled) {
						setTimeout(() => {
							if (typeof this.onResizeDblclick === 'function') {
								const mockEvent = {
									preventDefault: () => {},
									stopPropagation: () => {},
								} as any;

								this.onResizeDblclick(mockEvent, "bottom");
							}
						}, 300);
					}

					return result;
				};
			};
		}

        if (Object.keys(methodsToPatch).length === 0) return false;

        this.uninstaller = around(baseNodePrototype, methodsToPatch);
        this.register(this.uninstaller);

        return true;
    }

	registerCanvasNodeAutoHeightPatcher() {
		const tryToPatch = () => {
			const success = this.patchCanvasNodeAutoHeight();

			if (success) {
				this.detachAutoHeightPatcherListeners();
			}
		};
		this.autoHeightCheckReference = tryToPatch;

		this.app.workspace.on('active-leaf-change', tryToPatch);
		this.app.workspace.on('layout-change', tryToPatch);

		tryToPatch();
	}

	private detachAutoHeightPatcherListeners() {
		if (this.autoHeightCheckReference) {
			this.app.workspace.off('active-leaf-change', this.autoHeightCheckReference);
			this.app.workspace.off('layout-change', this.autoHeightCheckReference);
			this.autoHeightCheckReference = null;
		}
	}

	private detachAutoLinkListeners() {
		if (this.autoLinkCheckReference) {
			this.app.workspace.off('active-leaf-change', this.autoLinkCheckReference);
			this.app.workspace.off('layout-change', this.autoLinkCheckReference);
			this.autoLinkCheckReference = null;
		}
	}

	createEdge(node1: any, node2: any) {
		const random = (e: number) => {
			let t = [];
			for (let n = 0; n < e; n++) {
				t.push((16 * Math.random() | 0).toString(16));
			}
			return t.join("");
		};

		const node1CenterX = node1.x + node1.width / 2;
		const node1CenterY = node1.y + node1.height / 2;
		const node2CenterX = node2.x + node2.width / 2;
		const node2CenterY = node2.y + node2.height / 2;
	  
		const angle = Math.atan2(node2CenterY - node1CenterY, node2CenterX - node1CenterX) * 180 / Math.PI;
		const normalizedAngle = angle < 0 ? angle + 360 : angle;
		
		let fromSide: NodeSide;
		let toSide: NodeSide;
		
		if (normalizedAngle >= 315 || normalizedAngle < 45) {
			fromSide = 'right';
			toSide = 'left';
		} else if (normalizedAngle >= 45 && normalizedAngle < 135) {
			fromSide = 'bottom';
			toSide = 'top';
		} else if (normalizedAngle >= 135 && normalizedAngle < 225) {
			fromSide = 'left';
			toSide = 'right';
		} else {
			fromSide = 'top';
			toSide = 'bottom';
		}
	
		const edgeData: CanvasEdgeData = {
			id: random(16),
			fromSide: fromSide,
			fromNode: node1.id,
			toSide: toSide,
			toNode: node2.id
		};
	
		return edgeData;
	}

	/**
	 * Performs a comprehensive cleanup on all canvas files when the plugin is
	 * unloaded, ensuring any custom properties or data managed by this plugin
	 * are removed from the vault.
	 */
	async onunload() {
		document.body.classList.remove('enhanced-canvas-enabled');
		this.detachAutoHeightPatcherListeners();
		this.detachAutoLinkListeners();

		this.sendToCanvas.clearSelectedCanvas(false);
		try {
			const canvasFiles = this.app.vault.getFiles().filter(file => file.extension === 'canvas');
			
			await Promise.all(canvasFiles.map(async (canvasFile) => {
				try {
					const content = await this.app.vault.read(canvasFile);
					const canvasData = JSON.parse(content) as CanvasData;
					
					const tempCanvas = {
						view: {
							file: canvasFile
						},
						setData: () => {},
						requestSave: () => {}
					};
					
					this.removeAllProperty(tempCanvas, canvasData);
				} catch (error) {
					return;
				}
			}));
		} catch (error) {
			return;
		}
	}
}

/** Settings tab UI for Enhanced Canvas. */
class EnhancedCanvasSettingTab extends PluginSettingTab {
	plugin: EnhancedCanvas;

	constructor(app: any, plugin: EnhancedCanvas) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Enable Frontmatter Synchronization')
			.setDesc(
				'When enabled, canvas nodes and edges are mapped to file metadata (properties). '
			)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.enableFrontmatter)
					.onChange(async (value) => {
						if (!value) {
							// Run cleanup BEFORE disabling the flag, because removeProperty()
							// has an early-return guard that checks enableFrontmatter.
							try {
								const canvasFiles = this.plugin.app.vault.getFiles().filter(file => file.extension === 'canvas');

								await Promise.all(canvasFiles.map(async (canvasFile) => {
									try {
										const content = await this.plugin.app.vault.read(canvasFile);
										const canvasData = JSON.parse(content) as CanvasData;

										const tempCanvas = {
											view: {
												file: canvasFile
											},
											setData: () => {},
											requestSave: () => {}
										};

										this.plugin.removeAllProperty(tempCanvas, canvasData);
									} catch (error) {
										return;
									}
								}));
							} catch (error) {
								// continue even if cleanup fails
							}
						}

						this.plugin.settings.enableFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Enable Custom Visuals & CSS')
			.setDesc(
				'When enabled, hide the metadata panel (properties) inside Canvas Node (and embedded notes and iframe previews).'
			)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.enableCustomCSS)
					.onChange(async (value) => {
						this.plugin.settings.enableCustomCSS = value;
						await this.plugin.saveSettings();
						this.plugin.toggleCSSClass(value);
					})
			);
	}
}
