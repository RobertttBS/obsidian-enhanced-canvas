import {
    EventRef,
    ItemView,
    Menu,
} from "obsidian";
import { around } from "monkey-around";

import EnhancedCanvas from "../main";
import { Canvas, CanvasView } from "../Canvas";
import { AdvancedTagSuggestModal } from "./AdvancedTagSuggestModal";

type Position = {
    x: number;
    y: number;
};

/**
 * Adds a Canvas context-menu action for importing all markdown files that match
 * a selected tag.
 */
export class CanvasTagImport {
    private plugin: EnhancedCanvas;
    private patched = false;
    private menus = new WeakSet<Menu>();
    private leafEvent: EventRef | null = null;
    private layoutEvent: EventRef | null = null;

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
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- alias needed: `this` inside the around() patch rebinds to the Canvas instance, so the CanvasTagImport reference must be captured in an outer variable
        const tagImport = this;
        const uninstall = around(canvas.constructor.prototype, {
            showCreationMenu: (next: (menu: Menu, position: Position, ...args: unknown[]) => unknown) => {
                return function(this: Canvas, menu: Menu, position: Position, ...args: unknown[]) {
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

    private getAnyCanvas(): Canvas | null {
        const canvasView = this.plugin.app.workspace.getLeavesOfType("canvas")?.[0]?.view as ItemView | undefined;
        if (!canvasView || canvasView.getViewType() !== "canvas") return null;

        return (canvasView as CanvasView).canvas;
    }

    private addMenuItem(menu: Menu, canvas: Canvas, position: Position): void {
        if (!canvas || canvas.readonly || this.menus.has(menu)) return;
        this.menus.add(menu);

        menu.addItem((item) => {
            item
                .setTitle("Add notes by tag...")
                .setIcon("hashtag")
                .setSection("create")
                .onClick(() => {
                    new AdvancedTagSuggestModal(this.plugin.app, this.plugin, canvas, position).open();
                });
        });
    }
}
