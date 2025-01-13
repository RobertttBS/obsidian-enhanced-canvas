import {
	debounce,
	ItemView,
	Plugin,
} from 'obsidian';
import { CanvasEdgeData, NodeSide, CanvasData } from "obsidian/canvas";
import { around } from "monkey-around";

export default class EnhancedCanvas extends Plugin {
	public patchedEdge: boolean; // flag to check if edge is patched

	addLinkAndOptimizeEdge(canvas: any) {
		const selectedNodes = Array.from(canvas.selection);
		const fileNodes = selectedNodes.filter(node => node?.filePath);
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const allEdgesData: CanvasEdgeData[] = [];
		const currentData = canvas.getData();
	
		// get all existing edges
		const existingEdgesSet = new Set(currentData.edges.map(edge => `${edge.fromNode}->${edge.toNode}`));

		const filePathToNodeMap = new Map<string, any>();
		fileNodes.forEach(node => {
			if (node.filePath) {
				filePathToNodeMap.set(node.filePath, node);
			}
		});

		fileNodes.forEach(sourceNode => {
			const links = resolvedLinks[sourceNode.filePath];
			if (!links) return;
	
			const targetFilePaths = Object.keys(links).filter(targetPath => 
				filePathToNodeMap.has(targetPath) && filePathToNodeMap.get(targetPath) !== sourceNode
			);
	
			targetFilePaths.forEach(targetPath => {
				const targetNode = filePathToNodeMap.get(targetPath);
				const edgeKey = `${sourceNode.id}->${targetNode.id}`;
	
				if (!existingEdgesSet.has(edgeKey)) {
					const newEdge = this.createEdge(sourceNode, targetNode);
					allEdgesData.push(newEdge);
					existingEdgesSet.add(edgeKey);
				}
			});
		});
	
		currentData.edges.push(...allEdgesData);
	
		// adjust edge with shortest path
		const nodeIdMap = new Map(currentData.nodes.map(node => [node.id, node]));
		currentData.edges.forEach(edge => {
			const fromNode = nodeIdMap.get(edge.fromNode);
			const toNode = nodeIdMap.get(edge.toNode);
			if (fromNode && toNode) {
				const updatedEdge = this.createEdge(fromNode, toNode);
				if (edge.fromSide !== updatedEdge.fromSide || edge.toSide !== updatedEdge.toSide) {
					edge.fromSide = updatedEdge.fromSide;
					edge.toSide = updatedEdge.toSide;
				}
			}
		});
	
		canvas.setData(currentData);
		canvas.requestSave();
	}

