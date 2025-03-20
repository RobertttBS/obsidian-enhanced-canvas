import {
	debounce,
	ItemView,
	Plugin,
	TFile
} from 'obsidian';
import { CanvasEdgeData, NodeSide, CanvasData } from "obsidian/canvas";
import { around } from "monkey-around";

export default class EnhancedCanvas extends Plugin {
	public patchedEdge: boolean; // flag to check if edge is patched
	private isMetadataClicked: boolean = false;

	addLinkAndOptimizeEdge(canvas: any, addNewEdges: boolean = true) {
		const selectedNodes = Array.from(canvas.selection);
		const fileNodes = selectedNodes.filter(node => node?.filePath);
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const currentData = canvas.getData();

		// create a map of existing edges for quick lookup
		const existingEdgesMap = new Map();
		currentData.edges.forEach(edge => {
			existingEdgesMap.set(`${edge.fromNode}->${edge.toNode}`, edge);
		});

		// map from file path to node
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
	
		if (newEdges.length > 0 && addNewEdges) {
			currentData.edges.push(...newEdges);
		}

		const selectedNodeIds = new Set(selectedNodes.map(node => node.id));
	
		// adjust the edge sides
		currentData.edges.forEach(edge => {
			if (selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode)) {
				const fromNode = currentData.nodes.find(node => node.id === edge.fromNode);
				const toNode = currentData.nodes.find(node => node.id === edge.toNode);
				if (fromNode && toNode) {
					const updatedEdge = this.createEdge(fromNode, toNode);
					if (edge.fromSide !== updatedEdge.fromSide || edge.toSide !== updatedEdge.toSide) {
						edge.fromSide = updatedEdge.fromSide;
						edge.toSide = updatedEdge.toSide;
					}
				}
			}
		});

