export interface EnhancedCanvasSettings {
    showReleaseNotes: boolean;
    previousRelease: string;
}

export const DEFAULT_SETTINGS: EnhancedCanvasSettings = {
    showReleaseNotes: true,
    previousRelease: "0.0.0"
};