	// For JSON nodes only, which are stored in the canvas file, not the canvas node in Obsidian.
	removeProperty(node: any, propertyName: string) {
		const file = this.app.vault.getFileByPath(node.file);
		if (!file) {
			console.error('file not found', node.file);
			return;
		}

		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;
	
			// remove the property
			if (frontmatter[propertyName]) {
				delete frontmatter[propertyName];
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
		console.log('renameProperty', oldName, newName);
		const file = this.app.vault.getFileByPath(node.file);
		if (!file) {
			console.error(`File not found: ${node.file}`);
			return;
		}
	
		const getBaseName = (name: string) => name.substring(name.lastIndexOf('/') + 1);

		const baseName = getBaseName(newName);
		const oldBaseName = getBaseName(oldName);
	
		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;

			if (frontmatter.canvas) {
				const oldCanvasLink = `[[${oldBaseName}]]`;
				const newCanvasLink = `[[${baseName}]]`;
				frontmatter.canvas = frontmatter.canvas
					.map((link: string) => link === oldCanvasLink ? newCanvasLink : link)
					.filter((link: string) => link);
			}

			if (frontmatter.hasOwnProperty(oldName)) {
				frontmatter[baseName] = frontmatter[oldName];
				delete frontmatter[oldName];
			}
			
			Object.keys(frontmatter).forEach(key => {
				if (key === baseName) {
					const value = frontmatter[key];
					if (Array.isArray(value)) {
						frontmatter[key] = value.map(item =>
							typeof item === 'string' ? item.replace(new RegExp(`\\[\\[${oldBaseName}\\]\\]`, 'g'), `[[${baseName}]]`) : item
						);
					} else if (typeof value === 'string') {
						frontmatter[key] = value.replace(new RegExp(`\\[\\[${oldBaseName}\\]\\]`, 'g'), `[[${baseName}]]`);
					}
				}
			});
		});
	}

	// For the command to remove all properties named after the current canvas file.
	removeAllProperty(canvas: any, canvasData: CanvasData) {
		const nodes = canvasData.nodes;
		nodes.forEach(node => {
			if (!node?.file) return;

			this.removeProperty(node, canvas.view.file.name);
		});
		canvas.setData(canvasData);
		canvas.requestSave();
	}

	// unused function, return the content without frontmatter.
	// getContentWithoutFrontmatter = async (file: any) => {
	// 	const content = await this.app.vault.read(file);
	// 	if (!content) return;

	// 	const fileCache = this.app.metadataCache.getFileCache(file);
	// 	if (!fileCache?.sections?.length) return content;

	// 	const firstSection = fileCache.sections[0];
	// 	if (firstSection.type !== "yaml") return content;

	// 	return content.substring(firstSection.position.end.offset + 1);
	// }

	// update the items in the "propertyName" array in the frontmatter of the file.
	updateFrontmatter = async (file: any, link: any, action: any, propertyName: string) => {
		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (!frontmatter) return;

			if (!frontmatter[propertyName]) {
				Reflect.set(frontmatter, propertyName, []);
			} else if (!Array.isArray(frontmatter[propertyName])) {
				Reflect.set(frontmatter, propertyName, [frontmatter[propertyName]]);
			}
	
			if (action === 'add' && !frontmatter[propertyName].includes(link)) {
				frontmatter[propertyName].push(link);
			} else if (action === 'remove') {
				frontmatter[propertyName] = frontmatter[propertyName].filter(l => l !== link);
				if (frontmatter[propertyName].length === 0) {
					delete frontmatter[propertyName];
				}
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
		console.log('Loading Enhanced Canvas');

		this.registerCustomCommands();
		this.registerCanvasAutoLink();
		this.registerCanvasFileDeletion();
	}

	registerCanvasFileDeletion() {
		const deleteCanvasFile = async (file: any) => {
			if (file.extension !== 'canvas') return;
			if (file.deleted === true) return;
			// @ts-ignore
			const content = await this.app.vault.read(file);
			const canvasData = JSON.parse(content);

			// @ts-ignore
			canvasData.nodes.forEach((node) => { // JSON nodes, not canvas nodes
				if (node.type !== 'file') return;

				this.removeProperty(node, file.name);
			});
		}

		const renameCanvasFile = async (file: any, newPath: string) => {
			if (file.extension !== 'canvas') return;
			if (file.deleted === true) return;
			// @ts-ignore
			const content = await this.app.vault.read(file);
			const canvasData = JSON.parse(content);
			// @ts-ignore
			canvasData.nodes.forEach((node) => {
				if (node.type !== 'file') return;
				this.renameProperty(node, file.name, newPath);
			});
		}

		around(this.app.fileManager.constructor.prototype, {
			trashFile: (next: any) => {
				return function (file: any) {
					deleteCanvasFile(file);
					const result = next.call(this, file);
					return result;
				};
			}
		});

		around(this.app.fileManager.constructor.prototype, {
			renameFile: (next: any) => {
				return function (file: any, newPath: string) {
					renameCanvasFile(file, newPath);
					const result = next.call(this, file, newPath);
					return result;
				};
			}
		});
	}

	registerCustomCommands() {
		this.addCommand({
			id: 'add-link-and-optimize-edge',
			name: 'Auto connect nodes and adjust edges with shortest path',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.addLinkAndOptimizeEdge(canvas);
			})
		});

		// With automatic property updates for dateFile and renameFile, this command is unnecessary.
		this.addCommand({
			id: 'remove-canvas-property',
			name: 'Remove the property of all nodes in current canvas',
			checkCallback: this.ifActiveViewIsCanvas((canvas, canvasData) => {
				this.removeAllProperty(canvas, canvasData);
			})
		});
	}

	registerCanvasAutoLink() {
		const processNodeUpdate = async (e: any) => {
			const fromNode = e?.from?.node;
			const toNode = e?.to?.node;

			if (!fromNode || !toNode) return;
			if (!fromNode?.filePath) return;
		
			const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
			if (!fromFile) return;

			const canvasName = e.canvas.view.file.name;
			const resolvedLinks = this.app.metadataCache.resolvedLinks[fromNode.filePath] || {};
			const fromNodeLinks = Object.keys(resolvedLinks);
		
			const { edges, nodes } = e.canvas.getData();
			const fromNodeEdges = edges.filter(edge => edge.fromNode === fromNode.id);
			const edgeToNodesFilePathSet = new Set(
				fromNodeEdges
					.map(edge => nodes.find(node => node.id === edge.toNode))
					.filter(node => node && node.file)
					.map(node => node.file)
			);
		
			// remove unrelated link
			fromNodeLinks.forEach(filePath => {
				if (!edgeToNodesFilePathSet.has(filePath)) {
					if (filePath === e.canvas.view.file.path) return;
					const targetFile = this.app.vault.getFileByPath(filePath);
					if (!targetFile) return;
		
					let link = this.app.fileManager.generateMarkdownLink(targetFile, filePath).replace(/^!(\[\[.*\]\])$/, '$1');
					this.updateFrontmatter(fromFile, link, 'remove', canvasName);
				}
			});
		
			// add related link
			if (toNode?.filePath) {
				const targetFile = this.app.vault.getFileByPath(toNode.filePath);
				if (!targetFile) return;
		
				let link = this.app.fileManager.generateMarkdownLink(targetFile, e.canvas.view.file.path).replace(/^!(\[\[.*\]\])$/, '$1');
				this.updateFrontmatter(fromFile, link, 'add', canvasName);
			}
		};

		const updateTargetNode = debounce(async (e: any) => {
			processNodeUpdate(e);
		}, 1000);

		const updateTargetNodeImmediate = async (e: any) => {
			processNodeUpdate(e);
		};

		//  update original node when edge is removed
		const updateOriginalNode = async (edge: any) => {
			if (!edge.to.node?.filePath || !edge.from.node?.filePath) return;

			const canvasName = edge.canvas.view.file.name;
			const toNode = edge.to.node;
			const fromNode = edge.from.node;

			const file = this.app.vault.getFileByPath(toNode.filePath);
			if (!file) return;

			let link = this.app.fileManager.generateMarkdownLink(file, edge.to.node.filePath);
			link = link.replace(/^!(\[\[.*\]\])$/, '$1'); // for image links

			if (fromNode?.filePath) {
				const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
				if (!fromFile) return;

				this.updateFrontmatter(fromFile, link, 'remove', canvasName);
			}
		};

		// remove the node frontmatter when the node is removed
		const removeNodeUpdate = async (node: any) => {
			if (node?.file?.extension !== 'md') return;

			const canvasFile = node?.canvas?.view?.file;
			if (!canvasFile || !canvasFile.name) return;
		
			const canvasName = canvasFile.name;

			if (node?.filePath) {				
				// remove the canvas file link from the property named 'canvas'
				let link = this.app.fileManager.generateMarkdownLink(canvasFile, canvasFile.path);
				link = link.replace(/^!(\[\[.*\]\])$/, '$1');
				this.updateFrontmatter(node.file, link, 'remove', 'canvas');

				// use the method for JSON node to remove the property named after the canvas file name.
				let tmpNode: { file?: string } = {};
				tmpNode.file = node.filePath;
				this.removeProperty(tmpNode, canvasName);
			}
		};

		// aims to add the canvas file link to the property named after the canvas file name.
		const addNodeUpdate = async (node: any) => {
			const resolvedNode = await node;
			const file = await resolvedNode?.file;
			if (!file) return;
			if (file.extension !== 'md') return;

			const canvasName = node.canvas.view.file.name;

			if (node.filePath) {
				const fromFile = this.app.vault.getFileByPath(node.filePath);
				if (!fromFile) return;

				let link = this.app.fileManager.generateMarkdownLink(node.canvas.view.file, node.canvas.view.file.path);
				link = link.replace(/^!(\[\[.*\]\])$/, '$1');

				this.updateFrontmatter(fromFile, link, 'add', 'canvas');
			}
		};

		const selfPatched = (edge: any) => {
			this.patchedEdge = true;

			around(edge.constructor.prototype, {
				update: (next: any) => {
					return function (...args: any[]) {
						const result = next.call(this, ...args);
						updateTargetNode(this);
						return result;
					};
				}
			});
		};

		const self = this;

		const patchCanvas = () => {
			const canvasView = this.app.workspace.getLeavesOfType('canvas')[0]?.view;
			if (!canvasView) return false;

			// @ts-ignore
			const canvas = canvasView.canvas;
			if (!canvas) return false;

			const edge = canvas.edges.values().next().value;
			if (edge) {
				this.patchedEdge = true;
				selfPatched(edge);
			}

			around(canvas.constructor.prototype, {
				removeNode: (next: any) => {
					return function (node: any) {
						const result = next.call(this, node);
						if (this.isClearing !== true) {
							removeNodeUpdate(node);
						}
						return result;
					};
				}
			});

			around(canvas.constructor.prototype, {
				addNode: (next: any) => {
					return function (node: any) {
						const result = next.call(this, node);
						addNodeUpdate(node);
						return result;
					};
				},
			});

			around(canvas.constructor.prototype, {
				removeEdge: (next: any) => {
					return function (edge: any) {
						const result = next.call(this, edge);
						if (this.isClearing !== true) {
							updateOriginalNode(edge);
						}
						return result;
					};
				}
			});

			around(canvas.constructor.prototype, {
				addEdge: (next: any) => {
					return function (edge: any) {
						const result = next.call(this, edge);
						if (!self.patchedEdge) {
							this.patchedEdge = true;
							selfPatched(edge);
						}
						updateTargetNodeImmediate(edge);
						return result;
					};
				},
			});

			around(canvas.constructor.prototype, {
				clear: (next: any) => {
					return function () {
						this.isClearing = true;
						const result = next.call(this);
						this.isClearing = false;
						return result;
					};
				},
			});
		};

		this.app.workspace.onLayoutReady(() => {
			if (!patchCanvas()) {
				const evt = this.app.workspace.on("layout-change", () => {
					if (patchCanvas()) {
						this.app.workspace.offref(evt);
					}
				});
				this.registerEvent(evt);
			}
		});
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

	onunload() {
	}
}