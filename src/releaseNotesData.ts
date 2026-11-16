// Shown after an update, above the feature guide. Replace it each release.
export const whatsNew = `
## What's new

- **Built-in OCR**: a second way to read the text in images, running inside Obsidian (PaddleOCR, on your graphics card when available). One model reads many languages at once. It needs a one-time download of about 31 MB of model files; nothing is downloaded unless you choose it. Your images never leave your computer.
- **Windows, when Windows OCR is blocked**: on a computer where PowerShell is blocked by a security policy or endpoint protection, or no OCR language is installed, the notice now has a **Use built-in OCR** button. Click it once: the files download and reading continues. That computer no longer starts PowerShell, also after a restart.
- **Windows, by choice**: the new *OCR engine* setting switches between *System (Windows OCR)* and *Built-in*. The choice is stored per device.
- **Linux**: Linux desktops now read images themselves, with the built-in OCR. A notice asks before the download; PDFs are indexed meanwhile.
- **Remove it**: the command *Remove downloaded built-in OCR files* frees the space.
- **macOS and mobile**: nothing changes.
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
Search words or a \`[[link]]\` across the Canvas: \`a b\` needs both words, \`a OR b\` either, \`"a b"\` the exact phrase. Matching cards are outlined, the rest dimmed, matched text highlighted, and the view zooms to fit. Node colors are never changed.
- **Where:** Cmd/Ctrl+F in a Canvas, command *Find in canvas (selected text or link)*, or right-click selected text in a card → **Find in canvas**.
- **Clear:** click an empty spot on the Canvas, or run *Clear find highlights*.
- **Hotkey:** whatever *Search current file* uses (Cmd/Ctrl+F by default); while editing a card it still searches that card. Or bind *Find in canvas* in Settings → Hotkeys.

### Search text in images and PDFs
Reads the text in every vault image, on-device (macOS and Windows: the system's OCR; Linux, or Windows by choice: the built-in OCR), and the embedded text of every PDF. Search all images and PDFs, or let Find in canvas match image and PDF cards; matching text is boxed on the image, and a PDF result opens at its page.
- **Where:** command *Search text in images and PDFs* or the ribbon icon; *Find in canvas* for image and PDF cards. Same search syntax as Find in canvas; results are numbered, with the total count on top. *All*, *Images* and *PDFs* filter by file type, the button beside them hides thumbnails, and **Show more** at the end lists 50 more.
- **Locked PDFs:** command *Unlock password-protected PDFs for text search* (or **Unlock…** in the notice after indexing) asks for each password once. The password isn't saved.
- **Rebuild:** command *Rebuild image and PDF text index* reads every image and PDF again. Files in *Excluded files* are skipped.
- **Settings:** *Search text in images and PDFs* (on by default; the first run takes a few minutes). On Windows, *OCR engine* chooses between Windows OCR and the built-in OCR. *Show image and PDF results in Search* puts matching images, with thumbnails, in core Search next to your notes (add \`-file:.md -file:.canvas\` for images and PDFs only); the ribbon icon stays.
- **Built-in OCR:** needs a one-time download of about 31 MB, after you choose it or click **Download**. Used on Linux, and on Windows when you pick it or when Windows OCR can't run (no OCR language installed, or PowerShell blocked). *Remove downloaded built-in OCR files* frees the space.
- **Mobile:** the same setting searches the index synced from your computer.

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
