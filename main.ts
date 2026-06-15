import {
	App,
	FileManager,
	FileView,
	Menu,
	debounce,
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice
} from 'obsidian';
import { CanvasEdgeData, CanvasNodeData, NodeSide, CanvasData } from "obsidian/canvas";
import { around } from "monkey-around";
import { Canvas, CanvasEdge, CanvasNode, CanvasView, Position, Size } from 'Canvas';
import { CanvasExploder } from './src/CanvasExploder';
import { SendToCanvas } from './src/SendToCanvas';
import { CanvasTagImport } from './src/CanvasTagImport';
import { EnhancedCanvasSettings, DEFAULT_SETTINGS } from "./src/settings";
import { isVersionNewer, randomId } from "./src/utils";
import { ReleaseNotesModal } from "./src/ReleaseNotesModal";

interface CanvasNodeWithFlag extends CanvasNode {
    _autoHeightTimer?: number | null;
    autoHeightEnabled?: boolean;
    onResizeDblclick(event: unknown, direction: string): void;
}

/** Subset of Canvas used by removeAllProperty. */
interface CanvasLike {
    view: { file: TFile };
    setData(data: CanvasData): void;
    requestSave(save?: boolean): void;
}

/** A JSON canvas node, narrowed to just the file reference used by the
 * property-mutating methods. Accepts both AllCanvasNodeData (via its
 * `[key: string]: any` index signature) and ad-hoc `{ file: '…' }` stubs. */
interface JsonNodeRef {
    file?: string;
    [key: string]: unknown;
}

/** Normalizes a frontmatter value (missing, string, or array) to a string array. */
function frontmatterValueToArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
	}
	if (typeof value === 'string' && value.trim() !== '') return [value];
	return [];
}

/** Escapes regex metacharacters so file names can be embedded in a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * processFrontMatter serializes keys in object insertion order, so a per-canvas
 * property created before the `canvas` property (e.g. by an edge sync racing the
 * node-add sync) ends up above it in the YAML. Rebuilds the object so `canvas`
 * sits just before the first per-canvas key, leaving other properties in place.
 */
function ensureCanvasKeyOrder(frontmatter: Record<string, unknown>, canvasKeys: Iterable<string>) {
	const keys = Object.keys(frontmatter);
	const canvasIndex = keys.indexOf('canvas');
	if (canvasIndex === -1) return;

	const targetKeys = new Set(canvasKeys);
	targetKeys.delete('canvas');
	const firstTargetIndex = keys.findIndex(key => targetKeys.has(key));
	if (firstTargetIndex === -1 || canvasIndex < firstTargetIndex) return;

	const values = { ...frontmatter };
	const reordered = keys.filter(key => key !== 'canvas');
	reordered.splice(reordered.indexOf(keys[firstTargetIndex]), 0, 'canvas');

	for (const key of keys) delete frontmatter[key];
	for (const key of reordered) frontmatter[key] = values[key];
}

export default class EnhancedCanvas extends Plugin {
	public exploder: CanvasExploder;
	public sendToCanvas: SendToCanvas;
	public canvasTagImport: CanvasTagImport;
	private isMetadataClicked = false;
	settings: EnhancedCanvasSettings;

	public canvasStackInterval: number | null = null;
	public autoHeightUninstaller: (() => void) | null = null;
	public dragTempNodeUninstaller: (() => void) | null = null;

