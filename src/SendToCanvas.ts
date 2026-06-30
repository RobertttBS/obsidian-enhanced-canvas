// src/SendToCanvas.ts

import {
    TFile,
    App,
    FuzzySuggestModal,
    MarkdownView,
    Notice,
} from "obsidian";

import EnhancedCanvas from '../main';
import { AllCanvasNodeData, CanvasData, CanvasView } from '../Canvas';
import { randomId } from './utils';

/**
 * Orchestrates the workflow for pushing active markdown context into Canvas workspaces, 
 * managing the lifecycle of target canvas selection and providing interface feedback 
 * to streamline the integration of textual notes into visual boards.
 */
export class SendToCanvas {
    plugin: EnhancedCanvas;

    constructor(plugin: EnhancedCanvas) {
        this.plugin = plugin;
    }

    selectedCanvas: TFile | null = null;
    statusBarItemEl: HTMLElement | null = null;

    handleSendToCanvas(): void {
        const currentFile = this.getCurrentMarkdownFile();

        if (!currentFile) {
            new Notice("Please open a Markdown file to send to the Canvas.");
            return;
        }
        
        this.promptCanvasSelectionAndInsert(currentFile);
    }

    handleSendToSelectedCanvas(): void {
        const currentFile = this.getCurrentMarkdownFile();

        if (!currentFile) {
            new Notice("Please open a Markdown file to send to the Canvas.");
            return;
        }

        if (this.selectedCanvas) {
            void this.addFileNodeToCanvas(currentFile, this.selectedCanvas);
            new Notice(`Using previously selected Canvas: ${this.selectedCanvas.name}`);
        } else {
            new Notice(`Failed to send. No Canvas file selected yet.`);
            this.promptCanvasSelectionAndInsert(currentFile);
        }
    }

