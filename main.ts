import {
	debounce,
	ItemView,
	Plugin,
} from 'obsidian';
import { CanvasEdgeData, NodeSide } from "obsidian/canvas";
import { around } from "monkey-around";

export default class LinkNodesInCanvas extends Plugin {
	public patchedEdge: boolean; // flag to check if edge is patched

	async onload() {
		console.log('Loading Enhanced Canvas');
		this.registerCustomCommands();
		this.registerCanvasAutoLink();
	}

	registerCustomCommands() {
		this.addCommand({
			id: 'enhanced-canvas',
			name: 'Auto connect nodes and adjust edge with shortest path',
			checkCallback: (checking: boolean) => {
				const canvasView = this.app.workspace.getActiveViewOfType(ItemView);
				if (canvasView?.getViewType() === "canvas") {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						// @ts-ignore
						const canvas = canvasView.canvas;
						const selection = canvas.selection;
						const currentData = canvas.getData();
						// @ts-ignore
						const selectedNodes = Array.from(selection);

						// @ts-ignore
						const fileNodes = Array.from(selection).filter((node) => node?.filePath !== undefined && node?.filePath !== null); ;

						const resolvedLinks = this.app.metadataCache.resolvedLinks;
						const allEdgesData: CanvasEdgeData[] = [];
						fileNodes.forEach((node) => {
							// @ts-ignore
							if (!node.filePath || !resolvedLinks[node.filePath]) {
								return;
							}
							// @ts-ignore
							const allLinks = (Object.keys(resolvedLinks[node.filePath]) as Array<string>);
							for (let i = 0; i < fileNodes.length; i++) {
								// @ts-ignore
								if (allLinks.includes(fileNodes[i].filePath)) { 
									if (node !== fileNodes[i]) { // fileNodes[i] is linked to node
										const newEdge = this.createEdge(node, fileNodes[i]);

										// find if the edge already exists
										const existingEdgeIndex = currentData.edges.findIndex((edge: CanvasEdgeData) => 
											edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
										);

										if (existingEdgeIndex === -1) {
											allEdgesData.push(newEdge);
										}
									}
								}
							}
						});

						currentData.edges = [
							...currentData.edges,
							...allEdgesData,
						];

						const currentEdges = currentData.edges;
						currentEdges.forEach((edge: CanvasEdgeData) => {
							if (edge.fromNode && edge.toNode) {
								const fromNode = currentData.nodes.find((node: any) => node.id === edge.fromNode);
								const toNode = currentData.nodes.find((node: any) => node.id === edge.toNode);

								const newEdge = this.createEdge(fromNode, toNode);

								// find if the edge already exists
								if (edge.fromSide !== newEdge.fromSide || edge.toSide !== newEdge.toSide) {
									edge.fromSide = newEdge.fromSide;
									edge.toSide = newEdge.toSide;
								}
							}
						});

						canvas.setData(currentData);
						canvas.requestSave();
					}
					return true;
				}
			}
		});
	}

	registerCanvasAutoLink() {
		const updateFrontmatterRelated = (file: any, link: any, action: any) => {
			this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (!frontmatter) return;
		
				if (!frontmatter.related) {
					frontmatter.related = [];
				} else if (!Array.isArray(frontmatter.related)) {
					frontmatter.related = [frontmatter.related];
				}
		
				if (action === 'add' && !frontmatter.related.includes(link)) {
					frontmatter.related.push(link);
				} else if (action === 'remove') {
					frontmatter.related = frontmatter.related.filter(l => l !== link);
					if (frontmatter.related.length === 0) {
						delete frontmatter.related;
					}
				}
			});
		};

		const updateTargetNode = debounce(async (e: any) => {
			const fromNode = e.from.node;
			const toNode = e.to.node;
		
			if (!fromNode?.filePath && !Object.hasOwn(fromNode, 'text')) return;
		
			const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
			if (!fromFile) return;
		
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
		
			// 移除不相關的連結
			fromNodeLinks.forEach(filePath => {
				if (!edgeToNodesFilePathSet.has(filePath)) {
					const targetFile = this.app.vault.getFileByPath(filePath);
					if (!targetFile) return;
		
					let link = this.app.fileManager.generateMarkdownLink(targetFile, filePath).replace(/^!(\[\[.*\]\])$/, '$1');
					updateFrontmatterRelated(fromFile, link, 'remove');
				}
			});
		
			// 添加新的相關連結
			if (toNode?.filePath) {
				const targetFile = this.app.vault.getFileByPath(toNode.filePath);
				if (!targetFile) return;
		
				let link = this.app.fileManager.generateMarkdownLink(targetFile, e.canvas.view.file.path).replace(/^!(\[\[.*\]\])$/, '$1');
				updateFrontmatterRelated(fromFile, link, 'add');
			}
		}, 1000);

		const updateOriginalNode = async (edge: any) => {
			if (!edge.to.node.filePath) return;
			if (!edge.from.node?.filePath && !Object.hasOwn(edge.from.node, 'text')) return;

			const toNode = edge.to.node;
			const fromNode = edge.from.node;

			const file = this.app.vault.getFileByPath(toNode.filePath);
			if (!file) return;

			let link = this.app.fileManager.generateMarkdownLink(file, edge.to.node.filePath);
			link = link.replace(/^!(\[\[.*\]\])$/, '$1'); // for image links

			if (fromNode?.filePath) {
				const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
				if (!fromFile) return;

				this.app.fileManager.processFrontMatter(fromFile, (frontmatter) => {
					if (!frontmatter || !frontmatter.related) return;
			
					if (!Array.isArray(frontmatter.related)) {
						frontmatter.related = [frontmatter.related];
					}
			
					frontmatter.related = frontmatter.related.filter(l => l !== link);
			
					if (frontmatter.related.length === 0) {
						delete frontmatter.related;
					}
				});
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

			console.log('patch edge success');
		};

		const self = this;

		const patchCanvas = () => {
			const canvasView = this.app.workspace.getLeavesOfType('canvas')[0]?.view;
			if (!canvasView) return false;

			// @ts-ignore
			const canvas = canvasView.canvas;
			if (!canvas) return false;

			const edge = canvas.edges.values().next().value;
			if (edge) { // if edge exists, patch it.
				this.patchedEdge = true;
				selfPatched(edge);
			}

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
							selfPatched(edge);
						}
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

			console.log('patch canvas success');
		};

		this.app.workspace.onLayoutReady(() => {
			if (!patchCanvas()) {
				const evt = this.app.workspace.on("layout-change", () => {
					patchCanvas() && this.app.workspace.offref(evt);
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

		// compute angle between two nodes
		const angle = Math.atan2(node2.y - node1.y, node2.x - node1.x) * 180 / Math.PI;
    
		// normalize angle to 0-360
		const normalizedAngle = angle < 0 ? angle + 360 : angle;
		
		// determine the side of the node to connect
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