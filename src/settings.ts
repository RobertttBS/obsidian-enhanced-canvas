export interface EnhancedCanvasSettings {
    showReleaseNotes: boolean;
    previousRelease: string;
    enableFrontmatter: boolean;
    enableCustomCSS: boolean;

    defaultTextNodeWidth: number;
    defaultTextNodeHeight: number;
    defaultFileNodeWidth: number;
    defaultFileNodeHeight: number;
}

export const DEFAULT_SETTINGS: EnhancedCanvasSettings = {
    showReleaseNotes: true,
    previousRelease: "0.0.0",
    enableFrontmatter: true,
    enableCustomCSS: true,

    defaultTextNodeWidth: 250,
    defaultTextNodeHeight: 60,
    defaultFileNodeWidth: 400,
    defaultFileNodeHeight: 400,
};
