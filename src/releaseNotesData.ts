// Shown after an update, above the feature guide. Replace it each release.
export const whatsNew = `
## What's new

- **Find in canvas**: search a word or a \`[[link]]\` to highlight every matching card, dim the rest, and zoom to fit. Press Cmd/Ctrl+F (the *Search current file* hotkey) in a Canvas, run *Find in canvas* from the command palette, or right-click selected text in a card. Click an empty spot to clear.
`;

// Shown on first install and after every update. Add an entry when a feature ships.
export const featureGuide = `
## Features

### Canvas properties
Add a note to a Canvas and it gets a \`canvas\` property linking back to the board. Connect two notes with an edge and the target is linked in a property named after the Canvas. Renaming or deleting files keeps these properties up to date.
- **Try it:** drag a note into a Canvas, connect it to another note, then open the note's properties.
- **Settings:** *Enable Frontmatter Synchronization* (turning it off removes every property this plugin added).

### Focus node from links
Click a Canvas link in a note's properties, backlinks, or search results, and the Canvas opens zoomed to that note's node.
- **Try it:** click the \`canvas\` property of a note that's on a Canvas.

### Split by headings
Break a note or text card into a tree of cards, one per heading.
- **Where:** right-click a file or text node → **Split by headings**.
- **Settings:** *Auto-resize leaf nodes on split*, *Choose heading level on split*, *Max auto-resize height*.

### Add notes by tag
Bulk-import every note matching a tag query (supports AND, OR, and exclude).
- **Where:** right-click an empty spot on the Canvas → **Add notes by tag...**

### Find in canvas
Search a word or a \`[[link]]\` across the Canvas. Matching cards are outlined, the rest dimmed, matched text highlighted, and the view zooms to fit. Node colors are never changed.
- **Where:** Cmd/Ctrl+F in a Canvas, command *Find in canvas (selected text or link)*, or right-click selected text in a card → **Find in canvas**.
- **Clear:** click an empty spot on the Canvas, or run *Clear find highlights*.
- **Hotkey:** whatever *Search current file* uses (Cmd/Ctrl+F by default); while editing a card it still searches that card. Or bind *Find in canvas* in Settings → Hotkeys.

### Send to Canvas
Add the current note to a Canvas of your choice. That Canvas is remembered, so later notes can go straight to it.
- **Commands:** *Send to Canvas*, *Send to Selected Canvas*, *Clear selected Canvas file*.

### Auto-resize node
Double-click a node's bottom edge, and its height follows the content as you edit the text or change the width. Dragging the bottom edge turns it off.

### Edge commands
Search "edges" in the command palette to draw edges from the links in your notes, re-route them, or delete them.

### Hide properties in Canvas nodes
Hides the properties panel inside Canvas nodes and embedded notes.
- **Settings:** *Enable Custom Visuals & CSS*.

Reopen this guide anytime with the **Show feature guide** command.

[Details on GitHub](https://github.com/RobertttBS/obsidian-enhanced-canvas)
`;
