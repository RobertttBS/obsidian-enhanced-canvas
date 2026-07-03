import { App, Modal, TextComponent, ButtonComponent, TFile, Notice, AbstractInputSuggest } from "obsidian";
import EnhancedCanvas from "../main";
import { parseTagQuery, matchesTagQuery } from "./utils";
import { Canvas, CanvasNode } from "../Canvas";

const NODE_GAP = 20;

// Matches the (optionally -/# prefixed) word ending at the cursor, supporting
// non-ASCII characters.
const WORD_AT_CURSOR = /([-#]?)([^\s#|]*)$/;

/**
 * Completes the tag under the cursor (not the whole input), so multi-term
 * queries like "#a -#b" get suggestions for each term.
 */
class TagSuggest extends AbstractInputSuggest<string> {
    isOpen = false;

    constructor(app: App, private inputEl: HTMLInputElement, private allTags: string[]) {
        super(app, inputEl);
        this.limit = 10;
    }

    open() { super.open(); this.isOpen = true; }
    close() { super.close(); this.isOpen = false; }

    protected getSuggestions(value: string): string[] {
        const cursor = this.inputEl.selectionStart ?? value.length;
        const query = (value.substring(0, cursor).match(WORD_AT_CURSOR)?.[2] ?? "").toLowerCase();
        if (!query) return [];
        return this.allTags.filter(tag => tag.toLowerCase().includes(query));
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(tag);
    }

    selectSuggestion(tag: string): void {
        const value = this.inputEl.value;
        const cursor = this.inputEl.selectionStart ?? value.length;
        const match = value.substring(0, cursor).match(WORD_AT_CURSOR);
        if (match) {
            const start = cursor - match[0].length;
            const inserted = (match[1] === "-" ? "-#" : "#") + tag.replace(/^#/, "");
            this.setValue(value.substring(0, start) + inserted + value.substring(cursor));
            const pos = start + inserted.length;
            this.inputEl.setSelectionRange(pos, pos);
        }
        this.close();
    }
}

export class AdvancedTagSuggestModal extends Modal {
    private plugin: EnhancedCanvas;
    private canvas: Canvas;
    private position: { x: number, y: number };
    private inputComponent: TextComponent;
    private tagSuggest: TagSuggest;

    constructor(app: App, plugin: EnhancedCanvas, canvas: Canvas, position: { x: number, y: number }) {
        super(app);
        this.plugin = plugin;
        this.canvas = canvas;
        this.position = position;
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
        this.tagSuggest = new TagSuggest(this.app, this.inputComponent.inputEl, this.getTags());

        // Enter imports — unless the suggestion popover is open, in which case
        // AbstractInputSuggest's own scope handles it (completes the tag).
        // Both guards are needed because the popover's key handler and this
        // listener can fire in either order.
        this.inputComponent.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.isComposing && !e.defaultPrevented && !this.tagSuggest.isOpen) {
                this.executeImport();
            }
        });

        new ButtonComponent(inputContainer)
            .setButtonText("Import")
            .setCta()
            .onClick(() => this.executeImport());

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
        this.tagSuggest?.close();
        this.contentEl.empty();
    }
}
