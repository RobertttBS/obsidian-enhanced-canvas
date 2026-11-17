// Shown after an update, above the feature guide. Replace it each release.
export const whatsNew = `
## What's new

- **Built-in OCR on Windows**: click **Download** in the notice (60 MB, once) to read images with the built-in OCR: more accurate, many languages at once, and unaffected by company security software (slow without a graphics card). Prefer Windows OCR? Choose it in settings → *OCR engine*.
- **Search text in images on Linux**: click **Download** in the notice (60 MB, once).
- **Already using the built-in OCR?** Click **Download** in the notice once more (29 MB) so new images keep being read.
- **Reading images paused?** Click **Use built-in OCR** in the notice.
`;

// Shown on first install and after every update. Add an entry when a feature ships.
export const featureGuide = `
## Features

### Canvas properties
Notes on a Canvas get a \`canvas\` property linking back to it, and an edge between two notes links the target in a property named after the Canvas.
- **Try it:** drag a note into a Canvas, connect it to another note, then open the note's properties.
- **Settings:** *Enable Frontmatter Synchronization* (turning it off removes every property this plugin added).

### Focus card from links
Click a Canvas link in a note's properties, backlinks, or search results, and the Canvas opens zoomed to that note's card.
- **Try it:** click the \`canvas\` property of a note that's on a Canvas.

### Split by headings
Break a note or text card into a tree of cards, one per heading.
- **Where:** right-click a note card or a text card → **Split by headings**.
- **Settings:** *Auto-resize leaf cards on split*, *Choose heading level on split*, *Max auto-resize height*.

### Add notes by tag
Add every note matching a tag query: \`#a #b\` needs both tags, \`#a OR #b\` either, \`-#c\` excludes.
- **Where:** right-click an empty spot on the Canvas → **Add notes by tag...**

### Find in canvas
Search words or a \`[[link]]\` across the Canvas: \`a b\` needs both words, \`a OR b\` either, \`"a b"\` the exact phrase. Matching cards are highlighted and the view zooms to fit.
- **Where:** Cmd/Ctrl+F in a Canvas (the *Search current file* hotkey), or right-click selected text in a card → **Find in canvas**.
- **Clear:** click an empty spot on the Canvas.

### Search text in images and PDFs
Search the text inside every image (OCR) and PDF in your vault, read on your computer. *Find in canvas* also matches image and PDF cards.
- **Where:** command *Search text in images and PDFs* or the ribbon icon.
- **Settings:** *Search text in images and PDFs* (on by default), *Show image and PDF results in Search* (adds them to core Search), *OCR engine* (Windows; **Built-in** is the default).
- **Windows, Linux:** click **Download** in the notice (60 MB, once).
- **Locked PDFs:** click **Unlock…** in the notice after indexing.
- **Mobile:** turn on the same setting to search the index synced from your computer.

### Send to Canvas
Add the current note to a Canvas; later notes can go straight to the same one.
- **Commands:** *Send to Canvas*, *Send to Selected Canvas*, *Clear selected Canvas file*.

### Auto-resize card
Double-click a card's bottom edge, and its height follows the content as you edit the text or change the width. Dragging the bottom edge turns it off.

### Default card size
Set the width and height of new text and file cards.
- **Settings:** *Default card size*.

### Edge commands
Search "edges" in the command palette to draw edges from the links in your notes, re-route them, or delete them.

### Hide properties in Canvas cards
Hides the properties panel inside Canvas cards and embedded notes.
- **Settings:** *Hide properties in Canvas cards*.

Reopen this guide anytime with the **Show feature guide** command.

[Details on GitHub](https://github.com/RobertttBS/obsidian-enhanced-canvas)
`;
