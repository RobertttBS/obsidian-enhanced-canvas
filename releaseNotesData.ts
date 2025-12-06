export const firstInstallContent = `
Building upon the original "Property Link" and "Auto Focus" features, I am excited to share three key additions in recent updates.
### ✨ Split Node by Headings

**Split Node by Headings** instantly deconstructs a single file node into a hierarchical tree based on its headings. This feature transforms a linear document into a visual outline, generating connected nodes for each section to help you map out the structure of your notes effortlessly.

### ✨ Send Note to Canvas

With the **"Send to Canvas"** command, you can push your current markdown note directly to a specific Canvas. It automatically appends a "canvas" property to your note, allowing you to navigate back to the board instantly in the future.

Once you have sent a note, that Canvas becomes the "Selected." You can then use the **"Send to Selected Canvas"** command on other notes to instantly add them to the same board—bypassing the file selection step entirely.

### ✨ Auto-Resize Node

This is a feature I have wanted for a long time. Previously, while double-clicking the bottom edge would fit a node to its content, changing the width would break this fit, forcing you to double-click again.

With this update, double-clicking the bottom edge engages **"Auto-Resize."** Now, when you drag the right edge to adjust the width, the height dynamically adjusts to fit your text. No need for repeated double-clicking!

_(Coming soon: A feature that auto-resizes the node immediately after editing text within the Canvas.)_

[View detailed demo at github](https://github.com/RobertttBS/obsidian-enhanced-canvas)
`;

export const releaseNotesContent: Record<string, string> = {
    "1.0.17": firstInstallContent
};
