import { App, Modal, MarkdownRenderer, ButtonComponent } from "obsidian";
import EnhancedCanvas from "./main";
import { releaseNotesContent, firstInstallContent } from "./releaseNotesData";

export class ReleaseNotesModal extends Modal {
    private plugin: EnhancedCanvas;
    private version: string;
    private isNewInstall: boolean;

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

        this.renderContent();
    }

    async renderContent() {
        const { contentEl } = this;

        const markdownText = this.isNewInstall 
            ? firstInstallContent 
            : releaseNotesContent[this.version] || "Thank you for updating! This update includes bug fixes.";

        await MarkdownRenderer.render(
            this.app,
            markdownText,
            contentEl,
            "/",
            this.plugin 
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
        this.contentEl.empty();
        
        if (this.plugin.settings.previousRelease !== this.version) {
            this.plugin.settings.previousRelease = this.version;
            await this.plugin.saveSettings();
        }
    }
}