	/**
	 * Scans the selected nodes to identify underlying file references and automatically
	 * generates visual connections where valid links exist between files but edges are
	 * currently missing on the canvas.
	 */
	createMissingEdgesFromLinks(canvas: Canvas) {
		const selectedNodes = Array.from(canvas.selection) as CanvasNode[];
		const fileNodes = selectedNodes.filter((node) => !!node?.filePath);
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const currentData = canvas.getData();

		const existingEdgesMap = new Map<string, CanvasEdgeData>();
		currentData.edges.forEach((edge: CanvasEdgeData) => {
			existingEdgesMap.set(`${edge.fromNode}->${edge.toNode}`, edge);
		});

		const filePathToNodeMap = new Map<string, CanvasNode>();
		fileNodes.forEach((node: CanvasNode) => {
			if (node.filePath) {
				filePathToNodeMap.set(node.filePath, node);
			}
		});

		const newEdges: CanvasEdgeData[] = [];

		fileNodes.forEach((sourceNode: CanvasNode) => {
			if (!sourceNode.filePath) return;
			const links = resolvedLinks[sourceNode.filePath];
			if (!links) return;

			Object.keys(links).forEach((targetPath: string) => {
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
	optimizeEdgesBetweenSelectedNodes(canvas: Canvas) {
		const selectedNodes = Array.from(canvas.selection) as CanvasNode[];
		if (selectedNodes.length < 2) return;

		const currentData = canvas.getData();

		const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));

		const nodeById = new Map<string, CanvasNodeData>();
		for (const node of currentData.nodes) {
			nodeById.set(node.id, node);
		}

		let didUpdateEdges = false;
		currentData.edges.forEach((edge: CanvasEdgeData) => {
			if (selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode)) {
				const fromNode = nodeById.get(edge.fromNode);
				const toNode = nodeById.get(edge.toNode);
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

	deleteEdges(canvas: Canvas) {
		const selectedNodes = Array.from(canvas.selection) as CanvasNode[];
		const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
		const currentData = canvas.getData();

		currentData.edges = currentData.edges.filter((edge: CanvasEdgeData) => {
			return !(selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode));
		});
	
		canvas.setData(currentData);
		canvas.requestSave(false);
	}
	
	/**
	 * add 'canvas' and canvas basename properties to the node frontmatter.
	 */
	addProperty(node: JsonNodeRef, propertyName: string, basename: string) {
		if (!this.settings.enableFrontmatter) return;
		if (!node.file) return;
		const file = this.app.vault.getFileByPath(node.file); // node is JSON node, not canvas node
		if (!file) return;

		const canvasLink = `[[${propertyName}]]`;

		// Skip the write when the cached frontmatter already carries both properties.
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (cached && cached[basename] && frontmatterValueToArray(cached.canvas).includes(canvasLink)) return;

		void this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;

			if (!frontmatter.canvas) {
				frontmatter.canvas = [];
			}
			if (!frontmatter.canvas.includes(canvasLink)) {
				frontmatter.canvas.push(canvasLink);
			}

			if (!frontmatter[basename]) {
				frontmatter[basename] = [];
			}

			ensureCanvasKeyOrder(frontmatter, [basename]);
		});
	}

	/**
	 * For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	 */
	removeProperty(node: JsonNodeRef, propertyName: string, basename: string) {
		if (!this.settings.enableFrontmatter) return;
		if (!node.file) return;
		const file = this.app.vault.getFileByPath(node.file); // node is JSON node, not canvas node
		if (!file) return;

		// Skip the write when the cached frontmatter has nothing to remove.
		const canvasLink = `[[${propertyName}]]`;
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!cached || (!(basename in cached) && !frontmatterValueToArray(cached.canvas).includes(canvasLink))) return;

		return this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;
	
			// remove the property
			if (frontmatter[basename]) {
				delete frontmatter[basename];
			}
	
			// remove the link from the canvas property
			if (frontmatter.canvas) {
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
	renameProperty(node: JsonNodeRef, oldName: string, newName: string) {
		if (!this.settings.enableFrontmatter) return;
		if (!node.file) return;
		const file = this.app.vault.getFileByPath(node.file);
		if (!file) return;
	
		const getBaseName = (name: string) => name.substring(name.lastIndexOf('/') + 1);

		newName = getBaseName(newName);
		const oldBaseName = oldName.endsWith('.canvas') ? oldName.slice(0, -7) : oldName;
		const newBaseName = newName.endsWith('.canvas') ? newName.slice(0, -7) : newName;
	
		void this.app.fileManager.processFrontMatter(file, (frontmatter) => {
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

	async removeAllProperty(canvas: CanvasLike, canvasData: CanvasData) {
		if (!this.settings.enableFrontmatter) return;
		const nodes = canvasData.nodes;
		await Promise.all(nodes.map(node => {
			if (!node?.file) return;
			return this.removeProperty(node, canvas.view.file.name, canvas.view.file.basename);
		}));
		canvas.setData(canvasData);
		canvas.requestSave(false);
	}

	/**
	 * Startup sweep: ensures every markdown note referenced by a canvas carries
	 * the plugin's frontmatter properties (the `canvas` link list plus one
	 * property per canvas holding links to edge-connected notes).
	 *
	 * The desired state is aggregated across all canvases first, then compared
	 * against the metadata cache, so each note gets at most one
	 * `processFrontMatter` write — and none at all when it is already up to
	 * date, which is the common case on restart.
	 */
	async syncAllCanvasProperties() {
		if (!this.settings.enableFrontmatter) return;

		interface DesiredProps {
			/** Entries the `canvas` property must contain, e.g. '[[Name.canvas]]'. */
			canvasLinks: Set<string>;
			/** Per-canvas properties (canvas basenames) that must exist. */
			ensureKeys: Set<string>;
			/** Links each per-canvas property must contain. */
			linksByKey: Map<string, Set<string>>;
		}
		const desiredByPath = new Map<string, DesiredProps>();
		const getDesired = (path: string): DesiredProps => {
			let desired = desiredByPath.get(path);
			if (!desired) {
				desired = { canvasLinks: new Set(), ensureKeys: new Set(), linksByKey: new Map() };
				desiredByPath.set(path, desired);
			}
			return desired;
		};

		const canvasFiles = this.app.vault.getFiles().filter(file => file.extension === 'canvas');

		await Promise.all(canvasFiles.map(async (canvasFile) => {
			let canvasData: CanvasData;
			try {
				const content = await this.app.vault.read(canvasFile);
				if (!content || content.trim() === '') return;
				canvasData = JSON.parse(content) as CanvasData;
			} catch (error) {
				console.error("Enhanced Canvas: Failed to read canvas file", canvasFile.path, error);
				return;
			}
			if (!canvasData) return;

			const nodes = Array.isArray(canvasData.nodes) ? canvasData.nodes : [];
			const edges = Array.isArray(canvasData.edges) ? canvasData.edges : [];

			const nodeById = new Map<string, CanvasNodeData>();
			for (const node of nodes) {
				nodeById.set(node.id, node);
			}

			for (const node of nodes) {
				if (!node?.file) continue;
				const desired = getDesired(node.file);
				desired.canvasLinks.add(`[[${canvasFile.name}]]`);
				desired.ensureKeys.add(canvasFile.basename);
			}

			for (const edgeData of edges) {
				const fromNode = nodeById.get(edgeData.fromNode);
				const toNode = nodeById.get(edgeData.toNode);

				if (!fromNode?.file || !toNode?.file) continue;
				if (fromNode.file === toNode.file) continue;

				const toFile = this.app.vault.getFileByPath(toNode.file);
				if (!toFile) continue;

				const link = this.app.fileManager.generateMarkdownLink(toFile, fromNode.file).replace(/^!(\[\[.*\]\])$/, '$1');

				const desired = getDesired(fromNode.file);
				let links = desired.linksByKey.get(canvasFile.basename);
				if (!links) {
					links = new Set();
					desired.linksByKey.set(canvasFile.basename, links);
				}
				links.add(link);
			}
		}));

		await Promise.all(Array.from(desiredByPath.entries()).map(async ([path, desired]) => {
			const file = this.app.vault.getFileByPath(path);
			// processFrontMatter only works on markdown notes; skip everything else.
			if (!file || file.extension !== 'md') return;

			const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (cached) {
				const cachedCanvas = frontmatterValueToArray(cached.canvas);
				const cachedKeys = Object.keys(cached);
				const canvasKeyIndex = cachedKeys.indexOf('canvas');
				const upToDate =
					Array.from(desired.canvasLinks).every(link => cachedCanvas.includes(link)) &&
					// The key must exist *and* sit below the `canvas` property in the YAML.
					Array.from(desired.ensureKeys).every(key =>
						!!cached[key] && canvasKeyIndex !== -1 && canvasKeyIndex < cachedKeys.indexOf(key)) &&
					Array.from(desired.linksByKey.entries()).every(([key, links]) => {
						const existing = frontmatterValueToArray(cached[key]);
						return Array.from(links).every(link => existing.includes(link));
					});
				if (upToDate) return;
			}

			try {
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					if (!frontmatter) return;

					if (!frontmatter.canvas) {
						frontmatter.canvas = [];
					} else if (typeof frontmatter.canvas === 'string') {
						frontmatter.canvas = [frontmatter.canvas];
					}
					if (Array.isArray(frontmatter.canvas)) {
						for (const link of desired.canvasLinks) {
							if (!frontmatter.canvas.includes(link)) {
								frontmatter.canvas.push(link);
							}
						}
					}

					for (const key of desired.ensureKeys) {
						if (!frontmatter[key]) {
							frontmatter[key] = [];
						}
					}

					for (const [key, links] of desired.linksByKey) {
						const existingValue = Reflect.get(frontmatter, key);
						const wasString = typeof existingValue === 'string' && existingValue.trim() !== '';
						const merged = frontmatterValueToArray(existingValue);
						for (const link of links) {
							if (!merged.includes(link)) {
								merged.push(link);
							}
						}
						Reflect.set(frontmatter, key, merged.length === 1 && wasString ? merged[0] : merged);
					}

					ensureCanvasKeyOrder(frontmatter, desired.ensureKeys);
				});
			} catch (error) {
				console.error("Enhanced Canvas: Failed to update properties for note", path, error);
			}
		}));
	}

	/**
	 * Modifies a file's frontmatter property to ensure a specific value is either 
	 * included or excluded while maintaining list integrity.
	 */
    updateFrontmatter = async (file: TFile, link: string, action: 'add' | 'remove', propertyName: string) => {
		if (!this.settings.enableFrontmatter) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const existingValue = Reflect.get(fm, propertyName);
            const currentSet = new Set<string>();
            let wasString = false;

            if (Array.isArray(existingValue)) {
                existingValue.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
                             .forEach(item => currentSet.add(item));
            } else if (typeof existingValue === 'string' && existingValue.trim() !== '') {
                currentSet.add(existingValue);
                wasString = true;
            }
            
            if (action === 'add') {
                currentSet.add(link);
            } else if (action === 'remove') {
                currentSet.delete(link);
            }

            const finalArray = Array.from(currentSet);

            if (finalArray.length > 0) {
                if (finalArray.length === 1 && wasString) {
                    Reflect.set(fm, propertyName, finalArray[0]);
                } else {
                    Reflect.set(fm, propertyName, finalArray);
                }
            } else {
                Reflect.deleteProperty(fm, propertyName);
            }

            ensureCanvasKeyOrder(fm, [propertyName]);
        });
    };

	private ifActiveViewIsCanvas = (commandFn: (canvas: Canvas) => void) => (checking: boolean) => {
		const activeView = this.app.workspace.getActiveViewOfType(ItemView);
		if (activeView?.getViewType() !== 'canvas') {
			return checking ? false : undefined;
		}

		if (checking) return true;

		const canvas = (activeView as CanvasView).canvas;
		if (!canvas) return;
		return commandFn(canvas);
	}

	/** Applies or removes the body CSS class that gates the optional visual styles. */
	toggleCSSClass(enabled: boolean) {
		if (enabled) {
			activeDocument.body.classList.add('enhanced-canvas-enabled');
		} else {
			activeDocument.body.classList.remove('enhanced-canvas-enabled');
		}
	}

	/**
	 * Patching Canvas internals needs a live Canvas leaf, which may not exist
	 * at load time. Runs `patch` now and again on every workspace change that
	 * could introduce one, until it reports success — then detaches the retry
	 * listeners so the patch can't run twice (see CLAUDE.md). The listeners
	 * are also registered for unload cleanup, so a patch that never succeeds
	 * leaks nothing.
	 */
	registerLazyPatcher(patch: () => boolean) {
		let patched = false;
		const tryToPatch = () => {
			if (patched || !patch()) return;
			patched = true;
			this.app.workspace.offref(leafEvent);
			this.app.workspace.offref(layoutEvent);
		};

		const leafEvent = this.app.workspace.on('active-leaf-change', tryToPatch);
		const layoutEvent = this.app.workspace.on('layout-change', tryToPatch);
		this.registerEvent(leafEvent);
		this.registerEvent(layoutEvent);
		this.app.workspace.onLayoutReady(tryToPatch);
		tryToPatch();
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
		this.canvasTagImport = new CanvasTagImport(this);

		this.addSettingTab(new EnhancedCanvasSettingTab(this.app, this));
		this.toggleCSSClass(this.settings.enableCustomCSS);

		this.registerPluginCommands();
		this.registerCanvasAutoLink();
		this.registerFileManagerPatches();
		this.registerFocusCanvas();
		this.registerCanvasExploder();
		this.registerCanvasTagImport();
		this.registerCanvasNodeAutoHeightPatcher();
		this.registerCanvasDefaultNodeSize();
		this.registerCanvasDragTempNodePatcher();

		try {
			await this.syncAllCanvasProperties();
		} catch (error) {
			console.error("Enhanced Canvas: Error in metadata update loop", error);
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
					window.clearInterval(this.canvasStackInterval);
					this.canvasStackInterval = null;
				}

				if (!leaf) return;

				const isStacked = !!activeDocument.querySelector('.workspace-tabs.mod-stacked');
				if (!isStacked) return;

				const view = leaf.view;
				if (view.getViewType() !== 'canvas') return;

				if (typeof view.onResize === 'function') {
					view.onResize();
				}
				
				window.setTimeout(() => {
					if (typeof view.onResize === 'function') view.onResize();
				}, 200);

				let lastLeft = view.containerEl.getBoundingClientRect().left;

				this.canvasStackInterval = window.setInterval(() => {
					if (!view || !view.containerEl) {
						if (this.canvasStackInterval !== null) {
							window.clearInterval(this.canvasStackInterval);
							this.canvasStackInterval = null;
						}
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
				this.registerInterval(this.canvasStackInterval);
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
                        isNewInstall,
                        previousVersion
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
		const deleteFile = async (file: TFile) => {
			if ((file as TFile & { deleted?: boolean }).deleted === true) return;

			const backLinks = this.app.metadataCache.getBacklinksForFile(file);
			if (!backLinks || !backLinks.data) return;

			const linkRegexBasename = new RegExp(`\\[\\[${escapeRegExp(file.basename)}(\\|.*)?\\]\\]`);
			const linkRegexFullName = new RegExp(`\\[\\[${escapeRegExp(file.name)}(\\|.*)?\\]\\]`);

			for (const [sourcePath] of backLinks.data.entries()) {
				const sourceFile = this.app.vault.getFileByPath(sourcePath);
				if (!sourceFile || sourceFile.extension !== 'md') continue;

				await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter) => {
					if (!frontmatter) return;

					Object.keys(frontmatter).forEach(key => {
						if (Array.isArray(frontmatter[key])) {
							frontmatter[key] = frontmatter[key].filter((item: unknown) => {
								if (typeof item !== 'string') return true;

								return !(linkRegexBasename.test(item) || linkRegexFullName.test(item));
							});
						}
					});
				});
			}
		}

		const deleteCanvasFile = async (file: TFile) => {
			if (file.extension !== 'canvas') return;
			if ((file as TFile & { deleted?: boolean }).deleted === true) return;

			const content = await this.app.vault.read(file);
			if (!content) return;
			const canvasData = JSON.parse(content) as CanvasData;
			if (!canvasData) return;

			canvasData.nodes.forEach((node: CanvasNodeData) => {
				if (node.type !== 'file') return;
				void this.removeProperty(node, file.name, file.basename);
			});
		}

		const renameCanvasFile = async (file: TFile, newPath: string) => {
			if (file.extension !== 'canvas') return;
			if ((file as TFile & { deleted?: boolean }).deleted === true) return;

			const content = await this.app.vault.read(file);
			if (!content) return;
			const canvasData = JSON.parse(content) as CanvasData;
			if (!canvasData) return;

			canvasData.nodes.forEach((node: CanvasNodeData) => {
				if (node.type !== 'file') return;
				this.renameProperty(node, file.name, newPath);
			});
		}

		const uninstaller = around(this.app.fileManager.constructor.prototype, {
			trashFile(old: (file: TFile) => Promise<void>) {
				return function(this: FileManager, file: TFile) {
					void deleteCanvasFile(file);
					void deleteFile(file);
					return old.call(this, file);
				};
			},
			renameFile(old: (file: TFile, newPath: string) => Promise<void>) {
				return function(this: FileManager, file: TFile, newPath: string) {
					void renameCanvasFile(file, newPath);
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
			checkCallback: this.ifActiveViewIsCanvas((canvas) => {
				this.optimizeEdgesBetweenSelectedNodes(canvas);
			})
		});

		this.addCommand({
			id: 'delete-edges',
			name: 'Delete edges between selected nodes',
			checkCallback: this.ifActiveViewIsCanvas((canvas) => {
				this.deleteEdges(canvas);
			})
		});

		this.addCommand({
			id: 'add-link-and-optimize-edge',
			name: 'Add edges according the links in notes',
			checkCallback: this.ifActiveViewIsCanvas((canvas) => {
				this.createMissingEdgesFromLinks(canvas);
				this.optimizeEdgesBetweenSelectedNodes(canvas);
			})
		});

		this.addCommand({
			id: 'remove-canvas-property',
			name: 'Remove the property of all nodes in current Canvas',
			checkCallback: this.ifActiveViewIsCanvas((canvas) => {
				void this.removeAllProperty(canvas, canvas.getData());
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
		let clickedSourceFile: string | null = null;

		const handleClick = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target.closest('.metadata-container') || target.closest('.search-result-container')) {
				this.isMetadataClicked = true;

				const activeView = this.app.workspace.getActiveViewOfType(FileView);
				clickedSourceFile = activeView?.file?.path ?? null;

				window.setTimeout(() => {
					this.isMetadataClicked = false;
					clickedSourceFile = null;
				}, 500);
			}
		};

		// DOM events don't cross window boundaries, so attach to every window's
		// document — main, any popouts open at load, and any opened later.
		const attachedDocs = new WeakSet<Document>();
		const attachTo = (doc: Document) => {
			if (attachedDocs.has(doc)) return;
			attachedDocs.add(doc);
			this.registerDomEvent(doc, 'click', handleClick, true);
		};

		attachTo(document);

		this.app.workspace.iterateAllLeaves((leaf) => {
			const doc = leaf.view.containerEl.ownerDocument;
			if (doc) attachTo(doc);
		});

		this.registerEvent(
			this.app.workspace.on('window-open', (_workspaceWindow, win: Window) => {
				attachTo(win.document);
			})
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				Promise.resolve().then(async () => {
					if (this.isMetadataClicked == false || !clickedSourceFile) return;
					// get current active leaf
					const activeLeaf = this.app.workspace.getActiveViewOfType(ItemView);
					if (!activeLeaf || activeLeaf.getViewType() !== 'canvas') return;

					const prevFile = clickedSourceFile;
					if (!prevFile) return;

					const canvas = (activeLeaf as CanvasView).canvas;
					if (!canvas) return;

					for (const value of canvas.nodes.values()) {
						if (value?.filePath === prevFile) {
							canvas.select(value);
						}
					}
					window.setTimeout(() => {
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
		const processNodeUpdate = async (e: CanvasEdge) => {
			if (!this.settings.enableFrontmatter) return;

			const fromNode = e?.from?.node;
			const toNode = e?.to?.node;

			if (!fromNode || !toNode) return;
			if (!fromNode?.filePath) return;

			const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
			if (!fromFile) return;

			// The sync is debounced, so the canvas may have unloaded meanwhile.
			const canvasFile = e.canvas?.view?.file;
			if (!canvasFile) return;
			const canvasName = canvasFile.basename;

			const resolvedLinks = this.app.metadataCache.resolvedLinks[fromNode.filePath] || {};
			const fromNodeLinks = Object.keys(resolvedLinks);

			const { edges, nodes } = e.canvas.getData();

			const nodeById = new Map<string, CanvasNodeData>();
			const sameFileNodeIds = new Set<string>();
			for (const node of nodes) {
				nodeById.set(node.id, node);
				if (node.file === fromNode.filePath) sameFileNodeIds.add(node.id);
			}

			// Node gone from the canvas (closed or node deleted) — removeNodeUpdate
			// owns that cleanup; reconciling against the now-empty data would
			// wrongly strip every link.
			if (!sameFileNodeIds.has(fromNode.id)) return;

			const edgeToNodesFilePathSet = new Set<string>();
			for (const edge of edges) {
				if (!sameFileNodeIds.has(edge.fromNode)) continue;
				const targetNode = nodeById.get(edge.toNode);
				if (targetNode?.type === 'file') edgeToNodesFilePathSet.add(targetNode.file);
			}

			const getFilePath = (path: string) => this.app.vault.getFileByPath(path);
			const toLink = (path: string, file: TFile) =>
				this.app.fileManager.generateMarkdownLink(file, path).replace(/^!(\[\[.*\]\])$/, '$1');

			const linksToRemove: string[] = [];
			fromNodeLinks.forEach(filePath => {
				if (edgeToNodesFilePathSet.has(filePath)) return;
				if (filePath === canvasFile.path) return;
				const targetFile = getFilePath(filePath);
				if (!targetFile) return;
				linksToRemove.push(toLink(filePath, targetFile));
			});

			// Only add the link when the edge is still present in the canvas data —
			// the debounced sync may run after the edge was already deleted again.
			let linkToAdd: string | null = null;
			if (toNode.filePath && fromNode.filePath !== toNode.filePath && edgeToNodesFilePathSet.has(toNode.filePath)) {
				const targetFile = getFilePath(toNode.filePath);
				if (targetFile) linkToAdd = toLink(toNode.filePath, targetFile);
			}

			// Early skip via the metadata cache so a clean canvas open issues no
			// writes. The cache lags right after a write, so it only gates the
			// call — the actual add/remove decisions are made against the real
			// frontmatter inside processFrontMatter below.
			const cachedLinks = frontmatterValueToArray(
				this.app.metadataCache.getFileCache(fromFile)?.frontmatter?.[canvasName]
			);
			const cacheOutOfDate =
				linksToRemove.some(link => cachedLinks.includes(link)) ||
				(linkToAdd !== null && !cachedLinks.includes(linkToAdd));
			if (!cacheOutOfDate) return;

			await this.app.fileManager.processFrontMatter(fromFile, (fm) => {
				const existingValue = Reflect.get(fm, canvasName);
				const wasString = typeof existingValue === 'string' && existingValue.trim() !== '';
				const removeSet = new Set(linksToRemove);
				const next = frontmatterValueToArray(existingValue).filter(link => !removeSet.has(link));
				if (linkToAdd && !next.includes(linkToAdd)) next.push(linkToAdd);

				if (next.length > 0) {
					Reflect.set(fm, canvasName, next.length === 1 && wasString ? next[0] : next);
				} else {
					Reflect.deleteProperty(fm, canvasName);
				}

				ensureCanvasKeyOrder(fm, [canvasName]);
			});
		};

		// Edges touched within the debounce window all get processed; repeated
		// updates of the same edge collapse into one slot. Opening a canvas
		// re-adds every edge, so the addEdge patch queues here too: the flush
		// then runs after the import finishes, against complete canvas data —
		// an immediate sync would reconcile against partially imported edges
		// and strip links that are still being loaded.
		const pendingEdgeUpdates = new Set<CanvasEdge>();
		const flushEdgeUpdates = debounce(() => {
			const pending = Array.from(pendingEdgeUpdates);
			pendingEdgeUpdates.clear();
			for (const edge of pending) {
				void processNodeUpdate(edge);
			}
		}, 500, true);

		// edge.update() fires on every geometric change (node drag, pan, layout),
		// but the frontmatter sync only depends on what the edge connects. Track
		// each edge's endpoints and queue a sync only when they change. The first
		// sighting is the baseline: new edges are already synced by the addEdge
		// patch below.
		const edgeConnectivity = new WeakMap<CanvasEdge, string>();
		const updateTargetNode = (e: CanvasEdge) => {
			const connectivity =
				`${e.from?.node?.id ?? ''}:${e.from?.node?.filePath ?? ''}` +
				`->${e.to?.node?.id ?? ''}:${e.to?.node?.filePath ?? ''}`;
			const previous = edgeConnectivity.get(e);
			if (previous === connectivity) return;
			edgeConnectivity.set(e, connectivity);
			if (previous === undefined) return;

			pendingEdgeUpdates.add(e);
			flushEdgeUpdates();
		};

		/**
		 * Synchronizes file metadata with the canvas state by removing the frontmatter reference in the source file
		 * when the corresponding visual connection to the target file is no longer present.
		 */
		const updateOriginalNode = async (edge: CanvasEdge) => {
			const toNode = edge.to.node;
			const fromNode = edge.from.node;
			const toFilePath = toNode?.filePath;
			const fromFilePath = fromNode?.filePath;
			if (!toFilePath || !fromFilePath) return;

			const canvasName = edge.canvas.view.file.basename;

			const file = this.app.vault.getFileByPath(toFilePath);
			if (!file) return;

			let link = this.app.fileManager.generateMarkdownLink(file, toFilePath);
			link = link.replace(/^!(\[\[.*\]\])$/, '$1'); // for image links

			const fromFile = this.app.vault.getFileByPath(fromFilePath);
			if (!fromFile) return;

			const { edges, nodes } = edge.canvas.getData();
			const sameFileNodeIds = new Set(
				nodes.filter((node: CanvasNodeData) => node.file === fromFilePath).map((node: CanvasNodeData) => node.id)
			);

			const stillHasConnection = edges.some((e: CanvasEdgeData) =>
				sameFileNodeIds.has(e.fromNode) &&
				e.toNode === toNode.id &&
				e.fromNode !== fromNode.id
			);

			if (!stillHasConnection) {
				void this.updateFrontmatter(fromFile, link, 'remove', canvasName);
			}
		};

		// remove the node frontmatter when the node is removed
		const removeNodeUpdate = async (node: CanvasNode) => {
            const resolvedNode = await node;
            if (resolvedNode?.file?.extension !== 'md') return;

            const canvasFile = resolvedNode?.canvas?.view?.file;
            if (!canvasFile || !canvasFile.name) return;

            if (resolvedNode?.filePath) {
                // Check if other nodes in the canvas are using the same source file
                const canvasData = await resolvedNode.canvas.getData();
                const otherNodes = canvasData.nodes.filter(
                    (n: CanvasNodeData) => n.file === resolvedNode.filePath
                );

                // Only remove the property if no other nodes are using the same source file
                if (otherNodes.length === 0) {
                    // use the method for JSON node to remove the property named after the canvas file name.
                    const tmpNode: { file?: string } = { file: resolvedNode.filePath };
                    void this.removeProperty(tmpNode, canvasFile.name, canvasFile.basename);
                }
            }
        };

		// aims to add the canvas file link to the property named after the canvas file name.
		const addNodeUpdate = async (node: CanvasNode) => {
			const resolvedNode = await node;
			if (resolvedNode?.file?.extension !== 'md') return;

			const canvasFile = resolvedNode.canvas.view.file;
			if (!canvasFile || !canvasFile.name) return;

			if (resolvedNode.filePath) {
				// use the method for JSON node to add the property named after the canvas file name.
				const tmpNode: { file?: string } = { file: resolvedNode.filePath };
				void this.addProperty(tmpNode, canvasFile.name, canvasFile.basename);
			}
		};

		const patchedEdgeConstructors = new WeakSet<object>();

		const selfPatched = (edge: CanvasEdge) => {
			if (patchedEdgeConstructors.has(edge.constructor)) return;
			patchedEdgeConstructors.add(edge.constructor);

			const uninstaller = around(edge.constructor.prototype, {
				update: (next: (...args: unknown[]) => unknown) => {
					return function (this: CanvasEdge, ...args: unknown[]) {
						const result = next.call(this, ...args);
						updateTargetNode(this);
						return result;
					};
				}
			});

			this.register(uninstaller);
		};

		let canvasPatched = false;

		const patchCanvas = () => {
			if (canvasPatched) return false;

			const canvasView = this.app.workspace.getLeavesOfType('canvas')
				.find(l => (l.view as CanvasView)?.canvas != null)?.view as CanvasView | undefined;
			if (!canvasView?.canvas) return false;

			const uninstaller = around(canvasView.canvas.constructor.prototype, {
				removeNode(old: (node: CanvasNode) => void) {
					return function(this: Canvas, node: CanvasNode) {
						const result = old.call(this, node);
						if (this.isClearing !== true) {
							void removeNodeUpdate(node);
						}
						return result;
					};
				},
				addNode(old: (node: CanvasNode) => void) {
					return function(this: Canvas, node: CanvasNode) {
						const result = old.call(this, node);
						void addNodeUpdate(node);
						return result;
					};
				},
				removeEdge(old: (edge: CanvasEdge) => void) {
					return function(this: Canvas, edge: CanvasEdge) {
						const result = old.call(this, edge);
						if (this.isClearing !== true) {
							void updateOriginalNode(edge);
						}
						return result;
					};
				},
				addEdge(old: (edge: CanvasEdge) => void) {
					return function(this: Canvas, edge: CanvasEdge) {
						const result = old.call(this, edge);
						selfPatched(edge);
						pendingEdgeUpdates.add(edge);
						flushEdgeUpdates();
						return result;
					};
				},
				clear(old: () => void) {
					return function(this: Canvas) {
						this.isClearing = true;
						const result = old.call(this);
						queueMicrotask(() => {
							this.isClearing = false;
						});
						return result;
					};
				}
			});

			this.register(uninstaller);
			canvasPatched = true;
			return true;
		};

		this.registerLazyPatcher(patchCanvas);
	}

	registerCanvasExploder() {
        // For File Nodes - use file-menu event
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu: Menu) => {
                this.exploder.checkAndAddMenu(menu, "Split by headings");
            })
        );

        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu: Menu) => {
                this.exploder.checkAndAddMenu(menu, "Split by headings");
            })
        );

        // For Text Nodes - patch canvas node menu
        this.patchCanvasNodeMenu();
	}

	registerCanvasTagImport() {
		this.canvasTagImport.register();
	}

    /**
     * Patches Canvas to add context menu for text nodes (which don't trigger file-menu).
     */
    patchCanvasNodeMenu() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- alias needed: `this` inside the around() patch rebinds to the Canvas node, so the plugin reference must be captured in an outer variable
        const plugin = this;

        this.registerLazyPatcher(() => {
            const canvasView = this.app.workspace.getLeavesOfType("canvas")
                .find(l => (l.view as CanvasView)?.canvas?.nodes?.size)?.view as CanvasView | undefined;
            const anyNode = canvasView?.canvas?.nodes?.values()?.next()?.value;
            if (!anyNode) return false;

            const basePrototype = Object.getPrototypeOf(Object.getPrototypeOf(anyNode));
            if (!basePrototype?.showMenu) return false;

            const uninstall = around(basePrototype, {
                showMenu: (next: (menu: Menu, ...args: unknown[]) => unknown) => {
                    return function(this: CanvasNode, menu: Menu, ...args: unknown[]) {
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
            return true;
        });
    }
	
	/**
	 * Installs hooks into the native Canvas prototype to enable automatic height adjustment behavior,
	 * allowing nodes to dynamically resize to fit their content in response to specific user gestures
	 * on resize handles.
	 */
	patchCanvasNodeAutoHeight(): boolean {
        if (this.autoHeightUninstaller) return false;

        const canvasView = this.app.workspace.getLeavesOfType("canvas")?.first()?.view;
        if (!canvasView) return false;

        const canvas = (canvasView as CanvasView).canvas;
        if (!canvas) return false;

        const anyNode = canvas.nodes.values().next().value;
        if (!anyNode) return false;

        const anyNodeConstructor = anyNode.constructor;
        const baseNodePrototype = Object.getPrototypeOf(anyNodeConstructor.prototype);

        type PatchFn = (originalMethod: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
        const methodsToPatch: Record<string, PatchFn> = {};

        if (baseNodePrototype.onResizeDblclick) {
            methodsToPatch.onResizeDblclick = (originalMethod) => {
                return function(this: CanvasNodeWithFlag, ...args: unknown[]) {
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
                return function(this: CanvasNodeWithFlag, ...args: unknown[]) {
                    const [event, direction] = args;
                    
                    const result = originalMethod.apply(this, args);

                    if (direction === "bottom") {
                        if (this._autoHeightTimer) {
                            window.clearTimeout(this._autoHeightTimer);
                        }
                        this._autoHeightTimer = window.setTimeout(() => {
                            this.autoHeightEnabled = false; 
                            this._autoHeightTimer = null;
                        }, 300);
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
			methodsToPatch.blur = (originalMethod) => {
				return function(this: CanvasNodeWithFlag, ...args: unknown[]) {
					const result = originalMethod.apply(this, args);

					if (this.autoHeightEnabled) {
						window.setTimeout(() => {
							if (typeof this.onResizeDblclick === 'function') {
								const mockEvent = {
									preventDefault: () => {},
									stopPropagation: () => {},
								};

								this.onResizeDblclick(mockEvent, "bottom");
							}
						}, 300);
					}

					return result;
				};
			};
		}

        if (Object.keys(methodsToPatch).length === 0) return false;

        this.autoHeightUninstaller = around(baseNodePrototype, methodsToPatch);
        this.register(this.autoHeightUninstaller);

        return true;
    }

	registerCanvasNodeAutoHeightPatcher() {
		this.registerLazyPatcher(() => this.patchCanvasNodeAutoHeight());
	}

	/**
	 * Writes the user's configured default sizes into a Canvas instance's config so that
	 * every native creation path (double-click, paste, programmatic createTextNode/createFileNode)
	 * picks them up. Touches in-memory state only.
	 */
	applyDefaultNodeSizeToCanvas(canvas: Canvas) {
		if (!canvas?.config) return;
		canvas.config.defaultTextNodeDimensions = {
			width:  this.settings.defaultTextNodeWidth,
			height: this.settings.defaultTextNodeHeight,
		};
		canvas.config.defaultFileNodeDimensions = {
			width:  this.settings.defaultFileNodeWidth,
			height: this.settings.defaultFileNodeHeight,
		};
	}

	applyDefaultNodeSizeToAllOpenCanvases() {
		for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
			const canvas = (leaf.view as CanvasView)?.canvas;
			if (canvas) this.applyDefaultNodeSizeToCanvas(canvas);
		}
	}

	registerCanvasDefaultNodeSize() {
		const apply = () => this.applyDefaultNodeSizeToAllOpenCanvases();

		this.registerEvent(this.app.workspace.on('active-leaf-change', apply));
		this.registerEvent(this.app.workspace.on('layout-change',     apply));
		this.app.workspace.onLayoutReady(apply);
		apply();
	}

	/**
	 * Patches Canvas.prototype.dragTempNode so dragging a note in from the file explorer
	 * uses the user's configured file-node size instead of whatever Obsidian's drag handler
	 * computed upstream of canvas.config.
	 */
	patchCanvasDragTempNode(): boolean {
		if (this.dragTempNodeUninstaller) return false;

		const canvasView = this.app.workspace.getLeavesOfType('canvas')?.first()?.view as CanvasView | undefined;
		const canvas = canvasView?.canvas;
		if (!canvas?.constructor?.prototype?.dragTempNode) return false;

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- alias needed: `this` inside the around() patch rebinds to the Canvas instance, so the plugin reference must be captured in an outer variable
		const plugin = this;
		const uninstall = around(canvas.constructor.prototype, {
			dragTempNode(orig: (dragEvent: unknown, nodeSize: Size, onDropped: (position: Position) => void) => void) {
				return function (this: Canvas, dragEvent: unknown, _nodeSize: Size, onDropped: (position: Position) => void) {
					const overridden: Size = {
						width:  plugin.settings.defaultFileNodeWidth,
						height: plugin.settings.defaultFileNodeHeight,
					};
					return orig.call(this, dragEvent, overridden, onDropped);
				};
			},
		});

		this.dragTempNodeUninstaller = uninstall;
		this.register(uninstall);
		return true;
	}

	registerCanvasDragTempNodePatcher() {
		this.registerLazyPatcher(() => this.patchCanvasDragTempNode());
	}

	createEdge(
		node1: Pick<CanvasNodeData, 'id' | 'x' | 'y' | 'width' | 'height'>,
		node2: Pick<CanvasNodeData, 'id' | 'x' | 'y' | 'width' | 'height'>,
	) {
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
			id: randomId(16),
			fromSide: fromSide,
			fromNode: node1.id,
			toSide: toSide,
			toNode: node2.id
		};
	
		return edgeData;
	}

	/**
	 * Performs a comprehensive cleanup on all markdown notes when the plugin
	 * is unloaded, ensuring any custom properties or data managed by this
	 * plugin are removed from the vault.
	 */
	onunload() {
		if (this.canvasStackInterval !== null) {
			window.clearInterval(this.canvasStackInterval);
			this.canvasStackInterval = null;
		}

		activeDocument.body.classList.remove('enhanced-canvas-enabled');

		this.sendToCanvas.clearSelectedCanvas(false);
		void this.cleanupCanvasProperties();
	}

	/**
	 * Strips every plugin-managed property from every markdown note: the
	 * `canvas` property plus each per-canvas property (named after a canvas
	 * basename). Note-driven rather than canvas-driven so it also removes
	 * orphans left behind by deleted/renamed canvases or removed nodes, and
	 * it works regardless of `enableFrontmatter`. Returns the paths of notes
	 * whose frontmatter could not be updated.
	 */
	async cleanupCanvasProperties(): Promise<string[]> {
		const canvasBasenames = new Set(
			this.app.vault.getFiles()
				.filter(file => file.extension === 'canvas')
				.map(file => file.basename)
		);

		// '[[folder/Name.canvas|Alias]]' -> 'Name'
		const linkToBasename = (link: string) => {
			const target = link.replace(/^\[\[(.*)\]\]$/, '$1').split('|')[0];
			const base = target.substring(target.lastIndexOf('/') + 1);
			return base.endsWith('.canvas') ? base.slice(0, -'.canvas'.length) : base;
		};

		const failedFiles: string[] = [];

		await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => {
			const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!cached) return;
			if (!('canvas' in cached) && !Object.keys(cached).some(key => canvasBasenames.has(key))) return;

			try {
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					if (!frontmatter) return;

					const canvasLinks = Array.isArray(frontmatter.canvas)
						? frontmatter.canvas
						: typeof frontmatter.canvas === 'string' ? [frontmatter.canvas] : [];
					for (const link of canvasLinks) {
						if (typeof link === 'string') delete frontmatter[linkToBasename(link)];
					}
					delete frontmatter.canvas;

					for (const key of Object.keys(frontmatter)) {
						if (canvasBasenames.has(key)) delete frontmatter[key];
					}
				});
			} catch (error) {
				console.error("Enhanced Canvas: Failed to clean properties from note", file.path, error);
				failedFiles.push(file.path);
			}
		}));

		return failedFiles;
	}
}

/** Settings tab UI for Enhanced Canvas. */
class EnhancedCanvasSettingTab extends PluginSettingTab {
	plugin: EnhancedCanvas;

	constructor(app: App, plugin: EnhancedCanvas) {
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
							// Disable first so live canvas handlers can't re-add
							// properties mid-sweep; the sweep ignores the setting.
							this.plugin.settings.enableFrontmatter = false;
							await this.plugin.saveSettings();

							const failedFiles = await this.plugin.cleanupCanvasProperties();
							if (failedFiles.length > 0) {
								new Notice(`Failed to clean up properties for ${failedFiles.length} notes. Check console.`);
								this.plugin.settings.enableFrontmatter = true;
								await this.plugin.saveSettings();
								toggle.setValue(true);
							}
							return;
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

		const MIN_NODE_DIMENSION = 50;
		const MAX_NODE_DIMENSION = 5000;

		new Setting(containerEl).setName('Default node size').setHeading();

		const sizeRow = (
			name: string,
			desc: string,
			key: 'defaultTextNodeWidth' | 'defaultTextNodeHeight' | 'defaultFileNodeWidth' | 'defaultFileNodeHeight',
		) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text
						.setValue(String(this.plugin.settings[key]))
						.onChange(async (raw) => {
							const n = Number.parseInt(raw, 10);
							if (!Number.isFinite(n)) return;
							if (n < MIN_NODE_DIMENSION || n > MAX_NODE_DIMENSION) return;
							this.plugin.settings[key] = n;
							await this.plugin.saveSettings();
							this.plugin.applyDefaultNodeSizeToAllOpenCanvases();
						})
				);
		};

		sizeRow('Text node width',  'Initial width (px) for new text cards. 50–5000.',  'defaultTextNodeWidth');
		sizeRow('Text node height', 'Initial height (px) for new text cards. 50–5000.', 'defaultTextNodeHeight');
		sizeRow('File node width',  'Initial width (px) for new file nodes. 50–5000.',  'defaultFileNodeWidth');
		sizeRow('File node height', 'Initial height (px) for new file nodes. 50–5000.', 'defaultFileNodeHeight');
	}
}
