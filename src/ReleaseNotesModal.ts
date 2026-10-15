import { App, Modal, MarkdownRenderer, ButtonComponent, Component } from "obsidian";
import EnhancedCanvas from "../main";
import { whatsNew, featureGuide } from "./releaseNotesData";

export class ReleaseNotesModal extends Modal {
    private plugin: EnhancedCanvas;
    private version: string;
    private isNewInstall: boolean;
    private renderComponent = new Component();

    constructor(app: App, plugin: EnhancedCanvas, version: string, isNewInstall: boolean) {
        super(app);
        this.plugin = plugin;
        this.version = version;
        this.isNewInstall = isNewInstall;
    }

    onOpen() {
        const { contentEl, titleEl } = this;

        titleEl.setText(
            this.isNewInstall
            ? "Welcome to Enhanced Canvas"
            : `Enhanced Canvas updated to v${this.version}`
        );

        contentEl.classList.add("enhanced-canvas-release-notes");

        this.renderComponent.load();
        void this.renderContent();
    }

    async renderContent() {
        const { contentEl } = this;

        const markdownText = this.isNewInstall ? featureGuide : `${whatsNew}\n---\n${featureGuide}`;

        await MarkdownRenderer.render(
            this.app,
            markdownText,
            contentEl,
            "/",
            this.renderComponent
        );

        const buttonContainer = contentEl.createDiv({ cls: "release-notes-button-container" });
        buttonContainer.style.marginTop = "20px";
        buttonContainer.style.textAlign = "right";

        new ButtonComponent(buttonContainer)
            .setButtonText("Got it")
            .setCta()
            .onClick(() => {
                this.close();
            });
    }

    onClose() {
        this.renderComponent.unload();
        this.contentEl.empty();

        if (this.plugin.settings.previousRelease !== this.version) {
            this.plugin.settings.previousRelease = this.version;
            void this.plugin.saveSettings();
        }
    }
}
