import { App, Modal, MarkdownRenderer, ButtonComponent, Component } from "obsidian";
import EnhancedCanvas from "../main";
import { releaseNotesContent, firstInstallContent } from "./releaseNotesData";
import { isVersionNewer } from "./utils";

export class ReleaseNotesModal extends Modal {
    private plugin: EnhancedCanvas;
    private version: string;
    private isNewInstall: boolean;
    private previousVersion: string;
    private renderComponent = new Component();

    constructor(app: App, plugin: EnhancedCanvas, version: string, isNewInstall: boolean, previousVersion = "0.0.0") {
        super(app);
        this.plugin = plugin;
        this.version = version;
        this.isNewInstall = isNewInstall;
        this.previousVersion = previousVersion;
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

        let markdownText = "";
        if (this.isNewInstall) {
            markdownText = firstInstallContent;
        } else {
            const notes: string[] = [];
            const versions = Object.keys(releaseNotesContent).sort((a, b) => isVersionNewer(a, b) ? -1 : 1);
            
            for (const v of versions) {
                if (isVersionNewer(v, this.previousVersion) && !isVersionNewer(v, this.version)) {
                    notes.push(releaseNotesContent[v]);
                }
            }
            
            markdownText = notes.length > 0 
                ? notes.join("\n\n---\n\n")
                : "Thank you for updating! This update includes bug fixes.";
        }

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

    async onClose() {
        this.renderComponent.unload();
        this.contentEl.empty();

        if (this.plugin.settings.previousRelease !== this.version) {
            this.plugin.settings.previousRelease = this.version;
            await this.plugin.saveSettings();
        }
    }
}
