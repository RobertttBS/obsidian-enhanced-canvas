export interface EnhancedCanvasSettings {
    showReleaseNotes: boolean;
    previousRelease: string;
    enableFrontmatter: boolean;
    enableCustomCSS: boolean;
}

export const DEFAULT_SETTINGS: EnhancedCanvasSettings = {
    showReleaseNotes: true,
    previousRelease: "0.0.0",
    enableFrontmatter: true,
    enableCustomCSS: true,
};
