export const firstInstallContent = `
Building upon the original "Property Link" and "Auto Focus" features, I am excited to share three key additions in recent updates.
### ✨ Split Node by Headings

**Split Node by Headings** instantly deconstructs a single file node into a hierarchical tree based on its headings. You can try this by right-clicking on a file node and selecting "Split Node by Headings" in Canvas.

### ✨ Send Note to Canvas

With the **"Send to Canvas"** plugin command, you can push your current markdown note directly to a specific Canvas. It automatically appends a "canvas" property to your note, allowing you to navigate back to the board instantly in the future.

Once you have sent a note, that Canvas becomes the "Selected." You can then use the **"Send to Selected Canvas"** plugin command on other notes to instantly add them to the same board—bypassing the file selection step entirely.

### ✨ Auto-Resize Node

This is a feature I’ve wanted for a long time. Previously, double-clicking the bottom edge would fit a node to its content, but changing the width would break this fit, forcing you to double-click again.

With this update, double-clicking the bottom edge activates "Auto-Resize." Now, the node's height dynamically adapts to fit your content—whether you are **adjusting the width** or **updating the text**. No need for repeated double-clicking!

[View detailed demo at github](https://github.com/RobertttBS/obsidian-enhanced-canvas)
`;

export const releaseNotesContent: Record<string, string> = {
    "1.0.17": firstInstallContent
};
