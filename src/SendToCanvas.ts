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

// 為了更精確地使用類型，我們將 App 的屬性提取出來，便於在 Modal 等類中使用
type ObsidianApp = App & {
    metadataCache: MetadataCache;
    fileManager: FileManager;
    vault: Vault;
    workspace: Workspace;
};


// ====================================================================
// A. 主要插件類 (Main Plugin Class)
// ====================================================================

/**
 * 專門處理將當前 Markdown 檔案傳送到指定 Canvas 檔案的功能。
 * 包含 Canvas 檔案選擇、狀態列顯示以及 Frontmatter 更新的穩健邏輯。
 */
export class SendToCanvas {
    plugin: EnhancedCanvas;

    constructor(plugin: EnhancedCanvas) {
        this.plugin = plugin;
    }
    // 💡 為什麼: 使用 `| null` 是 TypeScript 的最佳實踐，明確指出該屬性可能為空。
    selectedCanvas: TFile | null = null;
    statusBarItemEl: HTMLElement | null = null;

    /**
     * 處理命令：檢查當前檔案，並啟動 Canvas 選擇流程。
     */
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
    /**
     * 輔助方法：獲取當前活動的 Markdown 檔案。
     */
    getCurrentMarkdownFile(): TFile | null {
        const leaf: WorkspaceLeaf | null = this.plugin.app.workspace.activeLeaf;

        if (!leaf || !(leaf.view.file instanceof TFile) || leaf.view.file.extension !== 'md') {
            return null;
        }
        
        return leaf.view.file;
    }

    /**
     * 彈出 Fuzzy Suggest Modal 讓用戶選擇 Canvas 檔案。
     * @param targetFile - 要被嵌入的 Markdown 檔案 (Source)
     */
    promptCanvasSelectionAndInsert(targetFile: TFile) {
        const canvasFiles = this.getCanvasFiles();

        if (!canvasFiles.length) {
            new Notice("No Canvas files found in vault.");
            return;
        }

        const modal = new CanvasFileSuggestModal(
            this.plugin.app as ObsidianApp, // 類型斷言以符合 Modal 的類型
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
     * 核心：修改 Canvas 檔案的 JSON，加入新的 File Node，並更新來源 Frontmatter。
     * @param targetFile - 要被嵌入的 Markdown 檔案 (Source)
     * @param canvasFile - 要修改的 Canvas 檔案 (Target)
     */
    async addFileNodeToCanvas(targetFile: TFile, canvasFile: TFile): Promise<void> {
        // 1. 非同步讀取 Canvas JSON 內容
        // 💡 為什麼: 檔案 I/O 操作必然是 async 的。
        const canvasContent = await this.plugin.app.vault.read(canvasFile);
        
        let canvasData: { nodes: any[], edges: any[] };
        try {
            canvasData = JSON.parse(canvasContent || "{}"); 
        } catch (e) {
            new Notice(`Error reading Canvas JSON for ${canvasFile.name}.`);
            console.error("Canvas JSON Parse Error:", e);
            return;
        }

        // 2. 健壯性檢查與初始化 (確保陣列存在)
        if (!Array.isArray(canvasData.nodes)) {
            canvasData.nodes = [];
        }
        if (!Array.isArray(canvasData.edges)) {
            canvasData.edges = [];
        }
        
        // 3. 創建並增加新節點
        const newNode = this.createCanvasFileNode(targetFile, canvasData.nodes.length);
        canvasData.nodes.push(newNode);
        
        // 4. 非同步寫回 Vault
        const updatedContent = JSON.stringify(canvasData, null, 2); 

        try {
            // 💡 為什麼: 寫入操作也是 async 的。
            await this.plugin.app.vault.modify(canvasFile, updatedContent);
            
            // 5. 更新來源檔案的 Frontmatter
            const internalLink = `[[${canvasFile.path}]]`;
            await this.updateFrontmatter(targetFile, internalLink, 'add', 'canvas');
            
            new Notice(`Successfully sent ${targetFile.name} to Canvas: ${canvasFile.name}`);            
            
        } catch (e) {
            new Notice(`Failed to send ${targetFile.name} to Canvas: ${canvasFile.name}`);            
            console.error("Canvas Modify Error:", e);
        }
    }
    
    /**
     * 處理 Markdown 檔案的 Frontmatter：新增或移除 Canvas 檔案的內部連結。
     */
    /**
     * @description 原子性地更新文件 Frontmatter 中的屬性，確保值是唯一的連結陣列。
     * @param file - 要修改的 TFile 物件。
     * @param link - 要新增或移除的標準化內部連結字串 (例如 "My Note")。
     * @param action - 'add' (新增) 或 'remove' (移除)。
     * @param propertyName - 要修改的 Frontmatter 屬性名稱 (例如 "My Canvas")。
     */
    updateFrontmatter = async (file: TFile, link: string, action: 'add' | 'remove', propertyName: string) => {
        await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
            
            // 1. 在原子操作範圍內，讀取當前 Frontmatter 值並標準化為 Set
            const existingValue = Reflect.get(fm, propertyName);
            let currentSet = new Set<string>();

            // 標準化：無論是單一字串或陣列，都將其轉換為 Set
            if (Array.isArray(existingValue)) {
                // 將陣列中的所有非空字串元素加入 Set
                existingValue.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
                             .forEach(item => currentSet.add(item));
            } else if (typeof existingValue === 'string' && existingValue.trim() !== '') {
                currentSet.add(existingValue);
            }
            
            // 2. 執行去重檢查和修改
            if (action === 'add') {
                // Set 的特性保證了新增操作的自動去重。
                currentSet.add(link);
            } else if (action === 'remove') {
                currentSet.delete(link);
            }

            // 3. 將最終結果轉換為陣列並設置回 Frontmatter
            const finalArray = Array.from(currentSet);

            if (finalArray.length > 0) {
                // 為了保持 Frontmatter 的一致性，我們應寫回一個陣列。
                // 即使只有一個元素，寫入陣列也比單一字串更易於處理。
                Reflect.set(fm, propertyName, finalArray);
            } else {
                // 如果陣列為空，則移除該屬性，保持 Frontmatter 清潔。
                Reflect.deleteProperty(fm, propertyName);
            }
        }); 
    };

