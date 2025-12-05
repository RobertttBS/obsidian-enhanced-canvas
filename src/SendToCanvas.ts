// src/SendToCanvas.ts

import {
    Plugin,
    TFile,
    App,
    FuzzySuggestModal,
    Notice,
    WorkspaceLeaf,
    MetadataCache,
    FileManager,
    Vault,
    Workspace,
} from "obsidian";

import EnhancedCanvas from '../main'; 

type ObsidianApp = App & {
    metadataCache: MetadataCache;
    fileManager: FileManager;
    vault: Vault;
    workspace: Workspace;
};

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
            this.addFileNodeToCanvas(currentFile, this.selectedCanvas);
            new Notice(`Using previously selected Canvas: ${this.selectedCanvas.name}`);
        } else {
            new Notice(`Failed to send. No Canvas file selected yet.`);
            this.promptCanvasSelectionAndInsert(currentFile);
        }
    }

    getCurrentMarkdownFile(): TFile | null {
        const leaf: WorkspaceLeaf | null = this.plugin.app.workspace.activeLeaf;

        if (!leaf || !(leaf.view.file instanceof TFile) || leaf.view.file.extension !== 'md') {
            return null;
        }
        
        return leaf.view.file;
    }

    promptCanvasSelectionAndInsert(targetFile: TFile) {
        const canvasFiles = this.getCanvasFiles();

        if (!canvasFiles.length) {
            new Notice("No Canvas files found in vault.");
            return;
        }

        const modal = new CanvasFileSuggestModal(
            this.plugin.app as ObsidianApp,
            canvasFiles,
            (canvasFile: TFile) => {    
                this.selectedCanvas = canvasFile;
                this.updateStatusBar();

                this.addFileNodeToCanvas(targetFile, canvasFile);
            },
        );
        modal.open();
    }
    
    /**
     * Integrates a target file into a specified canvas workspace and updates the file's metadata to establish a persistent link to the canvas.
     */
    async addFileNodeToCanvas(targetFile: TFile, canvasFile: TFile): Promise<void> {
        if(!canvasFile||!canvasFile.name) return;
        const canvasContent = await this.plugin.app.vault.read(canvasFile);
        
        let canvasData: { nodes: any[], edges: any[] };
        try {
            canvasData = JSON.parse(canvasContent || "{}"); 
        } catch (e) {
            new Notice(`Error reading Canvas JSON for ${canvasFile.name}.`);
            console.error("Canvas JSON Parse Error:", e);
            return;
        }

        if (!Array.isArray(canvasData.nodes)) {
            canvasData.nodes = [];
        }
        if (!Array.isArray(canvasData.edges)) {
            canvasData.edges = [];
        }
        
        const newNode = this.createCanvasFileNode(targetFile, canvasData.nodes.length);
        canvasData.nodes.push(newNode);
        
        const updatedContent = JSON.stringify(canvasData, null, 2); 

        try {
            await this.plugin.app.vault.modify(canvasFile, updatedContent);
            
            const internalLink = `[[${canvasFile.name}]]`;
            await this.plugin.updateFrontmatter(targetFile, internalLink, 'add', 'canvas');
            
            new Notice(`Successfully sent ${targetFile.name} to Canvas: ${canvasFile.name}`);            
            
        } catch (e) {
            new Notice(`Failed to send ${targetFile.name} to Canvas: ${canvasFile.name}`);            
            console.error("Canvas Modify Error:", e);
        }
    }
    
    createCanvasFileNode(file: TFile, index: number): any {
        const id = this.randomId();
        
        const PADDING = 50;
        const WIDTH = 600;
        const HEIGHT = 500;
        
        const xPos = PADDING + (index % 5) * (WIDTH + PADDING);
        const yPos = PADDING + Math.floor(index / 5) * (HEIGHT + PADDING);
        
        return {
            id: id,
            x: xPos,
            y: yPos,
            width: WIDTH,
            height: HEIGHT,
            type: "file",
            file: file.path,
        };
    }

    randomId(length: number = 16): string {
        const byteLength = Math.ceil(length / 2);
        const array = new Uint8Array(byteLength);
        
        window.crypto.getRandomValues(array);
        
        return Array.from(array, (byte) => 
            byte.toString(16).padStart(2, '0')
        ).join('').substring(0, length);
    }
    
    getCanvasFiles(): TFile[] {
        return this.plugin.app.vault.getFiles().filter((file) => file.extension === "canvas");
    }
    
    updateStatusBar(): void {
        const file = this.selectedCanvas;
        
        if (file) {
            if (!this.statusBarItemEl) {
                this.statusBarItemEl = this.plugin.addStatusBarItem();
                this.statusBarItemEl.addClass("scs-status-canvas"); // 確保有一個基礎類
                
                this.plugin.registerDomEvent(this.statusBarItemEl, 'click', this.handleStatusBarClick.bind(this));
            }
            
            this.statusBarItemEl.empty();
            this.statusBarItemEl.setText(`Selected Canvas: ${file.name}`);
            this.statusBarItemEl.title = `Click to clear selection: ${file.name}`; // 增加 tooltip
            this.statusBarItemEl.addClass("is-active"); 
            
        } else {
            this.clearStatusBar();
        }
    }
    
    handleStatusBarClick(evt: MouseEvent): void {
        evt.preventDefault();
        this.clearSelectedCanvas();
    }
    
    clearSelectedCanvas(showNotice: boolean = true): void {
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

    constructor(app: ObsidianApp, files: TFile[], onSelect: (file: TFile) => void) {
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

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(file);
        this.close();
    }
}
