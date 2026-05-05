import {
    App,
    FuzzySuggestModal,
    getAllTags,
    ItemView,
    Menu,
    Notice,
    TFile
} from "obsidian";
import { around } from "monkey-around";

import EnhancedCanvas from "../main";

type Position = {
    x: number;
    y: number;
};

const NODE_WIDTH = 400;
const NODE_HEIGHT = 400;
const NODE_GAP = 20;

/**
 * Adds a Canvas context-menu action for importing all markdown files that match
 * a selected tag.
 */
export class CanvasTagImport {
    private plugin: EnhancedCanvas;
    private patched = false;
    private menus = new WeakSet<Menu>();
    private leafEvent: any = null;
    private layoutEvent: any = null;

    constructor(plugin: EnhancedCanvas) {
        this.plugin = plugin;
    }

    register(): void {
        const tryToPatch = () => {
            if (this.patchCanvasCreationMenu()) {
                this.detachPatchListeners();
            }
        };

        this.leafEvent = this.plugin.app.workspace.on("active-leaf-change", tryToPatch);
        this.layoutEvent = this.plugin.app.workspace.on("layout-change", tryToPatch);

        this.plugin.registerEvent(this.leafEvent);
        this.plugin.registerEvent(this.layoutEvent);
        this.plugin.app.workspace.onLayoutReady(tryToPatch);
        tryToPatch();
    }

    private patchCanvasCreationMenu(): boolean {
        if (this.patched) return true;

        const canvas = this.getAnyCanvas();
        if (!canvas?.constructor?.prototype?.showCreationMenu) return false;

        const plugin = this.plugin;
        const tagImport = this;
        const uninstall = around(canvas.constructor.prototype, {
            showCreationMenu: (next) => {
                return function(menu: Menu, position: Position, ...args: any[]) {
                    const result = next.call(this, menu, position, ...args);
                    tagImport.addMenuItem(menu, this, position);
                    return result;
                };
            }
        });

        plugin.register(uninstall);
        this.patched = true;
        return true;
    }

    private detachPatchListeners(): void {
        if (this.leafEvent) {
            this.plugin.app.workspace.offref(this.leafEvent);
            this.leafEvent = null;
        }

        if (this.layoutEvent) {
            this.plugin.app.workspace.offref(this.layoutEvent);
            this.layoutEvent = null;
        }
    }

    private getAnyCanvas(): any {
        const canvasView = this.plugin.app.workspace.getLeavesOfType("canvas")?.[0]?.view as ItemView | undefined;
        if (!canvasView || canvasView.getViewType() !== "canvas") return null;

        return (canvasView as any).canvas;
    }

    private addMenuItem(menu: Menu, canvas: any, position: Position): void {
        if (!canvas || canvas.readonly || this.menus.has(menu)) return;
        this.menus.add(menu);

        menu.addItem((item) => {
            item
                .setTitle("Add notes by tag...")
                .setIcon("hashtag")
                .setSection("create")
                .onClick(() => {
                    new TagSuggestModal(this.plugin.app, this.plugin, canvas, position).open();
                });
        });
    }
}

class TagSuggestModal extends FuzzySuggestModal<string> {
    private plugin: EnhancedCanvas;
    private canvas: any;
    private position: Position;

    constructor(app: App, plugin: EnhancedCanvas, canvas: any, position: Position) {
        super(app);
        this.plugin = plugin;
        this.canvas = canvas;
        this.position = position;
        this.setPlaceholder("Select a tag to add matching notes...");
    }

    getItems(): string[] {
        const tags = new Set<string>();

        for (const file of this.plugin.app.vault.getMarkdownFiles()) {
            const cache = this.plugin.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            const fileTags = getAllTags(cache) ?? [];
            for (const tag of fileTags) {
                tags.add(tag);
                this.addParentTags(tag, tags);
            }
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

    getItemText(tag: string): string {
        return tag;
    }

    onChooseItem(tag: string, evt: MouseEvent | KeyboardEvent): void {
        this.close();
        this.addTaggedFiles(tag);
    }

    private addTaggedFiles(tag: string): void {
        const matchingFiles = this.getMatchingFiles(tag);

        if (matchingFiles.length === 0) {
            new Notice(`No new files found with tag ${tag}.`);
            return;
        }

        const columns = Math.ceil(Math.sqrt(matchingFiles.length));
        const createdNodes: any[] = [];

        matchingFiles.forEach((file, index) => {
            const x = this.position.x + (index % columns) * (NODE_WIDTH + NODE_GAP);
            const y = this.position.y + Math.floor(index / columns) * (NODE_HEIGHT + NODE_GAP);

            try {
                const node = this.canvas.createFileNode({
                    file,
                    pos: { x, y },
                    size: { width: NODE_WIDTH, height: NODE_HEIGHT },
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
            new Notice(`Failed to Add notes by tag ${tag}.`);
            return;
        }

        this.selectNodes(createdNodes);
        this.canvas.requestSave(false);

        new Notice(`Added ${createdNodes.length} node${createdNodes.length === 1 ? "" : "s"} with tag ${tag}.`);
    }

    private getMatchingFiles(tag: string): TFile[] {
        const existingPaths = this.getExistingFileNodePaths();

        return this.plugin.app.vault.getMarkdownFiles()
            .filter((file) => !existingPaths.has(file.path))
            .filter((file) => this.fileMatchesTag(file, tag))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    private getExistingFileNodePaths(): Set<string> {
        const canvasData = this.canvas.getData?.();
        const nodes = Array.isArray(canvasData?.nodes) ? canvasData.nodes : [];

        return new Set(
            nodes
                .filter((node: any) => node?.type === "file" && typeof node.file === "string")
                .map((node: any) => node.file)
        );
    }

    private fileMatchesTag(file: TFile, selectedTag: string): boolean {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        if (!cache) return false;

        const tags = getAllTags(cache) ?? [];
        return tags.some((tag) => tag === selectedTag || tag.startsWith(`${selectedTag}/`));
    }

    private selectNodes(nodes: any[]): void {
        if (typeof this.canvas.deselectAll === "function") {
            this.canvas.deselectAll();
        } else {
            this.canvas.selection?.clear?.();
        }

        for (const node of nodes) {
            if (typeof this.canvas.select === "function") {
                this.canvas.select(node);
            } else {
                this.canvas.selection?.add?.(node);
            }
        }
    }
}