    getCurrentMarkdownFile(): TFile | null {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.file.extension !== 'md') return null;
        return view.file;
    }

    promptCanvasSelectionAndInsert(targetFile: TFile) {
        const canvasFiles = this.getCanvasFiles();

        if (!canvasFiles.length) {
            new Notice("No Canvas files found in vault.");
            return;
        }

        const modal = new CanvasFileSuggestModal(
            this.plugin.app,
            canvasFiles,
            (canvasFile: TFile) => {    
                this.selectedCanvas = canvasFile;
                this.updateStatusBar();

                void this.addFileNodeToCanvas(targetFile, canvasFile);
            },
        );
        modal.open();
    }
    
    /**
     * Incorporates a file into a Canvas board as a visual node and establishes a bidirectional reference between the document and the workspace.
     *
     * @param targetFile - The file to be added to the visualization.
     * @param canvasFile - The target Canvas file.
     */
    async addFileNodeToCanvas(targetFile: TFile, canvasFile: TFile): Promise<void> {
        if (!canvasFile || !canvasFile.name) return;

        let canvasData: CanvasData;
        const canvasLeaves = this.plugin.app.workspace.getLeavesOfType('canvas');
        const openLeaf = canvasLeaves.find(leaf => (leaf.view as CanvasView).file?.path === canvasFile.path);
        const canvasView = openLeaf ? (openLeaf.view as CanvasView) : null;

        if (canvasView && canvasView.canvas) {
            canvasData = canvasView.canvas.getData();
        } else {
            const canvasContent = await this.plugin.app.vault.read(canvasFile);
            try {
                canvasData = JSON.parse(canvasContent || '{"nodes":[], "edges":[]}');
            } catch (e) {
                new Notice(`Error reading Canvas JSON for ${canvasFile.name}.`);
                console.error("Canvas JSON Parse Error:", e);
                return;
            }
        }

        if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
        if (!Array.isArray(canvasData.edges)) canvasData.edges = [];

        const existingNode = canvasData.nodes.find(node => node.type === 'file' && node.file === targetFile.path);
        if (existingNode) {
            new Notice(`${targetFile.basename} already exists in Canvas.`);
            return;
        }

        const newNode = this.createNodeAtBottom(targetFile, canvasData.nodes);
        canvasData.nodes.push(newNode);

        try {
            if (canvasView && canvasView.canvas) {
                canvasView.canvas.setData(canvasData);
                canvasView.canvas.requestSave();
            } else {
                const updatedContent = JSON.stringify(canvasData, null, 2);
                await this.plugin.app.vault.modify(canvasFile, updatedContent);
            }

            const internalLink = `[[${canvasFile.name}]]`;
            await this.plugin.updateFrontmatter(targetFile, internalLink, 'add', 'canvas');

            new Notice(`Added ${targetFile.basename} to Canvas: ${canvasFile.basename}`);
        } catch (e) {
            new Notice(`Failed to add to Canvas: ${canvasFile.name}`);
            console.error("Canvas Modify Error:", e);
        }
    }

    /**
     * Creates a new node for a file at the bottom of the canvas.
     *
     * @param file - The file to create a node for.
     * @param existingNodes - The existing nodes in the canvas.
     * @returns The new node.
     */
    createNodeAtBottom(file: TFile, existingNodes: AllCanvasNodeData[]): AllCanvasNodeData {
        const id = randomId();
        const WIDTH  = this.plugin.settings.defaultFileNodeWidth;
        const HEIGHT = this.plugin.settings.defaultFileNodeHeight;
        const GAP = 100;
        const DEFAULT_X = -200;

        let startY = -200;

        if (existingNodes.length > 0) {
            const maxY = existingNodes.reduce((max, node) => {
                const bottomEdge = node.y + node.height;
                return bottomEdge > max ? bottomEdge : max;
            }, -Infinity);
            
            if (maxY !== -Infinity) {
                startY = maxY + GAP;
            }
        }

        return {
            id: id,
            x: DEFAULT_X,
            y: startY,
            width: WIDTH,
            height: HEIGHT,
            type: "file",
            file: file.path,
        };
    }
    
    getCanvasFiles(): TFile[] {
        return this.plugin.app.vault.getFiles().filter((file) => file.extension === "canvas");
    }
    
    updateStatusBar(): void {
        const file = this.selectedCanvas;
        
        if (file) {
            if (!this.statusBarItemEl) {
                this.statusBarItemEl = this.plugin.addStatusBarItem();
                this.statusBarItemEl.addClass("scs-status-canvas");
                
                this.plugin.registerDomEvent(this.statusBarItemEl, 'click', this.handleStatusBarClick.bind(this));
            }
            
            this.statusBarItemEl.empty();
            this.statusBarItemEl.setText(`Selected Canvas: ${file.name}`);
            this.statusBarItemEl.title = `Click to clear selection: ${file.name}`;
            this.statusBarItemEl.addClass("is-active"); 
            
        } else {
            this.clearStatusBar();
        }
    }
    
    handleStatusBarClick(evt: MouseEvent): void {
        evt.preventDefault();
        this.clearSelectedCanvas();
    }
    
    clearSelectedCanvas(showNotice = true): void {
        if (this.selectedCanvas) {
            const fileName = this.selectedCanvas.name;
            this.selectedCanvas = null; 
            this.clearStatusBar(); 
            
            if (showNotice) {
                new Notice(`Cleared selected Canvas: ${fileName}`);
            }

        } else if (showNotice) {
            new Notice("No Canvas file is currently selected.");
        }
    }
    
    clearStatusBar(): void {
        if (this.statusBarItemEl) {
            this.statusBarItemEl.remove();
            this.statusBarItemEl = null; 
        }
    }
}

class CanvasFileSuggestModal extends FuzzySuggestModal<TFile> {
    files: TFile[];
    onSelect: (file: TFile) => void;

    constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onSelect = onSelect;
        this.setPlaceholder("Select a Canvas file...");
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(file);
        this.close();
    }
}