		canvas.setData(currentData);
		canvas.requestSave();
	}

	deleteEdges(canvas: any) {
		const selectedNodes = Array.from(canvas.selection);
		const selectedNodeIds = new Set(selectedNodes.map(node => node.id));
		const currentData = canvas.getData();
	
		// Filter out edges that connect selected nodes
		currentData.edges = currentData.edges.filter(edge => {
			// Keep the edge if either endpoint is not in the selection
			return !(selectedNodeIds.has(edge.fromNode) && selectedNodeIds.has(edge.toNode));
		});
	
		canvas.setData(currentData);
		canvas.requestSave();
	}
	
	// add 'canvas' and canvas basename properties to the node frontmatter.
	addProperty(node: any, propertyName: string, basename: string) {
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

	// For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	removeProperty(node: any, propertyName: string, basename: string) {
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

	// For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	renameProperty(node: any, oldName: string, newName: string) {
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

	// For the command to remove all properties named after the current canvas file.
	removeAllProperty(canvas: any, canvasData: CanvasData) {
		const nodes = canvasData.nodes;
		nodes.forEach(node => {
			if (!node?.file) return;

			this.removeProperty(node, canvas.view.file.name,canvas.view.file.basename);
		});
		canvas.setData(canvasData);
		canvas.requestSave();
	}

	async processEdgeUpdate(e: any) {
        const fromNode = e?.from?.node;
        const toNode = e?.to?.node;

        if (!fromNode || !toNode) return;
        if (!fromNode?.filePath && !fromNode?.file) return;

        const fromFilePath = fromNode.filePath || fromNode.file;
        const toFilePath = toNode.filePath || toNode.file;

        const fromFile = this.app.vault.getFileByPath(fromFilePath);
        const toFile = this.app.vault.getFileByPath(toFilePath);

        if (!fromFile || !toFile) return;

        const canvasName = e.canvas.view.file.basename;

        let link = this.app.fileManager.generateMarkdownLink(toFile, fromFilePath).replace(/^!(\[\[.*\]\])$/, '$1');
        await this.updateFrontmatter(fromFile, link, 'add', canvasName);
    }

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
	
	// update the items in the "propertyName" array in the frontmatter of the file.
	updateFrontmatter = async (file: any, link: any, action: any, propertyName: string) => {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;
	
			if (!frontmatter.canvas) {
				frontmatter.canvas = [];
			}
	
			if (!frontmatter[propertyName]) {
				Reflect.set(frontmatter, propertyName, []);
			} else if (!Array.isArray(frontmatter[propertyName])) {
				Reflect.set(frontmatter, propertyName, [frontmatter[propertyName]]);
			}
	
			if (action === 'add' && !frontmatter[propertyName].includes(link)) {
				frontmatter[propertyName].push(link);
			} else if (action === 'remove') {
				frontmatter[propertyName] = frontmatter[propertyName].filter(l => l !== link);
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

	async onload() {
		this.registerCustomCommands();
		this.registerCanvasAutoLink();
		this.registerCanvasFileDeletion();
		this.registerFocusCanvas();

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
	}

	registerCanvasFileDeletion() {
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

	registerCustomCommands() {
		this.addCommand({
			id: 'optimize-edges',
			name: 'Adjust edges with shortest path',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.addLinkAndOptimizeEdge(canvas, false);
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
				this.addLinkAndOptimizeEdge(canvas);
			})
		});

		// With automatic property updates for dateFile and renameFile, this command is unnecessary.
		this.addCommand({
			id: 'remove-canvas-property',
			name: 'Remove the property of all nodes in current Canvas',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.removeAllProperty(canvas, canvasData);
			})
		});
	}

	registerFocusCanvas() {
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target.closest('.metadata-container')) {
				this.isMetadataClicked = true;
			
				setTimeout(() => {
					this.isMetadataClicked = false;
				}, 200);
			}
		});

		this.registerEvent( // Implement the feature to zoom to the last opened file when switching to the canvas view.
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
		
					// find the node with the same file path as the prevFile and zoom to it
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

			// find all nodes of the same source file
			const sameFileNodes = nodes.filter(node => node.file === fromNode.filePath);
			// find all edges that are connected to the same source file nodes
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
		
			// remove unrelated link
			fromNodeLinks.forEach(filePath => {
				if (!edgeToNodesFilePathSet.has(filePath)) {
					if (filePath === e.canvas.view.file.path) return;
					const targetFile = getFilePath(filePath);
					if (!targetFile) return;
		
					let link = this.app.fileManager.generateMarkdownLink(targetFile, filePath).replace(/^!(\[\[.*\]\])$/, '$1');
					updatePromises.push(this.updateFrontmatter(fromFile, link, 'remove', canvasName));
				}
			});
		
			// add related link in current canvas
			if (toNode?.filePath) {
				const targetFile = getFilePath(toNode.filePath);
				if (!targetFile) return;
		
				let link = this.app.fileManager.generateMarkdownLink(targetFile, toNode.filePath).replace(/^!(\[\[.*\]\])$/, '$1');
				updatePromises.push(this.updateFrontmatter(fromFile, link, 'add', canvasName));
			}

			await Promise.all(updatePromises);
		};

		const updateTargetNode = debounce(async (e: any) => {
			await processNodeUpdate(e);
		}, 500, true);

		const updateTargetNodeImmediate = async (e: any) => {
			await processNodeUpdate(e);
		};

		//  update original node when edge is removed
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
		
		const layoutChangeHandler = () => {
			if (patchCanvas()) {
				// when canvas patched successfully, remove the layout change listener
				plugin.app.workspace.off('active-leaf-change', layoutChangeHandler);
				plugin.app.workspace.off('layout-change', layoutChangeHandler);
			}
		};

		plugin.app.workspace.on('active-leaf-change', layoutChangeHandler);
		plugin.app.workspace.on('layout-change', layoutChangeHandler);
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

	async onunload() {
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
				} catch (error) { // Error occurred during plugin unload cleanup, possibly due to empty .canvas file
					return;
				}
			}));
		} catch (error) { // Error occurred during plugin unload cleanup, possibly due to empty .canvas file
			return;
		}
	}	
}
