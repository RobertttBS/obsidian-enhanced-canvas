export const firstInstallContent = `
Building upon the original "Property Link" and "Auto Focus" features, I am excited to share three key additions in recent updates.
### ✨ Split Node by Headings & Add Notes by Tag

**Split Node by Headings** instantly deconstructs a single file node into a hierarchical tree based on its headings. You can try this by right-clicking on a file node and selecting "Split Node by Headings" in Canvas.
**Add Notes

### ✨ Send Note to Canvas

With the **"Send to Canvas"** plugin command, you can push your current markdown note directly to a specific Canvas. It automatically appends a "canvas" property to your note, allowing you to navigate back to the board instantly in the future.

Once you have sent a note, that Canvas becomes the "Selected." You can then use the **"Send to Selected Canvas"** plugin command on other notes to instantly add them to the same board—bypassing the file selection step entirely.

### ✨ Auto-Resize Node

This is a feature I’ve wanted for a long time. Previously, double-clicking the bottom edge would fit a node to its content, but changing the width would break this fit, forcing you to double-click again.

With this update, double-clicking the bottom edge activates "Auto-Resize." Now, the node's height dynamically adapts to fit your content—whether you are **adjusting the width** or **updating the text**. No need for repeated double-clicking!

[View detailed demo at github](https://github.com/RobertttBS/obsidian-enhanced-canvas)
`;

export const fixCursorShiftIssueInStackTabsCanvas = `
> [!success] Refactor in 1.0.26
> No new features, but some refactoring.

> [!NOTE] Feature in 1.0.25
> Add advanced multi-tag suggestions with robust querying.

> [!tip] Feature in 1.0.24
> Check the Enhanced Canvas settings to configure your preferred width and height for new nodes in Canvas.

> [!note] Feature in 1.0.23
> Added "Add notes by tag..." right-click menu option to bulk import notes by tag.

> [!bug] Fixed in 1.0.22
> Fixed an issue where properties failed to sync for pinned Canvas tabs on Windows 11. (I hope the bug is gone.)

> [!note] Feature in 1.0.21
> Since the Obsidian Canvas core plugin now supports backlinks, I have added a settings view to Enhanced Canvas that allows you to toggle the "Sync Frontmatter" feature (as well as the plugin's CSS). If you prefer not to have this property added, you can simply disable the "Sync Frontmatter" feature.

> [!tip] Feature in 1.0.20
> Added "Focus" functionality for Linked Mentions.

> [!NOTE] Feature in 1.0.19
> Added "Split by headings" functionality for Card Nodes.

> [!bug] Fixed in 1.0.18
> You can now use Canvas with "stacked tabs" enabled without experiencing the cursor position shift issue.
> This fix applies to the Obsidian Canvas core plugin rather than this specific plugin.
`;

export const releaseNotesContent: Record<string, string> = {
    "1.0.26": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.25": fixCursorShiftIssueInStackTabsCanvas, 
    "1.0.24": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.23": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.22": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.21": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.20": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.19": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.18": fixCursorShiftIssueInStackTabsCanvas,
    "1.0.17": firstInstallContent
};
