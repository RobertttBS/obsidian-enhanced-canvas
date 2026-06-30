import { App, Modal, TextComponent, ButtonComponent, TFile, Notice } from "obsidian";
import EnhancedCanvas from "../main";
import { parseTagQuery, matchesTagQuery } from "./utils";
import { Canvas, CanvasNode } from "../Canvas";

const NODE_GAP = 20;

export class AdvancedTagSuggestModal extends Modal {
    private plugin: EnhancedCanvas;
    private canvas: Canvas;
    private position: { x: number, y: number };
    private inputComponent: TextComponent;
    private suggestionContainer: HTMLDivElement;
    private suggestions: string[] = [];
    private selectedIndex = -1;
    private allTags: string[] = [];

    constructor(app: App, plugin: EnhancedCanvas, canvas: Canvas, position: { x: number, y: number }) {
        super(app);
        this.plugin = plugin;
        this.canvas = canvas;
        this.position = position;
        this.allTags = this.getTags();
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText("Add notes by tag (Advanced)");

        contentEl.createEl("p", {
            text: "Use space for AND, 'OR' for OR, and '-' for NOT. Example: #tag1 #tag2 -#tag3",
            cls: "setting-item-description"
        });

        const inputContainer = contentEl.createDiv({ cls: "advanced-tag-input-container" });

        this.inputComponent = new TextComponent(inputContainer);
        this.inputComponent.setPlaceholder("Enter tag query...");
        
        this.inputComponent.onChange(() => {
            this.updateSuggestions();
        });

        this.inputComponent.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                this.navigateSuggestions(1);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                this.navigateSuggestions(-1);
            } else if (e.key === "Enter") {
                if (this.selectedIndex !== -1 && this.suggestions.length > 0) {
                    e.preventDefault();
                    this.selectSuggestion(this.suggestions[this.selectedIndex]);
                } else {
                    this.executeImport();
                }
            } else if (e.key === "Escape") {
                // Two-tier Escape behavior:
                // 1. First Escape clears suggestions if they are visible.
                // 2. Second Escape (or Escape when no suggestions) closes the modal (handled by Obsidian).
                if (this.suggestions.length > 0) {
                    e.preventDefault();
                    this.clearSuggestions();
                }
            }
        });

        new ButtonComponent(inputContainer)
            .setButtonText("Import")
            .setCta()
            .onClick(() => {
                this.executeImport();
            });

        this.suggestionContainer = contentEl.createDiv({ cls: "advanced-tag-suggestions" });
        
        this.inputComponent.inputEl.focus();
    }

    /**
     * Retrieves all tags from the metadata cache.
     * Note: getTags() can be stale-on-open if the cache hasn't updated recently,
     * but it's the most efficient way to get a list of all existing tags.
     */
    private getTags(): string[] {
        const tagsMap = this.app.metadataCache.getTags();
        const tags = new Set<string>();

        for (const tag of Object.keys(tagsMap)) {
            tags.add(tag);
            this.addParentTags(tag, tags);
        }

        return Array.from(tags).sort((a, b) => a.localeCompare(b));
    }

    private addParentTags(tag: string, tags: Set<string>): void {
        const parts = tag.split("/");
        if (parts.length <= 1) return;

        for (let depth = 1; depth < parts.length; depth++) {
            tags.add(parts.slice(0, depth).join("/"));
        }
    }

    private updateSuggestions() {
        const value = this.inputComponent.getValue();
        const cursorPosition = this.inputComponent.inputEl.selectionStart || 0;
        
        // Find the word under the cursor, supporting non-ASCII characters.
        // Matches an optional leading - or # followed by non-whitespace/separator characters.
        const beforeCursor = value.substring(0, cursorPosition);
        const lastWordMatch = beforeCursor.match(/([-#]?)[^\s#|]*$/);
        
        if (!lastWordMatch || lastWordMatch[0].length === 0) {
            this.clearSuggestions();
            return;
        }

        const lastWord = lastWordMatch[0];
        let query = lastWord;
        if (query.startsWith("-")) query = query.substring(1);
        if (query.startsWith("#")) query = query.substring(1);

        if (query.length === 0) {
            this.clearSuggestions();
            return;
        }

        this.suggestions = this.allTags
            .filter(tag => tag.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10);

        this.renderSuggestions();
    }

    private renderSuggestions() {
        this.suggestionContainer.empty();
        this.selectedIndex = -1;

        if (this.suggestions.length === 0) {
            this.suggestionContainer.removeClass("is-visible");
            return;
        }

        this.suggestionContainer.addClass("is-visible");
        this.suggestions.forEach((suggestion, index) => {
            const div = this.suggestionContainer.createDiv({
                text: suggestion,
                cls: "suggestion-item"
            });

            div.addEventListener("click", () => {
                this.selectSuggestion(suggestion);
            });

            div.addEventListener("mouseenter", () => {
                this.setHighlight(index);
            });
        });

        // Automatically highlight the first suggestion
        this.setHighlight(0);
    }

    private setHighlight(index: number) {
        const items = this.suggestionContainer.querySelectorAll(".suggestion-item");
        items.forEach((item, i) => {
            if (i === index) {
                item.addClass("is-selected");
            } else {
                item.removeClass("is-selected");
            }
        });
        this.selectedIndex = index;
    }

    private navigateSuggestions(direction: number) {
        if (this.suggestions.length === 0) return;

        let newIndex = this.selectedIndex + direction;
        if (newIndex < 0) newIndex = this.suggestions.length - 1;
        if (newIndex >= this.suggestions.length) newIndex = 0;

        this.setHighlight(newIndex);
        
        const highlightedItem = this.suggestionContainer.querySelectorAll(".suggestion-item")[newIndex] as HTMLElement;
        if (highlightedItem) {
            highlightedItem.scrollIntoView({ block: "nearest" });
        }
    }

    private selectSuggestion(suggestion: string) {
        const value = this.inputComponent.getValue();
        const cursorPosition = this.inputComponent.inputEl.selectionStart || 0;
        
        const beforeCursor = value.substring(0, cursorPosition);
        const afterCursor = value.substring(cursorPosition);
        
        const lastWordMatch = beforeCursor.match(/([-#]?)[^\s#|]*$/);
        if (lastWordMatch) {
            const prefix = lastWordMatch[1]; 
            const startOfWord = cursorPosition - lastWordMatch[0].length;
            
            let newPrefix = prefix;
            if (!newPrefix) {
                newPrefix = "#";
            } else if (newPrefix === "-") {
                newPrefix = "-#";
            }

            let cleanSuggestion = suggestion;
            if (cleanSuggestion.startsWith("#")) {
                cleanSuggestion = cleanSuggestion.substring(1);
            }

            const newValue = value.substring(0, startOfWord) + newPrefix + cleanSuggestion + afterCursor;
            
            this.inputComponent.setValue(newValue);
            this.inputComponent.inputEl.focus();
            const newCursorPos = startOfWord + newPrefix.length + cleanSuggestion.length;
            this.inputComponent.inputEl.setSelectionRange(newCursorPos, newCursorPos);
        }

        this.clearSuggestions();
    }

    private clearSuggestions() {
        this.suggestionContainer.empty();
        this.suggestionContainer.removeClass("is-visible");
        this.suggestions = [];
        this.selectedIndex = -1;
    }

    private executeImport() {
        const queryStr = this.inputComponent.getValue();
        if (!queryStr.trim()) return;

        const query = parseTagQuery(queryStr);
        
        // Provide feedback if the query resulted in no valid groups (e.g., only exclude tags or nonsense tags)
        if (query.length === 0) {
            new Notice("Invalid query. Ensure you have at least one inclusion tag (e.g., #tag).");
            return;
        }

        const matchingFiles = this.app.vault.getMarkdownFiles()
            .filter(file => matchesTagQuery(file, query, this.app.metadataCache))
            .sort((a, b) => a.path.localeCompare(b.path));

        if (matchingFiles.length === 0) {
            new Notice(`No files found matching the query: ${queryStr}`);
            return;
        }

        this.addFilesToCanvas(matchingFiles);
        this.close();
    }

    private addFilesToCanvas(files: TFile[]) {
        const width = this.plugin.settings.defaultFileNodeWidth;
        const height = this.plugin.settings.defaultFileNodeHeight;

        const columns = Math.ceil(Math.sqrt(files.length));
        const createdNodes: CanvasNode[] = [];

        files.forEach((file, index) => {
            const x = this.position.x + (index % columns) * (width + NODE_GAP);
            const y = this.position.y + Math.floor(index / columns) * (height + NODE_GAP);

            try {
                const node = this.canvas.createFileNode({
                    file,
                    pos: { x, y },
                    size: { width, height },
                    save: false,
                    focus: false
                });

                if (node) {
                    createdNodes.push(node);
                }
            } catch (error) {
                console.error(`Enhanced Canvas: failed to create Canvas node for ${file.path}`, error);
            }
        });

        if (createdNodes.length === 0) {
            new Notice(`Failed to add notes to Canvas.`);
            return;
        }

        this.selectNodes(createdNodes);
        this.canvas.requestSave();

        new Notice(`Added ${createdNodes.length} node${createdNodes.length === 1 ? "" : "s"}.`);
    }

    private selectNodes(nodes: CanvasNode[]): void {
        this.canvas.deselectAll();

        for (const node of nodes) {
            this.canvas.selection.add(node);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