    /**
     * 私有輔助方法：生成一個新的 Canvas File Node JSON 結構。
     */
    createCanvasFileNode(file: TFile, index: number): any {
        const id = this.randomId();
        
        const PADDING = 50;
        const WIDTH = 600;
        const HEIGHT = 500;
        
        // 簡單的網格定位邏輯
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

    /**
     * 產生一個夠長的隨機 ID。
     */
    randomId(length: number = 16): string {
        const byteLength = Math.ceil(length / 2);
        const array = new Uint8Array(byteLength);
        
        // 💡 為什麼: 使用 window.crypto.getRandomValues 確保 ID 具有密碼學上的隨機性，
        // 這對於 Canvas 節點 ID 來說是必要的，以避免碰撞。
        window.crypto.getRandomValues(array);
        
        return Array.from(array, (byte) => 
            byte.toString(16).padStart(2, '0')
        ).join('').substring(0, length);
    }
    
    /**
     * 輔助方法：從 Vault 中篩選出所有 Canvas 檔案 (TFile)。
     */
    getCanvasFiles(): TFile[] {
        // 💡 為什麼: app.vault.getFiles() 返回的是一個快照，用於快速獲取所有檔案。
        return this.plugin.app.vault.getFiles().filter((file) => file.extension === "canvas");
    }
    
    /**
     * 負責建立、更新或清除狀態列的顯示。
     */
    updateStatusBar(): void {
        const file = this.selectedCanvas;
        
        if (file) {
            // 1. 如果元素還不存在，就建立它
            if (!this.statusBarItemEl) {
                this.statusBarItemEl = this.plugin.addStatusBarItem();
                this.statusBarItemEl.addClass("scs-status-canvas"); // 確保有一個基礎類
                
                // 2. 在元素第一次被建立時，使用 registerDomEvent 綁定點擊事件。
                // 💡 為什麼: 這樣能確保事件監聽器在插件卸載時被 Obsidian 自動清理，
                // 避免記憶體洩漏。我們只綁定一次。
                this.plugin.registerDomEvent(this.statusBarItemEl, 'click', this.handleStatusBarClick.bind(this));
            }
            
            // 3. 更新內容
            this.statusBarItemEl.empty();
            this.statusBarItemEl.setText(`Selected Canvas: ${file.name}`);
            this.statusBarItemEl.title = `Click to clear selection: ${file.name}`; // 增加 tooltip
            this.statusBarItemEl.addClass("is-active"); 
            
        } else {
            this.clearStatusBar();
        }
    }
    
    /**
     * 處理狀態列被點擊的事件，執行清除邏輯。
     */
    handleStatusBarClick(evt: MouseEvent): void {
        evt.preventDefault();
        this.clearSelectedCanvas();
    }
    
    /**
     * 清除選定的 Canvas 狀態並更新狀態列。
     */
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
    
    /**
     * 私有輔助方法：清除狀態列元素。
     */
    clearStatusBar(): void {
        if (this.statusBarItemEl) {
            // 💡 為什麼: 移除 DOM 元素是確保狀態列消失的唯一方法。
            // 由於我們在 `updateStatusBar` 中使用 `this.registerDomEvent`，
            // 即使元素被移除，插件也會追蹤這個事件直到 `onunload`，但這對於 DOM 元素本身
            // 的清理是足夠的。
            this.statusBarItemEl.remove();
            
            // 💡 為什麼: 設置為 null 以便在下次需要時可以重建元素。
            this.statusBarItemEl = null; 
        }
    }
}


// ====================================================================
// B. Modal 類
// ====================================================================

/**
 * 繼承自 FuzzySuggestModal，專用於選擇 Canvas TFile 實例。
 */
class CanvasFileSuggestModal extends FuzzySuggestModal<TFile> {
    files: TFile[];
    onSelect: (file: TFile) => void;

    // 💡 為什麼: 這裡的 app 類型使用我們定義的 ObsidianApp，確保 app 上的屬性是完整的。
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
        return file.path; // 顯示完整路徑會更有幫助
    }

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(file);
        this.close();
    }
}
