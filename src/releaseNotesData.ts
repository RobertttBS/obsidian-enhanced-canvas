// Shown after an update, above the feature guide. Replace it each release.
export const whatsNew = `
## What's new

- **Search text in images and PDFs**: run the command *Search text in images and PDFs* or click the ribbon icon. On Windows and Linux, click **Download** in the notice first (60 MB, once). On phones, turn on *Search text in images and PDFs* in Settings; image text comes from your computers through sync.
- **Image and PDF results in Search**: core Search lists images and PDFs whose text matches, with a preview of each image. Type a word in Search to try it.
- **Show only images and PDFs**: add \`-file:.md -file:.canvas\` to your search.
- **Hide them**: Settings → Enhanced Canvas → turn off *Show image and PDF results in Search*.
- **Page preview**: in *Search text in images and PDFs*, hover a result to preview the image or the matching PDF page. If Settings → Page preview → *Search* requires Cmd/Ctrl, hold that key while you hover.
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
Search the text inside every image (OCR) and PDF in your vault. *Find in canvas* also matches image and PDF cards.
- **Where:** command *Search text in images and PDFs* or the ribbon icon.
- **Preview:** hover a result to see the image or the matching PDF page (Settings → Page preview → *Search* sets whether Cmd/Ctrl is needed).
- **Settings:** *Search text in images and PDFs* (on by default), *Show image and PDF results in Search* (on by default; adds them to core Search, turn it off to hide them), *OCR engine* (Windows; **Built-in** is the default).
- **Windows, Linux:** click **Download** in the notice (60 MB, once).
- **Locked PDFs:** click **Unlock…** in the notice after indexing, on each device.
- **Mobile:** turn on the same setting. PDFs are read on the device; image text comes from your computers through sync.
- **Other devices:** images read on one computer are searchable on the others through sync. For a computer you no longer use, run *Remove image text from other devices…*.

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
